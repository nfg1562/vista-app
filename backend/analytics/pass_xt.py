from __future__ import annotations

import numpy as np
import pandas as pd

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


def _default_direction(team: str | None) -> int:
    return -1 if team == "Team_B" else 1


def _clamp_position(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(float(value), maximum))


def xt_value(x: float, y: float, team: str | None = None) -> float:
    if x is None or y is None:
        return 0.0
    try:
        x_val = float(x)
        y_val = float(y)
    except (TypeError, ValueError):
        return 0.0
    if team == "Team_B":
        x_val = 105 - x_val
    x_val = _clamp_position(x_val, 0.0, 105 - 1e-6)
    y_val = _clamp_position(y_val, 0.0, 68 - 1e-6)
    x_bin = int(x_val / (105 / XT_GRID.shape[1]))
    y_bin = int(y_val / (68 / XT_GRID.shape[0]))
    x_bin = min(max(x_bin, 0), XT_GRID.shape[1] - 1)
    y_bin = min(max(y_bin, 0), XT_GRID.shape[0] - 1)
    return float(XT_GRID[y_bin, x_bin])


def _default_direction(team: str) -> int:
    return -1 if team == "Team_B" else 1


def infer_team_directions(positions_df):
    if positions_df is None or positions_df.empty:
        return {}
    time_col = "time" if "time" in positions_df.columns else "minute"
    t0 = positions_df[time_col].min()
    snapshot = positions_df[positions_df[time_col] == t0]
    directions = {}
    for team in snapshot["team"].unique():
        mean_x = snapshot[snapshot["team"] == team]["x"].mean()
        directions[team] = 1 if mean_x < 52.5 else -1
    return directions


def _team_lines_at(positions_df: pd.DataFrame, time_val: int, minute_val: int, team: str):
    if positions_df is None or positions_df.empty:
        return None, None
    df = positions_df[positions_df["team"] == team]
    df_t = df[df["time"] == time_val] if "time" in df.columns else pd.DataFrame()
    if df_t.empty and "minute" in df.columns:
        df_t = df[df["minute"] == minute_val]
    if df_t.empty:
        return None, None
    def_x = df_t[df_t["role"] == "DEF"]["x"].mean()
    mid_x = df_t[df_t["role"] == "MID"]["x"].mean()
    fallback = df_t["x"].mean()
    if pd.isna(def_x):
        def_x = fallback
    if pd.isna(mid_x):
        mid_x = fallback
    return float(def_x), float(mid_x)


PASS_EVENT_TYPES = ("pass", "cross")


def infer_pass_endpoints(events_df: pd.DataFrame, max_time_gap: int = 3) -> pd.DataFrame:
    if events_df is None or events_df.empty:
        return pd.DataFrame()
    time_col = "time" if "time" in events_df.columns else "minute"
    df = (
        events_df.dropna(subset=["x", "y"])
        .sort_values(by=[time_col])
        .reset_index(drop=True)
    )
    passes = df[df["event_type"].isin(PASS_EVENT_TYPES)].copy()
    if passes.empty:
        return passes
    end_x, end_y, end_time, end_type = [], [], [], []
    for _, row in passes.iterrows():
        t = row[time_col]
        team = row["team"]
        future = df[
            (df["team"] == team)
            & (df[time_col] > t)
            & (df[time_col] <= t + max_time_gap)
        ]
        if not future.empty:
            nxt = future.iloc[0]
            end_x.append(float(nxt["x"]))
            end_y.append(float(nxt["y"]))
            end_time.append(int(nxt[time_col]))
            end_type.append(nxt["event_type"])
        else:
            end_x.append(float(row["x"]))
            end_y.append(float(row["y"]))
            end_time.append(int(t))
            end_type.append(None)
    passes["end_x"] = end_x
    passes["end_y"] = end_y
    passes["end_time"] = end_time
    passes["end_event_type"] = end_type
    return passes


def build_pass_analysis(
    events_df: pd.DataFrame,
    positions_df: pd.DataFrame,
    selected_minute: int,
    window: int = 5,
    team: str | None = None,
) -> pd.DataFrame:
    if events_df is None or events_df.empty:
        return pd.DataFrame()
    passes = infer_pass_endpoints(events_df)
    if passes.empty:
        return passes
    minute_col = "minute" if "minute" in passes.columns else None
    if minute_col:
        passes = passes[
            passes[minute_col].between(max(0, selected_minute - window + 1), selected_minute)
        ]
    if team:
        passes = passes[passes["team"] == team]
    if passes.empty:
        return passes

    directions = infer_team_directions(positions_df)
    teams_unique = passes["team"].unique().tolist()
    opponents = {t: [x for x in teams_unique if x != t][0] if len(teams_unique) > 1 else None for t in teams_unique}
    line_breaks = []
    mid_breaks = []
    prog_flags = []
    xt_gains = []

    for _, row in passes.iterrows():
        t = int(row.get("time", row.get("minute", 0)))
        minute = int(row.get("minute", t // 60))
        team_name = row["team"]
        opponent = opponents.get(team_name)
        direction = directions.get(team_name, _default_direction(team_name))
        start_x, start_y = float(row["x"]), float(row["y"])
        end_x, end_y = float(row["end_x"]), float(row["end_y"])
        progress = direction * (end_x - start_x)
        prog_flags.append(progress >= 8.0)
        if opponent:
            def_x, mid_x = _team_lines_at(positions_df, t, minute, opponent)
        else:
            def_x, mid_x = None, None
        if def_x is None or mid_x is None:
            line_breaks.append(False)
            mid_breaks.append(False)
        else:
            if direction == 1:
                line_breaks.append(start_x < def_x <= end_x)
                mid_breaks.append(start_x < mid_x <= end_x)
            else:
                line_breaks.append(start_x > def_x >= end_x)
                mid_breaks.append(start_x > mid_x >= end_x)
        xt_start = xt_value(start_x, start_y, team_name)
        xt_end = xt_value(end_x, end_y, team_name)
        xt_gain = xt_end - xt_start
        if "success" in row and not bool(row["success"]):
            xt_gain = 0.0
        xt_gains.append(xt_gain)
    passes = passes.copy()
    passes["is_progressive"] = prog_flags
    passes["breaks_def_line"] = line_breaks
    passes["breaks_mid_line"] = mid_breaks
    passes["xT_gain"] = xt_gains
    passes["progress"] = (passes["end_x"] - passes["x"]) * passes["team"].map(
        lambda t: directions.get(t, _default_direction(t))
    )
    return passes


def filter_entry_passes(pass_df: pd.DataFrame, team: str) -> pd.DataFrame:
    if pass_df is None or pass_df.empty:
        return pd.DataFrame()
    if team == "Team_A":
        return pass_df[pass_df["end_x"] >= 70]
    if team == "Team_B":
        return pass_df[pass_df["end_x"] <= 35]
    return pd.DataFrame()
