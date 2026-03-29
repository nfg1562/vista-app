from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

from .ia import run_ia_score_prediction
from .shots import compute_xg_timeline_series
from .recommendations import (
    generate_tactical_recommendations,
    suggest_pressing_adaptations_df,
)
from .staff import compute_channel_counts, compute_team_shape
from .utils import ensure_minute_column, frames_to_df
from .xg_xt import summarize_xg_xt, compute_xt_timeline_series
from .pass_xt import build_pass_analysis, filter_entry_passes


def _timeline_dict_to_rows(series: Dict[str, List[Tuple[int, float]]]) -> List[Dict[str, float]]:
    if not series:
        return []
    minute_map: Dict[int, Dict[str, float]] = {}
    for team, points in series.items():
        for minute, value in points:
            minute_map.setdefault(int(minute), {})[team] = float(value)
    rows = []
    for minute in sorted(minute_map.keys()):
        row = {"minute": minute}
        row.update(minute_map[minute])
        rows.append(row)
    return rows


def _compute_summary(events_df: pd.DataFrame) -> Dict[str, Any]:
    score = {"Team_A": 0, "Team_B": 0}
    shots = {"Team_A": 0, "Team_B": 0}
    passes_success = {"Team_A": 0, "Team_B": 0}
    for _, row in events_df.iterrows():
        team = row.get("team")
        evt = row.get("event_type")
        if evt == "shot":
            shots[team] += 1
            if row.get("success"):
                score[team] += 1
        if evt == "pass" and row.get("success"):
            passes_success[team] += 1
    total_passes = passes_success["Team_A"] + passes_success["Team_B"]
    possession = {
        "Team_A": passes_success["Team_A"] / total_passes if total_passes else 0.5,
        "Team_B": passes_success["Team_B"] / total_passes if total_passes else 0.5,
    }
    return {"score": score, "shots": shots, "possession": possession}


def _slice_snapshot(
    df: pd.DataFrame, minute: int, window: int = 1, time_col: str = "time"
) -> pd.DataFrame:
    if df.empty:
        return df
    return df[df["minute"].between(max(0, minute - window + 1), minute)]


def _fatigue_trend(physical_df: pd.DataFrame) -> List[Dict[str, Any]]:
    if physical_df.empty:
        return []
    result = (
        physical_df.groupby(["minute", "player_id"])["fatigue"]
        .mean()
        .reset_index()
        .sort_values(["player_id", "minute"])
    )
    return result.to_dict(orient="records")


def _build_stats_df(events_df: pd.DataFrame, minute: int) -> pd.DataFrame:
    if events_df.empty:
        return pd.DataFrame(
            [
                {
                    "minute": minute,
                    "possession_Team_A": 0.5,
                    "possession_Team_B": 0.5,
                    "shots_Team_A": 0,
                    "shots_Team_B": 0,
                }
            ]
        )

    hist = events_df[events_df["minute"] <= minute]
    passes_success = {"Team_A": 0, "Team_B": 0}
    shots = {"Team_A": 0, "Team_B": 0}
    for _, row in hist.iterrows():
        team = row.get("team")
        evt_type = row.get("event_type")
        if evt_type == "pass" and row.get("success"):
            passes_success[team] += 1
        if evt_type == "shot":
            shots[team] += 1
    total_passes = passes_success["Team_A"] + passes_success["Team_B"]
    possession_a = (
        passes_success["Team_A"] / total_passes if total_passes else 0.5
    )
    possession_b = (
        passes_success["Team_B"] / total_passes if total_passes else 0.5
    )
    return pd.DataFrame(
        [
            {
                "minute": minute,
                "possession_Team_A": round(possession_a, 3),
                "possession_Team_B": round(possession_b, 3),
                "shots_Team_A": shots["Team_A"],
                "shots_Team_B": shots["Team_B"],
            }
        ]
    )


logger = logging.getLogger("analytics.pipeline")


def build_analytics_snapshot(
    minute: int,
    positions: List[Any],
    events: List[Any],
    physical: List[Any],
) -> Dict[str, Any]:
    try:
        pos_df = frames_to_df(positions)
        evt_df = frames_to_df(events)
        phy_df = frames_to_df(physical)
        if "eventType" in evt_df.columns:
            evt_df = evt_df.rename(columns={"eventType": "event_type"})
        if "playerId" in pos_df.columns:
            pos_df = pos_df.rename(columns={"playerId": "player_id"})
        if "playerId" in phy_df.columns:
            phy_df = phy_df.rename(columns={"playerId": "player_id"})
        ensure_minute_column(pos_df)
        ensure_minute_column(evt_df)
        ensure_minute_column(phy_df)
        logger.debug(
            "build_snapshot minute=%s pos_cols=%s evt_cols=%s phy_cols=%s",
            minute,
            pos_df.columns.tolist(),
            evt_df.columns.tolist(),
            phy_df.columns.tolist(),
        )
        summary = _compute_summary(evt_df)
        stats_df = _build_stats_df(evt_df, minute)
        recs = generate_tactical_recommendations(
            pos_df,
            phy_df,
            evt_df,
            stats_df,
            total_subs_done=0,
            sub_windows_used=0,
            replaced_players=None,
        )
        pressing = suggest_pressing_adaptations_df(
            pos_df, evt_df, pd.DataFrame(), current_minute=minute
        )
        if "event_type" not in evt_df.columns:
            raise KeyError(f"evt_df missing event_type. cols={list(evt_df.columns)}")
        match_passes = build_pass_analysis(evt_df, pos_df, minute, window=5)
        entries = {
            "Team_A": filter_entry_passes(match_passes, "Team_A").to_dict(orient="records")
            if not match_passes.empty
            else [],
            "Team_B": filter_entry_passes(match_passes, "Team_B").to_dict(orient="records")
            if not match_passes.empty
            else [],
        }
        staff_shapes = {}
        channel_counts = {}
        for team in ["Team_A", "Team_B"]:
            snapshot = pos_df[pos_df["minute"] == minute]
            team_snapshot = snapshot[snapshot["team"] == team]
            shape = compute_team_shape(team_snapshot)
            staff_shapes[team] = shape
            channel_counts[team] = compute_channel_counts(team_snapshot)
        xg_summary, xg_top, xg_top_xt = summarize_xg_xt(evt_df, pos_df, minute)
        xg_timeline = _timeline_dict_to_rows(compute_xg_timeline_series(evt_df, minute))
        xt_timeline = _timeline_dict_to_rows(compute_xt_timeline_series(evt_df, pos_df, minute))
        ia_trace = run_ia_score_prediction(pos_df, phy_df, evt_df)
        fatigue_history = _fatigue_trend(phy_df)
        shots = (
            evt_df[evt_df["event_type"] == "shot"].to_dict(orient="records")
            if not evt_df.empty
            else []
        )
        return {
            "summary": summary,
            "recommendations": recs.to_dict(orient="records"),
            "pressing": pressing.to_dict(orient="records"),
            "entries": entries,
            "passes": match_passes.to_dict(orient="records") if not match_passes.empty else [],
            "staff": {
                "shapes": staff_shapes,
                "channels": channel_counts,
            },
            "xg_xt": {
                "summary": xg_summary.to_dict(orient="records"),
                "top_xg": xg_top.to_dict(orient="records"),
                "top_xt": xg_top_xt.to_dict(orient="records"),
                "xg_timeline": xg_timeline,
                "xt_timeline": xt_timeline,
            },
            "ia": ia_trace,
            "fatigue": fatigue_history,
            "shots": shots,
        }
    except Exception as exc:
        logger.exception("Failed to build analytics snapshot")
        raise
