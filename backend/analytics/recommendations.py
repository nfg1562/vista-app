from __future__ import annotations

from typing import Dict, List, Optional

import pandas as pd


def _normalize_recommendation_text(text: str) -> str:
    normalized = " ".join(str(text or "").lower().replace("priorite :", "").split())
    return normalized.strip()


def _is_low_signal_recommendation(text: str) -> bool:
    normalized = _normalize_recommendation_text(text)
    if not normalized:
        return True
    if "aucun point faible detecte" in normalized:
        return True
    if normalized == "ajustements individuels":
        return True
    if normalized.startswith("pressing equilibre") and "0 recup" in normalized and "0 pertes" in normalized:
        return True
    return False


def _minute_window(df: pd.DataFrame, minute: int, span: int = 5) -> pd.DataFrame:
    if df is None or df.empty or "minute" not in df.columns:
        return df if df is not None else pd.DataFrame()
    end = int(minute)
    start = max(0, end - max(1, span) + 1)
    return df[df["minute"].between(start, end)]


def _safe_mean(series: pd.Series) -> float:
    if series is None or series.empty:
        return 0.0
    return float(series.fillna(0.0).mean())


def _phase_guidance(minute: int) -> str:
    if minute <= 10:
        return "Debut de match : securiser les transitions defensives et fermer l'axe rapidement"
    if minute < 45:
        return "Phase d'installation : stabiliser la possession puis attaquer le cote faible"
    if minute < 70:
        return "Temps fort a exploiter : maintenir la pression dans le dernier tiers"
    if minute < 90:
        return "Match plus ouvert : equilibrer la perte puis accelerer vers l'avant"
    return "Fin de match : valoriser chaque transition et proteger la zone de finition"


def _score_until_minute(events: pd.DataFrame, minute: int) -> Dict[str, int]:
    score = {"Team_A": 0, "Team_B": 0}
    if events is None or events.empty:
        return score
    hist = events[events["minute"] <= int(minute)]
    goals = hist[(hist["event_type"] == "shot") & (hist["success"])]
    for team, count in goals.groupby("team").size().items():
        if team in score:
            score[team] = int(count)
    return score


def _lane_label(y_value: float, team: Optional[str] = None) -> str:
    if y_value < 22.7:
        lane = "gauche"
    elif y_value < 45.3:
        lane = "axe"
    else:
        lane = "droite"
    if team == "Team_B":
        if lane == "gauche":
            return "droite"
        if lane == "droite":
            return "gauche"
    return lane


def _lane_phrase(label: str) -> str:
    if label == "gauche":
        return "couloir gauche"
    if label == "droite":
        return "couloir droit"
    return "axe"


def _lane_counts(events: pd.DataFrame) -> Dict[str, int]:
    counts = {"gauche": 0, "axe": 0, "droite": 0}
    if events is None or events.empty or "y" not in events.columns:
        return counts
    for _, row in events.iterrows():
        try:
            y_value = float(row.get("y", 0.0) or 0.0)
        except (TypeError, ValueError):
            y_value = 0.0
        counts[_lane_label(y_value, str(row.get("team", "")))] += 1
    return counts


def _lane_xg(shots: pd.DataFrame) -> Dict[str, float]:
    totals = {"gauche": 0.0, "axe": 0.0, "droite": 0.0}
    if shots is None or shots.empty or "y" not in shots.columns:
        return totals
    for _, row in shots.iterrows():
        try:
            y_value = float(row.get("y", 0.0) or 0.0)
        except (TypeError, ValueError):
            y_value = 0.0
        xg_value = float(row.get("xG", 0.0) or 0.0)
        totals[_lane_label(y_value, str(row.get("team", "")))] += xg_value
    return totals


def _dominant_key(values: Dict[str, float | int]) -> str:
    return max(values.items(), key=lambda item: item[1])[0]


def _pass_success_rate(events: pd.DataFrame) -> float:
    if events is None or events.empty:
        return 0.0
    passes = events[events["event_type"].isin(["pass", "cross"])]
    if passes.empty:
        return 0.0
    return float(passes["success"].astype(bool).mean())


