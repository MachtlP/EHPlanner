from contextlib import asynccontextmanager
import re
from datetime import date, timedelta
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.calendars import CACHE, events_for_range, http_url, monday_of, today
from app.db import init_db, next_color, now, session

STATIC = Path(__file__).resolve().parent / "static"
TASK_FIELDS = {
    "stream_id", "title", "note", "important", "urgent", "status", "scheduled_on",
    "plan_start", "plan_end", "estimate_min",
}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(lifespan=lifespan)


def clean_text(value: str, limit: int, label: str) -> str:
    cleaned = " ".join(value.split())
    if not cleaned or len(cleaned) > limit:
        raise HTTPException(status_code=400, detail=f"{label} must be 1–{limit} characters")
    return cleaned


def stream_or_404(conn, stream_id: int):
    row = conn.execute("SELECT * FROM streams WHERE id = ?", (stream_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Stream not found")
    return row


def live_stream_or_404(conn, stream_id: int):
    row = stream_or_404(conn, stream_id)
    if row["archived"]:
        raise HTTPException(status_code=400, detail="That stream is in the graveyard")
    return row


def task_or_404(conn, task_id: int):
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return row


def clean_day(value) -> str | None:
    if value is None or value == "":
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise HTTPException(status_code=400, detail="Day must be YYYY-MM-DD") from None


def dump_stream(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "color": row["color"],
        "position": row["position"],
        "show_matrix": bool(row["show_matrix"]),
        "archived": bool(row["archived"]),
    }


def dump_task(row) -> dict:
    return {
        "id": row["id"],
        "stream_id": row["stream_id"],
        "title": row["title"],
        "note": row["note"],
        "important": bool(row["important"]),
        "urgent": bool(row["urgent"]),
        "status": row["status"],
        "scheduled_on": row["scheduled_on"],
        "plan_start": minutes_to_clock(row["plan_start"]) if row["plan_start"] is not None else None,
        "plan_end": minutes_to_clock(row["plan_end"]) if row["plan_end"] is not None else None,
        "estimate_min": row["estimate_min"],
        "completed_on": row["completed_on"],
        "updated_at": row["updated_at"],
    }


class StreamCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class StreamUpdate(BaseModel):
    name: str | None = None
    show_matrix: bool | None = None
    archived: bool | None = None


class TaskCreate(BaseModel):
    stream_id: int
    title: str
    note: str = ""
    important: bool = False
    urgent: bool = False
    scheduled_on: str | None = None


class TaskUpdate(BaseModel):
    stream_id: int | None = None
    title: str | None = None
    note: str | None = None
    important: bool | None = None
    urgent: bool | None = None
    status: str | None = None
    scheduled_on: str | None = None
    plan_mode: str | None = None
    plan_start: str | None = None
    plan_end: str | None = None
    estimate_hours: float | None = None


class WeekFill(BaseModel):
    start: str | None = None


@app.get("/api/streams")
def list_streams():
    with session() as conn:
        rows = conn.execute("SELECT * FROM streams ORDER BY position, id").fetchall()
    return [dump_stream(row) for row in rows]


@app.post("/api/streams", status_code=201)
def create_stream(body: StreamCreate):
    name = clean_text(body.name, 40, "Name")
    with session() as conn:
        exists = conn.execute(
            "SELECT id FROM streams WHERE name = ? COLLATE NOCASE", (name,)
        ).fetchone()
        if exists:
            raise HTTPException(status_code=409, detail="A stream with that name already exists")
        position = conn.execute("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM streams").fetchone()["p"]
        created = now()
        cur = conn.execute(
            "INSERT INTO streams (name, color, position, created_at) VALUES (?, ?, ?, ?)",
            (name, next_color(conn), position, created),
        )
        row = conn.execute("SELECT * FROM streams WHERE id = ?", (cur.lastrowid,)).fetchone()
    return dump_stream(row)


@app.patch("/api/streams/{stream_id}")
def update_stream(stream_id: int, body: StreamUpdate):
    changes = body.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=400, detail="No changes")
    if "name" in changes:
        changes["name"] = clean_text(changes["name"], 40, "Name")
    if "show_matrix" in changes:
        changes["show_matrix"] = int(changes["show_matrix"])
    if "archived" in changes:
        changes["archived"] = int(changes["archived"])
    with session() as conn:
        stream_or_404(conn, stream_id)
        if "name" in changes:
            exists = conn.execute(
                "SELECT id FROM streams WHERE name = ? COLLATE NOCASE AND id != ?",
                (changes["name"], stream_id),
            ).fetchone()
            if exists:
                raise HTTPException(status_code=409, detail="A stream with that name already exists")
        assignments = ", ".join(f"{column} = ?" for column in changes)
        conn.execute(
            f"UPDATE streams SET {assignments} WHERE id = ?",
            [changes[column] for column in changes] + [stream_id],
        )
        row = conn.execute("SELECT * FROM streams WHERE id = ?", (stream_id,)).fetchone()
    return dump_stream(row)


@app.delete("/api/streams/{stream_id}", status_code=204)
def delete_stream(stream_id: int):
    with session() as conn:
        stream_or_404(conn, stream_id)
        conn.execute("DELETE FROM tasks WHERE stream_id = ?", (stream_id,))
        conn.execute("DELETE FROM streams WHERE id = ?", (stream_id,))
    return Response(status_code=204)


@app.get("/api/tasks")
def list_tasks():
    with session() as conn:
        rows = conn.execute("SELECT * FROM tasks ORDER BY updated_at DESC, id DESC").fetchall()
    return [dump_task(row) for row in rows]


@app.post("/api/tasks", status_code=201)
def create_task(body: TaskCreate):
    title = clean_text(body.title, 200, "Title")
    note = body.note.strip()
    if len(note) > 2000:
        raise HTTPException(status_code=400, detail="Note must be at most 2000 characters")
    scheduled_on = clean_day(body.scheduled_on)
    stamp = now()
    with session() as conn:
        live_stream_or_404(conn, body.stream_id)
        cur = conn.execute(
            """
            INSERT INTO tasks (
                stream_id, title, note, important, urgent, status, scheduled_on, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)
            """,
            (body.stream_id, title, note, int(body.important), int(body.urgent), scheduled_on, stamp, stamp),
        )
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (cur.lastrowid,)).fetchone()
    return dump_task(row)


