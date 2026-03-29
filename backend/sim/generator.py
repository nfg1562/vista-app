from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Any, Dict, List, Sequence, Tuple

from models import EventFrame, PhysicalFrame, PositionFrame

TEAM_NAMES = ["Team_A", "Team_B"]
ROLES = ["GK", "DEF", "MID", "FWD"]
EVENT_TYPES = ["pass", "cross", "shot", "tackle", "foul"]
FORMATION_ROLE_COUNTS = {
    "4-3-3": {"GK": 1, "DEF": 4, "MID": 3, "FWD": 3},
    "4-4-2": {"GK": 1, "DEF": 4, "MID": 4, "FWD": 2},
}


def clamp(value: float, minv: float, maxv: float) -> float:
    return max(minv, min(maxv, value))


def default_team_config() -> Dict[str, Dict]:
    return {
        "Team_A": {
            "formation": "4-3-3",
            "players": {
                "GK": ["Team_A_1"],
                "DEF": [f"Team_A_{i}" for i in range(2, 6)],
                "MID": [f"Team_A_{i}" for i in range(6, 9)],
                "FWD": [f"Team_A_{i}" for i in range(9, 12)],
            },
        },
        "Team_B": {
            "formation": "4-4-2",
            "players": {
                "GK": ["Team_B_1"],
                "DEF": [f"Team_B_{i}" for i in range(2, 6)],
                "MID": [f"Team_B_{i}" for i in range(6, 10)],
                "FWD": [f"Team_B_{i}" for i in range(10, 12)],
            },
        },
    }


def _role_counts_for_formation(formation: str) -> Dict[str, int]:
    return FORMATION_ROLE_COUNTS.get(formation, FORMATION_ROLE_COUNTS["4-3-3"]).copy()


def _roster_entry_label(entry: Any, fallback: str) -> str:
    if entry is None:
        return fallback
    numero = str(getattr(entry, "numero", "") or "").strip()
    nom = str(getattr(entry, "nom", "") or "").strip()
    if numero and nom:
        return f"{numero} {nom}"
    if nom:
        return nom
    if numero:
        return numero
    return fallback


def build_sim_team_config(rosters: Dict[str, Sequence[Any]] | None = None) -> Dict[str, Dict]:
    base = default_team_config()
    if not rosters:
        return base

    for team_key, roster_key in (("Team_A", "home"), ("Team_B", "away")):
        formation = str(base[team_key].get("formation", "4-3-3"))
        role_counts = _role_counts_for_formation(formation)
        entries = list(rosters.get(roster_key) or [])
        labels: List[str] = []
        total_needed = sum(role_counts.values())
        for idx in range(total_needed):
            fallback = f"{team_key}_{idx + 1}"
            entry = entries[idx] if idx < len(entries) else None
            labels.append(_roster_entry_label(entry, fallback))

        start = 0
        players: Dict[str, List[str]] = {}
        for role in ROLES:
            count = role_counts.get(role, 0)
            players[role] = labels[start : start + count]
            start += count
        base[team_key]["players"] = players
    return base


@dataclass
class SimGeneratorConfig:
    duration_minutes: int = 15
    emit_fps: int = 1