def _territory_average(positions: pd.DataFrame, team: str) -> float:
    if positions is None or positions.empty:
        return 0.0
    team_positions = positions[positions["team"] == team]
    if team_positions.empty or "x" not in team_positions.columns:
        return 0.0
    return _safe_mean(team_positions["x"])


def detect_opponent_weaknesses(
    events: pd.DataFrame,
    physical: pd.DataFrame,
    positions: pd.DataFrame,
    team="Team_B",
    minute=None,
) -> List[str]:
    weaknesses: List[str] = []
    if minute is not None:
        events = _minute_window(events, int(minute), span=6)
        physical = _minute_window(physical, int(minute), span=6)
        positions = _minute_window(positions, int(minute), span=6)

    team_events = events[events["team"] == team] if not events.empty else pd.DataFrame()
    team_physical = physical[physical["team"] == team] if not physical.empty else pd.DataFrame()
    team_positions = positions[positions["team"] == team] if not positions.empty else pd.DataFrame()

    if not team_events.empty:
        failed_passes = team_events[
            (team_events["event_type"] == "pass") & (~team_events["success"])
        ]
        if len(failed_passes) >= 3:
            weaknesses.append(f"Relance adverse fragile ({len(failed_passes)} passes ratees)")
        failed_duels = team_events[
            (team_events["event_type"] == "duel") & (~team_events["success"])
        ]
        if len(failed_duels) >= 2:
            weaknesses.append(f"Duels adverses perdus ({len(failed_duels)})")

    if not team_physical.empty:
        fatigue_avg = _safe_mean(team_physical["fatigue"])
        speed_avg = _safe_mean(team_physical["speed"])
        if fatigue_avg >= 0.72:
            weaknesses.append(f"Fatigue adverse elevee ({fatigue_avg:.2f})")
        if speed_avg <= 4.9:
            weaknesses.append(f"Intensite adverse en baisse (vitesse {speed_avg:.1f})")

    if not team_positions.empty and "x" in team_positions.columns:
        avg_x = _safe_mean(team_positions["x"])
        if team == "Team_B" and avg_x < 42:
            weaknesses.append(f"Bloc adverse tres bas (x moyen {avg_x:.1f})")
        elif team == "Team_A" and avg_x > 63:
            weaknesses.append(f"Bloc adverse desequilibre haut (x moyen {avg_x:.1f})")

    deduped: List[str] = []
    for item in weaknesses:
        if item not in deduped:
            deduped.append(item)
    return deduped[:2]


