from __future__ import annotations

from typing import Dict, Optional

from backend.analytics.presence import zone_x

ZONES = ["bas", "médian", "haut"]
ZONE_Y_POS = {
    "bas": 68 * 1 / 6,
    "médian": 68 * 3 / 6,
    "haut": 68 * 5 / 6,
}


def compute_presence_comparison_bars(
    current_presence: Dict[str, float],
    simulated_presence: Dict[str, float],
    tactic_name: str,
    team: str,
    minute: int,
) -> Optional[Dict[str, object]]:
    if not current_presence:
        return None
    current = [current_presence.get(zone, 0.0) for zone in ZONES]
    simulated = [simulated_presence.get(zone, 0.0) for zone in ZONES]
    return {
        "zones": ZONES,
        "current": current,
        "simulated": simulated,
        "labels": {
            "title": f"Comparaison presences – {team}",
            "team": team,
            "minute": minute,
            "tactic": tactic_name,
        },
    }


def compute_presence_fieldmap_payload(
    current_presence: Dict[str, float],
    simulated_presence: Dict[str, float],
    tactic_name: str,
    team: str,
    minute: int,
) -> Optional[Dict[str, object]]:
    if not current_presence:
        return None

    def build_points(presence: Dict[str, float], prefix: str):
        points = []
        for zone in ZONES:
            ratio = presence.get(zone, 0.0)
            points.append(
                {
                    "zone": zone,
                    "x": 105 / 2,
                    "y": ZONE_Y_POS[zone],
                    "size": 6000 * ratio,
                    "ratio": ratio,
                    "label": f"{prefix} {zone}",
                }
            )
        return points

    return {
        "pitch": {"length": 105, "width": 68},
        "points_current": build_points(current_presence, "actuelle"),
        "points_simulated": build_points(simulated_presence, f"sim {tactic_name}"),
        "tactic": tactic_name,
        "team": team,
        "minute": minute,
    }
