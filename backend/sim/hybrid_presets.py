from __future__ import annotations

import csv
from pathlib import Path
import unicodedata
from typing import Any, Dict, Iterable, List, Sequence


PITCH_LENGTH = 105.0
PITCH_WIDTH = 68.0


def _normalize(value: str) -> str:
    normalized = unicodedata.normalize("NFD", str(value or ""))
    stripped = "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")
    return "".join(ch.lower() for ch in stripped if ch.isalnum())


def identify_hybrid_preset(match_info: Dict[str, str] | None) -> str | None:
    if not match_info:
        return None
    home = _normalize(match_info.get("home", ""))
    away = _normalize(match_info.get("away", ""))
    if home in ("uzbekistan", "ouzbekistan") and away == "gabon":
        return "uzbekistan_gabon_2026"
    return None


def _roster_entry_label(entry: Any, fallback: str) -> str:
    if entry is None:
        return fallback
    numero = str(getattr(entry, "numero", "") or "").strip()
    nom = str(getattr(entry, "nom", "") or "").strip()
    if numero and nom:
        return f"{numero} {nom}"
    if nom:
        return nom
    if numero:
        return numero
    return fallback


def _label_name(label: str) -> str:
    text = str(label or "").strip()
    parts = text.split()
    if parts and parts[0].isdigit():
        return " ".join(parts[1:]).strip()
    return text


def _name_tokens(label: str) -> List[str]:
    cleaned = unicodedata.normalize("NFD", _label_name(label))
    stripped = "".join(ch for ch in cleaned if unicodedata.category(ch) != "Mn")
    normalized = "".join(ch if ch.isalnum() else " " for ch in stripped).lower()
    return [token for token in normalized.split() if token]


def _same_name(left: str, right: str) -> bool:
    left_name = _normalize(_label_name(left))
    right_name = _normalize(_label_name(right))
    if left_name == right_name:
        return True
    left_tokens = _name_tokens(left)
    right_tokens = _name_tokens(right)
    if not left_tokens or not right_tokens:
        return False
    if left_tokens[-1] != right_tokens[-1]:
        return False
    return left_tokens[0][0] == right_tokens[0][0]


def _promote_required(labels: List[str], target_idx: int, required_label: str) -> None:
    existing_idx = next(
        (idx for idx, label in enumerate(labels) if _same_name(label, required_label)),
        None,
    )
    if existing_idx is None:
        labels[target_idx] = required_label
        return
    labels[target_idx], labels[existing_idx] = labels[existing_idx], labels[target_idx]


def _labels_from_roster(rows: Sequence[Any], defaults: Sequence[str]) -> List[str]:
    result: List[str] = []
    for idx, fallback in enumerate(defaults):
        entry = rows[idx] if idx < len(rows) else None
        label = _roster_entry_label(entry, fallback)
        if _normalize(label).startswith("teama") or _normalize(label).startswith("teamb"):
            label = fallback
        result.append(label)
    return result


def _build_uzbekistan_gabon_team_config(rosters: Dict[str, Sequence[Any]] | None = None) -> Dict[str, Dict]:
    home_defaults = [
        "1 Uzbekistan GK",
        "2 Uzbekistan RB",
        "3 Uzbekistan RCB",
        "4 Uzbekistan LCB",
        "5 Uzbekistan LB",
        "6 Uzbekistan DM",
        "7 A. Ganiev",
        "19 Jakhongir Urozov",
        "11 Uzbekistan RW",
        "14 Eldor Shomurodov",
        "17 Alisher Odilov",
    ]
    away_defaults = [
        "1 Gabon GK",
        "2 Gabon RB",
        "3 Gabon RCB",
        "4 Gabon LCB",
        "5 Gabon LB",
        "6 Gabon DM",
        "11 S. W. Babicka",
        "8 Gabon CM",
        "17 Gabon LW",
        "10 Teddy Averlant",
        "9 Gabon CF",
    ]
    rosters = rosters or {}
    home = _labels_from_roster(list(rosters.get("home") or []), home_defaults)
    away = _labels_from_roster(list(rosters.get("away") or []), away_defaults)

    for idx, label in ((8, "11 Jakhongir Urozov"), (9, "14 Eldor Shomurodov")):
        _promote_required(home, idx, label)
    for idx, label in ((9, "9 Teddy Averlant"),):
        _promote_required(away, idx, label)

    return {
        "Team_A": {
            "formation": "4-3-3",
            "players": {
                "GK": [home[0]],
                "DEF": home[1:5],
                "MID": home[5:8],
                "FWD": home[8:11],
            },
        },
        "Team_B": {
            "formation": "4-3-3",
            "players": {
                "GK": [away[0]],
                "DEF": away[1:5],
                "MID": away[5:8],
                "FWD": away[8:11],
            },
        },
    }


def _flatten_players(team_cfg: Dict[str, Dict[str, List[str]]]) -> Iterable[tuple[str, int, str]]:
    for role in ("GK", "DEF", "MID", "FWD"):
        for idx, player in enumerate(team_cfg["players"].get(role, [])):
            yield role, idx, player


def _find_player(team_cfg: Dict[str, Dict[str, List[str]]], needle: str, fallback: str) -> str:
    for _, _, player in _flatten_players(team_cfg):
        if _same_name(player, needle):
            return player
    return fallback


def _find_label_in_rosters(rosters: Dict[str, Sequence[Any]] | None, needle: str, fallback: str) -> str:
    if not rosters:
        return fallback
    for roster_key in ("home", "away", "bench_home", "bench_away"):
        for entry in list(rosters.get(roster_key) or []):
            label = _roster_entry_label(entry, fallback)
            if _same_name(label, needle):
                return label
    return fallback


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _phase_shift(team: str, minute: int) -> float:
    if team == "Team_A":
        if minute < 10:
            return 1.5
        if minute < 45:
            return 4.0
        if minute < 70:
            return 8.0
        if minute < 90:
            return 4.5
        return 7.0
    if minute < 10:
        return 6.0
    if minute < 45:
        return 2.5
    if minute < 60:
        return 1.0
    if minute < 70:
        return -1.5
    if minute < 90:
        return -0.5
    return -2.0


