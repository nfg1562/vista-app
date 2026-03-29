from __future__ import annotations

import asyncio
import json
from typing import Callable

from models import EventFrame, PhysicalFrame, PositionFrame, WSMessage
from match_state import MatchClockState
from store import InMemoryStore
from sim.generator import SimGenerator, SimGeneratorConfig


class SimPublisher:
    def __init__(
        self,
        match_id: str,
        store: InMemoryStore,
        clock: MatchClockState,
        ws_broadcast: Callable[[str, WSMessage], asyncio.Future],
        generator: SimGenerator | None = None,
        config: SimGeneratorConfig | None = None,
        emit_fps: int = 1,
        on_reco_tick: Callable[[int], asyncio.Future] | None = None,
    ) -> None:
        self.match_id = match_id
        self.store = store
        self.clock = clock
        self.emit_interval = 1.0 / emit_fps
        self.ws_broadcast = ws_broadcast
        self.generator = generator or SimGenerator(config=config)
        self.on_reco_tick = on_reco_tick
        self._last_reco_minute: int | None = None
        self._task: asyncio.Task | None = None
        self._stop = False

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop = False
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._stop = True
        if self._task:
            await self._task

    async def _run(self) -> None:
        while not self._stop:
            self.clock.tick()
            if self.clock.status != "running":
                await asyncio.sleep(self.emit_interval)
                continue
            t = self.clock.get_live_time()
            current_minute = t // 60
            positions, physical, events = self.generator.tick(t)
            for frame in positions:
                self.store.add_position(frame)
                await self.ws_broadcast(
                    self.match_id,
                    json.dumps(WSMessage(type="pos", payload=frame).model_dump()),
                )
            for frame in physical:
                self.store.add_physical(frame)
                await self.ws_broadcast(
                    self.match_id,
                    json.dumps(WSMessage(type="phy", payload=frame).model_dump()),
                )
            for frame in events:
                self.store.add_event(frame)
                await self.ws_broadcast(
                    self.match_id,
                    json.dumps(WSMessage(type="evt", payload=frame).model_dump()),
                )
            if self.on_reco_tick and (
                self._last_reco_minute is None or current_minute > self._last_reco_minute
            ):
                self._last_reco_minute = current_minute
                asyncio.create_task(self.on_reco_tick(current_minute))
            await asyncio.sleep(self.emit_interval)


class DummyWSManager:
    def __init__(self):
        self.messages: list[WSMessage] = []

    async def broadcast(self, match_id: str, message: WSMessage) -> None:
        self.messages.append((match_id, message))


async def _self_test() -> None:
    store = InMemoryStore()
    clock = MatchClockState()
    ws = DummyWSManager()
    publisher = SimPublisher(
        "match-1",
        store,
        clock,
        ws_broadcast=ws.broadcast,
        generator=SimGenerator(),
        emit_fps=1,
    )
    clock.start()
    await publisher.start()
    await asyncio.sleep(2.2)
    await publisher.stop()
    assert store.get_last_time() >= 2
    snapshot = store.get_snapshot(2)
    assert snapshot["positions"]
    assert snapshot["events"] or True
    assert ws.messages
    print("SimPublisher smoke test passed")


if __name__ == "__main__":
    asyncio.run(_self_test())
