from __future__ import annotations

from typing import Dict, List, Tuple

import numpy as np
import pandas as pd

from .pass_xt import build_pass_analysis

XT_GRID = np.array(
    [
        [0.000, 0.000, 0.001, 0.002, 0.003, 0.005, 0.007, 0.010, 0.014, 0.019, 0.028, 0.045],
        [0.000, 0.001, 0.002, 0.003, 0.004, 0.006, 0.009, 0.012, 0.017, 0.024, 0.035, 0.054],
        [0.001, 0.002, 0.003, 0.004, 0.006, 0.008, 0.011, 0.015, 0.021, 0.030, 0.044, 0.065],
        [0.002, 0.003, 0.004, 0.006, 0.009, 0.012, 0.016, 0.022, 0.030, 0.043, 0.062, 0.090],
        [0.002, 0.003, 0.005, 0.007, 0.010, 0.014, 0.020, 0.028, 0.040, 0.058, 0.083, 0.120],
        [0.002, 0.003, 0.005, 0.008, 0.012, 0.018, 0.026, 0.037, 0.053, 0.077, 0.110, 0.160],
        [0.001, 0.002, 0.004, 0.006, 0.010, 0.016, 0.024, 0.034, 0.049, 0.071, 0.102, 0.145],
        [0.000, 0.001, 0.002, 0.004, 0.007, 0.012, 0.018, 0.026, 0.038, 0.055, 0.080, 0.120],
    ]
)


def summarize_xg_xt(events_df: pd.DataFrame, positions_df: pd.DataFrame, selected_minute: int):
    if events_df is None or events_df.empty:
        return pd.DataFrame(), pd.DataFrame(), pd.DataFrame()
    shots = events_df[
        (events_df["event_type"] == "shot") & (events_df["minute"] <= selected_minute)
    ].copy()
    if "xG" not in shots.columns:
        shots["xG"] = 0.0
    shots["xG"] = shots["xG"].fillna(0.0).astype(float)

    passes = build_pass_analysis(events_df, positions_df, selected_minute, window=selected_minute + 1)
    if not passes.empty:
        passes = passes[passes["minute"] <= selected_minute]

    teams = sorted(events_df["team"].dropna().unique().tolist())
    summary_rows = []
    for team in teams:
        team_shots = shots[shots["team"] == team]
        team_pass = passes[passes["team"] == team] if not passes.empty else pd.DataFrame()
        xg_total = float(team_shots["xG"].sum()) if not team_shots.empty else 0.0
        xt_gain = float(team_pass["xT_gain"].clip(lower=0).sum()) if not team_pass.empty else 0.0
        line_breaks = 0
        progressive = 0
        if not team_pass.empty:
            line_breaks = int((team_pass["breaks_def_line"] | team_pass["breaks_mid_line"]).sum())
            progressive = int(team_pass["is_progressive"].sum())
        summary_rows.append({
            "team": team,
            "xG": xg_total,
            "xT_gain": xt_gain,
            "shots": int(team_shots.shape[0]),
            "line_breaks": line_breaks,
            "progressive_passes": progressive,
        })
    summary_df = pd.DataFrame(summary_rows)

    top_xg = pd.DataFrame()
    if not shots.empty:
        top_xg = (
            shots.groupby("player_id")["xG"]
            .sum()
            .sort_values(ascending=False)
            .head(5)
            .reset_index()
            .rename(columns={"player_id": "player", "xG": "xG_total"})
        )

    top_xt = pd.DataFrame()
    if not passes.empty:
        top_xt = (
            passes.groupby("player_id")["xT_gain"]
            .sum()
            .sort_values(ascending=False)
            .head(5)
            .reset_index()
            .rename(columns={"player_id": "player", "xT_gain": "xT_gain"})
        )

    return summary_df, top_xg, top_xt


def compute_xt_timeline_series(
    events_df: pd.DataFrame,
    positions_df: pd.DataFrame,
    selected_minute: int,
) -> Dict[str, List[Tuple[int, float]]]:
    passes = build_pass_analysis(events_df, positions_df, selected_minute, window=selected_minute + 1)
    if passes.empty:
        return {}
    passes["minute"] = passes["minute"].astype(int)
    minutes = sorted(passes["minute"].unique())
    result: Dict[str, List[Tuple[int, float]]] = {}
    for team in passes["team"].unique():
        team_passes = passes[passes["team"] == team]
        team_sums = team_passes.groupby("minute")["xT_gain"].sum().clip(lower=0)
        all_minutes = list(range(min(minutes), max(minutes) + 1))
        rolled = team_sums.reindex(all_minutes, fill_value=0).rolling(window=5, min_periods=1).sum()
        result[team] = [(m, float(rolled.loc[m])) for m in all_minutes]
    return result


def compute_xt_heatmap_matrix(
    passes_df: pd.DataFrame, grid_shape: Tuple[int, int] = XT_GRID.shape
) -> np.ndarray:
    heat = np.zeros(grid_shape, dtype=float)
    if passes_df is None or passes_df.empty:
        return heat
    for _, row in passes_df.iterrows():
        if not row.get("success", True):
            continue
        gain = float(row.get("xT_gain", 0.0))
        if gain <= 0:
            continue
        x = min(max(float(row.get("end_x", 0.0)), 0.0), 105 - 1e-6)
        y = min(max(float(row.get("end_y", 0.0)), 0.0), 68 - 1e-6)
        x_bin = int(x / (105 / grid_shape[1]))
        y_bin = int(y / (68 / grid_shape[0]))
        x_bin = min(max(x_bin, 0), grid_shape[1] - 1)
        y_bin = min(max(y_bin, 0), grid_shape[0] - 1)
        heat[y_bin, x_bin] += gain
    return heat
import numpy as np
from typing import Dict, List, Tuple
