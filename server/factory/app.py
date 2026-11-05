"""FastAPI application — factory harness API + static UI."""

from __future__ import annotations

import asyncio
import json
import threading
import uuid
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import compat, events, store
from .hermes_runner import run_hermes
from .orch import get_orchestrator
from .paths import HOST, PORT, ROOT, ensure_factory_dirs
from .settings import load_settings, save_settings
from .workspace import WorkspaceError, validate_workspace_path

app = FastAPI(title="Hermes Factory", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _startup() -> None:
    ensure_factory_dirs()
    store.init_db()
    compat.seed_templates()
    # Ensure workspace exists
    load_settings()
    events.set_loop(asyncio.get_running_loop())


class RunBody(BaseModel):
    profile: Optional[str] = None
    prompt: str = ""


class MissionStartBody(BaseModel):
    message: str = Field(..., min_length=1)
    startId: Optional[str] = None


class CardPatchBody(BaseModel):
    status: Optional[str] = None
    note: Optional[str] = None
    assigneeId: Optional[str] = None
    title: Optional[str] = None
    dependsOn: Optional[List[str]] = None
    gateAllow: bool = False


class HermesClearBody(BaseModel):
    ids: Optional[List[str]] = None


@app.get("/api/health")
def health() -> Dict[str, Any]:
    s = load_settings()
    return {
        "ok": True,
        "version": "0.2.0",
        "orchestration": s.get("orchestration"),
        "workspacePath": s.get("workspacePath"),
        "hermesHome": str(compat.HERMES_HOME),
        "hermesBin": s.get("hermesBin") or compat.HERMES_BIN,
        "settingsPath": str(compat.SETTINGS_PATH),
        "templatesDir": str(compat.TEMPLATES_DIR),
    }


@app.get("/api/profiles")
def profiles() -> Dict[str, Any]:
    return {"profiles": compat.list_profiles()}


@app.get("/api/settings")
def get_settings() -> Dict[str, Any]:
    return load_settings()


@app.put("/api/settings")
def put_settings(body: Dict[str, Any]) -> Dict[str, Any]:
    try:
        if "workspacePath" in body:
            validate_workspace_path(body.get("workspacePath"), create=True)
    except WorkspaceError as err:
        raise HTTPException(400, str(err)) from err
    return save_settings(body)


@app.get("/api/state")
def get_state() -> Dict[str, Any]:
    # Merge SQLite mission/kanban with any legacy fields clients expect
    base = store.export_ui_state()
    legacy = compat.load_state()
    for key in ("viewMode", "board", "calls", "session", "agentUsage", "seq", "templateId"):
        if key in legacy and key not in base:
            base[key] = legacy[key]
    return base


@app.put("/api/state")
def put_state(body: Dict[str, Any]) -> Dict[str, Any]:
    # Persist UI extras to legacy state.json; mission/kanban owned by SQLite
    if isinstance(body.get("mission"), dict):
        store.save_mission(body["mission"])
    if isinstance(body.get("kanban"), list):
        store.clear_cards()
        for c in body["kanban"]:
            if isinstance(c, dict):
                store.upsert_card(c)
    legacy = compat.load_state()
    legacy.update({k: v for k, v in body.items() if k not in ("mission", "kanban")})
    legacy["mission"] = store.get_mission()
    legacy["kanban"] = store.list_cards()
    return compat.save_state(legacy)


@app.get("/api/history")
def history() -> Dict[str, Any]:
    entries = store.list_history()
    if not entries:
        entries = compat.load_history()
    return {"entries": entries}


@app.post("/api/history")
def post_history(body: Dict[str, Any]) -> Dict[str, Any]:
    if not body.get("id"):
        raise HTTPException(400, "history entry needs an id")
    store.append_history(body)
    try:
        compat.append_history(body)
    except Exception:
        pass
    return {"ok": True}


@app.get("/api/templates")
def templates() -> Dict[str, Any]:
    return {"templates": compat.list_templates()}


@app.get("/api/templates/{tid}")
def template_get(tid: str) -> Dict[str, Any]:
    tmpl = compat.load_template(tid)
    if not tmpl:
        raise HTTPException(404, f"template not found: {tid}")
    return tmpl


@app.put("/api/templates/{tid}")
def template_put(tid: str, body: Dict[str, Any]) -> Dict[str, Any]:
    body = dict(body)
    body["id"] = tid or body.get("id")
    return compat.save_template(body)


@app.post("/api/templates")
def template_create(body: Dict[str, Any]) -> JSONResponse:
    base_id = body.get("cloneFrom") or "software-company"
    base = compat.load_template(base_id) or compat.load_template("software-company") or {
        "rooms": [],
        "desks": [],
        "roles": [],
        "orchestratorRoleId": "ceo",
    }
    new_id = compat.slugify(
        str(body.get("id") or body.get("name") or f"company-{uuid.uuid4().hex[:6]}")
    )
    if compat.load_template(new_id):
        raise HTTPException(409, f"template already exists: {new_id}")
    created = dict(base)
    created["id"] = new_id
    created["name"] = body.get("name") or new_id.replace("-", " ").title()
    return JSONResponse(compat.save_template(created), status_code=201)


@app.delete("/api/templates/{tid}")
def template_delete(tid: str) -> Dict[str, Any]:
    if tid == "software-company":
        raise HTTPException(400, "cannot delete built-in software-company")
    if not compat.delete_template(tid):
        raise HTTPException(404, f"template not found: {tid}")
    return {"ok": True, "deleted": tid}


@app.post("/api/run")
def api_run(body: RunBody) -> JSONResponse:
    prompt = (body.prompt or "").strip()
    if not prompt:
        raise HTTPException(400, "prompt required")
    result = run_hermes(body.profile, prompt)
    return JSONResponse(result, status_code=200 if result.get("ok") else 502)


@app.get("/api/kanban")
def kanban_list(managerId: Optional[str] = None) -> Dict[str, Any]:
    return {"cards": store.list_cards(managerId)}


@app.post("/api/kanban")
def kanban_add(body: Dict[str, Any]) -> Dict[str, Any]:
    card = store.upsert_card(body)
    events.publish("kanban", {"cards": store.list_cards()})
    return card


@app.patch("/api/kanban/{card_id}")
def kanban_patch(card_id: str, body: CardPatchBody) -> Dict[str, Any]:
    from .rules import is_frozen

    card = store.get_card(card_id)
    if not card:
        raise HTTPException(404, "card not found")
    fields = body.model_dump(exclude_none=True)
    gate = fields.pop("gateAllow", False)
    if fields.get("status") == "done":
        cards = {c["id"]: c for c in store.list_cards()}
        if is_frozen(card, cards) and not gate:
            raise HTTPException(
                409,
                "frozen card — set gateAllow=true (GATE: allow) to force done",
            )
    updated = store.patch_card(card_id, fields)
    events.publish("kanban", {"cards": store.list_cards()})
    return updated or {}


@app.delete("/api/kanban")
def kanban_clear(managerId: Optional[str] = None) -> Dict[str, Any]:
    store.clear_cards(managerId)
    events.publish("kanban", {"cards": []})
    return {"ok": True}


@app.get("/api/hermes-tasks")
def hermes_tasks() -> Dict[str, Any]:
    return compat.list_hermes_agent_tasks()


@app.post("/api/hermes-tasks/clear")
def hermes_tasks_clear(body: HermesClearBody) -> Dict[str, Any]:
    return compat.clear_hermes_agent_tasks(body.ids)


@app.post("/api/missions")
def mission_start(body: MissionStartBody) -> Dict[str, Any]:
    orch = get_orchestrator()
    return orch.start_board_mission(body.message)


@app.post("/api/missions/ping")
def mission_ping() -> Dict[str, Any]:
    orch = get_orchestrator()

    def _run() -> None:
        orch.run_progress_ping(reason="manual")

    threading.Thread(target=_run, daemon=True).start()
    return {"ok": True}


@app.post("/api/missions/abort")
def mission_abort() -> Dict[str, Any]:
    """Pause the run — keep kanban; unlock dock."""
    get_orchestrator().pause()
    return {"ok": True, "action": "pause"}


@app.post("/api/missions/stop")
def mission_stop() -> Dict[str, Any]:
    """Stop & remove — clear mission + kanban."""
    get_orchestrator().stop()
    return {"ok": True, "action": "stop"}


@app.websocket("/ws/events")
async def ws_events(ws: WebSocket) -> None:
    await ws.accept()
    q = events.subscribe()
    try:
        # Snapshot on connect
        await ws.send_text(
            json.dumps(
                {
                    "event": "hello",
                    "payload": {
                        "state": store.export_ui_state(),
                        "settings": load_settings(),
                    },
                }
            )
        )
        while True:
            raw = await q.get()
            await ws.send_text(raw)
    except WebSocketDisconnect:
        pass
    finally:
        events.unsubscribe(q)


# Static UI (after API routes)
_static_dirs = ("css", "js")
for name in _static_dirs:
    path = ROOT / name
    if path.is_dir():
        app.mount(f"/{name}", StaticFiles(directory=str(path)), name=name)


@app.get("/")
def index() -> FileResponse:
    return FileResponse(str(ROOT / "index.html"))


def main() -> None:
    import uvicorn

    ensure_factory_dirs()
    store.init_db()
    compat.seed_templates()
    print(f"Hermes Factory → http://{HOST}:{PORT}")
    print(f"Workspace → {load_settings().get('workspacePath')}")
    uvicorn.run(
        "factory.app:app",
        host=HOST,
        port=PORT,
        reload=False,
        factory=False,
    )


if __name__ == "__main__":
    main()
