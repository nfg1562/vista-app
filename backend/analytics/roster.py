from __future__ import annotations

from typing import Dict, List

import pandas as pd

from backend.analytics.substitutions import extract_player_number


def default_roster_df(
    team_id: str,
    count: int,
    start_number: int,
    player_ids: List[str],
    player_name_map: Dict[str, str],
) -> pd.DataFrame:
    rows = []
    for idx in range(count):
        pid = player_ids[idx] if idx < len(player_ids) else f"{team_id}_{idx + 1}"
        label = player_name_map.get(pid, pid)
        number = extract_player_number(label)
        if number is None:
            number = start_number + idx
        name = str(label)
        if name.startswith("Team_A_") or name.startswith("Team_B_"):
            name = ""
        if name.strip().isdigit():
            name = ""
        if name and name.split()[0].isdigit():
            name = " ".join(name.split()[1:])
        rows.append({"numero": number, "nom": name})
    return pd.DataFrame(rows)


def build_roster_list_from_df(df: pd.DataFrame) -> List[str]:
    roster = []
    if df is None or df.empty:
        return roster
    for _, row in df.iterrows():
        num = str(row.get("numero", "")).strip()
        name = str(row.get("nom", "")).strip()
        if not name or name.lower() == "nan":
            continue
        if num and num.lower() != "nan":
            roster.append(f"{num} {name}")
        else:
            roster.append(name)
    return roster
