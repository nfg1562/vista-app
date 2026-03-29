from __future__ import annotations

import logging
from typing import Callable, Dict, List, Optional, Sequence

import pandas as pd


RecoFn = Callable[..., pd.DataFrame]
logger = logging.getLogger("backend.reco")


def ensure_recos_up_to_date(
    match_id: str,
    current_minute: int,
    positions_df: pd.DataFrame,
    physical_df: pd.DataFrame,
    events_df: pd.DataFrame,
    stats_df: Optional[pd.DataFrame],
    repo,
    tactical_fn: RecoFn,
    pressing_fn: RecoFn,
    total_subs_done: int,
    sub_windows_used: int,
    replaced_players: Sequence[str],
    halftime_minute: int,
    end_second_half: int,
    team_pressing: str = "Team_A",
    clock_status: Optional[str] = None,
    log_fn: Optional[Callable[[dict], None]] = None,
) -> Dict[str, object]:
    end_first_half = int(halftime_minute)
    end_second_half = int(end_second_half)
    current_minute = int(current_minute)
    last_minute = repo.get_last_computed_minute(match_id)
    phase = _match_phase(
        current_minute,
        end_first_half=end_first_half,
        end_second_half=end_second_half,
        clock_status=clock_status,
    )
    target_max = _target_max_minute(
        phase,
        current_minute,
        end_first_half=end_first_half,
        end_second_half=end_second_half,
    )
    data_max = _max_minute(positions_df, events_df, physical_df)
    if data_max >= 0:
        target_max = min(target_max, data_max)
    target_max = min(target_max, end_second_half)
    if target_max <= last_minute:
        result = {
            "match_id": match_id,
            "current_minute": current_minute,
            "last_computed_minute": last_minute,
            "phase": phase,
            "target_max_minute": target_max,
            "stored": {},
            "written_recos": 0,
        }
        if log_fn:
            log_fn(result)
        return result

    positions_df = _slice_df(positions_df, target_max)
    physical_df = _slice_df(physical_df, target_max)
    events_df = _slice_df(events_df, target_max)
    stats_df = stats_df if stats_df is not None else pd.DataFrame()

    tactical_df = tactical_fn(
        positions_df,
        physical_df,
        events_df,
        stats_df,
        total_subs_done=total_subs_done,
        sub_windows_used=sub_windows_used,
        replaced_players=list(replaced_players),
        is_halftime=False,
    )
    tactical_by_minute = _group_by_minute(tactical_df)
    halftime_rows: List[dict] = []
    if end_first_half >= 0 and last_minute < end_first_half <= target_max:
        halftime_df = tactical_fn(
            positions_df,
            physical_df,
            events_df,
            stats_df,
            total_subs_done=total_subs_done,
            sub_windows_used=sub_windows_used,
            replaced_players=list(replaced_players),
            is_halftime=True,
        )
        halftime_rows = _group_by_minute(halftime_df).get(end_first_half, [])

    stored_counts: Dict[int, int] = {}
    for minute in range(last_minute + 1, target_max + 1):
        tactical_rows = tactical_by_minute.get(minute, [])
        if minute == end_first_half and halftime_rows:
            tactical_rows = halftime_rows
        pressing_rows = _rows_from_df(
            pressing_fn(
                positions_df,
                events_df,
                stats_df,
                team=team_pressing,
                opponent="Team_B" if team_pressing == "Team_A" else "Team_A",
                current_minute=minute,
            )
        )
        combined = tactical_rows + pressing_rows
        repo.upsert_minute(match_id, minute, combined)
        stored_counts[minute] = len(combined)

    written_recos = sum(stored_counts.values())
    logger.info(
        "reco/compute match_id=%s current_minute=%s phase=%s last_computed=%s target_max=%s written_minutes=%s written_recos=%s",
        match_id,
        current_minute,
        phase,
        last_minute,
        target_max,
        len(stored_counts),
        written_recos,
    )
    result = {
        "match_id": match_id,
        "current_minute": current_minute,
        "last_computed_minute": target_max,
        "phase": phase,
        "target_max_minute": target_max,
        "stored": stored_counts,
        "written_recos": written_recos,
    }
    if log_fn:
        log_fn(result)
    return result


def _match_phase(
    minute: int,
    end_first_half: int,
    end_second_half: int,
    clock_status: Optional[str] = None,
) -> str:
    if minute < 0:
        return "PRE_MATCH"
    if minute < end_first_half:
        return "FIRST_HALF"
    if minute == end_first_half:
        return "HALF_TIME"
    if minute < end_second_half:
        return "SECOND_HALF"
    if clock_status == "ended":
        return "FINISHED"
    return "FULL_TIME"


def _target_max_minute(
    phase: str,
    current_minute: int,
    end_first_half: int,
    end_second_half: int,
) -> int:
    if phase == "PRE_MATCH":
        return -1
    if phase == "HALF_TIME":
        return end_first_half
    if phase in ("FULL_TIME", "FINISHED"):
        return end_second_half
    if phase == "FIRST_HALF":
        return min(current_minute, end_first_half)
    return min(current_minute, end_second_half)


def _slice_df(df: pd.DataFrame, max_minute: int) -> pd.DataFrame:
    if df is None or df.empty or "minute" not in df.columns:
        return df if df is not None else pd.DataFrame()
    return df[df["minute"] <= max_minute]


def _group_by_minute(df: pd.DataFrame) -> Dict[int, List[dict]]:
    grouped: Dict[int, List[dict]] = {}
    if df is None or df.empty or "minute" not in df.columns:
        return grouped
    for _, row in df.iterrows():
        minute = int(row.get("minute", 0))
        grouped.setdefault(minute, []).append(_row_from_series(row))
    return grouped


def _row_from_series(row: pd.Series) -> dict:
    record = row.to_dict()
    if "type" not in record:
        record["type"] = "Analyse"
    if "recommendation" not in record:
        record["recommendation"] = ""
    return record


def _rows_from_df(df: pd.DataFrame) -> List[dict]:
    if df is None or df.empty:
        return []
    rows = []
    for _, row in df.iterrows():
        rows.append(_row_from_series(row))
    return rows


def _max_minute(*dfs: pd.DataFrame) -> int:
    max_minute = None
    for df in dfs:
        if df is None or df.empty or "minute" not in df.columns:
            continue
        max_val = int(df["minute"].max())
        if max_minute is None or max_val > max_minute:
            max_minute = max_val
    return max_minute if max_minute is not None else -1