@app.patch("/api/tasks/{task_id}")
def update_task(task_id: int, body: TaskUpdate):
    changes = body.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=400, detail="No changes")
    if "status" in changes and changes["status"] not in ("open", "done"):
        raise HTTPException(status_code=400, detail="Status must be open or done")
    if "title" in changes:
        changes["title"] = clean_text(changes["title"], 200, "Title")
    if "note" in changes:
        changes["note"] = changes["note"].strip()
        if len(changes["note"]) > 2000:
            raise HTTPException(status_code=400, detail="Note must be at most 2000 characters")
    if "important" in changes:
        changes["important"] = int(changes["important"])
    if "urgent" in changes:
        changes["urgent"] = int(changes["urgent"])
    if "scheduled_on" in changes:
        changes["scheduled_on"] = clean_day(changes["scheduled_on"])
    mode = changes.pop("plan_mode", None)
    if mode == "clock":
        start_raw = changes.pop("plan_start", None)
        end_raw = changes.pop("plan_end", None)
        changes.pop("estimate_hours", None)
        if not start_raw or not end_raw:
            raise HTTPException(status_code=400, detail="Start and end are required")
        start_min = clock_to_minutes(start_raw)
        end_min = clock_to_minutes(end_raw)
        if end_min <= start_min:
            raise HTTPException(status_code=400, detail="End must be after start")
        if not changes.get("scheduled_on"):
            raise HTTPException(status_code=400, detail="Pick a day")
        changes["plan_start"] = start_min
        changes["plan_end"] = end_min
        changes["estimate_min"] = None
    elif mode == "estimate":
        changes.pop("plan_start", None)
        changes.pop("plan_end", None)
        hours = changes.pop("estimate_hours", None)
        if hours is None:
            raise HTTPException(status_code=400, detail="Hours are required")
        minutes = int(round(float(hours) * 60))
        if minutes < 15 or minutes > 24 * 60:
            raise HTTPException(status_code=400, detail="Estimate must be between 0.25 and 24 hours")
        if not changes.get("scheduled_on"):
            raise HTTPException(status_code=400, detail="Pick a day")
        changes["estimate_min"] = minutes
        changes["plan_start"] = None
        changes["plan_end"] = None
    elif mode == "none":
        changes.pop("plan_start", None)
        changes.pop("plan_end", None)
        changes.pop("estimate_hours", None)
        changes["scheduled_on"] = None
        changes["plan_start"] = None
        changes["plan_end"] = None
        changes["estimate_min"] = None
    elif mode:
        raise HTTPException(status_code=400, detail="Plan must be on the clock or an estimate")
    else:
        changes.pop("plan_start", None)
        changes.pop("plan_end", None)
        changes.pop("estimate_hours", None)
        if "scheduled_on" in changes and changes["scheduled_on"] is None:
            changes["plan_start"] = None
            changes["plan_end"] = None
            changes["estimate_min"] = None
    unknown = set(changes) - TASK_FIELDS
    if unknown:
        raise HTTPException(status_code=400, detail="No changes")
    if changes.get("status") == "done":
        changes["completed_on"] = today().isoformat()
    elif changes.get("status") == "open":
        changes["completed_on"] = None
    changes["updated_at"] = now()
    columns = list(changes)
    assignments = ", ".join(f"{column} = ?" for column in columns)
    with session() as conn:
        task_or_404(conn, task_id)
        if "stream_id" in changes:
            live_stream_or_404(conn, changes["stream_id"])
        conn.execute(
            f"UPDATE tasks SET {assignments} WHERE id = ?",
            [changes[column] for column in columns] + [task_id],
        )
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return dump_task(row)


