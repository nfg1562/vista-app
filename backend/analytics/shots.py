from __future__ import annotations

import numpy as np
import pandas as pd


def compute_shot_overview_payload(events_df: pd.DataFrame, selected_minute: int):
    if events_df is None or events_df.empty:
        return None
    shots = events_df[
        (events_df["event_type"] == "shot") & (events_df["minute"] <= selected_minute)
    ].copy()
    if shots.empty:
        return None
    if "xG" not in shots.columns:
        shots["xG"] = 0.0
    shots["xG"] = shots["xG"].fillna(0.0).astype(float)
    shots["on_target"] = shots["success"].astype(bool)
    summary = {
        "minutes": list(range(0, selected_minute + 1)),
        "by_team": {},
    }
    for team in shots["team"].dropna().unique():
        team_shots = shots[shots["team"] == team]
        team_shots = team_shots.copy()
        team_shots["minute"] = team_shots["minute"].astype(int)
        timeline = team_shots.groupby(["minute", "on_target"]).size().unstack(fill_value=0)
        on_target = timeline.get(True, pd.Series(dtype=int)).reindex(summary["minutes"], fill_value=0).cumsum().tolist()
        off_target = timeline.get(False, pd.Series(dtype=int)).reindex(summary["minutes"], fill_value=0).cumsum().tolist()
        summary["by_team"][team] = {"on_target_cum": on_target, "off_target_cum": off_target}
    brief_shots = []
    for _, row in shots.iterrows():
        brief_shots.append(
            {
                "team": row["team"],
                "x": float(row["x"]) if not pd.isna(row["x"]) else 0.0,
                "y": float(row["y"]) if not pd.isna(row["y"]) else 0.0,
                "xG": float(row["xG"]),
                "on_target": bool(row["on_target"]),
            }
        )
    return {"shots": brief_shots, "summary_timeline": summary}


def compute_xg_timeline_series(events_df: pd.DataFrame, selected_minute: int):
    if events_df is None or events_df.empty:
        return {}
    shots = events_df[
        (events_df["event_type"] == "shot") & (events_df["minute"] <= selected_minute)
    ].copy()
    if shots.empty:
        return {}
    if "xG" not in shots.columns:
        shots["xG"] = 0.0
    shots["xG"] = shots["xG"].fillna(0.0).astype(float)
    shots["minute"] = shots["minute"].astype(int)
    result = {}
    minutes = list(range(0, selected_minute + 1))
    for team in shots["team"].dropna().unique():
        team_series = shots[shots["team"] == team].groupby("minute")["xG"].sum()
        rolled = (
            team_series.reindex(minutes, fill_value=0)
            .rolling(window=5, min_periods=1)
            .sum()
            .tolist()
        )
        result[team] = list(zip(minutes, rolled))
    return result