def _momentum(team: str, minute: int) -> float:
    if team == "Team_A":
        if minute < 10:
            return 0.47
        if minute < 45:
            return 0.56
        if minute < 70:
            return 0.66
        if minute < 90:
            return 0.54
        return 0.68
    if minute < 10:
        return 0.61
    if minute < 45:
        return 0.48
    if minute < 60:
        return 0.43
    if minute < 90:
        return 0.36
    return 0.32


ROLE_BASE_COORDS = {
    "GK": [(7.0, 34.0)],
    "DEF": [(24.0, 58.0), (22.0, 45.0), (22.0, 23.0), (24.0, 10.0)],
    "MID": [(45.0, 50.0), (44.0, 34.0), (45.0, 18.0)],
    "FWD": [(74.0, 58.0), (82.0, 34.0), (74.0, 14.0)],
}


def _attack_right(team: str, minute: int) -> bool:
    if team == "Team_A":
        return minute < 45
    return minute >= 45


def _build_positions(team_key: str, team_cfg: Dict[str, Dict[str, List[str]]], minute: int) -> List[dict]:
    attack_right = _attack_right(team_key, minute)
    direction = 1.0 if attack_right else -1.0
    shift = _phase_shift(team_key, minute)
    records: List[dict] = []

    for role, slot_idx, player in _flatten_players(team_cfg):
        base_x, base_y = ROLE_BASE_COORDS[role][slot_idx]
        x = base_x if attack_right else PITCH_LENGTH - base_x
        y = base_y
        x += shift * direction
        if team_key == "Team_A" and (role, slot_idx) in (("DEF", 0), ("MID", 0), ("FWD", 0)):
            x += 3.0 * direction
            y += 1.5
        if team_key == "Team_B" and minute >= 60 and (role, slot_idx) in (("FWD", 0), ("FWD", 2)):
            x -= 6.0 * direction
        if team_key == "Team_B" and minute >= 60 and role == "MID":
            x -= 2.0 * direction

        x += ((minute + slot_idx * 3) % 5) - 2
        y += ((minute * 2 + slot_idx * 5) % 7) - 3

        records.append(
            {
                "time": minute * 60,
                "minute": minute,
                "player_id": player,
                "team": team_key,
                "role": role,
                "x": round(_clamp(x, 0.0, PITCH_LENGTH), 2),
                "y": round(_clamp(y, 0.0, PITCH_WIDTH), 2),
            }
        )
    return records


def _build_physical(team_key: str, team_cfg: Dict[str, Dict[str, List[str]]], minute: int) -> List[dict]:
    records: List[dict] = []
    for role, slot_idx, player in _flatten_players(team_cfg):
        fatigue = 0.14 + minute / 120.0 + slot_idx * 0.015
        if team_key == "Team_B" and minute >= 60:
            fatigue += 0.08
        fatigue = _clamp(fatigue, 0.0, 0.96)

        speed = 7.7 - fatigue * 2.7
        if role == "GK":
            speed -= 1.9
        elif role == "DEF":
            speed -= 0.5
        elif role == "FWD":
            speed += 0.25
        if team_key == "Team_A" and 45 <= minute < 70:
            speed += 0.2
        if team_key == "Team_B" and minute >= 60:
            speed -= 0.45

        records.append(
            {
                "time": minute * 60,
                "minute": minute,
                "player_id": player,
                "team": team_key,
                "speed": round(_clamp(speed, 3.2, 8.6), 2),
                "fatigue": round(fatigue, 3),
            }
        )
    return records