@app.delete("/api/tasks/{task_id}", status_code=204)
def delete_task(task_id: int):
    with session() as conn:
        task_or_404(conn, task_id)
        conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    return Response(status_code=204)


def week_bounds(start: str | None) -> tuple[date, date]:
    if not start:
        start_day = monday_of(today())
    else:
        try:
            start_day = monday_of(date.fromisoformat(start))
        except ValueError:
            raise HTTPException(status_code=400, detail="Week must be YYYY-MM-DD") from None
    return start_day, start_day + timedelta(days=6)


class SettingsUpdate(BaseModel):
    app_name: str


class CalendarCreate(BaseModel):
    name: str
    url: str
    color: str = "#0e61b9"


def clean_color(value: str) -> str:
    color = value.strip().lower()
    if not re.fullmatch(r"#[0-9a-f]{6}", color):
        raise HTTPException(status_code=400, detail="Pick a color")
    return color


def clean_calendar_url(value: str) -> str:
    raw = value.strip()
    if not raw.startswith(("webcal://", "https://", "http://")):
        raise HTTPException(status_code=400, detail="Use a webcal or https link")
    url = http_url(raw)
    if not url.startswith(("https://", "http://")) or len(url) > 2000:
        raise HTTPException(status_code=400, detail="Use a webcal or https link")
    return url


def dump_calendar(row) -> dict:
    return {"id": row["id"], "name": row["name"], "color": row["color"]}


@app.get("/api/settings")
def get_settings():
    with session() as conn:
        name = conn.execute("SELECT value FROM settings WHERE key = 'app_name'").fetchone()
        rows = conn.execute("SELECT id, name, color FROM calendars ORDER BY id").fetchall()
    return {
        "app_name": name["value"] if name else "Machtls-Planner",
        "calendars": [dump_calendar(row) for row in rows],
    }


