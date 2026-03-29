from __future__ import annotations

from collections import deque, defaultdict
from typing import Dict, List, Optional

from models import EventFrame, MatchMeta, PhysicalFrame, PositionFrame


class InMemoryStore:
    def __init__(
        self,
        maxlen_positions: int = 1024,
        maxlen_physical: int = 1024,
        maxlen_events: int = 2048,
    ) -> None:
        self._positions: deque[PositionFrame] = deque(maxlen=maxlen_positions)
        self._physical: deque[PhysicalFrame] = deque(maxlen=maxlen_physical)
        self._events: deque[EventFrame] = deque(maxlen=maxlen_events)
        self._positions_by_time: Dict[int, List[PositionFrame]] = defaultdict(list)
        self._physical_by_time: Dict[int, List[PhysicalFrame]] = defaultdict(list)
        self._events_by_time: Dict[int, List[EventFrame]] = defaultdict(list)
        self._meta: Optional[MatchMeta] = None
        self._last_time: int = 0
        self._counts = {"positions": 0, "physical": 0, "events": 0}

    def set_meta(self, meta: MatchMeta) -> None:
        self._meta = meta

    def get_meta(self) -> Optional[MatchMeta]:
        return self._meta

    def add_position(self, frame: PositionFrame) -> None:
        self._positions.append(frame)
        self._positions_by_time[frame.time].append(frame)
        self._last_time = max(self._last_time, frame.time)
        self._counts["positions"] += 1

    def add_physical(self, frame: PhysicalFrame) -> None:
        self._physical.append(frame)
        self._physical_by_time[frame.time].append(frame)
        self._last_time = max(self._last_time, frame.time)
        self._counts["physical"] += 1

    def add_event(self, frame: EventFrame) -> None:
        self._events.append(frame)
        self._events_by_time[frame.time].append(frame)
        self._last_time = max(self._last_time, frame.time)
        self._counts["events"] += 1

    def get_last_time(self) -> int:
        return self._last_time

    def get_snapshot(self, timeSec: int) -> Dict[str, List]:
        return {
            "positions": list(self._positions_by_time.get(timeSec, [])),
            "physical": list(self._physical_by_time.get(timeSec, [])),
            "events": list(self._events_by_time.get(timeSec, [])),
        }

    def get_range(self, fromSec: int, toSec: int, kind: str = "events") -> List:
        if kind == "events":
            source = self._events_by_time
        elif kind == "positions":
            source = self._positions_by_time
        elif kind == "physical":
            source = self._physical_by_time
        else:
            return []
        result: List = []
        for t in range(fromSec, toSec + 1):
            result.extend(source.get(t, []))
        return result

    def all_positions(self) -> List[PositionFrame]:
        return list(self._positions)

    def all_physical(self) -> List[PhysicalFrame]:
        return list(self._physical)

    def all_events(self) -> List[EventFrame]:
        return list(self._events)

    def get_counts(self) -> Dict[str, int]:
        return self._counts.copy()


if __name__ == "__main__":
    store = InMemoryStore()
    pos0 = PositionFrame(time=0, minute=0, playerId="p1", team="Team_A", role="GK", x=0, y=0)
    pos1 = PositionFrame(time=1, minute=0, playerId="p2", team="Team_B", role="DEF", x=10, y=10)
    phy0 = PhysicalFrame(time=0, minute=0, playerId="p1", team="Team_A", speed=5.0, fatigue=0.1)
    evt1 = EventFrame(
        time=1,
        minute=0,
        playerId="p2",
        team="Team_B",
        eventType="pass",
        x=5.0,
        y=5.0,
        success=True,
        momentum=0.5,
        xG=0.0,
    )
    store.add_position(pos0)
    store.add_position(pos1)
    store.add_physical(phy0)
    store.add_event(evt1)
    snapshot = store.get_snapshot(1)
    assert store.get_last_time() == 1
    assert len(snapshot["positions"]) == 1
    assert len(snapshot["events"]) == 1
    print("store tests passed")