class SimGenerator:
    def __init__(
        self,
        config: SimGeneratorConfig | None = None,
        teams: Dict[str, Dict] | None = None,
    ) -> None:
        self.config = config or SimGeneratorConfig()
        self.teams = teams or default_team_config()
        self.momentum = 0.5
        self._last_momentum_update = 0
        self._score = {"Team_A": 0, "Team_B": 0}

    def _update_momentum(self, time_sec: int) -> None:
        if time_sec - self._last_momentum_update >= 300:
            self.momentum = clamp(self.momentum + random.uniform(-0.15, 0.15), 0.0, 1.0)
            self._last_momentum_update = time_sec

    def _player_base(self, team: str, player: str, role: str) -> Tuple[float, float]:
        if role == "GK":
            return (5 if team == "Team_A" else 100, 34)
        if role == "DEF":
            return (25 if team == "Team_A" else 80, random.uniform(10, 58))
        if role == "MID":
            return (50, random.uniform(5, 63))
        return (80 if team == "Team_A" else 25, random.uniform(15, 53))

    def _generate_positions(self, time_sec: int) -> List[PositionFrame]:
        minute = time_sec // 60
        frames: List[PositionFrame] = []
        for team in TEAM_NAMES:
            for role, players in self.teams[team]["players"].items():
                for player in players:
                    base_x, base_y = self._player_base(team, player, role)
                    x_offset = random.uniform(-5, 5) if role != "GK" else random.uniform(-2, 2)
                    y_offset = random.uniform(-4, 4) if role != "GK" else random.uniform(-1, 1)
                    frame = PositionFrame(
                        time=time_sec,
                        minute=minute,
                        playerId=player,
                        team=team,
                        role=role,
                        x=clamp(base_x + x_offset, 0, 105),
                        y=clamp(base_y + y_offset, 0, 68),
                    )
                    frames.append(frame)
        return frames

    def _generate_physical(self, time_sec: int) -> List[PhysicalFrame]:
        minute = time_sec // 60
        frames: List[PhysicalFrame] = []
        fatigue_base = clamp(time_sec / (self.config.duration_minutes * 60), 0.0, 1.0)
        for team in TEAM_NAMES:
            for role, players in self.teams[team]["players"].items():
                for player in players:
                    fatigue = clamp(fatigue_base + random.uniform(-0.1, 0.1), 0.0, 1.0)
                    speed = clamp(8.0 * (1.0 - 0.5 * fatigue) + random.uniform(-0.8, 0.8), 0.5, 9.0)
                    frames.append(
                        PhysicalFrame(
                            time=time_sec,
                            minute=minute,
                            playerId=player,
                            team=team,
                            speed=speed,
                            fatigue=fatigue,
                        )
                    )
        return frames

    def _generate_event(self, time_sec: int) -> EventFrame | None:
        if random.random() >= 0.1:
            return None
        minute = time_sec // 60
        event_type = random.choices(
            EVENT_TYPES, weights=[0.6, 0.1, 0.15, 0.1, 0.05], k=1
        )[0]
        team = "Team_A" if random.random() < 0.5 else "Team_B"
        player = random.choice(self.teams[team]["players"]["MID"] + self.teams[team]["players"].get(
            "FWD", []
        ))
        x = random.uniform(20, 105) if event_type == "shot" else random.uniform(0, 105)
        if event_type == "shot":
            x = clamp(random.uniform(80, 105), 0, 105)
            y = clamp(random.uniform(15, 53), 0, 68)
            success = random.random() < 0.3
            xg = random.uniform(0.01, 0.4)
            if success:
                self._score[team] += 1
        else:
            y = clamp(random.uniform(0, 68), 0, 68)
            success = random.random() < 0.8 if event_type == "pass" else random.random() < 0.5
            xg = 0.0
        return EventFrame(
            time=time_sec,
            minute=minute,
            playerId=player,
            team=team,
            eventType=event_type,
            x=x,
            y=y,
            success=success,
            momentum=self.momentum,
            xG=xg,
        )

    def tick(self, time_sec: int) -> Tuple[List[PositionFrame], List[PhysicalFrame], List[EventFrame]]:
        self._update_momentum(time_sec)
        positions = self._generate_positions(time_sec)
        physical = self._generate_physical(time_sec)
        events: List[EventFrame] = []
        while True:
            evt = self._generate_event(time_sec)
            if evt is None:
                break
            events.append(evt)
            if random.random() > 0.4:
                break
        return positions, physical, events


if __name__ == "__main__":
    generator = SimGenerator()
    for t in range(3):
        pos, phy, evts = generator.tick(t)
        print(f"tick={t} positions={len(pos)} physical={len(phy)} events={len(evts)}")
