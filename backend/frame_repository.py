from __future__ import annotations

import json
import os
import sqlite3
from typing import Iterable, Optional, Sequence, Tuple

from storage_paths import resolve_data_dir


class FrameRepository:
    def __init__(self, db_path: Optional[str] = None) -> None:
        if db_path is None:
            explicit = os.getenv("VISTA_FRAME_DB_PATH", "").strip()
            if explicit:
                db_path = explicit
            else:
                db_path = str(resolve_data_dir() / "match_frames.db")
        self.db_path = db_path
        self._ensure_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS frames (
                    match_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    time INTEGER NOT NULL,
                    minute INTEGER NOT NULL,
                    payload TEXT NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_frames_match_kind_minute "
                "ON frames(match_id, kind, minute)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_frames_match_time "
                "ON frames(match_id, time)"
            )

    def clear_match(self, match_id: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM frames WHERE match_id = ?", (match_id,))

    def insert_frames(self, match_id: str, kind: str, frames: Sequence[dict]) -> int:
        if not frames:
            return 0
        rows = []
        for frame in frames:
            time_val = int(frame.get("time", 0))
            minute_val = int(frame.get("minute", time_val // 60))
            payload = json.dumps(frame)
            rows.append((match_id, kind, time_val, minute_val, payload))
        with self._connect() as conn:
            conn.executemany(
                "INSERT INTO frames(match_id, kind, time, minute, payload) VALUES (?, ?, ?, ?, ?)",
                rows,
            )
        return len(rows)

    def get_frames_up_to_minute(self, match_id: str, kind: str, minute: int) -> list[dict]:
        with self._connect() as conn:
            cursor = conn.execute(
                "SELECT payload FROM frames WHERE match_id = ? AND kind = ? AND minute <= ? ORDER BY time ASC",
                (match_id, kind, minute),
            )
            rows = cursor.fetchall()
        return [json.loads(row["payload"]) for row in rows]

    def get_available_minutes(self, match_id: str) -> Tuple[Optional[int], Optional[int]]:
        with self._connect() as conn:
            cursor = conn.execute(
                "SELECT MIN(minute) AS min_minute, MAX(minute) AS max_minute "
                "FROM frames WHERE match_id = ?",
                (match_id,),
            )
            row = cursor.fetchone()
        if not row or row["min_minute"] is None or row["max_minute"] is None:
            return None, None
        return int(row["min_minute"]), int(row["max_minute"])

    def has_frames(self, match_id: str) -> bool:
        min_minute, max_minute = self.get_available_minutes(match_id)
        return min_minute is not None and max_minute is not None