@app.patch("/api/settings")
def update_settings(body: SettingsUpdate):
    name = clean_text(body.app_name, 40, "App name")
    with session() as conn:
        conn.execute(
            """
            INSERT INTO settings (key, value) VALUES ('app_name', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (name,),
        )
    return {"app_name": name}


@app.post("/api/calendars", status_code=201)
def create_calendar(body: CalendarCreate):
    name = clean_text(body.name, 80, "Name")
    url = clean_calendar_url(body.url)
    color = clean_color(body.color)
    with session() as conn:
        taken = conn.execute("SELECT id FROM calendars WHERE url = ?", (url,)).fetchone()
        if taken:
            raise HTTPException(status_code=400, detail="That calendar is already added")
        cur = conn.execute(
            "INSERT INTO calendars (name, url, color) VALUES (?, ?, ?)",
            (name, url, color),
        )
        row = conn.execute(
            "SELECT id, name, color FROM calendars WHERE id = ?",
            (cur.lastrowid,),
        ).fetchone()
    return dump_calendar(row)


@app.delete("/api/calendars/{calendar_id}", status_code=204)
def delete_calendar(calendar_id: int):
    with session() as conn:
        row = conn.execute("SELECT id FROM calendars WHERE id = ?", (calendar_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Calendar not found")
        conn.execute("DELETE FROM calendars WHERE id = ?", (calendar_id,))
    cache = CACHE / f"{calendar_id}.ics"
    if cache.exists():
        cache.unlink()
    return Response(status_code=204)


@app.get("/api/week")
def get_week(start: str | None = None, refresh: bool = False):
    start_day, end_day = week_bounds(start)
    with session() as conn:
        rows = conn.execute("SELECT id, name, url, color FROM calendars ORDER BY id").fetchall()
        calendars = [dict(row) for row in rows]
    events, warnings = events_for_range(calendars, start_day, end_day, refresh)
    return {
        "start": start_day.isoformat(),
        "events": events,
        "warnings": warnings,
        "calendars": [{"name": item["name"], "color": item["color"]} for item in calendars],
    }


@app.post("/api/week/fill")
def fill_week(body: WeekFill):
    start_day, _end_day = week_bounds(body.start)
    days = [start_day + timedelta(days=offset) for offset in range(7)]
    with session() as conn:
        taken = {
            row["scheduled_on"]
            for row in conn.execute(
                """
                SELECT scheduled_on FROM tasks
                WHERE status = 'open' AND scheduled_on IS NOT NULL AND scheduled_on != ''
                  AND stream_id IN (SELECT id FROM streams WHERE archived = 0)
                """
            )
        }
        free = [day for day in days if day >= today() and day.isoformat() not in taken]
        waiting = conn.execute(
            """
            SELECT id FROM tasks
            WHERE status = 'open' AND (scheduled_on IS NULL OR scheduled_on = '')
              AND stream_id IN (SELECT id FROM streams WHERE archived = 0)
            ORDER BY
                CASE
                    WHEN important = 1 AND urgent = 1 THEN 0
                    WHEN important = 1 THEN 1
                    WHEN urgent = 1 THEN 2
                    ELSE 3
                END,
                id
            """
        ).fetchall()
        if not waiting:
            message = "No open tasks are waiting for a day."
            placed = 0
        elif not free:
            message = "No open days left in this week."
            placed = 0
        else:
            stamp = now()
            pairs = list(zip(free, waiting))
            for day, task in pairs:
                conn.execute(
                    "UPDATE tasks SET scheduled_on = ?, updated_at = ? WHERE id = ?",
                    (day.isoformat(), stamp, task["id"]),
                )
            placed = len(pairs)
            extra = len(waiting) - placed
            message = f"Placed {placed} on the week."
            if extra:
                message += f" {extra} still waiting."
    return {"placed": placed, "message": message}


def clock_to_minutes(value: str) -> int:
    parts = str(value).split(":")
    if len(parts) < 2:
        raise HTTPException(status_code=400, detail="Time must be HH:MM")
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except ValueError:
        raise HTTPException(status_code=400, detail="Time must be HH:MM") from None
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise HTTPException(status_code=400, detail="Time must be HH:MM")
    return hour * 60 + minute


def minutes_to_clock(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def dump_time(row) -> dict:
    return {
        "id": row["id"],
        "day": row["day"],
        "note": row["note"],
        "start": minutes_to_clock(row["start_min"]),
        "end": minutes_to_clock(row["end_min"]),
        "minutes": row["minutes"],
        "stream_id": row["stream_id"],
    }


class TimeCreate(BaseModel):
    day: str
    note: str
    start: str
    end: str
    stream_id: int | None = None


class TimeUpdate(BaseModel):
    day: str | None = None
    note: str | None = None
    start: str | None = None
    end: str | None = None
    stream_id: int | None = None


def apply_time_changes(conn, changes: dict, current=None) -> dict:
    if "day" in changes:
        day = clean_day(changes["day"])
        if day is None:
            raise HTTPException(status_code=400, detail="Day must be YYYY-MM-DD")
        changes["day"] = day
    if "note" in changes:
        changes["note"] = clean_text(changes["note"], 200, "What")
    if "start" in changes or "end" in changes or current is None:
        start_value = changes.pop("start", None)
        end_value = changes.pop("end", None)
        if start_value is None and current is not None:
            start_value = minutes_to_clock(current["start_min"])
        if end_value is None and current is not None:
            end_value = minutes_to_clock(current["end_min"])
        if start_value is None or end_value is None:
            raise HTTPException(status_code=400, detail="Start and end are required")
        start_min = clock_to_minutes(start_value)
        end_min = clock_to_minutes(end_value)
        if end_min <= start_min:
            raise HTTPException(status_code=400, detail="End must be after start")
        changes["start_min"] = start_min
        changes["end_min"] = end_min
        changes["minutes"] = end_min - start_min
    if "stream_id" in changes and changes["stream_id"] is not None:
        stream_or_404(conn, changes["stream_id"])
    return changes


@app.get("/api/time")
def list_time():
    with session() as conn:
        rows = conn.execute("SELECT * FROM time_entries ORDER BY day, start_min, id").fetchall()
    return [dump_time(row) for row in rows]


@app.post("/api/time", status_code=201)
def create_time(body: TimeCreate):
    stamp = now()
    with session() as conn:
        changes = apply_time_changes(conn, body.model_dump())
        cur = conn.execute(
            """
            INSERT INTO time_entries (
                day, note, minutes, start_min, end_min, stream_id, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                changes["day"],
                changes["note"],
                changes["minutes"],
                changes["start_min"],
                changes["end_min"],
                changes["stream_id"],
                stamp,
                stamp,
            ),
        )
        row = conn.execute("SELECT * FROM time_entries WHERE id = ?", (cur.lastrowid,)).fetchone()
    return dump_time(row)


@app.patch("/api/time/{entry_id}")
def update_time(entry_id: int, body: TimeUpdate):
    changes = body.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=400, detail="No changes")
    stamp = now()
    with session() as conn:
        row = conn.execute("SELECT * FROM time_entries WHERE id = ?", (entry_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Time entry not found")
        changes = apply_time_changes(conn, changes, row)
        changes["updated_at"] = stamp
        assignments = ", ".join(f"{column} = ?" for column in changes)
        conn.execute(
            f"UPDATE time_entries SET {assignments} WHERE id = ?",
            [changes[column] for column in changes] + [entry_id],
        )
        row = conn.execute("SELECT * FROM time_entries WHERE id = ?", (entry_id,)).fetchone()
    return dump_time(row)


@app.delete("/api/time/{entry_id}", status_code=204)
def delete_time(entry_id: int):
    with session() as conn:
        row = conn.execute("SELECT id FROM time_entries WHERE id = ?", (entry_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Time entry not found")
        conn.execute("DELETE FROM time_entries WHERE id = ?", (entry_id,))
    return Response(status_code=204)


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=STATIC), name="static")
