"""SQLite-backed store for sprints."""

import json
import logging
import os
import sqlite3
import threading
from contextlib import closing
from datetime import datetime, timedelta, timezone

log = logging.getLogger(__name__)


def utcnow_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sprint_to_dict(row):
    return {
        "id": row["id"],
        "mix": row["mix"],
        "songs": json.loads(row["songs"]),
        "charts": json.loads(row["charts"]) if row["charts"] else [],
        "durationSeconds": row["duration_seconds"],
        "startedAt": row["started_at"],
        "endedAt": row["ended_at"],
        "status": row["status"],
    }


class SprintStore:
    def __init__(self, data_dir):
        os.makedirs(data_dir, exist_ok=True)
        self._path = os.path.join(data_dir, "sprints.db")
        self._lock = threading.Lock()
        with closing(self._connect()) as db:
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS sprints (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    mix TEXT NOT NULL,
                    songs TEXT NOT NULL,
                    charts TEXT,
                    duration_seconds INTEGER NOT NULL,
                    started_at TEXT NOT NULL,
                    ended_at TEXT,
                    status TEXT NOT NULL DEFAULT 'active'
                )
                """
            )
            cols = {r[1] for r in db.execute("PRAGMA table_info(sprints)")}
            if "charts" not in cols:
                db.execute("ALTER TABLE sprints ADD COLUMN charts TEXT")
            db.commit()

    def _connect(self):
        db = sqlite3.connect(self._path, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    def create(self, mix, songs, charts, duration_seconds):
        started = utcnow_iso()
        with self._lock, closing(self._connect()) as db:
            # End any stray active sprint first; only one is live at a time.
            db.execute(
                "UPDATE sprints SET status='ended_early', ended_at=? "
                "WHERE status='active'",
                (started,),
            )
            cur = db.execute(
                "INSERT INTO sprints (mix, songs, charts, duration_seconds, started_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (mix, json.dumps(songs), json.dumps(charts), duration_seconds, started),
            )
            db.commit()
        return self.get(cur.lastrowid)

    def get(self, sprint_id):
        with closing(self._connect()) as db:
            row = db.execute(
                "SELECT * FROM sprints WHERE id=?", (sprint_id,)
            ).fetchone()
        return sprint_to_dict(row) if row else None

    def latest(self, include_active_only=False):
        query = "SELECT * FROM sprints"
        if include_active_only:
            query += " WHERE status='active'"
        query += " ORDER BY id DESC LIMIT 1"
        with closing(self._connect()) as db:
            row = db.execute(query).fetchone()
        return sprint_to_dict(row) if row else None

    def current(self):
        """The sprint to show: an active one, else the most recent one."""
        sprint = self.latest(include_active_only=True)
        return sprint or self.latest()

    def end(self, sprint_id, status="completed"):
        ended = utcnow_iso()
        with self._lock, closing(self._connect()) as db:
            db.execute(
                "UPDATE sprints SET status=?, ended_at=? "
                "WHERE id=? AND status='active'",
                (status, ended, sprint_id),
            )
            db.commit()
        return self.get(sprint_id)

    def expire_if_due(self, now=None):
        """Mark a still-active sprint as completed once its time is up."""
        now = now or datetime.now(timezone.utc)
        with self._lock, closing(self._connect()) as db:
            rows = db.execute(
                "SELECT id, started_at, duration_seconds FROM sprints "
                "WHERE status='active'"
            ).fetchall()
            for row in rows:
                started = datetime.strptime(
                    row["started_at"], "%Y-%m-%dT%H:%M:%SZ"
                ).replace(tzinfo=timezone.utc)
                if started + timedelta(seconds=row["duration_seconds"]) <= now:
                    db.execute(
                        "UPDATE sprints SET status='completed', ended_at=? "
                        "WHERE id=?",
                        (now.strftime("%Y-%m-%dT%H:%M:%SZ"), row["id"]),
                    )
                    db.commit()
                    log.info("sprint %s auto-completed", row["id"])
                    return