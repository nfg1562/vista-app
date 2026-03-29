from __future__ import annotations

import time
from typing import Any, Dict, Iterable, List, Literal, Optional, Tuple


TimeStatus = Literal["idle", "running", "paused", "ended"]
MatchPhase = Literal[
    "PRE_MATCH",
    "FIRST_HALF",
    "HALF_TIME",
    "SECOND_HALF",
    "FULL_TIME",
    "FINISHED",
]


def current_time_ms() -> int:
    return int(time.time() * 1000)


class MatchClockState:
    def __init__(self) -> None:
        self.status: TimeStatus = "idle"
        self.liveTimeSec: int = 0
        self.anchorWallTsMs: Optional[int] = None
        self.anchorMatchSec: int = 0

    def init_idle(self) -> None:
        self.status = "idle"
        self.liveTimeSec = 0
        self.anchorWallTsMs = None
        self.anchorMatchSec = 0

    def start(self) -> None:
        if self.status in ("idle", "paused"):
            self.status = "running"
            self.anchorWallTsMs = current_time_ms()
            self.anchorMatchSec = self.liveTimeSec

    def pause(self) -> None:
        if self.status == "running" and self.anchorWallTsMs is not None:
            self.tick()
            self.status = "paused"
            self.anchorWallTsMs = None
            self.anchorMatchSec = self.liveTimeSec

    def resume(self) -> None:
        if self.status == "paused":
            self.status = "running"
            self.anchorWallTsMs = current_time_ms()
            self.anchorMatchSec = self.liveTimeSec

    def tick(self) -> None:
        if self.status == "running" and self.anchorWallTsMs is not None:
            elapsed = (current_time_ms() - self.anchorWallTsMs) // 1000
            self.liveTimeSec = self.anchorMatchSec + elapsed

    def get_live_time(self) -> int:
        self.tick()
        return self.liveTimeSec


def _phase_from_minute(
    minute: int,
    match_length: int = 90,
    halftime: int = 45,
    clock_status: Optional[TimeStatus] = None,
) -> MatchPhase:
    if minute < 0:
        return "PRE_MATCH"
    if minute < halftime:
        return "FIRST_HALF"
    if minute == halftime:
        return "HALF_TIME"
    if minute < match_length:
        return "SECOND_HALF"
    if clock_status == "ended":
        return "FINISHED"
    return "FULL_TIME"


def _attack_direction(minute: int, halftime: int = 45) -> Dict[str, str]:
    if minute < halftime:
        return {"Team_A": "right", "Team_B": "left"}
    return {"Team_A": "left", "Team_B": "right"}


def _frame_value(frame: Any, attr: str, default: Any = None) -> Any:
    if isinstance(frame, dict):
        if attr in frame:
            return frame.get(attr, default)
        alias = {
            "playerId": "player_id",
            "eventType": "event_type",
        }.get(attr)
        if alias:
            return frame.get(alias, default)
        return default
    return getattr(frame, attr, default)


def _lineup_from_positions(
    positions: Iterable[Any],
    minute: int,
) -> Dict[str, List[str]]:
    lineup = {"Team_A": set(), "Team_B": set()}
    for frame in positions:
        if _frame_value(frame, "minute", None) == minute:
            team = _frame_value(frame, "team", None)
            player = _frame_value(frame, "playerId", None)
            if team in lineup and player:
                lineup[team].add(str(player))
    return {
        "Team_A": sorted(lineup["Team_A"]),
        "Team_B": sorted(lineup["Team_B"]),
    }


def _lineup_from_roster(roster_entries: Optional[Iterable[Any]]) -> List[str]:
    result: List[str] = []
    if not roster_entries:
        return result
    for entry in roster_entries:
        numero = str(getattr(entry, "numero", "") or "").strip()
        nom = str(getattr(entry, "nom", "") or "").strip()
        if numero and nom:
            result.append(f"{numero} {nom}")
        elif numero:
            result.append(numero)
        elif nom:
            result.append(nom)
    return result


def _ensure_lineup(
    positions: Iterable[Any],
    minute: int,
    rosters: Optional[Dict[str, Iterable[Any]]] = None,
) -> Dict[str, List[str]]:
    lineup = _lineup_from_positions(positions, minute)
    if lineup["Team_A"] or lineup["Team_B"]:
        return lineup
    roster_home = _lineup_from_roster(rosters.get("home") if rosters else None)
    roster_away = _lineup_from_roster(rosters.get("away") if rosters else None)
    return {"Team_A": roster_home, "Team_B": roster_away}


