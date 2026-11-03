"""SQLite store: every fetch is recorded; 'last good' is the newest ok row."""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS fetches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    location TEXT NOT NULL,
    source TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT,
    result_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_fetches ON fetches(location, source, fetched_at);
"""


class Store:
    def __init__(self, path: Path | str):
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(SCHEMA)

    def save(self, location: str, result: dict) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO fetches(location, source, fetched_at, ok, error, result_json) VALUES (?,?,?,?,?,?)",
                (location, result["source"], result["fetched_at"], int(result["ok"]),
                 result.get("error"), json.dumps(result)),
            )
            self._conn.commit()

    def _one(self, sql: str, args: tuple) -> dict | None:
        with self._lock:
            row = self._conn.execute(sql, args).fetchone()
        return json.loads(row["result_json"]) if row else None

    def latest(self, location: str, source: str) -> dict | None:
        return self._one(
            "SELECT result_json FROM fetches WHERE location=? AND source=? ORDER BY fetched_at DESC, id DESC LIMIT 1",
            (location, source),
        )

    def last_good(self, location: str, source: str) -> dict | None:
        return self._one(
            "SELECT result_json FROM fetches WHERE location=? AND source=? AND ok=1 ORDER BY fetched_at DESC, id DESC LIMIT 1",
            (location, source),
        )

    def prune(self, keep_days: int = 14) -> None:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=keep_days)).isoformat()
        with self._lock:
            self._conn.execute("DELETE FROM fetches WHERE fetched_at < ?", (cutoff,))
            self._conn.commit()
