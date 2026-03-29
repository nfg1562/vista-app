from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Tuple

import pandas as pd


def _record_from_frame(frame: Any) -> Dict[str, Any]:
    if hasattr(frame, "model_dump"):
        return frame.model_dump()
    if isinstance(frame, dict):
        return frame.copy()
    if isinstance(frame, pd.Series):
        return frame.to_dict()
    try:
        return dict(frame)
    except Exception:
        return {}


def _coerce_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes")
    return bool(value)


def _normalize_value(record: Dict[str, Any], key_aliases: Tuple[str, ...], target: str, default: Any):
    for alias in key_aliases:
        if alias in record:
            record[target] = record.pop(alias)
            return
    record.setdefault(target, default)


def _normalize_position(record: Dict[str, Any]) -> Dict[str, Any]:
    _normalize_value(record, ("time",), "time", 0)
    _normalize_value(record, ("minute",), "minute", record["time"] // 60 if "time" in record else 0)
    _normalize_value(record, ("playerId", "player_id"), "player_id", "unknown")
    _normalize_value(record, ("team", "teamId", "team_id", "side"), "team", "Team_A")
    _normalize_value(record, ("role",), "role", "MID")
    _normalize_value(record, ("x",), "x", 50.0)
    _normalize_value(record, ("y",), "y", 25.0)
    record["x"] = float(record["x"])
    record["y"] = float(record["y"])
    return record


def _normalize_physical(record: Dict[str, Any]) -> Dict[str, Any]:
    _normalize_value(record, ("time",), "time", 0)
    _normalize_value(record, ("minute",), "minute", record["time"] // 60 if "time" in record else 0)
    _normalize_value(record, ("playerId", "player_id"), "player_id", "unknown")
    _normalize_value(record, ("team", "teamId", "team_id", "side"), "team", "Team_A")
    _normalize_value(record, ("speed",), "speed", 0.0)
    _normalize_value(record, ("fatigue",), "fatigue", 0.0)
    record["speed"] = float(record["speed"])
    record["fatigue"] = float(record["fatigue"])
    return record


def _normalize_event(record: Dict[str, Any]) -> Dict[str, Any]:
    _normalize_value(record, ("time",), "time", 0)
    _normalize_value(record, ("minute",), "minute", record["time"] // 60 if "time" in record else 0)
    _normalize_value(record, ("playerId", "player_id"), "player_id", "unknown")
    _normalize_value(record, ("team", "teamId", "team_id", "side"), "team", "Team_A")
    _normalize_value(record, ("eventType", "type", "event_type"), "event_type", "pass")
    _normalize_value(record, ("x",), "x", 50.0)
    _normalize_value(record, ("y",), "y", 25.0)
    _normalize_value(record, ("success",), "success", False)
    _normalize_value(record, ("momentum",), "momentum", 0.5)
    _normalize_value(record, ("xG", "xg"), "xG", 0.0)
    record["x"] = float(record["x"])
    record["y"] = float(record["y"])
    record["momentum"] = float(record["momentum"])
    record["xG"] = float(record["xG"])
    record["success"] = _coerce_bool(record["success"])
    return record


def _ensure_columns(df: pd.DataFrame, columns: List[str], defaults: Dict[str, Any]) -> pd.DataFrame:
    for col in columns:
        if col not in df.columns:
            df[col] = defaults.get(col, None)
    return df[columns]


def normalize_frames_to_dfs(
    positions: Iterable[Any],
    physical: Iterable[Any],
    events: Iterable[Any],
    stats: Optional[Iterable[Any]] = None,
) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, Optional[pd.DataFrame]]:
    pos_records = [_normalize_position(_record_from_frame(frame)) for frame in positions]
    phy_records = [_normalize_physical(_record_from_frame(frame)) for frame in physical]
    evt_records = [_normalize_event(_record_from_frame(frame)) for frame in events]

    pos_df = pd.DataFrame(pos_records)
    phy_df = pd.DataFrame(phy_records)
    evt_df = pd.DataFrame(evt_records)

    pos_df = _ensure_columns(
        pos_df,
        ["time", "minute", "player_id", "team", "role", "x", "y"],
        {"time": 0, "minute": 0, "player_id": "unknown", "team": "Team_A", "role": "MID", "x": 50.0, "y": 25.0},
    )
    phy_df = _ensure_columns(
        phy_df,
        ["time", "minute", "player_id", "team", "speed", "fatigue"],
        {"time": 0, "minute": 0, "player_id": "unknown", "team": "Team_A", "speed": 0.0, "fatigue": 0.0},
    )
    evt_df = _ensure_columns(
        evt_df,
        ["time", "minute", "player_id", "team", "event_type", "x", "y", "success", "momentum", "xG"],
        {
            "time": 0,
            "minute": 0,
            "player_id": "unknown",
            "team": "Team_A",
            "event_type": "pass",
            "x": 50.0,
            "y": 25.0,
            "success": False,
            "momentum": 0.5,
            "xG": 0.0,
        },
    )

    stats_df = pd.DataFrame(stats) if stats is not None else None

    return pos_df, evt_df, phy_df, stats_df
