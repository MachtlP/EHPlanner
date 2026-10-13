import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = Path(os.environ.get("DATABASE_PATH", ROOT / "data" / "planner.db"))

PALETTE = ("#2f5d50", "#8d4b32", "#3d5278", "#6b4c7a", "#8a6a2f", "#2f5f6b")
SEED_STREAMS = (
    ("Uni", "#2f5d50"),
    ("Car", "#8d4b32"),
    ("Private", "#3d5278"),
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db() -> None:
    with session() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS streams (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                color TEXT NOT NULL,
                position INTEGER NOT NULL,
                show_matrix INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY,
                stream_id INTEGER NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT '',
                important INTEGER NOT NULL DEFAULT 0,
                urgent INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'open',
                scheduled_on TEXT,
                completed_on TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS calendars (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                url TEXT NOT NULL,
                color TEXT NOT NULL
            )
            """
        )
        ensure_column(conn, "streams", "show_matrix", "INTEGER NOT NULL DEFAULT 0")
        ensure_column(conn, "streams", "archived", "INTEGER NOT NULL DEFAULT 0")
        ensure_column(conn, "tasks", "scheduled_on", "TEXT")
        ensure_column(conn, "tasks", "completed_on", "TEXT")
        ensure_column(conn, "tasks", "plan_start", "INTEGER")
        ensure_column(conn, "tasks", "plan_end", "INTEGER")
        ensure_column(conn, "tasks", "estimate_min", "INTEGER")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS time_entries (
                id INTEGER PRIMARY KEY,
                day TEXT NOT NULL,
                note TEXT NOT NULL,
                minutes INTEGER NOT NULL,
                stream_id INTEGER REFERENCES streams(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        ensure_column(conn, "time_entries", "start_min", "INTEGER")
        ensure_column(conn, "time_entries", "end_min", "INTEGER")
        backfill_time_span(conn)
        backfill_completed_on(conn)
        count = conn.execute("SELECT COUNT(*) AS n FROM streams").fetchone()["n"]
        if count == 0:
            created = now()
            for position, (name, color) in enumerate(SEED_STREAMS):
                conn.execute(
                    "INSERT INTO streams (name, color, position, created_at) VALUES (?, ?, ?, ?)",
                    (name, color, position, created),
                )
        seed_calendars(conn)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('app_name', 'Machtls-Planner')"
        )


@contextmanager
def session():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def ensure_column(conn: sqlite3.Connection, table: str, name: str, definition: str) -> None:
    have = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    if name not in have:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")


def backfill_time_span(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        "SELECT id, minutes FROM time_entries WHERE start_min IS NULL OR end_min IS NULL"
    ).fetchall()
    for row in rows:
        start = 9 * 60
        end = min(start + max(int(row["minutes"] or 60), 15), 23 * 60 + 59)
        conn.execute(
            "UPDATE time_entries SET start_min = ?, end_min = ?, minutes = ? WHERE id = ?",
            (start, end, end - start, row["id"]),
        )


def backfill_completed_on(conn: sqlite3.Connection) -> None:
    zone = ZoneInfo("America/Vancouver")
    rows = conn.execute(
        """
        SELECT id, updated_at FROM tasks
        WHERE status = 'done' AND (completed_on IS NULL OR completed_on = '')
        """
    ).fetchall()
    for row in rows:
        raw = row["updated_at"] or ""
        try:
            moment = datetime.fromisoformat(raw)
            if moment.tzinfo is None:
                moment = moment.replace(tzinfo=timezone.utc)
            day = moment.astimezone(zone).date().isoformat()
        except ValueError:
            day = raw[:10]
        conn.execute("UPDATE tasks SET completed_on = ? WHERE id = ?", (day, row["id"]))


def seed_calendars(conn: sqlite3.Connection) -> None:
    count = conn.execute("SELECT COUNT(*) AS n FROM calendars").fetchone()["n"]
    if count:
        return
    path = ROOT / "data" / "calendars.json"
    if not path.exists():
        return
    items = json.loads(path.read_text())
    for item in items:
        conn.execute(
            "INSERT INTO calendars (name, url, color) VALUES (?, ?, ?)",
            (item["name"], item["url"], item["color"]),
        )


def next_color(conn: sqlite3.Connection) -> str:
    used = {row["color"] for row in conn.execute("SELECT color FROM streams")}
    for color in PALETTE:
        if color not in used:
            return color
    count = conn.execute("SELECT COUNT(*) AS n FROM streams").fetchone()["n"]
    return PALETTE[count % len(PALETTE)]
