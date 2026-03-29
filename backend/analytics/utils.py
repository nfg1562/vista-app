from __future__ import annotations

from typing import Iterable

import pandas as pd

from models import EventFrame, PhysicalFrame, PositionFrame


def frames_to_df(frames: Iterable):
    if isinstance(frames, pd.DataFrame):
        return frames.copy()
    records = []
    for frame in frames:
        if hasattr(frame, "model_dump"):
            record = frame.model_dump()
        elif isinstance(frame, dict):
            record = frame.copy()
        else:
            record = dict(frame)
        # normalize field names to snake_case expected by analytics
        if "playerId" in record:
            record["player_id"] = record.pop("playerId")
        if "eventType" in record:
            record["event_type"] = record.pop("eventType")
        if "xG" in record:
            record["xG"] = record["xG"]
        if "minute" not in record:
            record["minute"] = record.get("time", 0) // 60
        records.append(record)
    if not records:
        return pd.DataFrame()
    return pd.DataFrame(records)


def ensure_minute_column(df: pd.DataFrame, time_col="time"):
    if "minute" not in df.columns:
        if time_col in df.columns:
            df["minute"] = df[time_col] // 60
        else:
            df["minute"] = 0
    return df


def df_max_time(df: pd.DataFrame) -> int:
    if df is None or df.empty or "time" not in df.columns:
        return 0
    return int(df["time"].max())
