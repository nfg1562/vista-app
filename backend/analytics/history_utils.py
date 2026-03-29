from __future__ import annotations

from typing import Dict, List, Tuple

import pandas as pd

from backend.analytics.pass_xt import build_pass_analysis


def safe_concat(hist_df: pd.DataFrame, new_rows: pd.DataFrame, cols: List[str]) -> pd.DataFrame:
    if new_rows is None or new_rows.empty:
        return hist_df
    new_rows = new_rows.dropna(how="all").reindex(columns=cols)
    if hist_df is None or hist_df.empty:
        return new_rows.reset_index(drop=True)
    return pd.concat([hist_df, new_rows], ignore_index=True)


def coerce_hist_dtypes(hist_df: pd.DataFrame, dtype_map: dict) -> pd.DataFrame:
    if hist_df is None or hist_df.empty:
        return hist_df
    return hist_df.astype(dtype_map, errors="ignore")


def dedup_histories(
    hist_pos: pd.DataFrame, hist_phy: pd.DataFrame, hist_evt: pd.DataFrame
) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    if hist_pos is not None and not hist_pos.empty:
        hist_pos = hist_pos.drop_duplicates(
            subset=["time", "player_id", "team", "x", "y"], ignore_index=True
        )
    if hist_phy is not None and not hist_phy.empty:
        hist_phy = hist_phy.drop_duplicates(
            subset=["time", "player_id", "team"], ignore_index=True
        )
    if hist_evt is not None and not hist_evt.empty:
        hist_evt = hist_evt.drop_duplicates(
            subset=["time", "player_id", "team", "event_type", "x", "y"],
            ignore_index=True,
        )
    return hist_pos, hist_phy, hist_evt


def compute_live_and_stats(
    live_pos_list,
    live_phy_list,
    live_evt_list,
    hist_pos_df,
    hist_phy_df,
    hist_evt_df,
):
    positions_df = pd.DataFrame(live_pos_list) if live_pos_list else pd.DataFrame(
        columns=["time", "minute", "player_id", "team", "role", "x", "y"]
    )
    physical_df = pd.DataFrame(live_phy_list) if live_phy_list else pd.DataFrame(
        columns=["time", "minute", "player_id", "team", "speed", "fatigue"]
    )
    events_df = pd.DataFrame(live_evt_list) if live_evt_list else pd.DataFrame(
        columns=[
            "time",
            "minute",
            "player_id",
            "team",
            "event_type",
            "x",
            "y",
            "success",
            "momentum",
            "xG",
        ]
    )

    if hist_pos_df is None or hist_pos_df.empty:
        stats_df = pd.DataFrame(
            columns=[
                "minute",
                "possession_Team_A",
                "possession_Team_B",
                "shots_Team_A",
                "shots_Team_B",
            ]
        )
    else:
        hist_pos_df = hist_pos_df.astype({"minute": "int64"}, errors="ignore")
        hist_evt_df = hist_evt_df.astype({"minute": "int64"}, errors="ignore")
        minutes = sorted(hist_pos_df["minute"].unique())
        stats_list = []
        cum_shots = {"Team_A": 0, "Team_B": 0}
        cum_pos = {"Team_A": 0, "Team_B": 0}

        for m in minutes:
            pos_m = hist_pos_df[hist_pos_df["minute"] == m]
            evt_m = hist_evt_df[hist_evt_df["minute"] == m]

            passes = evt_m[(evt_m["event_type"] == "pass") & (evt_m["success"] == True)]
            for t in ["Team_A", "Team_B"]:
                cum_pos[t] += len(passes[passes["team"] == t])
            total_pos = cum_pos["Team_A"] + cum_pos["Team_B"]
            possA = cum_pos["Team_A"] / total_pos if total_pos > 0 else 0.5
            possB = cum_pos["Team_B"] / total_pos if total_pos > 0 else 0.5

            shots = evt_m[evt_m["event_type"] == "shot"]
            for t in ["Team_A", "Team_B"]:
                cum_shots[t] += len(shots[shots["team"] == t])

            stats_list.append(
                {
                    "minute": m,
                    "possession_Team_A": possA,
                    "possession_Team_B": possB,
                    "shots_Team_A": cum_shots["Team_A"],
                    "shots_Team_B": cum_shots["Team_B"],
                }
            )

        stats_df = pd.DataFrame(stats_list)

    return positions_df, events_df, physical_df, stats_df