def _event(
    time_sec: int,
    team: str,
    player: str,
    event_type: str,
    x: float,
    y: float,
    *,
    success: bool = True,
    xg: float = 0.0,
    extras: Dict[str, Any] | None = None,
) -> dict:
    record = {
        "time": time_sec,
        "minute": time_sec // 60,
        "player_id": player,
        "team": team,
        "event_type": event_type,
        "x": round(_clamp(x, 0.0, PITCH_LENGTH), 2),
        "y": round(_clamp(y, 0.0, PITCH_WIDTH), 2),
        "success": success,
        "momentum": round(_momentum(team, time_sec // 60), 2),
        "xG": round(xg, 3),
    }
    if extras:
        record.update(extras)
    return record


ROOT_DIR = Path(__file__).resolve().parents[2]
DATASET_PACKAGE_DIR = ROOT_DIR / "uzbekistan_gabon_synthetic_dataset_package"
DETAILED_EVENT_LOG_PATH = ROOT_DIR / "event_log_detailed_full_match.csv"
DETAILED_SHOT_MAP_PATH = ROOT_DIR / "shot_map_detailed_coordinates.csv"
TEXTUAL_SHOT_MAP_PATH = DATASET_PACKAGE_DIR / "shot_map_textual_precise.csv"
TEAM_KEY_BY_LABEL = {
    "uzbekistan": "Team_A",
    "ouzbekistan": "Team_A",
    "gabon": "Team_B",
}
ZONE_PROGRESS = {
    "defensive_third": 0.18,
    "middle_third": 0.46,
    "final_third": 0.82,
    "right_flank": 0.66,
    "left_flank": 0.66,
    "central_zone": 0.58,
}
SIDE_Y = {"right": 56.0, "left": 12.0, "center": 34.0}
PLAYER_ALIASES = {
    "Team_A": {
        _normalize("Eldor Shomurodov"): "Eldor Shomurodov",
        _normalize("E. Shomurodov"): "Eldor Shomurodov",
        _normalize("O. Shukurov"): "O. Shukurov",
        _normalize("O. Urunov"): "Jakhongir Urozov",
        _normalize("Jakhongir Urozov"): "Jakhongir Urozov",
        _normalize("A. Ganiev"): "A. Abdullayev",
        _normalize("Alisher Odilov"): "Alisher Odilov",
    },
    "Team_B": {
        _normalize("Teddy Averlant"): "Teddy Averlant",
        _normalize("Didier Ndong"): "Didier Ndong",
        _normalize("Guelor Kanga"): "Guelor Kanga",
        _normalize("Jim Allevinah"): "Jim Allevinah",
        _normalize("Shavy Babicka"): "S. Nzé",
        _normalize("S. W. Babicka"): "S. Nzé",
    },
}


def _read_csv_rows(path: Path) -> List[Dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return [{str(key or ""): str(value or "") for key, value in row.items() if key} for row in reader if row]


def _coerce_csv_int(value: str, default: int = 0) -> int:
    try:
        return int(float(str(value or default).strip()))
    except (TypeError, ValueError):
        return default


def _coerce_csv_float(value: str, default: float = 0.0) -> float:
    try:
        return float(str(value or default).strip())
    except (TypeError, ValueError):
        return default


def _coerce_csv_bool(value: str) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "oui"}


def _shot_row_key(row: Dict[str, str]) -> tuple[int, str]:
    return _coerce_csv_int(row.get("minute", "0")), TEAM_KEY_BY_LABEL.get(
        _normalize(row.get("team", "")),
        "Team_A",
    )


def _dataset_rows() -> tuple[List[Dict[str, str]], List[Dict[str, str]], List[Dict[str, str]], str] | None:
    event_path = DATASET_PACKAGE_DIR / "event_log_minute_by_minute.csv"
    shot_path = DATASET_PACKAGE_DIR / "shot_map_hybrid.csv"
    summary_path = DATASET_PACKAGE_DIR / "team_summary_hybrid.csv"
    if not shot_path.exists():
        return None
    event_rows: List[Dict[str, str]] = []
    event_source = "package"
    if DETAILED_EVENT_LOG_PATH.exists():
        detailed_rows = _read_csv_rows(DETAILED_EVENT_LOG_PATH)
        detailed_minutes = sorted({_coerce_csv_int(row.get("minute", "0")) for row in detailed_rows})
        if detailed_minutes == list(range(96)):
            event_rows = detailed_rows
            event_source = "detailed"
    if not event_rows:
        if not event_path.exists():
            return None
        event_rows = _read_csv_rows(event_path)
    shot_rows = _read_csv_rows(shot_path)
    if DETAILED_SHOT_MAP_PATH.exists():
        detailed_shot_rows = _read_csv_rows(DETAILED_SHOT_MAP_PATH)
        detailed_by_key = {}
        for row in detailed_shot_rows:
            enriched = dict(row)
            enriched["coordinate_source"] = "detailed"
            detailed_by_key[_shot_row_key(enriched)] = enriched
        merged_shots: List[Dict[str, str]] = []
        seen_keys: set[tuple[int, str]] = set()
        for row in shot_rows:
            key = _shot_row_key(row)
            if key in detailed_by_key:
                merged = dict(row)
                merged.update(detailed_by_key[key])
                merged_shots.append(merged)
                seen_keys.add(key)
            else:
                merged = dict(row)
                merged["coordinate_source"] = "package"
                merged_shots.append(merged)
        for key, row in detailed_by_key.items():
            if key not in seen_keys:
                merged_shots.append(row)
        shot_rows = merged_shots
    else:
        shot_rows = [{**row, "coordinate_source": "package"} for row in shot_rows]
    if TEXTUAL_SHOT_MAP_PATH.exists():
        textual_shot_rows = _read_csv_rows(TEXTUAL_SHOT_MAP_PATH)
        textual_by_key = {
            _shot_row_key(row): {
                **row,
                "textual_source": "package_textual",
            }
            for row in textual_shot_rows
        }
        shot_rows = [
            {
                **row,
                **textual_by_key.get(_shot_row_key(row), {}),
            }
            for row in shot_rows
        ]
    summary_rows = _read_csv_rows(summary_path) if summary_path.exists() else []
    minutes = sorted({_coerce_csv_int(row.get("minute", "0")) for row in event_rows})
    if minutes != list(range(96)):
        return None
    return event_rows, shot_rows, summary_rows, event_source


def _team_personnel(
    team_key: str,
    team_cfg: Dict[str, Dict[str, List[str]]],
    rosters: Dict[str, Sequence[Any]] | None,
) -> Dict[str, str]:
    defenders = list(team_cfg["players"].get("DEF", []))
    midfielders = list(team_cfg["players"].get("MID", []))
    forwards = list(team_cfg["players"].get("FWD", []))
    fallback_impact = forwards[2] if len(forwards) >= 3 else (forwards[-1] if forwards else "unknown")
    return {
        "right_back": defenders[0] if defenders else "unknown",
        "left_back": defenders[-1] if defenders else "unknown",
        "right_mid": midfielders[0] if midfielders else "unknown",
        "pivot": midfielders[1] if len(midfielders) > 1 else (midfielders[0] if midfielders else "unknown"),
        "left_mid": midfielders[2] if len(midfielders) > 2 else (midfielders[-1] if midfielders else "unknown"),
        "right_wing": forwards[0] if forwards else "unknown",
        "striker": forwards[1] if len(forwards) > 1 else (forwards[0] if forwards else "unknown"),
        "left_wing": forwards[2] if len(forwards) > 2 else (forwards[-1] if forwards else "unknown"),
        "impact": _find_label_in_rosters(rosters, "Alisher Odilov", fallback_impact),
    }


def _canonical_player_name(team_key: str, raw_name: str) -> str:
    aliases = PLAYER_ALIASES.get(team_key, {})
    return aliases.get(_normalize(raw_name), raw_name)


def _resolve_player_label(
    team_key: str,
    team_cfg: Dict[str, Dict[str, List[str]]],
    rosters: Dict[str, Sequence[Any]] | None,
    raw_name: str,
    fallback: str,
) -> str:
    for _, _, player in _flatten_players(team_cfg):
        if _same_name(player, raw_name):
            return player
    resolved = _find_label_in_rosters(rosters, raw_name, fallback)
    if _same_name(resolved, raw_name):
        return resolved
    canonical = _canonical_player_name(team_key, raw_name)
    if canonical != raw_name:
        for _, _, player in _flatten_players(team_cfg):
            if _same_name(player, canonical):
                return player
        resolved = _find_label_in_rosters(rosters, canonical, fallback)
        if _same_name(resolved, canonical):
            return resolved
    return fallback


def _zone_side(zone: str, attack_side: str) -> str:
    if zone == "right_flank":
        return "right"
    if zone == "left_flank":
        return "left"
    side = str(attack_side or "").strip().lower()
    if side in ("right", "left", "center"):
        return side
    return "center"


def _progress_for_action(team_key: str, zone: str, phase: str) -> float:
    progress = ZONE_PROGRESS.get(zone, 0.52)
    if phase == "transition":
        progress += 0.08
    elif phase == "defensive":
        progress -= 0.12
    elif phase == "set_piece":
        progress += 0.1
    if team_key == "Team_A":
        return _clamp(progress, 0.08, 0.92)
    return _clamp(1.0 - progress, 0.08, 0.92)


def _point_for_action(
    minute: int,
    team_key: str,
    zone: str,
    attack_side: str,
    phase: str,
    *,
    advanced: bool = False,
) -> tuple[float, float]:
    side = _zone_side(zone, attack_side)
    progress = _progress_for_action(team_key, zone, phase)
    if advanced:
        progress = progress + 0.1 if team_key == "Team_A" else progress - 0.1
    progress = _clamp(progress, 0.05, 0.95)
    x = progress * PITCH_LENGTH
    y = SIDE_Y.get(side, 34.0)
    if zone == "central_zone":
        y = 34.0
    elif zone == "right_flank":
        y = 58.0
    elif zone == "left_flank":
        y = 10.0
    x += (minute % 3) - 1
    y += ((minute * 2) % 5) - 2
    return round(_clamp(x, 0.0, PITCH_LENGTH), 2), round(_clamp(y, 0.0, PITCH_WIDTH), 2)


def _support_players(personnel: Dict[str, str], side: str) -> tuple[str, str]:
    if side == "right":
        return personnel["right_back"], personnel["right_wing"]
    if side == "left":
        return personnel["left_back"], personnel["left_wing"]
    return personnel["pivot"], personnel["striker"]


def _action_success(action: str, outcome: str, is_goal: bool) -> bool:
    if is_goal:
        return True
    if action in ("pass_sequence", "progressive_run", "cross"):
        return outcome != "fail"
    if action in ("recovery",):
        return outcome != "fail"
    if action == "turnover":
        return outcome == "success"
    return outcome == "success"


def _base_pass_event(
    minute: int,
    team_key: str,
    passer: str,
    zone: str,
    attack_side: str,
    phase: str,
) -> dict:
    x, y = _point_for_action(minute, team_key, zone, attack_side, phase)
    return _event(minute * 60 + 4, team_key, passer, "pass", x, y, success=True)


def _shot_coordinates_from_row(row: Dict[str, str] | None, team_key: str) -> tuple[float, float] | None:
    if not row:
        return None
    x_raw = row.get("x", "")
    y_raw = row.get("y", "")
    if x_raw in ("", None) or y_raw in ("", None):
        return None
    x = _coerce_csv_float(x_raw, default=-1.0)
    y = _coerce_csv_float(y_raw, default=-1.0)
    if x < 0 or y < 0:
        return None
    if str(row.get("coordinate_source", "")).strip().lower() == "detailed":
        half_pitch = PITCH_LENGTH / 2.0
        attack_depth = (x / 100.0) * half_pitch
        x = half_pitch + attack_depth if team_key == "Team_A" else half_pitch - attack_depth
        y = (y / 100.0) * PITCH_WIDTH
    return round(_clamp(x, 0.0, PITCH_LENGTH), 2), round(_clamp(y, 0.0, PITCH_WIDTH), 2)


def _canonical_shot_textual_coords(row: Dict[str, str] | None) -> tuple[float, float] | None:
    if not row:
        return None
    zone_detail = _normalize(row.get("zone_detail", ""))
    description = _normalize(row.get("location_description", ""))
    if not zone_detail and not description:
        return None

    attack_x = 92.0
    if "close_range" in zone_detail or "6metres" in description:
        attack_x = 97.0
    elif "edge_box" in zone_detail or "entreedesurface" in description:
        attack_x = 81.0
    elif "angle" in zone_detail or "angleferme" in description:
        attack_x = 89.0
    elif "half_box" in zone_detail:
        attack_x = 91.0
    elif "central_box" in zone_detail:
        attack_x = 93.0
    elif "box" in zone_detail:
        attack_x = 92.0

    if "left" in zone_detail or "cotegauche" in description:
        attack_y = 21.0 if "edge" in zone_detail else 24.0
    elif "right" in zone_detail or "cotedroit" in description or "droitedugardien" in description:
        attack_y = 50.0 if "angle" in zone_detail else 46.0
    else:
        attack_y = 34.0

    if "pointdepenalty" in description:
        attack_x = max(attack_x, 94.0)
        attack_y = 34.0
    if "angleferme" in description:
        attack_x = min(attack_x, 90.0)
    if "prochedes6metres" in description:
        attack_x = max(attack_x, 97.0)

    return round(_clamp(attack_x, 0.0, PITCH_LENGTH), 2), round(_clamp(attack_y, 0.0, PITCH_WIDTH), 2)


def _shot_display_coordinates(
    row: Dict[str, str] | None,
    team_key: str,
    default_x: float,
    default_y: float,
) -> tuple[float, float]:
    textual_coords = _canonical_shot_textual_coords(row)
    if textual_coords is not None:
        canonical_x, canonical_y = textual_coords
        display_x = PITCH_LENGTH - canonical_x if team_key == "Team_A" else canonical_x
        return round(_clamp(display_x, 0.0, PITCH_LENGTH), 2), round(_clamp(canonical_y, 0.0, PITCH_WIDTH), 2)
    return round(_clamp(PITCH_LENGTH - default_x, 0.0, PITCH_LENGTH), 2), round(_clamp(default_y, 0.0, PITCH_WIDTH), 2)


def _shot_goalmouth_coordinates(
    row: Dict[str, str] | None,
    default_y: float,
) -> tuple[float, float]:
    zone_detail = _normalize(row.get("zone_detail", "")) if row else ""
    description = _normalize(row.get("location_description", "")) if row else ""
    result = _normalize(row.get("result", "")) if row else ""
    body_part = _normalize(row.get("body_part", "")) if row else ""

    if "left" in zone_detail or "cotegauche" in description:
        x = 30.0
    elif "right" in zone_detail or "cotedroit" in description or "droitedugardien" in description:
        x = 70.0
    else:
        x = 50.0

    if result == "off_target":
        y = 18.0
        if x < 50:
            x = 20.0
        elif x > 50:
            x = 80.0
    elif result == "blocked":
        y = 82.0
    elif body_part == "header" or "tete" in description:
        y = 34.0
    else:
        y = 48.0

    if not row:
        lane_x = (default_y / PITCH_WIDTH) * 100.0
        x = round(_clamp(lane_x, 18.0, 82.0), 2)

    return round(_clamp(x, 0.0, 100.0), 2), round(_clamp(y, 0.0, 100.0), 2)


def _shot_visual_extras(
    row: Dict[str, str] | None,
    team_key: str,
    analytical_x: float,
    analytical_y: float,
) -> Dict[str, Any]:
    display_x, display_y = _shot_display_coordinates(row, team_key, analytical_x, analytical_y)
    goalmouth_x, goalmouth_y = _shot_goalmouth_coordinates(row, analytical_y)
    extras: Dict[str, Any] = {
        "display_x": display_x,
        "display_y": display_y,
        "attack_direction_display": "left" if team_key == "Team_A" else "right",
        "goalmouth_x": goalmouth_x,
        "goalmouth_y": goalmouth_y,
    }
    if row:
        if row.get("location_description"):
            extras["location_description"] = row.get("location_description", "")
        if row.get("zone_detail"):
            extras["zone_detail"] = row.get("zone_detail", "")
        if row.get("result"):
            extras["shot_result"] = row.get("result", "")
    return extras


def _build_csv_driven_events(
    event_rows: Sequence[Dict[str, str]],
    shot_rows: Sequence[Dict[str, str]],
    summary_rows: Sequence[Dict[str, str]],
    teams: Dict[str, Dict],
    rosters: Dict[str, Sequence[Any]] | None,
) -> List[dict]:
    shot_by_minute = {_shot_row_key(row): row for row in shot_rows}
    event_row_by_key = {
        (_coerce_csv_int(row.get("minute", "0")), TEAM_KEY_BY_LABEL.get(_normalize(row.get("team", "")), "Team_A")): row
        for row in event_rows
    }
    personnel = {
        "Team_A": _team_personnel("Team_A", teams["Team_A"], rosters),
        "Team_B": _team_personnel("Team_B", teams["Team_B"], rosters),
    }
    events: List[dict] = []
    primary_shot_keys: set[tuple[int, str]] = set()

    for row in event_rows:
        minute = _coerce_csv_int(row.get("minute", "0"))
        team_key = TEAM_KEY_BY_LABEL.get(_normalize(row.get("team", "")), "Team_A")
        team_cfg = teams[team_key]
        side = _zone_side(row.get("zone", ""), row.get("attack_side", ""))
        phase = str(row.get("phase", "build_up") or "build_up").strip().lower()
        action = str(row.get("action", "pass_sequence") or "pass_sequence").strip().lower()
        outcome = str(row.get("outcome", "neutral") or "neutral").strip().lower()
        is_goal = _coerce_csv_bool(row.get("is_goal", "false"))
        shot_info = shot_by_minute.get((minute, team_key))
        team_players = personnel[team_key]
        support_from, support_to = _support_players(team_players, side)
        if team_key == "Team_B" and minute < 11 and action in ("pass_sequence", "progressive_run", "shot"):
            early_x, early_y = _point_for_action(minute, team_key, row.get("zone", ""), side, phase)
            events.append(
                _event(
                    minute * 60 + 2,
                    team_key,
                    team_players["pivot"],
                    "pass",
                    early_x,
                    early_y,
                    success=True,
                )
            )
        support_event = _base_pass_event(minute, team_key, support_from, row.get("zone", ""), side, phase)
        events.append(support_event)

        event_time = minute * 60 + 6
        if action == "shot":
            primary_shot_keys.add((minute, team_key))
            shot_zone = shot_info.get("zone", row.get("zone", "")) if shot_info else row.get("zone", "")
            shot_side = shot_info.get("attack_side", side) if shot_info else side
            shooter_fallback = team_players["striker"] if side == "center" else support_to
            shooter = _resolve_player_label(
                team_key,
                team_cfg,
                rosters,
                shot_info.get("player", "") if shot_info else "",
                shooter_fallback,
            )
            shot_x, shot_y = _point_for_action(minute, team_key, shot_zone, shot_side, phase, advanced=True)
            precise_coords = _shot_coordinates_from_row(shot_info, team_key)
            if precise_coords is not None:
                shot_x, shot_y = precise_coords
            row_xg = _coerce_csv_float(row.get("xg", "0.0"))
            shot_xg = _coerce_csv_float(shot_info.get("xg", "0.0")) if shot_info else 0.0
            xg = row_xg if row_xg > 0 else shot_xg
            body_part = _normalize(shot_info.get("body_part", "")) if shot_info else _normalize(row.get("sub_action", ""))
            description = str(row.get("description", "")).lower()
            sub_action = _normalize(row.get("sub_action", ""))
            assist_event_type = "cross" if "cross" in description or body_part == "head" or sub_action == "header" else "pass"
            assist_x, assist_y = _point_for_action(minute, team_key, shot_zone, shot_side, phase)
            creator = support_to if assist_event_type == "cross" else support_from
            events.append(
                _event(
                    event_time,
                    team_key,
                    creator,
                    assist_event_type,
                    assist_x,
                    assist_y,
                    success=True,
                )
            )
            events.append(
                _event(
                    event_time + 2,
                    team_key,
                    shooter,
                    "shot",
                    shot_x,
                    shot_y,
                    success=is_goal or _action_success(action, outcome, is_goal),
                    xg=xg,
                    extras=_shot_visual_extras(shot_info, team_key, shot_x, shot_y),
                )
            )
            continue

        event_type = {
            "pass_sequence": "pass",
            "progressive_run": "pass",
            "cross": "cross",
            "duel": "duel",
            "recovery": "tackle",
            "turnover": "tackle" if phase == "defensive" or outcome == "success" else "pass",
        }.get(action, "pass")
        actor = support_to if event_type in ("pass", "cross", "duel") else support_from
        if action == "turnover" and event_type == "pass":
            actor = support_from
        if action == "recovery":
            actor = team_players["pivot"]
        action_x, action_y = _point_for_action(
            minute,
            team_key,
            row.get("zone", ""),
            side,
            phase,
            advanced=action in ("progressive_run", "cross"),
        )
        events.append(
            _event(
                event_time,
                team_key,
                actor,
                event_type,
                action_x,
                action_y,
                success=_action_success(action, outcome, is_goal),
                xg=_coerce_csv_float(row.get("xg", "0.0")) if event_type == "shot" else 0.0,
            )
        )

    for shot_row in shot_rows:
        shot_key = _shot_row_key(shot_row)
        if shot_key in primary_shot_keys:
            continue
        minute, team_key = shot_key
        team_cfg = teams[team_key]
        team_players = personnel[team_key]
        base_row = event_row_by_key.get(shot_key, {})
        phase = str(base_row.get("phase", "build_up") or "build_up").strip().lower()
        shot_zone = shot_row.get("zone", base_row.get("zone", "central_zone"))
        shot_side = _zone_side(
            shot_zone,
            shot_row.get("attack_side", base_row.get("attack_side", "center")),
        )
        support_from, support_to = _support_players(team_players, shot_side)
        events.append(_base_pass_event(minute, team_key, support_from, shot_zone, shot_side, phase))
        shooter_fallback = team_players["striker"] if shot_side == "center" else support_to
        shooter = _resolve_player_label(
            team_key,
            team_cfg,
            rosters,
            shot_row.get("player", ""),
            shooter_fallback,
        )
        shot_x, shot_y = _point_for_action(minute, team_key, shot_zone, shot_side, phase, advanced=True)
        precise_coords = _shot_coordinates_from_row(shot_row, team_key)
        if precise_coords is not None:
            shot_x, shot_y = precise_coords
        assist_event_type = "cross" if _normalize(shot_row.get("body_part", "")) == "head" else "pass"
        assist_x, assist_y = _point_for_action(minute, team_key, shot_zone, shot_side, phase)
        creator = support_to if assist_event_type == "cross" else support_from
        events.append(
            _event(
                minute * 60 + 10,
                team_key,
                creator,
                assist_event_type,
                assist_x,
                assist_y,
                success=True,
            )
        )
        events.append(
            _event(
                minute * 60 + 12,
                team_key,
                shooter,
                "shot",
                shot_x,
                shot_y,
                success=str(shot_row.get("result", "")).strip().lower() == "goal",
                xg=_coerce_csv_float(shot_row.get("xg", "0.0")),
                extras=_shot_visual_extras(shot_row, team_key, shot_x, shot_y),
            )
        )

    target_possession: Dict[str, float] = {}
    for row in summary_rows:
        team_key = TEAM_KEY_BY_LABEL.get(_normalize(row.get("team", "")))
        if not team_key:
            continue
        pct = _coerce_csv_float(row.get("public_possession_pct", row.get("synthetic_minute_share_pct", "0")))
        if pct > 0:
            target_possession[team_key] = pct / 100.0

    successful_pass_counts = {
        "Team_A": sum(1 for event in events if event["team"] == "Team_A" and event["event_type"] == "pass" and event["success"]),
        "Team_B": sum(1 for event in events if event["team"] == "Team_B" and event["event_type"] == "pass" and event["success"]),
    }
    total_successful_passes = successful_pass_counts["Team_A"] + successful_pass_counts["Team_B"]
    for team_key, target_share in target_possession.items():
        current = successful_pass_counts.get(team_key, 0)
        denominator = max(0.05, 1.0 - target_share)
        needed = int(round((target_share * total_successful_passes - current) / denominator))
        if needed <= 0:
            continue
        team_minutes = sorted(
            {
                _coerce_csv_int(row.get("minute", "0"))
                for row in event_rows
                if TEAM_KEY_BY_LABEL.get(_normalize(row.get("team", "")), "Team_A") == team_key
            }
        )
        if not team_minutes:
            team_minutes = sorted({int(event["minute"]) for event in events if event["team"] == team_key})
        if not team_minutes:
            continue
        team_players = personnel[team_key]
        for idx in range(needed):
            minute = team_minutes[idx % len(team_minutes)]
            base_row = event_row_by_key.get((minute, team_key), {})
            side = _zone_side(base_row.get("zone", "middle_third"), base_row.get("attack_side", "center"))
            phase = str(base_row.get("phase", "build_up") or "build_up").strip().lower()
            zone = base_row.get("zone", "middle_third")
            passer = team_players["pivot"] if idx % 2 == 0 else _support_players(team_players, side)[1]
            x, y = _point_for_action(minute, team_key, zone, side, phase)
            events.append(
                _event(
                    minute * 60 + 18 + (idx % 3) * 2,
                    team_key,
                    passer,
                    "pass",
                    x,
                    y,
                    success=True,
                )
            )

    events.sort(key=lambda row: (int(row["time"]), str(row["team"]), str(row["player_id"])))
    return events


def _base_possession_sequence(minute: int, team: str, first: str, second: str, opponent: str, side: str, start_sec: int) -> List[dict]:
    if team == "Team_A":
        if side == "right":
            p1 = (43.0, 49.0)
            p2 = (60.0, 57.0)
        elif side == "left":
            p1 = (42.0, 18.0)
            p2 = (58.0, 15.0)
        else:
            p1 = (44.0, 33.0)
            p2 = (61.0, 35.0)
        end = (p2[0] + 2.0, p2[1])
    else:
        if side == "right":
            p1 = (62.0, 50.0)
            p2 = (46.0, 57.0)
        elif side == "left":
            p1 = (63.0, 16.0)
            p2 = (48.0, 14.0)
        else:
            p1 = (61.0, 34.0)
            p2 = (46.0, 33.0)
        end = (p2[0] - 2.0, p2[1])
    base = minute * 60 + start_sec
    return [
        _event(base, team, first, "pass", *p1, success=True),
        _event(base + 2, team, second, "pass", *p2, success=True),
        _event(base + 4, opponent, opponent, "tackle", *end, success=True),
    ]


def _home_cross_sequence(minute: int, creator: str, shooter: str, xg: float, goal: bool, start_sec: int) -> List[dict]:
    base = minute * 60 + start_sec
    return [
        _event(base, "Team_A", creator, "pass", 48.0, 50.0, success=True),
        _event(base + 2, "Team_A", creator, "cross", 76.0, 58.0, success=True),
        _event(base + 4, "Team_A", shooter, "shot", 93.0, 34.0, success=goal, xg=xg),
    ]


def _home_halfspace_sequence(minute: int, creator: str, shooter: str, xg: float, goal: bool, start_sec: int) -> List[dict]:
    base = minute * 60 + start_sec
    return [
        _event(base, "Team_A", creator, "pass", 51.0, 46.0, success=True),
        _event(base + 2, "Team_A", shooter, "pass", 73.0, 40.0, success=True),
        _event(base + 4, "Team_A", shooter, "shot", 88.0, 36.0, success=goal, xg=xg),
    ]


def _away_transition_sequence(minute: int, creator: str, shooter: str, xg: float, goal: bool, start_sec: int) -> List[dict]:
    base = minute * 60 + start_sec
    return [
        _event(base, "Team_B", creator, "pass", 54.0, 50.0, success=True),
        _event(base + 2, "Team_B", creator, "cross", 30.0, 48.0, success=True),
        _event(base + 4, "Team_B", shooter, "shot", 15.0, 34.0, success=goal, xg=xg),
    ]


def _away_central_sequence(minute: int, creator: str, shooter: str, xg: float, goal: bool, start_sec: int) -> List[dict]:
    base = minute * 60 + start_sec
    return [
        _event(base, "Team_B", creator, "pass", 56.0, 35.0, success=True),
        _event(base + 2, "Team_B", shooter, "pass", 34.0, 33.0, success=True),
        _event(base + 4, "Team_B", shooter, "shot", 18.0, 35.0, success=goal, xg=xg),
    ]


def _build_uzbekistan_gabon_fallback_frames(rosters: Dict[str, Sequence[Any]] | None = None) -> Dict[str, object]:
    teams = _build_uzbekistan_gabon_team_config(rosters)
    home_cfg = teams["Team_A"]
    away_cfg = teams["Team_B"]

    home_rb = home_cfg["players"]["DEF"][0]
    home_dm = home_cfg["players"]["MID"][0]
    home_ganiev = _find_label_in_rosters(rosters, "A. Ganiev", "7 A. Ganiev")
    home_urozov = _find_player(home_cfg, "Jakhongir Urozov", home_cfg["players"]["FWD"][0])
    home_rw = home_cfg["players"]["FWD"][0]
    home_shomurodov = _find_player(home_cfg, "Eldor Shomurodov", home_cfg["players"]["FWD"][1])
    home_odilov = _find_label_in_rosters(rosters, "Alisher Odilov", "18 Alisher Odilov")

    away_rb = away_cfg["players"]["DEF"][0]
    away_dm = away_cfg["players"]["MID"][0]
    away_babicka = _find_label_in_rosters(rosters, "S. W. Babicka", "11 S. W. Babicka")
    away_cm = away_cfg["players"]["MID"][2]
    away_averlant = _find_player(away_cfg, "Teddy Averlant", away_cfg["players"]["FWD"][1])
    away_cf = away_cfg["players"]["FWD"][2]

    positions: List[dict] = []
    physical: List[dict] = []
    events: List[dict] = []

    for minute in range(96):
        positions.extend(_build_positions("Team_A", home_cfg, minute))
        positions.extend(_build_positions("Team_B", away_cfg, minute))
        physical.extend(_build_physical("Team_A", home_cfg, minute))
        physical.extend(_build_physical("Team_B", away_cfg, minute))

        home_side = "right" if minute % 10 < 7 else ("center" if minute % 2 else "left")
        away_side = "right" if minute < 15 and minute % 2 == 0 else ("center" if minute % 3 else "left")

        events.extend(
            _base_possession_sequence(
                minute,
                "Team_A",
                home_ganiev if home_side == "right" else home_dm,
                home_rw if home_side == "right" else home_rb,
                away_dm,
                home_side,
                2,
            )
        )
        events.extend(
            _base_possession_sequence(
                minute,
                "Team_B",
                away_babicka if away_side == "right" else away_dm,
                away_rb if away_side == "right" else away_cm,
                home_dm,
                away_side,
                20,
            )
        )

        if 25 <= minute < 70 and minute % 2 == 0:
            events.extend(
                _base_possession_sequence(
                    minute,
                    "Team_A",
                    home_rb,
                    home_ganiev,
                    away_dm,
                    "right",
                    40,
                )
            )

        if minute < 10 and minute % 2 == 0:
            events.extend(
                _base_possession_sequence(
                    minute,
                    "Team_B",
                    away_dm,
                    away_babicka,
                    home_dm,
                    "right",
                    46,
                )
            )

    home_shots = [
        (14, "cross", home_ganiev, home_shomurodov, 0.24, True),
        (18, "cross", home_rw, home_odilov, 0.15, False),
        (24, "halfspace", home_ganiev, home_urozov, 0.10, False),
        (29, "cross", home_ganiev, home_shomurodov, 0.09, False),
        (33, "cross", home_rw, home_odilov, 0.18, False),
        (41, "halfspace", home_dm, home_urozov, 0.13, False),
        (48, "cross", home_ganiev, home_shomurodov, 0.08, False),
        (52, "cross", home_rw, home_shomurodov, 0.12, False),
        (59, "halfspace", home_rb, home_urozov, 0.21, True),
        (63, "cross", home_ganiev, home_odilov, 0.16, False),
        (67, "cross", home_rw, home_shomurodov, 0.07, False),
        (71, "halfspace", home_ganiev, home_odilov, 0.19, False),
        (76, "halfspace", home_dm, home_urozov, 0.09, False),
        (81, "cross", home_ganiev, home_shomurodov, 0.14, False),
        (87, "cross", home_rw, home_odilov, 0.08, False),
        (95, "halfspace", home_ganiev, home_odilov, 0.23, True),
    ]
    away_shots = [
        (3, "central", away_dm, away_babicka, 0.07, False),
        (6, "transition", away_babicka, away_averlant, 0.18, True),
        (10, "transition", away_babicka, away_averlant, 0.10, False),
        (27, "central", away_cm, away_babicka, 0.05, False),
        (38, "transition", away_babicka, away_averlant, 0.12, False),
        (57, "central", away_cm, away_cf, 0.08, False),
        (74, "transition", away_babicka, away_cf, 0.06, False),
        (82, "central", away_babicka, away_averlant, 0.15, False),
        (88, "transition", away_babicka, away_cf, 0.09, False),
    ]

    for minute, pattern, creator, shooter, xg, goal in home_shots:
        if pattern == "cross":
            events.extend(_home_cross_sequence(minute, creator, shooter, xg, goal, 30))
        else:
            events.extend(_home_halfspace_sequence(minute, creator, shooter, xg, goal, 30))

    for minute, pattern, creator, shooter, xg, goal in away_shots:
        if pattern == "transition":
            events.extend(_away_transition_sequence(minute, creator, shooter, xg, goal, 10))
        else:
            events.extend(_away_central_sequence(minute, creator, shooter, xg, goal, 10))

    events.sort(key=lambda row: (int(row["time"]), str(row["team"]), str(row["player_id"])))
    return {
        "preset_id": "uzbekistan_gabon_2026",
        "teams": teams,
        "positions": positions,
        "physical": physical,
        "events": events,
        "max_minute": 95,
    }


def build_uzbekistan_gabon_hybrid_frames(rosters: Dict[str, Sequence[Any]] | None = None) -> Dict[str, object]:
    teams = _build_uzbekistan_gabon_team_config(rosters)
    home_cfg = teams["Team_A"]
    away_cfg = teams["Team_B"]
    dataset = _dataset_rows()
    if dataset is None:
        return _build_uzbekistan_gabon_fallback_frames(rosters)

    event_rows, shot_rows, summary_rows, event_source = dataset
    positions: List[dict] = []
    physical: List[dict] = []

    for minute in range(96):
        positions.extend(_build_positions("Team_A", home_cfg, minute))
        positions.extend(_build_positions("Team_B", away_cfg, minute))
        physical.extend(_build_physical("Team_A", home_cfg, minute))
        physical.extend(_build_physical("Team_B", away_cfg, minute))

    events = _build_csv_driven_events(event_rows, shot_rows, summary_rows, teams, rosters)
    return {
        "preset_id": "uzbekistan_gabon_2026",
        "teams": teams,
        "positions": positions,
        "physical": physical,
        "events": events,
        "max_minute": 95,
        "team_summary": summary_rows,
        "event_source": event_source,
    }


def load_hybrid_preset(
    match_info: Dict[str, str] | None,
    rosters: Dict[str, Sequence[Any]] | None = None,
) -> Dict[str, object] | None:
    preset_id = identify_hybrid_preset(match_info)
    if preset_id == "uzbekistan_gabon_2026":
        return build_uzbekistan_gabon_hybrid_frames(rosters)
    return None
