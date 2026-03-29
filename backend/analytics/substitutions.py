from __future__ import annotations

from typing import Iterable


def compute_sub_windows(subs: Iterable[dict], halftime_minute: int, match_length: int) -> int:
    windows = set()
    if match_length <= halftime_minute:
        return 0
    second_half_len = match_length - halftime_minute
    split = halftime_minute + max(1, second_half_len // 2)
    for sub in subs:
        minute = int(sub.get("minute", 0))
        if minute == halftime_minute:
            continue
        if minute < halftime_minute:
            windows.add(1)
        elif minute < split:
            windows.add(2)
        else:
            windows.add(3)
    return len(windows)


def extract_player_number(player_label: str) -> int | None:
    if not player_label:
        return None
    parts = str(player_label).strip().replace("#", "").split()
    if parts and parts[0].isdigit():
        return int(parts[0])
    return None
