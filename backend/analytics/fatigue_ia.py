from __future__ import annotations

import pandas as pd


def calculate_injury_risk(
    physical_df: pd.DataFrame, player_id: str, minute: int, window: int = 5
):
    if physical_df is None or physical_df.empty:
        return None, False
    df_player = physical_df[
        (physical_df["player_id"] == player_id)
        & (physical_df["minute"].between(max(0, minute - window + 1), minute))
    ]
    if df_player.empty:
        return None, False
    fatigue_mean = df_player["fatigue"].mean()
    return fatigue_mean, fatigue_mean > 0.85


def extract_features_minute(
    positions_df: pd.DataFrame,
    physical_df: pd.DataFrame,
    events_df: pd.DataFrame,
    stats_df: pd.DataFrame,
    minute: int,
):
    pos_m = positions_df[positions_df["minute"] == minute]
    phys_m = physical_df[physical_df["minute"] == minute]
    evt_m = events_df[events_df["minute"] == minute]
    shots = len(evt_m[evt_m["event_type"] == "shot"])
    fouls = len(evt_m[evt_m["event_type"] == "foul"])
    passes = evt_m[evt_m["event_type"] == "pass"]
    bad_pass = passes[~passes["success"]] if not passes.empty else pd.DataFrame()
    xg_vals = evt_m[evt_m["event_type"] == "shot"].copy()
    if "xG" not in xg_vals.columns:
        xg_vals["xG"] = 0.0
    xg_sum = float(xg_vals["xG"].fillna(0.0).sum())
    fatigue_mean = phys_m["fatigue"].mean() if not phys_m.empty else 0.0
    pass_quality = (
        1.0 - (len(bad_pass) / max(1, len(passes))) if not passes.empty else 0.5
    )
    return [xg_sum, shots, pass_quality, fatigue_mean, fouls]


def predict_score_evolution(features):
    xg_sum, shots, pass_quality, fatigue, fouls = features
    prob = 0.15
    prob += 0.6 * min(xg_sum, 1.0)
    prob += 0.12 * min(shots, 4) / 4
    prob += 0.1 * pass_quality
    prob -= 0.15 * min(fouls, 4) / 4
    prob -= 0.2 * fatigue
    return max(0, min(1, prob))


def run_ia_score_prediction(
    positions_df: pd.DataFrame,
    physical_df: pd.DataFrame,
    events_df: pd.DataFrame,
    stats_df: pd.DataFrame,
):
    if positions_df is None or positions_df.empty:
        return pd.DataFrame(columns=["minute", "score_prob", "recommendation"])
    unique_minutes = sorted(positions_df["minute"].unique())
    recos = []
    for minute in unique_minutes:
        features = extract_features_minute(
            positions_df, physical_df, events_df, stats_df, minute
        )
        score_prob = predict_score_evolution(features)
        if score_prob > 0.6:
            txt = f"Minute {minute} : Forte probabilite de marquer ({int(score_prob*100)} %)"
        elif score_prob < 0.3:
            txt = f"Minute {minute} : Faible probabilite de marquer ({int(score_prob*100)} %)"
        else:
            txt = f"Minute {minute} : Probabilite moyenne ({int(score_prob*100)} %)"
        recos.append({"minute": minute, "score_prob": score_prob, "recommendation": txt})
    return pd.DataFrame(recos)
