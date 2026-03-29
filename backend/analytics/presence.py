from __future__ import annotations

from typing import Dict, Iterable, Optional

import pandas as pd

TACTIC_IMPACTS = {
    "4-4-2": {"bas": -0.05, "médian": 0.12, "haut": -0.07},
    "3-5-2": {"bas": -0.1, "médian": 0.2, "haut": -0.1},
    "4-3-3": {"bas": 0.05, "médian": -0.1, "haut": 0.05},
    "5-3-2": {"bas": 0.1, "médian": 0.05, "haut": -0.15},
    "3-4-3": {"bas": -0.08, "médian": 0.05, "haut": 0.1},
    "4-2-3-1": {"bas": 0.0, "médian": 0.15, "haut": -0.05},
    "4-1-4-1": {"bas": 0.05, "médian": 0.1, "haut": -0.1},
}


def zone_x(x: float) -> str:
    if x < 22.7:
        return "bas"
    if x < 45.3:
        return "médian"
    return "haut"


def presence_zones(positions: pd.DataFrame, team: str, minute: Optional[int] = None):
    if positions.empty:
        return {}
    df = positions[positions["team"] == team]
    if minute is not None:
        df = df[df["minute"] == minute]
    if df.empty:
        return {}
    df = df.copy()
    df["zone"] = df["x"].apply(zone_x)
    return df["zone"].value_counts(normalize=True).to_dict()


def simulate_tactic_impact(current_presence: Optional[Dict[str, float]], tactic_name: str):
    if tactic_name not in TACTIC_IMPACTS:
        return None
    if not current_presence:
        current_presence = {"bas": 1 / 3, "médian": 1 / 3, "haut": 1 / 3}
    impact = TACTIC_IMPACTS[tactic_name]
    simulated = {
        zone: max(0, current_presence.get(zone, 0) + impact.get(zone, 0))
        for zone in ["bas", "médian", "haut"]
    }
    total = sum(simulated.values()) or 1.0
    for zone in simulated:
        simulated[zone] /= total
    return simulated


def presence_payload_for_frontend(
    positions: pd.DataFrame,
    team: str,
    minute: Optional[int] = None,
    tactics: Optional[Iterable[str]] = None,
):
    current = presence_zones(positions, team, minute)
    tactic_list = list(tactics) if tactics else list(TACTIC_IMPACTS.keys())
    simulated = {
        tactic: simulate_tactic_impact(current if current else None, tactic)
        for tactic in tactic_list
    }
    return {"current": current, "simulated": simulated}
