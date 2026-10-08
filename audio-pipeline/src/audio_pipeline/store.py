"""Small SQLite WAL job ledger for restart-safe pipeline work."""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def _now() -> str:
    return datetime.now(UTC).isoformat()


class JobStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        with self._connect() as db:
            db.executescript(
                """
                PRAGMA journal_mode=WAL;
                PRAGMA synchronous=FULL;
                PRAGMA foreign_keys=ON;
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    riffado_job_id TEXT NOT NULL,
                    duration_ms INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    phase TEXT NOT NULL,
                    progress REAL NOT NULL DEFAULT 0,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    cancel_requested INTEGER NOT NULL DEFAULT 0,
                    acknowledged INTEGER NOT NULL DEFAULT 0,
                    error_type TEXT,
                    error TEXT,
                    result_json TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS chunks (
                    id TEXT PRIMARY KEY,
                    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                    chunk_index INTEGER NOT NULL,
                    start_sample INTEGER NOT NULL,
                    end_sample INTEGER NOT NULL,
                    content_sha256 TEXT NOT NULL,
                    status TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    result_json TEXT,
                    error_type TEXT,
                    error TEXT,
                    UNIQUE(job_id, chunk_index)
                );
                CREATE INDEX IF NOT EXISTS jobs_status_created_idx
                    ON jobs(status, created_at);
                CREATE INDEX IF NOT EXISTS chunks_job_status_idx
                    ON chunks(job_id, status, chunk_index);
                """
            )

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=30, isolation_level="IMMEDIATE")
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=30000")
        return db

    def create(
        self, key: str, riffado_job_id: str, duration_ms: int
    ) -> tuple[dict[str, Any], bool]:
        with self._lock, self._connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE idempotency_key=?", (key,)).fetchone()
            if row:
                return self._job(row), False
            now = _now()
            db.execute(
                """INSERT INTO jobs
                   (id,idempotency_key,riffado_job_id,duration_ms,status,phase,created_at,updated_at)
                   VALUES (?,?,?,?,'queued','queued',?,?)""",
                (key, key, riffado_job_id, duration_ms, now, now),
            )
            row = db.execute("SELECT * FROM jobs WHERE id=?", (key,)).fetchone()
            return self._job(row), True

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            return self._job(row) if row else None

    def list_runnable(self) -> list[dict[str, Any]]:
        with self._lock, self._connect() as db:
            rows = db.execute(
                "SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at"
            ).fetchall()
            return [self._job(row) for row in rows]

    def list_paused(self) -> list[dict[str, Any]]:
        with self._lock, self._connect() as db:
            rows = db.execute("SELECT * FROM jobs WHERE status='paused'").fetchall()
            return [self._job(row) for row in rows]

    def resume(self, job_id: str) -> bool:
        with self._lock, self._connect() as db:
            cur = db.execute(
                """UPDATE jobs SET status='queued',phase='queued',error_type=NULL,
                   error=NULL,updated_at=? WHERE id=? AND status='paused'""",
                (_now(), job_id),
            )
            return cur.rowcount == 1

    def update(self, job_id: str, **values: Any) -> None:
        allowed = {
            "status",
            "phase",
            "progress",
            "attempts",
            "cancel_requested",
            "acknowledged",
            "error_type",
            "error",
            "result_json",
        }
        updates = {key: value for key, value in values.items() if key in allowed}
        if not updates:
            return
        if "result_json" in updates and not isinstance(updates["result_json"], str):
            updates["result_json"] = json.dumps(updates["result_json"], separators=(",", ":"))
        updates["updated_at"] = _now()
        clause = ",".join(f"{column}=?" for column in updates)
        with self._lock, self._connect() as db:
            db.execute(f"UPDATE jobs SET {clause} WHERE id=?", (*updates.values(), job_id))

    def is_cancelled(self, job_id: str) -> bool:
        job = self.get(job_id)
        return not job or bool(job["cancel_requested"])

    def upsert_chunks(self, job_id: str, chunks: list[dict[str, Any]]) -> None:
        with self._lock, self._connect() as db:
            for item in chunks:
                db.execute(
                    """INSERT INTO chunks
                       (id,job_id,chunk_index,start_sample,end_sample,content_sha256,status)
                       VALUES (?,?,?,?,?,?,'queued')
                       ON CONFLICT(job_id,chunk_index) DO NOTHING""",
                    (
                        item["id"],
                        job_id,
                        item["index"],
                        item["start_sample"],
                        item["end_sample"],
                        item["content_sha256"],
                    ),
                )

    def chunks(self, job_id: str) -> list[dict[str, Any]]:
        with self._lock, self._connect() as db:
            rows = db.execute(
                "SELECT * FROM chunks WHERE job_id=? ORDER BY chunk_index", (job_id,)
            ).fetchall()
            result = []
            for row in rows:
                item = dict(row)
                item["result"] = (
                    json.loads(item.pop("result_json")) if item["result_json"] else None
                )
                result.append(item)
            return result

    def update_chunk(self, chunk_id: str, **values: Any) -> None:
        allowed = {"status", "attempts", "content_sha256", "result_json", "error_type", "error"}
        updates = {key: value for key, value in values.items() if key in allowed}
        if "result_json" in updates and not isinstance(updates["result_json"], str):
            updates["result_json"] = json.dumps(updates["result_json"], separators=(",", ":"))
        if not updates:
            return
        clause = ",".join(f"{column}=?" for column in updates)
        with self._lock, self._connect() as db:
            db.execute(f"UPDATE chunks SET {clause} WHERE id=?", (*updates.values(), chunk_id))
            if updates.get("status") == "completed":
                row = db.execute("SELECT job_id FROM chunks WHERE id=?", (chunk_id,)).fetchone()
                if row:
                    db.execute(
                        """UPDATE jobs SET progress=MAX(
                               progress,
                               0.68 + 0.30 * (
                                   SELECT CAST(COUNT(*) AS REAL) FROM chunks
                                   WHERE job_id=? AND status='completed'
                               ) / MAX(1, (
                                   SELECT COUNT(*) FROM chunks WHERE job_id=?
                               ))
                           ) WHERE id=? AND status='running'""",
                        (row["job_id"], row["job_id"], row["job_id"]),
                    )

    def set_cancelled(self, job_id: str) -> bool:
        with self._lock, self._connect() as db:
            cur = db.execute(
                """UPDATE jobs SET cancel_requested=1,updated_at=? WHERE id=?
                   AND status IN ('queued','running','paused','failed')""",
                (_now(), job_id),
            )
            return cur.rowcount == 1

    def retry(self, job_id: str) -> bool:
        with self._lock, self._connect() as db:
            row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row or row["status"] != "failed":
                return False
            db.execute(
                """UPDATE chunks SET status='queued',attempts=0,error_type=NULL,error=NULL
                   WHERE job_id=? AND status='failed'""",
                (job_id,),
            )
            db.execute(
                """UPDATE jobs SET status='queued',phase='queued',progress=0,
                   cancel_requested=0,error_type=NULL,error=NULL,updated_at=? WHERE id=?""",
                (_now(), job_id),
            )
            return True

    def acknowledge(self, job_id: str) -> bool:
        with self._lock, self._connect() as db:
            cur = db.execute(
                """UPDATE jobs SET acknowledged=1,status='acknowledged',updated_at=?
                   WHERE id=? AND status IN ('completed','needs_alignment')""",
                (_now(), job_id),
            )
            return cur.rowcount == 1

    def repair_acknowledged_result(self, job_id: str, result: dict[str, Any]) -> bool:
        if result.get("schema_version") != 1 or result.get("status") != "completed":
            return False
        with self._lock, self._connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row or not row["acknowledged"] or row["status"] != "acknowledged":
                return False
            current = json.loads(row["result_json"]) if row["result_json"] else None
            if not current:
                return False
            if current.get("status") == "completed":
                return current == result
            if current.get("status") != "needs_alignment":
                return False
            db.execute(
                """UPDATE jobs SET result_json=?,phase='completed',progress=1,
                   error_type=NULL,error=NULL,updated_at=?
                   WHERE id=? AND acknowledged=1 AND status='acknowledged'""",
                (json.dumps(result, separators=(",", ":")), _now(), job_id),
            )
            return True

    @staticmethod
    def _job(row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        item["cancel_requested"] = bool(item["cancel_requested"])
        item["acknowledged"] = bool(item["acknowledged"])
        item["result"] = json.loads(item.pop("result_json")) if item["result_json"] else None
        return item