def generate_tactical_recommendations(
    positions: pd.DataFrame,
    physical: pd.DataFrame,
    events: pd.DataFrame,
    stats: pd.DataFrame,
    total_subs_done=0,
    sub_windows_used=0,
    replaced_players: Optional[List[str]] = None,
    is_halftime=False,
):
    if replaced_players is None:
        replaced_players = []
    recs = []
    unique_minutes = (
        sorted(int(minute) for minute in positions["minute"].dropna().unique())
        if positions is not None and not positions.empty and "minute" in positions.columns
        else []
    )
    MAX_TOTAL_REPLACEMENTS = 5
    MAX_SUB_WINDOWS = 3
    MAX_SUBS_PER_WINDOW = 3
    FATIGUE_THRESHOLD = 0.72

    def score_recommendation(text: str) -> int:
        lowered = _normalize_recommendation_text(text)
        if "remplacement" in lowered:
            return 100
        if lowered.startswith("score ") or "retard au score" in lowered or lowered.startswith("avantage "):
            return 92
        if (
            "faiblesse adverse" in lowered
            or "point d'entree offensif" in lowered
            or lowered.startswith("canal prioritaire")
            or "couloir" in lowered
            or "zone a fermer" in lowered
            or "zone a exploiter" in lowered
        ):
            return 88
        if "xg" in lowered or "frappe" in lowered or "surface" in lowered or "qualite de tir" in lowered:
            return 84
        if (
            "transition" in lowered
            or "pressing" in lowered
            or "territoire" in lowered
            or "contre-pression" in lowered
            or lowered.startswith("bloc adverse")
        ):
            return 78
        if "relance" in lowered or "fatigue" in lowered or "passes" in lowered:
            return 74
        return 64

    def classify_recommendation(text: str) -> str:
        lowered = _normalize_recommendation_text(text)
        if "remplacement" in lowered or "fenetre" in lowered:
            return "Remplacement"
        if (
            "faiblesse adverse" in lowered
            or "cote faible" in lowered
            or "point d'entree offensif" in lowered
            or lowered.startswith("canal prioritaire")
            or "zone a fermer" in lowered
            or "couloir" in lowered
        ):
            return "Faiblesse"
        if "transition" in lowered or "pressing" in lowered or "contre-pression" in lowered or lowered.startswith("bloc adverse"):
            return "Pressing"
        return "Analyse"

    for current_minute in unique_minutes:
        pos_m = positions[positions["minute"] == current_minute]
        phy_recent = _minute_window(physical, current_minute, span=5)
        evt_recent = _minute_window(events, current_minute, span=6)
        hist_events = (
            events[events["minute"] <= current_minute]
            if events is not None and not events.empty and "minute" in events.columns
            else pd.DataFrame()
        )
        team_a_recent = evt_recent[evt_recent["team"] == "Team_A"] if not evt_recent.empty else pd.DataFrame()
        team_b_recent = evt_recent[evt_recent["team"] == "Team_B"] if not evt_recent.empty else pd.DataFrame()
        shots_a_recent = team_a_recent[team_a_recent["event_type"] == "shot"] if not team_a_recent.empty else pd.DataFrame()
        shots_b_recent = team_b_recent[team_b_recent["event_type"] == "shot"] if not team_b_recent.empty else pd.DataFrame()
        xg_a_recent = float(shots_a_recent["xG"].fillna(0.0).sum()) if "xG" in shots_a_recent.columns else 0.0
        xg_b_recent = float(shots_b_recent["xG"].fillna(0.0).sum()) if "xG" in shots_b_recent.columns else 0.0
        xg_a_total = float(hist_events[(hist_events["team"] == "Team_A") & (hist_events["event_type"] == "shot")]["xG"].fillna(0.0).sum()) if not hist_events.empty and "xG" in hist_events.columns else 0.0
        xg_b_total = float(hist_events[(hist_events["team"] == "Team_B") & (hist_events["event_type"] == "shot")]["xG"].fillna(0.0).sum()) if not hist_events.empty and "xG" in hist_events.columns else 0.0
        pass_rate_a = _pass_success_rate(team_a_recent)
        pass_rate_b = _pass_success_rate(team_b_recent)
        lane_counts_a = _lane_counts(team_a_recent[team_a_recent["event_type"].isin(["pass", "cross", "shot"])]) if not team_a_recent.empty else {"gauche": 0, "axe": 0, "droite": 0}
        lane_counts_b = _lane_counts(team_b_recent[team_b_recent["event_type"].isin(["pass", "cross", "shot"])]) if not team_b_recent.empty else {"gauche": 0, "axe": 0, "droite": 0}
        lane_xg_a = _lane_xg(shots_a_recent)
        lane_xg_b = _lane_xg(shots_b_recent)
        dominant_lane_a = _dominant_key(lane_counts_a) if sum(lane_counts_a.values()) else "axe"
        dominant_lane_b = _dominant_key(lane_counts_b) if sum(lane_counts_b.values()) else "axe"
        lane_share_a = (
            lane_counts_a[dominant_lane_a] / max(1, sum(lane_counts_a.values()))
            if sum(lane_counts_a.values())
            else 0.0
        )
        lane_share_b = (
            lane_counts_b[dominant_lane_b] / max(1, sum(lane_counts_b.values()))
            if sum(lane_counts_b.values())
            else 0.0
        )
        raw: List[str] = []

        raw.append(_phase_guidance(current_minute))

        score = _score_until_minute(events, current_minute)
        score_a = score["Team_A"]
        score_b = score["Team_B"]
        if score_a == score_b:
            raw.append(f"Score {score_a}-{score_b} : chercher l'avantage sans exposer l'axe")
        elif score_a < score_b:
            raw.append(f"Retard au score {score_a}-{score_b} : augmenter le volume dans la surface")
        else:
            raw.append(f"Avantage {score_a}-{score_b} : gerer le tempo puis contrer proprement")

        if current_minute <= 10 and len(shots_b_recent) >= len(shots_a_recent):
            raw.append("Transition Team_B a surveiller : fermer vite le premier porteur")

        if sum(lane_counts_a.values()) >= 4:
            raw.append(
                f"Canal prioritaire Team_A : {_lane_phrase(dominant_lane_a)} ({lane_counts_a[dominant_lane_a]} actions, {lane_share_a * 100:.0f}% du volume recent)"
            )
            if lane_share_a >= 0.5:
                raw.append(
                    f"Point d'entree offensif confirme pour Team_A : passer davantage via {_lane_phrase(dominant_lane_a)} puis attaquer la surface"
                )
        if sum(lane_counts_b.values()) >= 4 and lane_share_b >= 0.45:
            raw.append(
                f"Sortie adverse orientee vers {_lane_phrase(dominant_lane_b)} ({lane_share_b * 100:.0f}% du volume recent) : preparer le piege de pressing sur ce cote"
            )
        if len(shots_b_recent) > 0:
            danger_lane = _dominant_key(lane_xg_b) if sum(lane_xg_b.values()) > 0 else dominant_lane_b
            raw.append(
                f"Zone a fermer contre Team_B : {_lane_phrase(danger_lane)} (xG recent {lane_xg_b[danger_lane]:.2f})"
            )

        if xg_a_recent > xg_b_recent + 0.12:
            raw.append(
                f"xG recent favorable ({xg_a_recent:.2f} vs {xg_b_recent:.2f}) : maintenir la pression dans la surface"
            )
        elif xg_b_recent > xg_a_recent + 0.08:
            raw.append(
                f"xG recent concédé ({xg_b_recent:.2f}) : resserrer l'axe et la seconde balle"
            )
        elif len(shots_a_recent) + len(shots_b_recent) == 0 and current_minute >= 12:
            raw.append("Fenetre sans frappe recente : accelerer la derniere passe apres fixation")
        if len(shots_a_recent) > 0:
            average_xg_a = xg_a_recent / max(1, len(shots_a_recent))
            if average_xg_a < 0.1:
                raw.append(
                    f"Qualite de tir Team_A faible ({average_xg_a:.2f} xG/tir) : gagner des metres avant la finition"
                )
            elif average_xg_a >= 0.18:
                raw.append(
                    f"Qualite de tir Team_A elevee ({average_xg_a:.2f} xG/tir) : continuer a entrer dans la surface"
                )
        if len(shots_b_recent) > 0:
            average_xg_b = xg_b_recent / max(1, len(shots_b_recent))
            if average_xg_b >= 0.16:
                raw.append(
                    f"Occasions de Team_B dangereuses ({average_xg_b:.2f} xG/tir) : fermer plus tot la zone de frappe"
                )

        if len(hist_events) > 0:
            shots_a_total = int(((hist_events["team"] == "Team_A") & (hist_events["event_type"] == "shot")).sum())
            shots_b_total = int(((hist_events["team"] == "Team_B") & (hist_events["event_type"] == "shot")).sum())
            if shots_a_total >= shots_b_total + 3 and xg_a_total <= xg_b_total + 0.25:
                raw.append(
                    "Volume de tirs superieur pour Team_A sans vrai ecart de danger : mieux selectionner la zone de finition"
                )
            elif shots_b_total >= shots_a_total + 2 and xg_b_total >= xg_a_total:
                raw.append(
                    "Team_B transforme mieux ses possessions en tirs : couper plus tot l'acces a la zone de frappe"
                )
            if shots_a_total > 0 and xg_a_total / shots_a_total < 0.11:
                raw.append("Les tirs de Team_A restent trop lointains : rechercher davantage de centres en retrait")

        failed_passes_a = team_a_recent[
            (team_a_recent["event_type"] == "pass") & (~team_a_recent["success"])
        ] if not team_a_recent.empty else pd.DataFrame()
        if len(failed_passes_a) >= 4:
            raw.append(f"Relance a securiser ({len(failed_passes_a)} pertes recentes)")
        elif pass_rate_a > 0 and pass_rate_b > pass_rate_a + 0.1:
            raw.append(
                f"Circulation adverse plus propre ({pass_rate_b * 100:.0f}% vs {pass_rate_a * 100:.0f}%) : monter plus vite sur le premier relayeur"
            )
        elif pass_rate_a > pass_rate_b + 0.12 and current_minute >= 15:
            raw.append("Circulation Team_A plus propre : changer plus vite de rythme apres la fixation")

        team_a_physical = phy_recent[phy_recent["team"] == "Team_A"] if not phy_recent.empty else pd.DataFrame()
        team_b_physical = phy_recent[phy_recent["team"] == "Team_B"] if not phy_recent.empty else pd.DataFrame()
        speed_a = _safe_mean(team_a_physical["speed"]) if not team_a_physical.empty else 0.0
        speed_b = _safe_mean(team_b_physical["speed"]) if not team_b_physical.empty else 0.0
        if current_minute >= 60 and speed_b and speed_a >= speed_b + 0.25:
            raw.append("Team_B baisse physiquement : accelerer les courses et les transitions")
        territory_a = _territory_average(pos_m, "Team_A")
        territory_b = _territory_average(pos_m, "Team_B")
        if territory_a and territory_b:
            if territory_a - territory_b >= 8:
                raw.append(
                    f"Territoire favorable Team_A (+{territory_a - territory_b:.1f}m) : garder la contre-pression proche du ballon"
                )
            elif territory_b - territory_a >= 6:
                raw.append(
                    f"Territoire concede a Team_B (+{territory_b - territory_a:.1f}m) : proteger les demi-espaces avant la derniere passe"
                )
        if current_minute >= 70 and abs(score_a - score_b) <= 1:
            raw.append("Fin de match ouverte : preparer la contre-pression immediate apres chaque perte")

        can_replace = (
            total_subs_done < MAX_TOTAL_REPLACEMENTS
            and (sub_windows_used < MAX_SUB_WINDOWS or is_halftime)
        )
        if can_replace and not phy_recent.empty:
            fatigued = phy_recent[
                (phy_recent["team"] == "Team_A")
                & (phy_recent["fatigue"] >= FATIGUE_THRESHOLD)
                & (~phy_recent["player_id"].isin(replaced_players))
            ]
            if not fatigued.empty:
                grouped = (
                    fatigued.groupby("player_id")["fatigue"]
                    .mean()
                    .sort_values(ascending=False)
                )
                subs_left = MAX_TOTAL_REPLACEMENTS - total_subs_done
                subs_win = min(subs_left, MAX_SUBS_PER_WINDOW)
                to_replace = grouped.head(subs_win).index.tolist()
                if to_replace:
                    raw.append("Remplacement(s) : " + ", ".join(to_replace))
        else:
            if total_subs_done >= MAX_TOTAL_REPLACEMENTS:
                raw.append("Plus de remplacements (5/5)")
            elif sub_windows_used >= MAX_SUB_WINDOWS and not is_halftime:
                raw.append("Toutes fenetres de remplacement utilisees")

        weaknesses = detect_opponent_weaknesses(
            events,
            physical,
            positions,
            minute=current_minute,
        )
        for weakness in weaknesses:
            raw.append("Faiblesse adverse : " + weakness)

        if not pos_m.empty and "x" in pos_m.columns:
            midfield_presence = pos_m[(pos_m["x"] > 35) & (pos_m["x"] < 65)]
            if midfield_presence["player_id"].nunique() < 6:
                raw.append(
                    f"Milieu a densifier ({midfield_presence['player_id'].nunique()} joueurs dans l'axe intermediaire)"
                )

        deduped: List[str] = []
        seen: set[str] = set()
        for text in raw:
            normalized = _normalize_recommendation_text(text)
            if normalized in seen or _is_low_signal_recommendation(text):
                continue
            if text not in deduped:
                deduped.append(text)
                seen.add(normalized)

        prioritized = []
        for text in deduped:
            prioritized.append(
                {
                    "minute": current_minute,
                    "type": classify_recommendation(text),
                    "recommendation": text,
                    "priority": score_recommendation(text),
                }
            )
        prioritized = sorted(prioritized, key=lambda item: item["priority"], reverse=True)[:5]
        if prioritized:
            prioritized[0]["recommendation"] = "PRIORITE : " + prioritized[0]["recommendation"]
        recs.extend(prioritized)

    return (
        pd.DataFrame(recs)
        if recs
        else pd.DataFrame(columns=["minute", "type", "recommendation", "priority"])
    )


