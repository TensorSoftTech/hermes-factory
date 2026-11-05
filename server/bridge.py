#!/usr/bin/env python3
"""Hermes Factory bridge — real profiles, settings, oneshot runs."""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
HERMES_HOME = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
FACTORY_HOME = Path.home() / ".hermes-factory"
SETTINGS_PATH = FACTORY_HOME / "settings.json"
STATE_PATH = FACTORY_HOME / "state.json"
HISTORY_PATH = FACTORY_HOME / "history.json"
TEMPLATES_DIR = FACTORY_HOME / "templates"
STATE_LOCK = threading.Lock()
HISTORY_CAP = 200
SEED_DIR = ROOT / "server" / "seed"
HERMES_BIN = os.environ.get("HERMES_BIN", str(Path.home() / ".local" / "bin" / "hermes"))
HOST = os.environ.get("FACTORY_HOST", "127.0.0.1")
PORT = int(os.environ.get("FACTORY_PORT", "8787"))

DEFAULT_SETTINGS = {
    "templateId": "software-company",
    "parentProfile": "default",
    "roleProfiles": {},
    "hermesBin": HERMES_BIN,
    "themeId": "paper-sky",
    "avatarStyle": "robot",
}


def ensure_factory_dirs() -> None:
    FACTORY_HOME.mkdir(parents=True, exist_ok=True)
    TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)


def ensure_settings_dir() -> None:
    ensure_factory_dirs()


def slugify(value: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (value or "").strip().lower())
    s = re.sub(r"-+", "-", s).strip("-")
    return s or f"role-{uuid.uuid4().hex[:6]}"


def seed_templates() -> None:
    """Copy bundled seeds into ~/.hermes-factory/templates if missing."""
    ensure_factory_dirs()
    if not SEED_DIR.is_dir():
        return
    for seed in SEED_DIR.glob("*.json"):
        dest = TEMPLATES_DIR / seed.name
        if not dest.exists():
            dest.write_text(seed.read_text())
    upgrade_seed_roles()


