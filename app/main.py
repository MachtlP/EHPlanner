from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.db import init_db, next_color, now, session

STATIC = Path(__file__).resolve().parent / "static"
TASK_FIELDS = {"stream_id", "title", "note", "important", "urgent", "status"}


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


def task_or_404(conn, task_id: int):
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return row


def dump_stream(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "color": row["color"],
        "position": row["position"],
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
        "updated_at": row["updated_at"],
    }


class StreamCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class StreamUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class TaskCreate(BaseModel):
    stream_id: int
    title: str
    note: str = ""
    important: bool = False
    urgent: bool = False


class TaskUpdate(BaseModel):
    stream_id: int | None = None
    title: str | None = None
    note: str | None = None
    important: bool | None = None
    urgent: bool | None = None
    status: str | None = None


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
    name = clean_text(body.name, 40, "Name")
    with session() as conn:
        stream_or_404(conn, stream_id)
        exists = conn.execute(
            "SELECT id FROM streams WHERE name = ? COLLATE NOCASE AND id != ?",
            (name, stream_id),
        ).fetchone()
        if exists:
            raise HTTPException(status_code=409, detail="A stream with that name already exists")
        conn.execute("UPDATE streams SET name = ? WHERE id = ?", (name, stream_id))
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
    stamp = now()
    with session() as conn:
        stream_or_404(conn, body.stream_id)
        cur = conn.execute(
            """
            INSERT INTO tasks (stream_id, title, note, important, urgent, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
            """,
            (body.stream_id, title, note, int(body.important), int(body.urgent), stamp, stamp),
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
    unknown = set(changes) - TASK_FIELDS
    if unknown:
        raise HTTPException(status_code=400, detail="No changes")
    changes["updated_at"] = now()
    columns = list(changes)
    assignments = ", ".join(f"{column} = ?" for column in columns)
    with session() as conn:
        task_or_404(conn, task_id)
        if "stream_id" in changes:
            stream_or_404(conn, changes["stream_id"])
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


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=STATIC), name="static")
