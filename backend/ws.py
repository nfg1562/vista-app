from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any, DefaultDict, Set

class WSManager:
    def __init__(self) -> None:
        self._clients: DefaultDict[str, Set[Any]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def register(self, match_id: str, websocket: Any) -> None:
        async with self._lock:
            self._clients[match_id].add(websocket)

    async def unregister(self, match_id: str, websocket: Any) -> None:
        async with self._lock:
            if match_id in self._clients:
                self._clients[match_id].discard(websocket)
                if not self._clients[match_id]:
                    del self._clients[match_id]

    async def broadcast(self, match_id: str, message: Any) -> None:
        async with self._lock:
            clients = list(self._clients.get(match_id, []))
        for ws in clients:
            try:
                await ws.send_text(message)
            except Exception:
                await self.unregister(match_id, ws)

    async def count_clients(self, match_id: str) -> int:
        async with self._lock:
            return len(self._clients.get(match_id, []))


class DummyWebSocket:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send_text(self, message: str) -> None:
        self.sent.append(message)


async def _self_test() -> None:
    manager = WSManager()
    ws1 = DummyWebSocket()
    ws2 = DummyWebSocket()
    await manager.register("match-1", ws1)
    await manager.register("match-1", ws2)
    await manager.broadcast("match-1", '{"type":"test"}')
    assert ws1.sent
    assert ws2.sent
    print("ws manager test passed")


if __name__ == "__main__":
    asyncio.run(_self_test())
