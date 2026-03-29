from __future__ import annotations

from typing import Dict, Iterable

from .models import ScoreSnapshot


def compute_score(minute: int, events: Iterable[Dict]) -> ScoreSnapshot:
    shots = {"Team_A": 0, "Team_B": 0}
    goals = {"Team_A": 0, "Team_B": 0}
    xg_totals = {"Team_A": 0.0, "Team_B": 0.0}

    for evt in events:
        if evt.get("minute", 0) > minute:
            continue
        team = evt.get("team")
        if team not in shots:
            continue
        if evt.get("event_type") == "shot":
            shots[team] += 1
            xg_totals[team] += float(evt.get("xG", 0.0) or 0.0)
            if evt.get("success"):
                goals[team] += 1

    score_snapshot = {"Team_A": goals["Team_A"], "Team_B": goals["Team_B"]}
    shots_snapshot = {"Team_A": shots["Team_A"], "Team_B": shots["Team_B"]}
    return {"score": score_snapshot, "shots": shots_snapshot, "xg_totals": xg_totals}
