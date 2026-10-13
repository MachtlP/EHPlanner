import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
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
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        count = conn.execute("SELECT COUNT(*) AS n FROM streams").fetchone()["n"]
        if count == 0:
            created = now()
            for position, (name, color) in enumerate(SEED_STREAMS):
                conn.execute(
                    "INSERT INTO streams (name, color, position, created_at) VALUES (?, ?, ?, ?)",
                    (name, color, position, created),
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


def next_color(conn: sqlite3.Connection) -> str:
    used = {row["color"] for row in conn.execute("SELECT color FROM streams")}
    for color in PALETTE:
        if color not in used:
            return color
    count = conn.execute("SELECT COUNT(*) AS n FROM streams").fetchone()["n"]
    return PALETTE[count % len(PALETTE)]
