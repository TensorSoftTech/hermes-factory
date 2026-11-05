"""SQLite store for factory kanban, mission, runs, history."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .paths import DB_PATH, STATE_PATH, ensure_factory_dirs

_LOCK = threading.Lock()


def _connect() -> sqlite3.Connection:
    ensure_factory_dirs()
    con = sqlite3.connect(str(DB_PATH), timeout=5.0, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    return con


def init_db() -> None:
    with _LOCK:
        con = _connect()
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS cards (
              id TEXT PRIMARY KEY,
              kind TEXT NOT NULL,
              parent_id TEXT,
              manager_id TEXT NOT NULL,
              assignee_id TEXT,
              title TEXT NOT NULL,
              status TEXT NOT NULL,
              depends_on TEXT NOT NULL DEFAULT '[]',
              source TEXT,
              note TEXT,
              created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mission (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS feed (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ts REAL NOT NULL,
              payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS history (
              id TEXT PRIMARY KEY,
              payload TEXT NOT NULL,
              delivered_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS meta (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            """
        )
        con.commit()
        con.close()
    _maybe_import_state_json()


def _maybe_import_state_json() -> None:
    """One-shot import of legacy state.json kanban/mission if DB empty."""
    if not STATE_PATH.exists():
        return
    with _LOCK:
        con = _connect()
        n = con.execute("SELECT COUNT(*) AS c FROM cards").fetchone()["c"]
        if n:
            con.close()
            return
        try:
            data = json.loads(STATE_PATH.read_text())
        except (OSError, json.JSONDecodeError):
            con.close()
            return
        cards = data.get("kanban") or []
        for c in cards:
            if not isinstance(c, dict) or not c.get("id"):
                continue
            con.execute(
                """
                INSERT OR IGNORE INTO cards
                (id, kind, parent_id, manager_id, assignee_id, title, status,
                 depends_on, source, note, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    c["id"],
                    c.get("kind") or "sub",
                    c.get("parentId"),
                    c.get("managerId") or "",
                    c.get("assigneeId"),
                    c.get("title") or "Task",
                    c.get("status") or "todo",
                    json.dumps(c.get("dependsOn") or []),
                    c.get("source"),
                    c.get("note") or "",
                    c.get("createdAt") or time.time(),
                ),
            )
        mission = data.get("mission")
        if isinstance(mission, dict):
            mission = {**mission, "pinging": False}
            con.execute(
                "INSERT OR REPLACE INTO mission (id, payload) VALUES (1, ?)",
                (json.dumps(mission),),
            )
        con.commit()
        con.close()


def _row_card(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "parentId": row["parent_id"],
        "managerId": row["manager_id"],
        "assigneeId": row["assignee_id"],
        "title": row["title"],
        "status": row["status"],
        "dependsOn": json.loads(row["depends_on"] or "[]"),
        "source": row["source"],
        "note": row["note"] or "",
        "createdAt": row["created_at"],
    }


def list_cards(manager_id: str | None = None) -> list[dict[str, Any]]:
    with _LOCK:
        con = _connect()
        if manager_id:
            rows = con.execute(
                "SELECT * FROM cards WHERE manager_id = ? ORDER BY created_at DESC",
                (manager_id,),
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM cards ORDER BY created_at DESC"
            ).fetchall()
        con.close()
    return [_row_card(r) for r in rows]


def get_card(card_id: str) -> dict[str, Any] | None:
    with _LOCK:
        con = _connect()
        row = con.execute(
            "SELECT * FROM cards WHERE id = ?", (card_id,)
        ).fetchone()
        con.close()
    return _row_card(row) if row else None


def upsert_card(card: dict[str, Any]) -> dict[str, Any]:
    cid = card.get("id") or f"c-{uuid.uuid4().hex[:10]}"
    entry = {
        "id": cid,
        "kind": "main" if card.get("kind") == "main" else "sub",
        "parentId": card.get("parentId") or card.get("parent_id"),
        "managerId": card.get("managerId") or card.get("manager_id") or "",
        "assigneeId": card.get("assigneeId") or card.get("assignee_id"),
        "title": str(card.get("title") or "Task")[:180],
        "status": card.get("status") or "todo",
        "dependsOn": list(card.get("dependsOn") or card.get("depends_on") or []),
        "source": card.get("source") or "manual",
        "note": str(card.get("note") or "")[:280],
        "createdAt": card.get("createdAt") or card.get("created_at") or time.time(),
    }
    with _LOCK:
        con = _connect()
        con.execute(
            """
            INSERT INTO cards
            (id, kind, parent_id, manager_id, assignee_id, title, status,
             depends_on, source, note, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
              kind=excluded.kind,
              parent_id=excluded.parent_id,
              manager_id=excluded.manager_id,
              assignee_id=excluded.assignee_id,
              title=excluded.title,
              status=excluded.status,
              depends_on=excluded.depends_on,
              source=excluded.source,
              note=excluded.note
            """,
            (
                entry["id"],
                entry["kind"],
                entry["parentId"],
                entry["managerId"],
                entry["assigneeId"],
                entry["title"],
                entry["status"],
                json.dumps(entry["dependsOn"]),
                entry["source"],
                entry["note"],
                entry["createdAt"],
            ),
        )
        con.commit()
        con.close()
    return entry


def patch_card(card_id: str, fields: dict[str, Any]) -> dict[str, Any] | None:
    card = get_card(card_id)
    if not card:
        return None
    if "assigneeId" in fields:
        card["assigneeId"] = fields["assigneeId"]
    if "status" in fields and fields["status"]:
        card["status"] = fields["status"]
    if "note" in fields:
        card["note"] = str(fields["note"])[:280]
    if "dependsOn" in fields:
        card["dependsOn"] = list(fields["dependsOn"] or [])
    if "title" in fields and fields["title"]:
        card["title"] = str(fields["title"])[:180]
    return upsert_card(card)


def clear_cards(manager_id: str | None = None) -> None:
    with _LOCK:
        con = _connect()
        if manager_id:
            con.execute("DELETE FROM cards WHERE manager_id = ?", (manager_id,))
        else:
            con.execute("DELETE FROM cards")
        con.commit()
        con.close()


def get_mission() -> dict[str, Any] | None:
    with _LOCK:
        con = _connect()
        row = con.execute("SELECT payload FROM mission WHERE id = 1").fetchone()
        con.close()
    if not row:
        return None
    try:
        data = json.loads(row["payload"])
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def save_mission(mission: dict[str, Any] | None) -> None:
    with _LOCK:
        con = _connect()
        if mission is None:
            con.execute("DELETE FROM mission WHERE id = 1")
        else:
            payload = dict(mission)
            payload["pinging"] = bool(payload.get("pinging"))
            con.execute(
                "INSERT OR REPLACE INTO mission (id, payload) VALUES (1, ?)",
                (json.dumps(payload),),
            )
        con.commit()
        con.close()


def append_feed(edge: dict[str, Any]) -> None:
    with _LOCK:
        con = _connect()
        con.execute(
            "INSERT INTO feed (ts, payload) VALUES (?, ?)",
            (time.time(), json.dumps(edge)),
        )
        con.execute(
            "DELETE FROM feed WHERE id NOT IN (SELECT id FROM feed ORDER BY id DESC LIMIT 200)"
        )
        con.commit()
        con.close()


def list_feed(limit: int = 80) -> list[dict[str, Any]]:
    with _LOCK:
        con = _connect()
        rows = con.execute(
            "SELECT payload FROM feed ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        con.close()
    out = []
    for r in rows:
        try:
            out.append(json.loads(r["payload"]))
        except json.JSONDecodeError:
            continue
    out.reverse()
    return out


def append_history(entry: dict[str, Any]) -> None:
    eid = entry.get("id") or f"h-{uuid.uuid4().hex[:10]}"
    entry = {**entry, "id": eid}
    with _LOCK:
        con = _connect()
        con.execute(
            "INSERT OR REPLACE INTO history (id, payload, delivered_at) VALUES (?,?,?)",
            (eid, json.dumps(entry), entry.get("deliveredAt") or time.time()),
        )
        con.execute(
            """
            DELETE FROM history WHERE id NOT IN (
              SELECT id FROM history ORDER BY delivered_at DESC LIMIT 200
            )
            """
        )
        con.commit()
        con.close()


def list_history(limit: int = 50) -> list[dict[str, Any]]:
    with _LOCK:
        con = _connect()
        rows = con.execute(
            "SELECT payload FROM history ORDER BY delivered_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        con.close()
    out = []
    for r in rows:
        try:
            out.append(json.loads(r["payload"]))
        except json.JSONDecodeError:
            continue
    return out


def export_ui_state() -> dict[str, Any]:
    """Shape compatible with legacy /api/state consumers."""
    mission = get_mission()
    return {
        "version": 2,
        "mission": mission,
        "kanban": list_cards(),
        "feed": list_feed(100),
        "updatedAt": time.time(),
    }
