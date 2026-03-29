from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime
import os
from typing import Dict, List, Optional, Sequence

from storage_paths import resolve_data_dir


META_TYPE = "__computed__"
META_RECOMMENDATION = "__computed__"


@dataclass
class RecoRow:
    match_id: str
    minute: int
    type: str
    recommendation: str
    priority: Optional[float] = None
    created_at: Optional[str] = None


class InMemoryRecoRepository:
    def __init__(self) -> None:
        self._data: Dict[str, Dict[int, List[RecoRow]]] = {}
        self._computed: Dict[str, set[int]] = {}

    def upsert_minute(self, match_id: str, minute: int, reco_rows: Sequence[dict]) -> None:
        rows = [_row_from_dict(match_id, minute, row) for row in reco_rows]
        self._data.setdefault(match_id, {})[minute] = rows
        self._computed.setdefault(match_id, set()).add(int(minute))

    def get_minute(self, match_id: str, minute: int) -> List[dict]:
        rows = self._data.get(match_id, {}).get(minute, [])
        return [_row_to_dict(row) for row in rows]

    def get_range(self, match_id: str, start_minute: int, end_minute: int) -> List[dict]:
        result: List[dict] = []
        minutes = self._data.get(match_id, {})
        for minute in range(start_minute, end_minute + 1):
            for row in minutes.get(minute, []):
                result.append(_row_to_dict(row))
        return result

    def get_last_computed_minute(self, match_id: str) -> int:
        minutes = self._computed.get(match_id)
        if not minutes:
            return -1
        return max(minutes)

    def count_total(self, match_id: str) -> int:
        total = 0
        minutes = self._data.get(match_id, {})
        for rows in minutes.values():
            total += len(rows)
        return total

    def count_minute(self, match_id: str, minute: int) -> int:
        return len(self._data.get(match_id, {}).get(minute, []))

    def clear_match(self, match_id: str) -> None:
        self._data.pop(match_id, None)
        self._computed.pop(match_id, None)


class SQLiteRecoRepository:
    def __init__(self, db_path: Optional[str] = None) -> None:
        if db_path is None:
            explicit = os.getenv("VISTA_RECO_DB_PATH", "").strip()
            if explicit:
                db_path = explicit
            else:
                db_path = str(resolve_data_dir() / "recommendations.db")
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
                CREATE TABLE IF NOT EXISTS recommendations (
                    match_id TEXT NOT NULL,
                    minute INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    recommendation TEXT NOT NULL,
                    priority REAL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(match_id, minute, type, recommendation)
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_reco_match_minute "
                "ON recommendations(match_id, minute)"
            )

    def upsert_minute(self, match_id: str, minute: int, reco_rows: Sequence[dict]) -> None:
        now = datetime.utcnow().isoformat()
        rows = [_row_from_dict(match_id, minute, row, created_at=now) for row in reco_rows]
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM recommendations WHERE match_id = ? AND minute = ?",
                (match_id, minute),
            )
            if rows:
                conn.executemany(
                    """
                    INSERT OR REPLACE INTO recommendations
                    (match_id, minute, type, recommendation, priority, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    [
                        (
                            row.match_id,
                            row.minute,
                            row.type,
                            row.recommendation,
                            row.priority,
                            row.created_at or now,
                        )
                        for row in rows
                    ],
                )
            conn.execute(
                """
                INSERT OR REPLACE INTO recommendations
                (match_id, minute, type, recommendation, priority, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (match_id, minute, META_TYPE, META_RECOMMENDATION, None, now),
            )

    def get_minute(self, match_id: str, minute: int) -> List[dict]:
        with self._connect() as conn:
            cursor = conn.execute(
                """
                SELECT match_id, minute, type, recommendation, priority, created_at
                FROM recommendations
                WHERE match_id = ? AND minute = ? AND type != ?
                ORDER BY priority DESC
                """,
                (match_id, minute, META_TYPE),
            )
            rows = cursor.fetchall()
        return [_row_to_dict(_row_from_sql(row)) for row in rows]

    def get_range(self, match_id: str, start_minute: int, end_minute: int) -> List[dict]:
        with self._connect() as conn:
            cursor = conn.execute(
                """
                SELECT match_id, minute, type, recommendation, priority, created_at
                FROM recommendations
                WHERE match_id = ? AND minute BETWEEN ? AND ? AND type != ?
                ORDER BY minute ASC, priority DESC
                """,
                (match_id, start_minute, end_minute, META_TYPE),
            )
            rows = cursor.fetchall()
        return [_row_to_dict(_row_from_sql(row)) for row in rows]

    def get_last_computed_minute(self, match_id: str) -> int:
        with self._connect() as conn:
            cursor = conn.execute(
                "SELECT MAX(minute) AS max_minute FROM recommendations WHERE match_id = ? AND type = ?",
                (match_id, META_TYPE),
            )
            row = cursor.fetchone()
        if not row or row["max_minute"] is None:
            return -1
        return int(row["max_minute"])

    def count_total(self, match_id: str) -> int:
        with self._connect() as conn:
            cursor = conn.execute(
                "SELECT COUNT(*) AS total FROM recommendations WHERE match_id = ? AND type != ?",
                (match_id, META_TYPE),
            )
            row = cursor.fetchone()
        return int(row["total"]) if row else 0

    def count_minute(self, match_id: str, minute: int) -> int:
        with self._connect() as conn:
            cursor = conn.execute(
                "SELECT COUNT(*) AS total FROM recommendations WHERE match_id = ? AND minute = ? AND type != ?",
                (match_id, minute, META_TYPE),
            )
            row = cursor.fetchone()
        return int(row["total"]) if row else 0

    def clear_match(self, match_id: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM recommendations WHERE match_id = ?", (match_id,))


def _row_from_dict(
    match_id: str,
    minute: int,
    row: dict,
    created_at: Optional[str] = None,
) -> RecoRow:
    return RecoRow(
        match_id=match_id,
        minute=int(row.get("minute", minute)),
        type=str(row.get("type", "Analyse")),
        recommendation=str(row.get("recommendation", "")).strip(),
        priority=row.get("priority"),
        created_at=created_at,
    )


def _row_from_sql(row: sqlite3.Row) -> RecoRow:
    return RecoRow(
        match_id=row["match_id"],
        minute=int(row["minute"]),
        type=row["type"],
        recommendation=row["recommendation"],
        priority=row["priority"],
        created_at=row["created_at"],
    )


def _row_to_dict(row: RecoRow) -> dict:
    return {
        "match_id": row.match_id,
        "minute": row.minute,
        "type": row.type,
        "recommendation": row.recommendation,
        "priority": row.priority,
        "created_at": row.created_at,
    }
