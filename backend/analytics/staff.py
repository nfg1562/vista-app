from __future__ import annotations

from typing import Dict

import pandas as pd


def compute_team_shape(snapshot_df: pd.DataFrame):
    if snapshot_df.empty:
        return None
    x_vals = snapshot_df["x"]
    y_vals = snapshot_df["y"]
    length = float(x_vals.max() - x_vals.min())
    width = float(y_vals.max() - y_vals.min())
    compactness = (length / width) if width > 0 else 0.0
    lines = {}
    for role in ["DEF", "MID", "FWD"]:
        line_x = snapshot_df[snapshot_df["role"] == role]["x"].mean()
        if pd.isna(line_x):
            line_x = snapshot_df["x"].mean()
        lines[role] = float(line_x)
    line_gaps = {
        "def_mid": abs(lines["MID"] - lines["DEF"]),
        "mid_fwd": abs(lines["FWD"] - lines["MID"]),
    }
    return {
        "length": length,
        "width": width,
        "compactness": compactness,
        "lines": lines,
        "line_gaps": line_gaps,
        "avg_x": float(snapshot_df["x"].mean()),
    }


def compute_channel_counts(snapshot_df: pd.DataFrame) -> Dict[str, int]:
    if snapshot_df.empty:
        return {"gauche": 0, "axe": 0, "droite": 0}
    left = snapshot_df[snapshot_df["y"] < 68 / 3]
    mid = snapshot_df[(snapshot_df["y"] >= 68 / 3) & (snapshot_df["y"] < 2 * 68 / 3)]
    right = snapshot_df[snapshot_df["y"] >= 2 * 68 / 3]
    return {"gauche": len(left), "axe": len(mid), "droite": len(right)}