def upgrade_seed_roles() -> None:
    """Insert newly bundled software-company roles without touching existing ones.

    Only ids listed in the seed's ``seedAdds`` are added, and only if missing.
    Ids in ``seedRemoves`` (and their desks) are deleted. Other roles stay.
    """
    seed_path = SEED_DIR / "software-company.json"
    dest = TEMPLATES_DIR / "software-company.json"
    if not seed_path.exists() or not dest.exists():
        return
    try:
        seed = json.loads(seed_path.read_text())
        installed = json.loads(dest.read_text())
    except (OSError, json.JSONDecodeError):
        return
    if not isinstance(seed, dict) or not isinstance(installed, dict):
        return
    try:
        want = int(seed.get("seedRevision") or 0)
    except (TypeError, ValueError):
        want = 0
    try:
        have = int(installed.get("seedRevision") or 0)
    except (TypeError, ValueError):
        have = 0
    if want and have >= want:
        return

    removes = [rid for rid in (seed.get("seedRemoves") or []) if isinstance(rid, str)]
    adds = [rid for rid in (seed.get("seedAdds") or []) if isinstance(rid, str)]
    seed_roles = {
        r.get("id"): r
        for r in (seed.get("roles") or [])
        if isinstance(r, dict) and r.get("id")
    }
    seed_desks = {
        d.get("id"): d
        for d in (seed.get("desks") or [])
        if isinstance(d, dict) and d.get("id")
    }
    seed_rooms = {
        r.get("id"): r
        for r in (seed.get("rooms") or [])
        if isinstance(r, dict) and r.get("id")
    }
    roles = [r for r in (installed.get("roles") or []) if isinstance(r, dict)]
    desks = [d for d in (installed.get("desks") or []) if isinstance(d, dict)]
    rooms = [r for r in (installed.get("rooms") or []) if isinstance(r, dict)]
    role_ids = {r.get("id") for r in roles}
    desk_ids = {d.get("id") for d in desks}
    room_ids = {r.get("id") for r in rooms}
    occupied: set[tuple] = set()
    for role in roles:
        home = role.get("home")
        if isinstance(home, list) and len(home) == 2:
            occupied.add((home[0], home[1]))
    for desk in desks:
        tile = desk.get("tile")
        if isinstance(tile, list) and len(tile) == 2:
            occupied.add((tile[0], tile[1]))

    def free_near(tile) -> list:
        col, row = (tile[0], tile[1]) if isinstance(tile, list) and len(tile) == 2 else (2, 12)
        if (col, row) not in occupied:
            return [col, row]
        for dr in range(0, 6):
            for dc in range(0, 8):
                cand = (col + dc, row + dr)
                if cand not in occupied:
                    return [cand[0], cand[1]]
        return [col, row + 2]

    if removes:
        drop = set(removes)
        roles = [r for r in roles if r.get("id") not in drop]
        desks = [
            d
            for d in desks
            if d.get("id") not in {f"desk-{rid}" for rid in drop}
        ]
        role_ids = {r.get("id") for r in roles}
        desk_ids = {d.get("id") for d in desks}
        # Shrink the default leadership room once COO's desk is gone.
        if "coo" in drop:
            for room in rooms:
                if (
                    room.get("id") == "leadership"
                    and room.get("origin") == [6, 1]
                    and room.get("size") == [5, 3]
                ):
                    room["size"] = [3, 3]

    for rid in adds:
        if rid in role_ids or rid not in seed_roles:
            continue
        role = dict(seed_roles[rid])
        desk_id = role.get("desk")
        desk = dict(seed_desks[desk_id]) if desk_id in seed_desks else None
        if desk:
            room_id = desk.get("room")
            room = seed_rooms.get(room_id)
            if room and room_id not in room_ids:
                rooms.append(dict(room))
                room_ids.add(room_id)
            tile = free_near(desk.get("tile") or role.get("home"))
            desk["tile"] = tile
            role["home"] = list(tile)
            occupied.add((tile[0], tile[1]))
            if desk_id not in desk_ids:
                desks.append(desk)
                desk_ids.add(desk_id)
        elif isinstance(role.get("home"), list):
            tile = free_near(role["home"])
            role["home"] = tile
            occupied.add(tuple(tile))
        roles.append(role)
        role_ids.add(rid)

    refresh = [rid for rid in (seed.get("seedRefresh") or []) if isinstance(rid, str)]
    for rid in refresh:
        src = seed_roles.get(rid)
        if not src:
            continue
        for role in roles:
            if role.get("id") != rid:
                continue
            if src.get("description"):
                role["description"] = src["description"]
            if "teamHub" in src:
                role["teamHub"] = src["teamHub"]

    installed["roles"] = roles
    installed["desks"] = desks
    installed["rooms"] = rooms
    if want:
        installed["seedRevision"] = want
    dest.write_text(json.dumps(installed, indent=2) + "\n")


