from __future__ import annotations

from collections import defaultdict
from typing import Dict, Iterable

from .models import PossessionSnapshot


def compute_possession(minute: int, events: Iterable[Dict]) -> PossessionSnapshot:
    pass_stats = defaultdict(lambda: {"attempts": 0, "success": 0})

    for evt in events:
        if evt.get("minute", 0) > minute:
            continue
        if evt.get("event_type") != "pass":
            continue
        team = evt.get("team", "Team_A")
        pass_stats[team]["attempts"] += 1
        if evt.get("success"):
            pass_stats[team]["success"] += 1

    possession = {}
    accuracy = {}
    total_success = sum(stat["success"] for stat in pass_stats.values())
    for team in ["Team_A", "Team_B"]:
        stat = pass_stats.get(team, {"attempts": 0, "success": 0})
        success = stat["success"]
        attempts = stat["attempts"]
        accuracy[team] = success / attempts if attempts else 0.0

    if total_success > 0:
        possession["Team_A"] = pass_stats.get("Team_A", {"success": 0})["success"] / total_success
    else:
        possession["Team_A"] = 0.5
    possession["Team_B"] = 1.0 - possession["Team_A"]

    return {"possession": possession, "pass_accuracy": accuracy}