def suggest_pressing_adaptations_df(
    positions: pd.DataFrame,
    events: pd.DataFrame,
    stats: pd.DataFrame,
    team="Team_A",
    opponent="Team_B",
    current_minute=45,
):
    recs = []
    pos_m = positions[
        (positions["minute"] == current_minute) & (positions["team"] == opponent)
    ]
    if pos_m.empty:
        return pd.DataFrame(columns=["minute", "type", "recommendation"])
    avg_x = pos_m["x"].mean()
    bloc = "bas" if avg_x < 35 else "median" if avg_x < 65 else "haut"
    if bloc == "bas":
        recs.append("Bloc adverse : BAS. Fixer la ligne puis renverser vite vers le couloir faible")
    elif bloc == "median":
        recs.append("Bloc adverse : MEDIAN. Attirer la premiere ligne puis accelerer entre lateral et central")
    else:
        recs.append("Bloc adverse : HAUT. Chercher directement l'espace derriere la premiere ligne")
    if events.empty or "x" not in events.columns:
        return pd.DataFrame(
            [
                {"minute": current_minute, "type": "Pressing", "recommendation": item}
                for item in recs[:1]
            ]
        )

    opponent_build = events[
        (events["minute"].between(max(0, current_minute - 5), current_minute))
        & (events["team"] == opponent)
        & (events["event_type"].isin(["pass", "cross"]))
    ]
    if not opponent_build.empty:
        lane_counts = _lane_counts(opponent_build)
        if sum(lane_counts.values()) >= 4:
            dominant_lane = _dominant_key(lane_counts)
            recs.append(
                f"Orientation pressing : fermer d'abord {_lane_phrase(dominant_lane)} sur la sortie adverse recente"
            )

    recent = events[
        (events["minute"].between(max(0, current_minute - 5), current_minute))
        & (events["team"] == team)
    ]
    high_press = recent[
        (recent["event_type"].isin(["tackle", "duel"])) & (recent["x"] > 65)
    ]
    lost_duels = recent[
        (recent["event_type"] == "duel")
        & (~recent["success"])
        & (recent["x"] > 65)
    ]
    ps = len(high_press)
    pf = len(lost_duels)
    if ps == 0 and pf == 0:
        if bloc != "bas":
            recs.append("Pas de pressing haut recent : choisir un declencheur clair sur passe laterale ou controle ferme")
    elif ps < pf:
        recs.append(f"Pressing haut peu rentable ({ps} recup, {pf} duels perdus) : reculer de quelques metres avant de sortir")
    elif ps >= max(2, pf + 2):
        recs.append(f"Pressing haut rentable ({ps} recuperations) : maintenir la sortie agressive autour du ballon")
    else:
        recs.append(
            f"Pressing partage ({ps} recuperations, {pf} duels perdus) : sortir a deux pour proteger la couverture interieure"
        )

    prev = events[
        (events["minute"].between(max(0, current_minute - 10), max(0, current_minute - 6)))
        & (events["team"] == team)
    ]
    prev_high = prev[
        (prev["event_type"].isin(["tackle", "duel"])) & (prev["x"] > 65)
    ]
    prev_lost = prev[
        (prev["event_type"] == "duel")
        & (~prev["success"])
        & (prev["x"] > 65)
    ]
    prev_ps = len(prev_high)
    prev_pf = len(prev_lost)
    if prev_ps or prev_pf or ps or pf:
        delta_s = ps - prev_ps
        delta_f = pf - prev_pf
        if delta_s >= 2 and delta_f <= 0:
            recs.append("Pressing en progression : conserver le meme timing de sortie")
        elif delta_s <= -2 and delta_f > 0:
            recs.append("Pressing en recul : proteger d'abord l'interieur avant de ressortir")

    return pd.DataFrame(
        [
            {"minute": current_minute, "type": "Pressing", "recommendation": item}
            for item in recs
            if not _is_low_signal_recommendation(item)
        ]
    )