def build_match_state(
    minute: int,
    positions: Iterable[Any],
    events: Iterable[Any],
    control_events: Optional[List[Dict[str, Any]]] = None,
    rosters: Optional[Dict[str, Iterable[Any]]] = None,
    match_length: int = 90,
    halftime: int = 45,
    clock_status: Optional[TimeStatus] = None,
    no_data: bool = False,
) -> Dict[str, Any]:
    target_minute = max(0, int(minute))
    control_events = control_events or []

    score = {"Team_A": 0, "Team_B": 0}
    cards: Dict[str, Dict[str, Any]] = {}
    subs_used = {"Team_A": 0, "Team_B": 0}
    sub_windows: Dict[str, set] = {"Team_A": set(), "Team_B": set()}
    substitutions: List[Dict[str, Any]] = []

    lineup = _ensure_lineup(positions, target_minute, rosters=rosters)
    lineup_sets = {
        "Team_A": set(lineup["Team_A"]),
        "Team_B": set(lineup["Team_B"]),
    }

    for evt in events:
        evt_minute = _frame_value(evt, "minute", None)
        if evt_minute is None or evt_minute > target_minute:
            continue
        if _frame_value(evt, "eventType", None) == "shot" and _frame_value(evt, "success", False):
            team = _frame_value(evt, "team", None)
            if team in score:
                score[team] += 1

    ordered = sorted(
        control_events,
        key=lambda e: int(e.get("minute", 0)),
    )
    for evt in ordered:
        evt_minute = int(evt.get("minute", 0))
        if evt_minute > target_minute:
            continue
        evt_type = str(evt.get("type", "")).upper()
        team = evt.get("team")
        if evt_type == "GOAL" and team in score:
            score[team] += 1
            continue
        if evt_type == "SUBSTITUTION" and team in lineup_sets:
            subs_used[team] += 1
            sub_windows[team].add(evt_minute)
            player_out = evt.get("player_out_id")
            player_in = evt.get("player_in_id")
            substitutions.append(
                {
                    "minute": evt_minute,
                    "team": team,
                    "player_out_id": player_out,
                    "player_in_id": player_in,
                }
            )
            if player_out:
                lineup_sets[team].discard(str(player_out))
            if player_in:
                lineup_sets[team].add(str(player_in))
            continue
        if evt_type in ("YELLOW_CARD", "RED_CARD", "SECOND_YELLOW"):
            player_id = evt.get("player_id")
            if not player_id:
                continue
            player_key = str(player_id)
            entry = cards.setdefault(player_key, {"yellow": 0, "red": False})
            if evt_type == "YELLOW_CARD":
                entry["yellow"] += 1
                if entry["yellow"] >= 2:
                    entry["red"] = True
            elif evt_type == "SECOND_YELLOW":
                entry["yellow"] += 1
                entry["red"] = True
            else:
                entry["red"] = True
            if entry["red"] and team in lineup_sets:
                lineup_sets[team].discard(player_key)

    return {
        "minute": target_minute,
        "phase": _phase_from_minute(
            target_minute,
            match_length=match_length,
            halftime=halftime,
            clock_status=clock_status,
        ),
        "score": score,
        "lineup": {
            "Team_A": sorted(lineup_sets["Team_A"]),
            "Team_B": sorted(lineup_sets["Team_B"]),
        },
        "bench": {
            "Team_A": _lineup_from_roster(rosters.get("bench_home") if rosters else None),
            "Team_B": _lineup_from_roster(rosters.get("bench_away") if rosters else None),
        }
        if rosters
        else None,
        "cards": cards,
        "subs_used": subs_used,
        "substitutions": substitutions,
        "substitutions_at_minute": [
            sub for sub in substitutions if int(sub.get("minute", 0)) == target_minute
        ],
        "sub_windows_used": {
            "Team_A": len(sub_windows["Team_A"]),
            "Team_B": len(sub_windows["Team_B"]),
        },
        "attack_direction": _attack_direction(target_minute, halftime=halftime),
        "no_data": no_data,
    }

if __name__ == "__main__":
    clock = MatchClockState()
    clock.start()
    time.sleep(1.2)
    assert clock.get_live_time() >= 1
    clock.pause()
    paused = clock.get_live_time()
    time.sleep(0.5)
    assert clock.get_live_time() == paused
    clock.resume()
    time.sleep(1.1)
    assert clock.get_live_time() >= paused + 1
    print("match_state tests passed")
