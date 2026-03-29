from __future__ import annotations

import pandas as pd


def compute_team_shape(snapshot_df: pd.DataFrame):
    if snapshot_df is None or snapshot_df.empty:
        return None
    x_vals = snapshot_df["x"]
    y_vals = snapshot_df["y"]
    length = float(x_vals.max() - x_vals.min())
    width = float(y_vals.max() - y_vals.min())
    compactness = (length / width) if width > 0 else 0.0
    lines = {}
    for role in ["DEF", "MID", "FWD"]:
        values = snapshot_df[snapshot_df["role"] == role]["x"]
        line_x = values.mean()
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


def get_snapshot_positions(positions_df: pd.DataFrame, minute: int, team: str | None = None):
    if positions_df is None or positions_df.empty:
        return pd.DataFrame()
    df = positions_df[positions_df["minute"] == minute]
    if team:
        df = df[df["team"] == team]
    if df.empty:
        return df
    if "time" in df.columns:
        last_time = df["time"].max()
        df = df[df["time"] == last_time]
    return df


def simulate_team_positions(snapshot_df: pd.DataFrame, line_shift: float, width_scale: float, line_spacing: float):
    if snapshot_df is None or snapshot_df.empty:
        return pd.DataFrame()
    df = snapshot_df.copy()
    center_x = df["x"].mean()
    center_y = df["y"].mean()
    df["x"] = center_x + (df["x"] - center_x) * line_spacing + line_shift
    df["y"] = center_y + (df["y"] - center_y) * width_scale
    df["x"] = df["x"].clip(0, 105)
    df["y"] = df["y"].clip(0, 68)
    return df
