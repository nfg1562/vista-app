from __future__ import annotations

from collections import defaultdict
from typing import Dict, List

import numpy as np
import pandas as pd
from scipy.ndimage import gaussian_filter1d


def compute_fatigue_trend_series(
    physical_df: pd.DataFrame,
    player_id: str,
    minute: int,
    window: int = 10,
) -> Dict[str, List[float]]:
    start_min = max(0, minute - window + 1)
    df_player = physical_df[
        (physical_df["player_id"] == player_id)
        & (physical_df["minute"].between(start_min, minute))
    ].sort_values("minute")
    if df_player.empty:
        return {"minutes": [], "fatigue_raw": [], "fatigue_smooth": [], "risk_threshold": 0.85}
    minutes = df_player["minute"].astype(int).tolist()
    fatigue_vals = df_player["fatigue"].values
    smooth = (
        gaussian_filter1d(fatigue_vals, sigma=1).tolist()
        if len(fatigue_vals) > 3
        else fatigue_vals.tolist()
    )
    return {
        "minutes": minutes,
        "fatigue_raw": fatigue_vals.tolist(),
        "fatigue_smooth": smooth,
        "risk_threshold": 0.85,
    }


def compute_player_heatmap_matrix(
    positions_df: pd.DataFrame, minute: int, player_id: str, grid_x: int = 50, grid_y: int = 34
) -> Dict[str, np.ndarray]:
    if positions_df is None or positions_df.empty:
        x_edges = np.linspace(0, 105, grid_x + 1)
        y_edges = np.linspace(0, 68, grid_y + 1)
        return {"heatmap": np.zeros((grid_y, grid_x)), "x_edges": x_edges, "y_edges": y_edges}
    start_min = max(0, minute - 5)
    window_df = positions_df[
        (positions_df["player_id"] == player_id)
        & (positions_df["minute"].between(start_min, minute))
    ]
    x_bins = np.linspace(0, 105, grid_x + 1)
    y_bins = np.linspace(0, 68, grid_y + 1)
    heatmap_data, y_edges, x_edges = np.histogram2d(
        window_df["y"].values, window_df["x"].values, bins=[y_bins, x_bins]
    )
    return {"heatmap": heatmap_data, "x_edges": x_edges, "y_edges": y_edges}


def compute_fatigue_table(physical_df: pd.DataFrame) -> List[Dict[str, float]]:
    if physical_df is None or physical_df.empty:
        return []
    avg = (
        physical_df.groupby("player_id")["fatigue"]
        .mean()
        .reset_index()
        .rename(columns={"fatigue": "avg_fatigue"})
    )
    table = []
    for _, row in avg.iterrows():
        fatigue_mean = float(row["avg_fatigue"])
        if fatigue_mean < 0.3:
            niveau = "Bas"
        elif fatigue_mean < 0.6:
            niveau = "Modéré"
        else:
            niveau = "Élevé"
        table.append({"player_id": row["player_id"], "fatigue": fatigue_mean, "niveau": niveau})
    return table