def list_templates() -> list[dict]:
    seed_templates()
    out = []
    for path in sorted(TEMPLATES_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        out.append(
            {
                "id": data.get("id") or path.stem,
                "name": data.get("name") or path.stem,
                "roleCount": len(data.get("roles") or []),
                "orchestratorRoleId": data.get("orchestratorRoleId"),
                "path": str(path),
            }
        )
    return out


def load_template(template_id: str) -> dict | None:
    seed_templates()
    safe = slugify(template_id)
    path = TEMPLATES_DIR / f"{safe}.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    data["id"] = data.get("id") or safe
    return normalize_org_chart(data)


def _boss_or_none(value, role_ids: set, self_id: str | None) -> str | None:
    if value is None or value == "" or value == "board":
        return None
    sid = str(value)
    if sid == self_id or sid not in role_ids:
        return None
    return sid


ROLE_KINDS = ("orchestrator", "manager", "executor", "evaluator")


def _normalize_role_kind(value, is_orchestrator: bool = False) -> str:
    v = str(value or "").strip().lower()
    if v in ROLE_KINDS:
        return v
    return "orchestrator" if is_orchestrator else "executor"


def normalize_org_chart(data: dict) -> dict:
    """
    Always define takesOrdersFrom + reportsTo + roleKind on every role.
    - Board target (orchestratorRoleId): both null (Board), roleKind=orchestrator.
    - Everyone else: both required role ids; missing → orchestrator.
    roleKind: orchestrator | manager | executor | evaluator
    """
    data = dict(data)
    roles = [r for r in (data.get("roles") or []) if isinstance(r, dict)]
    role_ids = {r.get("id") for r in roles if r.get("id")}
    orch = data.get("orchestratorRoleId")
    if orch not in role_ids and roles:
        orch = roles[0].get("id")
        data["orchestratorRoleId"] = orch

    for role in roles:
        rid = role.get("id")
        is_orch = rid == orch
        kind = _normalize_role_kind(role.get("roleKind"), is_orchestrator=is_orch)
        if is_orch:
            role["roleKind"] = "orchestrator"
            role["takesOrdersFrom"] = None
            role["reportsTo"] = None
            continue
        if kind == "orchestrator":
            kind = "manager"
        role["roleKind"] = kind
        orders = _boss_or_none(role.get("takesOrdersFrom"), role_ids, rid)
        reports = _boss_or_none(role.get("reportsTo"), role_ids, rid)
        role["takesOrdersFrom"] = orders or orch
        role["reportsTo"] = reports or orch

    data["roles"] = roles
    return data


def save_template(data: dict) -> dict:
    ensure_factory_dirs()
    tid = slugify(str(data.get("id") or data.get("name") or "template"))
    data = dict(data)
    data["id"] = tid
    if not data.get("name"):
        data["name"] = tid
    if not isinstance(data.get("rooms"), list):
        data["rooms"] = []
    if not isinstance(data.get("desks"), list):
        data["desks"] = []
    if not isinstance(data.get("roles"), list):
        data["roles"] = []
    # Keep desks in sync with roles
    desks_by_id = {d.get("id"): d for d in data["desks"] if isinstance(d, dict)}
    for role in data["roles"]:
        if not isinstance(role, dict):
            continue
        desk_id = role.get("desk") or f"desk-{role.get('id')}"
        role["desk"] = desk_id
        home = role.get("home") or [2, 6]
        if desk_id not in desks_by_id:
            desks_by_id[desk_id] = {
                "id": desk_id,
                "room": role.get("department", "eng-bay").lower().replace(" ", "-")[:24]
                or "eng-bay",
                "tile": list(home),
            }
        else:
            desks_by_id[desk_id]["tile"] = list(home)
        role["home"] = list(home)
    data["desks"] = list(desks_by_id.values())
    data = normalize_org_chart(data)
    path = TEMPLATES_DIR / f"{tid}.json"
    path.write_text(json.dumps(data, indent=2) + "\n")
    return data


def delete_template(template_id: str) -> bool:
    safe = slugify(template_id)
    if safe == "software-company":
        return False
    path = TEMPLATES_DIR / f"{safe}.json"
    if not path.exists():
        return False
    path.unlink()
    return True


def load_settings() -> dict:
    ensure_settings_dir()
    if not SETTINGS_PATH.exists():
        return dict(DEFAULT_SETTINGS)
    try:
        data = json.loads(SETTINGS_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return dict(DEFAULT_SETTINGS)
    out = dict(DEFAULT_SETTINGS)
    out.update(data)
    if not isinstance(out.get("roleProfiles"), dict):
        out["roleProfiles"] = {}
    return out


def save_settings(data: dict) -> dict:
    ensure_settings_dir()
    merged = dict(DEFAULT_SETTINGS)
    merged.update(data)
    if not isinstance(merged.get("roleProfiles"), dict):
        merged["roleProfiles"] = {}
    SETTINGS_PATH.write_text(json.dumps(merged, indent=2) + "\n")
    return merged


DEFAULT_STATE = {
    "version": 1,
    "viewMode": "office",
    "mission": None,
    "board": None,
    "calls": [],
    "session": None,
    "agentUsage": None,
    "seq": 0,
    "feed": [],
    "updatedAt": None,
}


def load_state() -> dict:
    """Live task/session state so a browser refresh doesn't wipe the mission."""
    ensure_factory_dirs()
    if not STATE_PATH.exists():
        return dict(DEFAULT_STATE)
    try:
        data = json.loads(STATE_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return dict(DEFAULT_STATE)
    if not isinstance(data, dict):
        return dict(DEFAULT_STATE)
    out = dict(DEFAULT_STATE)
    out.update(data)
    return out


def save_state(data: dict) -> dict:
    ensure_factory_dirs()
    if not isinstance(data, dict):
        data = {}
    out = dict(DEFAULT_STATE)
    out.update(data)
    out["updatedAt"] = time.time()
    tmp = STATE_PATH.with_suffix(".tmp")
    with STATE_LOCK:
        tmp.write_text(json.dumps(out))
        tmp.replace(STATE_PATH)
    return out


def load_history() -> list:
    """Delivered-task history (newest first), persisted across refreshes."""
    ensure_factory_dirs()
    if not HISTORY_PATH.exists():
        return []
    try:
        data = json.loads(HISTORY_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return []
    return data if isinstance(data, list) else []


def append_history(entry: dict) -> list:
    ensure_factory_dirs()
    if not isinstance(entry, dict) or not entry.get("id"):
        raise ValueError("history entry needs an id")
    items = load_history()
    items = [e for e in items if isinstance(e, dict) and e.get("id") != entry["id"]]
    items.insert(0, entry)
    items = items[:HISTORY_CAP]
    tmp = HISTORY_PATH.with_suffix(".tmp")
    with STATE_LOCK:
        tmp.write_text(json.dumps(items, indent=1))
        tmp.replace(HISTORY_PATH)
    return items


def parse_model_provider(config_path: Path) -> tuple[str, str]:
    model = "unknown"
    provider = "unknown"
    if not config_path.exists():
        return model, provider
    text = config_path.read_text(errors="ignore")
    # Prefer first non-commented model.default / provider under model:
    in_model = False
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        if re.match(r"^model:\s*$", line):
            in_model = True
            continue
        if in_model and re.match(r"^[A-Za-z0-9_]+:\s*", line) and not line.startswith(" "):
            in_model = False
        if in_model:
            m = re.match(r'^\s+(?:default|model):\s*["\']?([^"\']+)["\']?\s*$', line)
            if m:
                model = m.group(1).strip()
            p = re.match(r'^\s+provider:\s*["\']?([^"\']+)["\']?\s*$', line)
            if p:
                provider = p.group(1).strip()
    return model, provider


def profile_paths() -> list[tuple[str, Path]]:
    items: list[tuple[str, Path]] = [("default", HERMES_HOME)]
    profiles_dir = HERMES_HOME / "profiles"
    if profiles_dir.is_dir():
        for child in sorted(profiles_dir.iterdir()):
            if not child.is_dir():
                continue
            markers = (
                "config.yaml",
                ".env",
                "SOUL.md",
                "profile.yaml",
                "auth.json",
                "state.db",
            )
            if any((child / m).exists() for m in markers):
                items.append((child.name, child))
    return items


def list_profiles() -> list[dict]:
    out = []
    for name, path in profile_paths():
        model, provider = parse_model_provider(path / "config.yaml")
        soul = (path / "SOUL.md").exists()
        out.append(
            {
                "id": name,
                "name": name,
                "path": str(path),
                "model": model,
                "provider": provider,
                "hasSoul": soul,
                "isDefault": name == "default",
            }
        )
    return out


def _kanban_db_paths() -> list[tuple[str, Path]]:
    """Hermes Agent kanban DBs (default home + each profile) — not the factory board."""
    items: list[tuple[str, Path]] = []
    root = HERMES_HOME / "kanban.db"
    if root.exists():
        items.append(("default", root))
    profiles_dir = HERMES_HOME / "profiles"
    if profiles_dir.is_dir():
        for child in sorted(profiles_dir.iterdir()):
            if not child.is_dir():
                continue
            db = child / "kanban.db"
            if db.exists():
                items.append((child.name, db))
    return items


def list_hermes_agent_tasks(limit: int = 40) -> dict:
    """Open Hermes Agent (t_*) tasks still on disk — often leftover from CTO tool use."""
    import sqlite3

    tasks: list[dict] = []
    errors: list[str] = []
    for profile, path in _kanban_db_paths():
        try:
            con = sqlite3.connect(str(path.resolve()), timeout=2.0)
            con.row_factory = sqlite3.Row
            has = con.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'"
            ).fetchone()
            if not has:
                con.close()
                continue
            rows = con.execute(
                """
                SELECT id, title, status, assignee, worker_pid, created_at,
                       started_at, last_heartbeat_at, last_failure_error
                FROM tasks
                WHERE lower(status) NOT IN ('done', 'cancelled', 'canceled', 'failed')
                ORDER BY
                  CASE lower(status)
                    WHEN 'running' THEN 0
                    WHEN 'in_progress' THEN 1
                    WHEN 'ready' THEN 2
                    ELSE 3
                  END,
                  COALESCE(started_at, created_at) DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
            con.close()
        except Exception as err:  # noqa: BLE001 — surface DB issues to UI
            errors.append(f"{profile}: {err}")
            continue
        for row in rows:
            status = str(row["status"] or "").lower()
            tasks.append(
                {
                    "id": row["id"],
                    "title": row["title"],
                    "status": status,
                    "assignee": row["assignee"] or profile,
                    "profile": profile,
                    "workerPid": row["worker_pid"],
                    "createdAt": row["created_at"],
                    "startedAt": row["started_at"],
                    "lastHeartbeatAt": row["last_heartbeat_at"],
                    "lastError": (row["last_failure_error"] or "")[:200] or None,
                    "running": status in ("running", "in_progress")
                    or bool(row["worker_pid"]),
                }
            )
    tasks.sort(
        key=lambda t: (
            0 if t.get("running") else 1 if t.get("status") == "ready" else 2,
            -(t.get("startedAt") or t.get("createdAt") or 0),
        )
    )
    running = [t for t in tasks if t.get("running")]
    return {
        "ok": True,
        "tasks": tasks[:limit],
        "runningCount": len(running),
        "openCount": len(tasks),
        "errors": errors,
    }


def clear_hermes_agent_tasks(task_ids: list[str] | None = None) -> dict:
    """Archive leftover Hermes Agent (t_*) tasks so they stop dispatching."""
    listed = list_hermes_agent_tasks(limit=100)
    open_ids = [t["id"] for t in listed.get("tasks") or [] if t.get("id")]
    running_ids = {
        t["id"]
        for t in listed.get("tasks") or []
        if t.get("id") and t.get("running")
    }
    wanted = [str(x) for x in (task_ids if task_ids is not None else open_ids) if x]
    if not wanted:
        return {
            "ok": True,
            "cleared": [],
            "failed": [],
            "message": "No open Hermes Agent tasks",
        }

    settings = load_settings()
    bin_path = settings.get("hermesBin") or HERMES_BIN
    cleared: list[str] = []
    failed: list[dict] = []

    for tid in wanted:
        if tid in running_ids:
            try:
                subprocess.run(
                    [
                        bin_path,
                        "kanban",
                        "reclaim",
                        tid,
                        "--reason",
                        "factory clear leftover Hermes Agent task",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    env={**os.environ, "TERM": "dumb"},
                )
            except Exception as err:  # noqa: BLE001
                failed.append({"id": tid, "error": f"reclaim: {err}"})
                continue
        try:
            proc = subprocess.run(
                [bin_path, "kanban", "archive", tid],
                capture_output=True,
                text=True,
                timeout=30,
                env={**os.environ, "TERM": "dumb"},
            )
            if proc.returncode != 0:
                # Fallback: mark done in sqlite so dispatcher stops picking it up
                _force_close_hermes_task(tid, reason="factory clear")
                cleared.append(tid)
            else:
                cleared.append(tid)
        except Exception as err:  # noqa: BLE001
            try:
                _force_close_hermes_task(tid, reason=f"factory clear after {err}")
                cleared.append(tid)
            except Exception as err2:  # noqa: BLE001
                failed.append({"id": tid, "error": str(err2)})

    after = list_hermes_agent_tasks(limit=100)
    return {
        "ok": not failed,
        "cleared": cleared,
        "failed": failed,
        "remaining": after.get("openCount", 0),
        "runningCount": after.get("runningCount", 0),
        "tasks": after.get("tasks") or [],
    }


def _force_close_hermes_task(task_id: str, reason: str = "") -> None:
    """Last-resort: set status cancelled in every kanban.db that has the row."""
    import sqlite3

    for _profile, path in _kanban_db_paths():
        try:
            con = sqlite3.connect(str(path.resolve()), timeout=2.0)
            has = con.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'"
            ).fetchone()
            if not has:
                con.close()
                continue
            con.execute(
                """
                UPDATE tasks
                SET status = 'cancelled',
                    completed_at = COALESCE(completed_at, ?),
                    result = COALESCE(result, ?)
                WHERE id = ? AND lower(status) NOT IN ('done', 'cancelled', 'canceled')
                """,
                (int(time.time()), reason or "cleared from Hermes Factory", task_id),
            )
            con.commit()
            con.close()
        except Exception:
            continue


def resolve_run_profile(requested: str | None, settings: dict | None = None) -> tuple[str, dict]:
    """Enforce factory settings: never silently fall back to default/Nous when parent is set."""
    settings = settings or load_settings()
    parent = str(settings.get("parentProfile") or "default").strip() or "default"
    known = {p["id"]: p for p in list_profiles()}
    req = str(requested or "").strip()
    # Role ids (swe, cto, …) are not Hermes profiles — ignore them
    if req and req not in known:
        req = ""
    # Settings win: if parent is a real non-default profile, never run default/Nous
    if parent in known and parent != "default" and (not req or req == "default"):
        chosen = parent
    else:
        chosen = req or (parent if parent in known else "") or (
            "default" if "default" in known else parent
        )
    meta = known.get(chosen) or {
        "id": chosen,
        "provider": "unknown",
        "model": "unknown",
    }
    return chosen, {
        "id": meta.get("id") or chosen,
        "provider": meta.get("provider") or "unknown",
        "model": meta.get("model") or "unknown",
        "parentProfile": parent,
        "requested": requested or None,
    }


def run_hermes(profile: str, prompt: str, hermes_bin: str | None = None) -> dict:
    settings = load_settings()
    bin_path = hermes_bin or settings.get("hermesBin") or HERMES_BIN
    chosen, profile_meta = resolve_run_profile(profile, settings)
    usage_path = Path(tempfile.gettempdir()) / f"hf-usage-{uuid.uuid4().hex}.json"
    cmd = [bin_path]
    # Always pass -p when not default so we never inherit ~/.hermes (Nous) by accident
    if chosen and chosen != "default":
        cmd.extend(["-p", chosen])
    cmd.extend(["-z", prompt, "--usage-file", str(usage_path)])
    # Redacted command for API history (full prompt lives in request body)
    cmd_display = [
        bin_path,
        *(["-p", chosen] if chosen and chosen != "default" else []),
        "-z",
        f"<prompt {len(prompt)} chars>",
        "--usage-file",
        str(usage_path),
    ]

    started = time.time()
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,
            env={**os.environ, "TERM": "dumb"},
        )
    except subprocess.TimeoutExpired:
        latency_ms = int((time.time() - started) * 1000)
        return {
            "ok": False,
            "error": "Hermes timed out after 300s",
            "profile": chosen,
            "profileMeta": profile_meta,
            "reply": "",
            "usage": None,
            "latencyMs": latency_ms,
            "returncode": None,
            "cmd": cmd_display,
            "stderr": "",
            "promptChars": len(prompt),
        }
    except FileNotFoundError:
        latency_ms = int((time.time() - started) * 1000)
        return {
            "ok": False,
            "error": f"Hermes binary not found: {bin_path}",
            "profile": chosen,
            "profileMeta": profile_meta,
            "reply": "",
            "usage": None,
            "latencyMs": latency_ms,
            "returncode": None,
            "cmd": cmd_display,
            "stderr": "",
            "promptChars": len(prompt),
        }

    latency_ms = int((time.time() - started) * 1000)
    reply = (proc.stdout or "").strip()
    # Drop trailing session_id lines from -Q style if present
    lines = [ln for ln in reply.splitlines() if not ln.startswith("session_id:")]
    reply = "\n".join(lines).strip()

    usage = None
    if usage_path.exists():
        try:
            usage = json.loads(usage_path.read_text())
        except (OSError, json.JSONDecodeError):
            usage = None
        try:
            usage_path.unlink(missing_ok=True)
        except OSError:
            pass

    ok = proc.returncode == 0 and bool(reply)
    err = None if ok else (proc.stderr or proc.stdout or f"exit {proc.returncode}").strip()
    combined = f"{err or ''}\n{proc.stderr or ''}\n{proc.stdout or ''}"
    if not ok and (
        "402" in combined
        or "Insufficient available credits" in combined
        or "nousresearch.com" in combined.lower()
    ):
        hint = (
            f"[factory] HTTP 402 / Nous credits — this call used cloud Nous, not your local AI. "
            f"Settings parentProfile={profile_meta.get('parentProfile')} "
            f"(provider={profile_meta.get('provider')}, model={profile_meta.get('model')}). "
            f"Run profile for this call: {chosen}. "
            f"Hermes Agent kanban workers (t_*) use the default/Nous profile — "
            f"do not create Hermes kanban cards; only the factory board."
        )
        err = f"{err}\n{hint}" if err else hint
    return {
        "ok": ok,
        "error": err,
        "profile": chosen,
        "profileMeta": profile_meta,
        "reply": reply if ok else (reply or err or ""),
        "usage": usage,
        "stderr": (proc.stderr or "")[-8000:],
        "latencyMs": latency_ms,
        "returncode": proc.returncode,
        "cmd": cmd_display,
        "promptChars": len(prompt),
        "replyChars": len(reply),
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        print(f"[factory] {self.address_string()} {fmt % args}")

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code: int, payload: dict | list) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode() or "{}")
        except json.JSONDecodeError:
            return {}
        return data if isinstance(data, dict) else {}

    def end_headers(self) -> None:  # noqa: N802
        # Local UI modules change often — never let the browser keep stale avatars/office JS
        path = urlparse(getattr(self, "path", "") or "").path
        if path.endswith((".js", ".css", ".html")) or path in ("", "/"):
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/health":
            return self._json(
                200,
                {
                    "ok": True,
                    "hermesHome": str(HERMES_HOME),
                    "hermesBin": HERMES_BIN,
                    "settingsPath": str(SETTINGS_PATH),
                    "templatesDir": str(TEMPLATES_DIR),
                },
            )
        if path == "/api/profiles":
            return self._json(200, {"profiles": list_profiles()})
        if path == "/api/settings":
            return self._json(200, load_settings())
        if path == "/api/state":
            return self._json(200, load_state())
        if path == "/api/history":
            return self._json(200, {"entries": load_history()})
        if path == "/api/templates":
            return self._json(200, {"templates": list_templates()})
        if path == "/api/hermes-tasks":
            return self._json(200, list_hermes_agent_tasks())
        if path.startswith("/api/templates/"):
            tid = path[len("/api/templates/") :].strip("/")
            tmpl = load_template(tid)
            if not tmpl:
                return self._json(404, {"error": f"template not found: {tid}"})
            return self._json(200, tmpl)
        return super().do_GET()

    def do_PUT(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/settings":
            data = self._read_json()
            return self._json(200, save_settings(data))
        if path == "/api/state":
            data = self._read_json()
            return self._json(200, save_state(data))
        if path.startswith("/api/templates/"):
            tid = path[len("/api/templates/") :].strip("/")
            data = self._read_json()
            data["id"] = tid or data.get("id")
            return self._json(200, save_template(data))
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        data = self._read_json()
        if path == "/api/history":
            # Append one delivered-task entry (deduped by id, newest first)
            try:
                items = append_history(data)
            except ValueError as err:
                return self._json(400, {"error": str(err)})
            return self._json(201, {"ok": True, "count": len(items)})
        if path == "/api/hermes-tasks/clear":
            ids = data.get("ids")
            if ids is not None and not isinstance(ids, list):
                return self._json(400, {"ok": False, "error": "ids must be a list"})
            result = clear_hermes_agent_tasks(ids)
            return self._json(200 if result.get("ok") else 502, result)
        if path == "/api/run":
            settings = load_settings()
            prompt = (data.get("prompt") or "").strip()
            if not prompt:
                return self._json(400, {"ok": False, "error": "prompt required"})
            # Enforce settings.parentProfile / known profiles (ignore bare role ids)
            profile, _meta = resolve_run_profile(data.get("profile"), settings)
            result = run_hermes(profile, prompt, settings.get("hermesBin"))
            return self._json(200 if result["ok"] else 502, result)
        if path == "/api/templates":
            # Create new template (clone base or empty shell)
            base_id = data.get("cloneFrom") or "software-company"
            base = load_template(base_id) or load_template("software-company") or {
                "rooms": [],
                "desks": [],
                "roles": [],
                "orchestratorRoleId": "ceo",
            }
            new_id = slugify(str(data.get("id") or data.get("name") or f"company-{uuid.uuid4().hex[:6]}"))
            if load_template(new_id):
                return self._json(409, {"error": f"template already exists: {new_id}"})
            created = dict(base)
            created["id"] = new_id
            created["name"] = data.get("name") or new_id.replace("-", " ").title()
            return self._json(201, save_template(created))
        self._json(404, {"error": "not found"})

    def do_DELETE(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path.startswith("/api/templates/"):
            tid = path[len("/api/templates/") :].strip("/")
            if tid == "software-company":
                return self._json(400, {"error": "cannot delete built-in software-company"})
            ok = delete_template(tid)
            if not ok:
                return self._json(404, {"error": f"template not found: {tid}"})
            return self._json(200, {"ok": True, "deleted": tid})
        self._json(404, {"error": "not found"})


def main() -> None:
    ensure_factory_dirs()
    seed_templates()
    if not SETTINGS_PATH.exists():
        save_settings(DEFAULT_SETTINGS)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Hermes Factory → http://{HOST}:{PORT}")
    print(f"Settings → {SETTINGS_PATH}")
    print(f"Templates → {TEMPLATES_DIR}")
    print(f"Hermes → {HERMES_BIN}  home={HERMES_HOME}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
