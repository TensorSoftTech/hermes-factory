"""Server-side org orchestration — kanban waves, ping, CEO delivery."""

from __future__ import annotations

import re
import threading
import time
import uuid
from typing import Any

from .. import events, store
from ..compat import list_profiles, load_template
from ..hermes_runner import run_hermes
from ..rules import (
    apply_kanban_directives,
    parse_delivered,
    parse_kanban_directives,
    parse_manager_plan,
    parse_task_state,
    ready_subs,
    refresh_blocked,
)
from ..settings import load_settings
from . import org

PROGRESS_PING_MS = 90_000
FAIL_STREAK_PAUSE = 3

_orch: "Orchestrator | None" = None
_orch_lock = threading.Lock()


def get_orchestrator() -> "Orchestrator":
    global _orch
    with _orch_lock:
        if _orch is None:
            _orch = Orchestrator()
        return _orch


class Orchestrator:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._busy = False
        self._chain_abort = False
        self._ping_abort = False
        self._ping_timer: threading.Timer | None = None
        self._kick_timer: threading.Timer | None = None
        self._run_id = 0
        self._last_board = ""
        self._last_report = ""
        self._path: list[dict] = []
        self._fail_streak = 0
        self._pending_kicks: list[str] = []

    @property
    def busy(self) -> bool:
        return self._busy

    def stop(self) -> None:
        self._run_id += 1
        self._chain_abort = True
        self._ping_abort = True
        self._clear_ping_timer()
        self._clear_kick_timer()
        self._pending_kicks = []
        self._fail_streak = 0
        store.clear_cards()
        store.save_mission(None)
        self._busy = False
        events.publish("course_changed", {})
        events.publish("state", store.export_ui_state())

    def pause(self) -> None:
        self._run_id += 1
        self._chain_abort = True
        self._ping_abort = True
        self._clear_ping_timer()
        self._clear_kick_timer()
        self._pending_kicks = []
        m = store.get_mission() or {}
        m["paused"] = True
        m["pinging"] = False
        m["activeId"] = None
        m["activity"] = None
        m["phase"] = "paused"
        m["nextPingAt"] = None
        store.save_mission(m)
        self._unstick_doing_cards("paused — was doing")
        self._busy = False
        events.publish("mission", m)
        events.publish("busy", {"busy": False})

    def resume(self) -> dict[str, Any]:
        """Unpause — keep kanban/mission; restart recovery pings + ready kicks."""
        m = store.get_mission()
        if not m:
            return {"ok": False, "error": "no mission"}
        if m.get("delivered"):
            return {"ok": False, "error": "already delivered"}
        m["paused"] = False
        m["pinging"] = False
        m["phase"] = "open"
        m["taskState"] = m.get("taskState") or "in_progress"
        m["activity"] = None
        store.save_mission(m)
        events.publish("mission", m)
        self._chain_abort = False
        self._ping_abort = False
        self._busy = False
        self._fail_streak = 0
        # Soon: managers check open cards / kick ready todos
        self._schedule_ping(1_500)
        self._edge("you", "system", "Board resumed the task — pings and desk work continue.")
        return {"ok": True}

    def _clear_ping_timer(self) -> None:
        if self._ping_timer:
            self._ping_timer.cancel()
            self._ping_timer = None

    def _clear_kick_timer(self) -> None:
        if self._kick_timer:
            self._kick_timer.cancel()
            self._kick_timer = None

    def _schedule_ping(self, delay_ms: int = PROGRESS_PING_MS) -> None:
        self._clear_ping_timer()
        m = store.get_mission()
        if not m or m.get("delivered") or m.get("paused"):
            return
        at = time.time() * 1000 + delay_ms
        m["nextPingAt"] = at
        m["pinging"] = False
        store.save_mission(m)
        events.publish("mission", m)

        def _fire() -> None:
            self._ping_timer = None
            try:
                self.run_progress_ping()
            except Exception as err:  # noqa: BLE001
                self._edge("system", "you", f"Ping error: {err}")
                self._schedule_ping(self._ping_backoff_ms())

        self._ping_timer = threading.Timer(max(0.5, delay_ms / 1000), _fire)
        self._ping_timer.daemon = True
        self._ping_timer.start()

    def _ping_backoff_ms(self) -> int:
        n = max(0, self._fail_streak - 1)
        return min(300_000, PROGRESS_PING_MS * (2**n))

    def _note_hermes_ok(self) -> None:
        self._fail_streak = 0

    def _note_hermes_fail(self) -> bool:
        """Bump fail streak; auto-pause after FAIL_STREAK_PAUSE. Returns True if paused."""
        self._fail_streak += 1
        if self._fail_streak < FAIL_STREAK_PAUSE:
            return False
        self._edge(
            "system",
            "you",
            f"Factory paused after {FAIL_STREAK_PAUSE} consecutive Hermes oneshot failures. Resume when ready.",
        )
        self.pause()
        return True

    def _clear_activity(self) -> None:
        m = store.get_mission() or {}
        m["activity"] = None
        m["activeId"] = None
        store.save_mission(m)
        events.publish("mission", m)

    def _unstick_doing_cards(self, note: str) -> None:
        changed = False
        for c in store.list_cards():
            if c.get("status") != "doing":
                continue
            store.patch_card(c["id"], {"status": "todo", "note": note})
            changed = True
        if changed:
            events.publish("kanban", {"cards": store.list_cards()})

    def _schedule_desk_kicks(self, manager_ids: list[str], delay_ms: int = 500) -> None:
        """Run ready desk kicks after ping releases busy — not interleaved with CEO/CTO oneshots."""
        pending = [mid for mid in manager_ids if mid]
        if not pending:
            return
        self._pending_kicks = list(dict.fromkeys(pending))
        self._clear_kick_timer()

        def _fire() -> None:
            self._kick_timer = None
            managers = list(self._pending_kicks)
            self._pending_kicks = []
            m = store.get_mission()
            if not m or m.get("delivered") or m.get("paused"):
                return
            if self._busy:
                self._schedule_desk_kicks(managers, 2_000)
                return
            self._busy = True
            events.publish("busy", {"busy": True})
            try:
                template = self._template()
                for mid in managers:
                    if self._ping_abort or (store.get_mission() or {}).get("paused"):
                        break
                    try:
                        self._kick_ready(template, mid)
                    except Exception as err:  # noqa: BLE001
                        self._edge(mid, "you", f"START failed: {err}")
                if self._all_subs_done() and not (store.get_mission() or {}).get("paused"):
                    self._ceo_deliver(
                        self._run_id,
                        template,
                        self._last_board or m.get("title") or "",
                    )
            finally:
                self._busy = False
                events.publish("busy", {"busy": False})

        self._kick_timer = threading.Timer(max(0.2, delay_ms / 1000), _fire)
        self._kick_timer.daemon = True
        self._kick_timer.start()

    def _edge(self, src: str, dst: str, text: str) -> None:
        edge = {"from": src, "to": dst, "text": text, "ts": time.time()}
        store.append_feed(edge)
        events.publish("feed", edge)

    def _alive_chain(self, run_id: int) -> None:
        if self._chain_abort or run_id != self._run_id:
            raise RuntimeError("COURSE_CHANGED")

    def _template(self) -> dict:
        settings = load_settings()
        tid = settings.get("templateId") or "software-company"
        # compat.load_template
        from ..compat import load_template as lt

        tmpl = lt(tid) or lt("software-company")
        if not tmpl:
            raise RuntimeError("No template loaded")
        return tmpl

    def _role_timeout(self, kind: str) -> int:
        settings = load_settings()
        key = "hermesPingTimeoutSec" if kind == "ping" else "hermesTimeoutSec"
        default = 180 if kind == "ping" else 900
        try:
            return max(30, int(settings.get(key) or default))
        except (TypeError, ValueError):
            return default

    def _role_turn(
        self, role_id: str, prompt: str, *, kind: str = "desk"
    ) -> dict[str, Any]:
        settings = load_settings()
        template = self._template()
        profile = org.profile_for_role(template, settings, role_id)
        timeout = self._role_timeout(kind)
        events.publish(
            "agent",
            {"roleId": role_id, "status": "working", "profile": profile},
        )
        m = store.get_mission() or {}
        m["activeId"] = role_id
        m["activity"] = {
            "roleId": role_id,
            "kind": "api",
            "label": "Hermes API call",
            "profile": profile,
            "startedAt": time.time() * 1000,
        }
        store.save_mission(m)
        events.publish("mission", m)

        result = run_hermes(profile, prompt, timeout=timeout)
        reply = result.get("reply") or ""
        events.publish(
            "agent",
            {
                "roleId": role_id,
                "status": "idle" if result.get("ok") else "blocked",
                "profile": profile,
            },
        )
        # Fan-out to UI Hermes-runs inspector (prompt / response / headers)
        events.publish(
            "hermes_run",
            {
                "roleId": role_id,
                "profile": profile,
                "prompt": prompt,
                "reply": reply,
                "ok": bool(result.get("ok")),
                "error": result.get("error"),
                "usage": result.get("usage"),
                "latencyMs": result.get("latencyMs"),
                "bridgeLatencyMs": result.get("latencyMs"),
                "cmd": result.get("cmd"),
                "stderr": result.get("stderr") or "",
                "returncode": result.get("returncode"),
                "isTask": True,
                "raw": {
                    k: result.get(k)
                    for k in (
                        "ok",
                        "error",
                        "profile",
                        "profileMeta",
                        "usage",
                        "latencyMs",
                        "cmd",
                        "workspace",
                        "returncode",
                    )
                },
            },
        )
        if not result.get("ok"):
            self._clear_activity()
            raise RuntimeError(result.get("error") or "Hermes failed")
        self._note_hermes_ok()
        return result

    def _persist_cards(self, cards: list[dict]) -> None:
        store.clear_cards()
        for c in cards:
            store.upsert_card(c)
        events.publish("kanban", {"cards": store.list_cards()})

    def _all_subs_done(self) -> bool:
        cards = [c for c in store.list_cards() if c.get("kind") != "main"]
        return bool(cards) and all(c.get("status") == "done" for c in cards)

    def start_board_mission(self, board_message: str) -> dict[str, Any]:
        if self._busy:
            return {"ok": False, "error": "Factory is busy"}
        text = (board_message or "").strip()
        if not text:
            return {"ok": False, "error": "message required"}

        def _run() -> None:
            try:
                self._run_board(text)
            except RuntimeError as err:
                if "COURSE_CHANGED" not in str(err):
                    self._edge("system", "you", f"Run failed: {err}")
            except Exception as err:  # noqa: BLE001
                self._edge("system", "you", f"Run failed: {err}")
            finally:
                self._busy = False
                events.publish("busy", {"busy": False})

        self._busy = True
        self._chain_abort = False
        self._ping_abort = False
        self._run_id += 1
        run_id = self._run_id
        self._last_board = text
        events.publish("busy", {"busy": True})
        threading.Thread(target=_run, daemon=True).start()
        return {"ok": True, "runId": run_id}

    def _ensure_mission(self, title: str, template: dict) -> dict:
        settings = load_settings()
        steps = []
        for r in template.get("roles") or []:
            if not isinstance(r, dict) or not r.get("id"):
                continue
            ov = (settings.get("roleProfiles") or {}).get(r["id"]) or {}
            steps.append(
                {
                    "id": r["id"],
                    "title": r.get("title") or r["id"],
                    "status": "queued",
                    "taskState": None,
                    "note": "",
                    "hermesProfile": ov.get("hermesProfile")
                    or r.get("hermesProfile")
                    or settings.get("parentProfile"),
                    "provider": ov.get("provider"),
                    "model": ov.get("model"),
                }
            )
        mission = {
            "missionId": f"{int(time.time()*1000)}-{uuid.uuid4().hex[:6]}",
            "title": title[:200],
            "taskState": "in_progress",
            "startedAt": time.time() * 1000,
            "delivered": False,
            "paused": False,
            "pinging": False,
            "pingCount": 0,
            "phase": "intake",
            "activeId": template.get("orchestratorRoleId"),
            "steps": steps,
            "nextPingAt": None,
        }
        store.save_mission(mission)
        events.publish("mission", mission)
        return mission

    def _mark_step(
        self,
        role_id: str,
        *,
        status: str | None = None,
        task_state: str | None = None,
        note: str | None = None,
        roll_up: bool = True,
    ) -> None:
        m = store.get_mission() or {}
        for s in m.get("steps") or []:
            if s.get("id") != role_id:
                continue
            if status:
                s["status"] = status
            if task_state:
                s["taskState"] = task_state
                if roll_up:
                    m["taskState"] = task_state
            if note is not None:
                s["note"] = note
            break
        store.save_mission(m)
        events.publish("mission", m)

    def _run_board(self, board_message: str) -> None:
        run_id = self._run_id
        template = self._template()
        settings = load_settings()
        orch_id = template.get("orchestratorRoleId") or "ceo"
        self._ensure_mission(board_message, template)
        self._path = []
        self._edge("you", orch_id, board_message)

        # —— CEO picks manager(s) ——
        managers = org.delegate_candidates(template, orch_id)
        mgr_lines = "\n".join(
            f"  {m['id']} — {m.get('title')}" for m in managers
        )
        prompt = "\n".join(
            [
                f"You are the {org.role_title(template, orch_id)}, orchestrator.",
                f"Board request:\n{board_message}",
                f"Valid managers:\n{mgr_lines}",
                "Reply briefly. End with DELEGATE: <manager_id>",
                "Also: TASK_STATE: in_progress",
            ]
        )
        self._alive_chain(run_id)
        result = self._role_turn(orch_id, prompt)
        reply = result["reply"]
        self._edge(orch_id, "you", reply)
        self._mark_step(orch_id, status="done", task_state=parse_task_state(reply), note=reply[:160])
        self._path.append({"id": orch_id, "reply": reply, "state": parse_task_state(reply)})

        m = re.search(r"DELEGATE:\s*([a-z0-9_-]+)", reply, re.I)
        manager_id = (m.group(1).lower() if m else None) or (
            managers[0]["id"] if managers else None
        )
        if not manager_id:
            raise RuntimeError("CEO did not delegate to a manager")

        # —— Manager plans MAIN + TASK ——
        executors = org.delegate_candidates(template, manager_id)
        ex_ids = [e["id"] for e in executors]
        ex_lines = "\n".join(
            f"  {e['id']} — {e.get('title')}" for e in executors
        )
        plan_prompt = "\n".join(
            [
                f"You are the {org.role_title(template, manager_id)}, a manager.",
                "You own the factory kanban. ONE MAIN card, then SUB tasks with optional AFTER deps.",
                f"Workspace: {settings.get('workspacePath')} — keep all work there.",
                "Do NOT create Hermes Agent kanban / t_* tasks.",
                f"Valid executors:\n{ex_lines}",
                "End with:",
                "  MAIN: <one line>",
                "  TASK: <role_id> | <subtask>",
                "  TASK: <role_id> | <subtask> | AFTER: <n>",
                "TASK_STATE: in_progress",
                f"Board request:\n{board_message}",
                f"CEO said:\n{reply}",
            ]
        )
        self._alive_chain(run_id)
        planned = self._role_turn(manager_id, plan_prompt)
        plan_reply = planned["reply"]
        self._edge(manager_id, "you", f"Plan: {plan_reply}")
        plan = parse_manager_plan(plan_reply, ex_ids)
        if not plan["tasks"] and ex_ids:
            plan["tasks"] = [
                {
                    "assigneeId": ex_ids[0],
                    "title": board_message[:140],
                    "dependsOn": [],
                    "index": 1,
                }
            ]

        cards = self._materialize_plan(manager_id, plan, board_message)
        self._persist_cards(cards)
        self._mark_step(
            manager_id,
            status="done",
            task_state="in_progress",
            note=f"Kanban plan → {len(plan['tasks'])} tasks",
        )

        # —— Waves ——
        self._run_waves(run_id, template, manager_id, board_message)

        # —— QA ——
        self._run_qa(run_id, template, manager_id, board_message)

        # —— CEO deliver if board complete, else keep open + ping ——
        if self._all_subs_done():
            self._ceo_deliver(run_id, template, board_message)
        else:
            m = store.get_mission() or {}
            m["phase"] = "open"
            m["taskState"] = "in_progress"
            store.save_mission(m)
            self._schedule_ping()

    def _materialize_plan(
        self, manager_id: str, plan: dict, board_message: str
    ) -> list[dict]:
        main_id = f"main-{uuid.uuid4().hex[:8]}"
        main = {
            "id": main_id,
            "kind": "main",
            "parentId": None,
            "managerId": manager_id,
            "assigneeId": manager_id,
            "title": (plan.get("mainTitle") or board_message)[:180],
            "status": "doing",
            "dependsOn": [],
            "source": "cto",
            "note": "Manager owns delivery",
            "createdAt": time.time(),
        }
        raw = []
        for i, t in enumerate(plan.get("tasks") or [], start=1):
            tid = f"sub-{uuid.uuid4().hex[:8]}"
            raw.append({**t, "_idx": i, "tempId": tid})
        subs = []
        for t in raw:
            dep_ids = []
            for ref in t.get("dependsOn") or []:
                num = str(ref).replace("#", "")
                if num.isdigit():
                    prior = next(
                        (x for x in raw if x["_idx"] == int(num)), None
                    )
                    if prior:
                        dep_ids.append(prior["tempId"])
                    continue
                prior = next(
                    (
                        x
                        for x in raw
                        if x["_idx"] < t["_idx"]
                        and x.get("assigneeId") == ref
                    ),
                    None,
                )
                if prior:
                    dep_ids.append(prior["tempId"])
            subs.append(
                {
                    "id": t["tempId"],
                    "kind": "sub",
                    "parentId": main_id,
                    "managerId": manager_id,
                    "assigneeId": t.get("assigneeId"),
                    "title": t.get("title") or "Task",
                    "status": "blocked" if dep_ids else "todo",
                    "dependsOn": dep_ids,
                    "source": "cto",
                    "note": "",
                    "createdAt": time.time(),
                }
            )
        return refresh_blocked([main, *subs], manager_id)

    def _run_waves(
        self, run_id: int, template: dict, manager_id: str, board_message: str
    ) -> list[dict]:
        results: list[dict] = []
        finished: set[str] = set()
        guard = 0
        while guard < 40:
            guard += 1
            self._alive_chain(run_id)
            cards = refresh_blocked(store.list_cards(), manager_id)
            self._persist_cards(cards)
            open_subs = [
                c
                for c in cards
                if c.get("kind") != "main"
                and c.get("status") != "done"
                and c["id"] not in finished
            ]
            if not open_subs:
                break
            ready_all = [
                c
                for c in ready_subs(cards, manager_id)
                if c["id"] not in finished
            ]
            ready = []
            seen = set()
            for c in ready_all:
                if c["assigneeId"] in seen:
                    continue
                seen.add(c["assigneeId"])
                ready.append(c)
            if not ready:
                self._edge(
                    manager_id,
                    "you",
                    f"Kanban waiting — {len(open_subs)} blocked",
                )
                break

            self._edge(
                manager_id,
                ready[0]["assigneeId"],
                f"Wave — {len(ready)} ready subtask(s)",
            )
            # Sequential within wave for simpler abort; parallel later
            for card in ready:
                self._alive_chain(run_id)
                r = self._run_sub(template, manager_id, card, board_message)
                finished.add(card["id"])
                if r and not r.get("failed"):
                    results.append(r)
        return results

    def _run_sub(
        self, template: dict, manager_id: str, card: dict, board_message: str
    ) -> dict | None:
        rid = card.get("assigneeId")
        if not rid:
            return None
        self._mark_step(
            rid, status="active", task_state="in_progress", note=card.get("title")
        )
        store.patch_card(
            card["id"], {"status": "doing", "note": "Working at desk"}
        )
        events.publish("kanban", {"cards": store.list_cards()})
        events.publish(
            "agent", {"roleId": rid, "status": "working"}
        )

        dep_notes = []
        cards = {c["id"]: c for c in store.list_cards()}
        for dep_id in card.get("dependsOn") or []:
            dep = cards.get(dep_id)
            if dep:
                dep_notes.append(
                    f"{dep.get('title')} ({org.role_title(template, dep.get('assigneeId'))}): {dep.get('note') or ''}"
                )
        role = org.role_by_id(template, rid) or {"id": rid, "title": rid}
        prompt = "\n".join(
            [
                f"You are the {role.get('title')}, an executor.",
                f"Workspace only: stay under the factory workspace.",
                f"Original board request:\n{board_message}",
                f"Your subtask: {card.get('title')}",
                ("Upstream:\n" + "\n".join(dep_notes)) if dep_notes else "",
                "Reply 2-4 sentences. Cleanup any processes you started.",
                "End with: TASK_STATE: <pending|in_progress|blocked|done>",
            ]
        )
        try:
            result = self._role_turn(rid, prompt, kind="desk")
        except Exception as err:  # noqa: BLE001
            store.patch_card(
                card["id"],
                {
                    "status": "todo",
                    "note": f"API/process failed — recovery ping to retry: {str(err)[:180]}",
                },
            )
            self._mark_step(
                rid, status="hold", task_state="blocked", note=str(err)[:120]
            )
            self._edge(rid, manager_id, f"Failed: {err}")
            events.publish("kanban", {"cards": store.list_cards()})
            self._note_hermes_fail()
            return {"id": rid, "cardId": card["id"], "failed": True, "reply": ""}

        reply = result["reply"]
        state = parse_task_state(reply)
        note = re.sub(r"\s+", " ", reply).strip()[:200]
        self._edge(rid, manager_id, f"[{state}] {card.get('title')}: {reply}")
        if state == "blocked":
            store.patch_card(
                card["id"], {"status": "blocked", "note": note or "Blocked"}
            )
            self._mark_step(
                rid, status="waiting", task_state="blocked", note=card.get("title")
            )
        else:
            store.patch_card(card["id"], {"status": "done", "note": note})
            self._mark_step(
                rid,
                status="done",
                task_state="done" if state == "done" else "in_progress",
                note=card.get("title"),
            )
        # Unblock dependents
        cards = refresh_blocked(store.list_cards(), manager_id)
        # Close main if all subs done
        subs = [c for c in cards if c.get("parentId") == card.get("parentId") and c.get("kind") != "main"]
        if card.get("parentId") and subs and all(c.get("status") == "done" for c in subs):
            store.patch_card(
                card["parentId"], {"status": "done", "note": "All subtasks done"}
            )
        events.publish("kanban", {"cards": store.list_cards()})
        events.publish("agent", {"roleId": rid, "status": "idle"})
        return {
            "id": rid,
            "cardId": card["id"],
            "reply": reply,
            "state": state,
            "failed": False,
        }

    def _run_qa(
        self, run_id: int, template: dict, manager_id: str, board_message: str
    ) -> None:
        evaluator = org.evaluator_for(template)
        done = [
            c
            for c in store.list_cards()
            if c.get("kind") != "main"
            and c.get("managerId") == manager_id
            and c.get("status") == "done"
        ]
        if not evaluator or not done:
            return
        self._alive_chain(run_id)
        eid = evaluator["id"]
        self._mark_step(eid, status="active", task_state="in_progress", note="QC review")
        self._edge(manager_id, eid, f"QC handoff ({len(done)} finished)")
        body = "\n\n".join(
            f"{org.role_title(template, c.get('assigneeId'))}: {c.get('note')}"
            for c in done
        )
        prompt = "\n".join(
            [
                f"You are the {evaluator.get('title')}, evaluator (QA).",
                f"Original board request:\n{board_message}",
                "Review finished subtasks:",
                body,
                "End with TASK_STATE: <pending|in_progress|blocked|done>",
            ]
        )
        try:
            result = self._role_turn(eid, prompt)
        except Exception as err:  # noqa: BLE001
            self._edge(eid, manager_id, f"QA failed: {err}")
            return
        qc_state = parse_task_state(result["reply"])
        qc_note = re.sub(r"\s+", " ", result["reply"]).strip()[:200]
        self._edge(eid, manager_id, f"[QA · {qc_state}] {result['reply']}")
        for c in done:
            store.patch_card(
                c["id"],
                {"note": f"QA · {qc_state}: {qc_note}"},
            )
        self._mark_step(
            eid,
            status="done" if qc_state == "done" else "hold",
            task_state=qc_state,
            note=qc_note,
        )
        events.publish("kanban", {"cards": store.list_cards()})

    def _ceo_deliver(
        self, run_id: int, template: dict, board_message: str
    ) -> bool:
        orch_id = template.get("orchestratorRoleId") or "ceo"
        self._alive_chain(run_id)
        path_lines = "\n".join(
            f"- {org.role_title(template, p['id'])}: {str(p.get('reply') or '')[:200]}"
            for p in self._path
        )
        cards = store.list_cards()
        card_lines = "\n".join(
            f"- [{c.get('status')}] {c.get('title')} → {org.role_title(template, c.get('assigneeId'))}"
            for c in cards
            if c.get("kind") != "main"
        )
        prompt = "\n".join(
            [
                f"You are the {org.role_title(template, orch_id)}, the board contact.",
                "Factory kanban shows ALL subtasks done — close out to the board now.",
                f"Original board request:\n{board_message}",
                f"Work trail:\n{path_lines or '(see kanban)'}",
                f"Cards:\n{card_lines}",
                "Write a board delivery report (4-8 sentences).",
                "End with exactly:",
                "TASK_STATE: done",
                "DELIVERED: yes",
            ]
        )
        self._mark_step(orch_id, status="active", note="Board report")
        m = store.get_mission() or {}
        m["phase"] = "verify"
        m["activeId"] = orch_id
        store.save_mission(m)
        events.publish("mission", m)
        self._edge(orch_id, "you", "All factory cards done — CEO board report required")
        try:
            result = self._role_turn(orch_id, prompt)
        except Exception as err:  # noqa: BLE001
            self._edge(orch_id, "you", f"CEO deliver failed: {err}")
            self._schedule_ping(5_000)
            return False
        reply = result["reply"]
        state = parse_task_state(reply, "done")
        wants = parse_delivered(reply)
        delivered_ok = wants is True and (state == "done" or self._all_subs_done())
        self._edge(
            orch_id,
            "you",
            f"[{state}{' · DELIVERED' if delivered_ok else ' · NOT DELIVERED'}] {reply}",
        )
        if delivered_ok:
            self._last_report = reply
            self._clear_ping_timer()
            store.append_history(
                {
                    "id": (store.get_mission() or {}).get("missionId")
                    or uuid.uuid4().hex,
                    "title": board_message[:200],
                    "taskState": "done",
                    "deliveredAt": time.time() * 1000,
                    "report": reply[:6000],
                    "boardMessage": board_message[:2000],
                }
            )
            m = store.get_mission() or {}
            m["delivered"] = True
            m["deliveredAt"] = time.time() * 1000
            m["pinging"] = False
            m["activeId"] = None
            m["phase"] = "delivered"
            m["taskState"] = "done"
            m["nextPingAt"] = None
            for s in m.get("steps") or []:
                if s.get("status") in ("active", "queued", "waiting"):
                    s["status"] = "done"
            store.save_mission(m)
            events.publish("mission", m)
            events.publish("delivered", {"report": reply})
            return True
        self._mark_step(
            orch_id,
            status="active",
            task_state=state,
            note="Verification — still open",
            roll_up=True,
        )
        self._edge(
            orch_id,
            "you",
            "Factory board is 100% done — CEO must end with DELIVERED: yes on the next ping",
        )
        self._schedule_ping(5_000)
        return False

    def run_progress_ping(self, reason: str = "ping") -> None:
        m = store.get_mission()
        if not m or m.get("delivered") or m.get("paused"):
            return
        if self._busy:
            self._schedule_ping(20_000)
            return

        self._busy = True
        self._ping_abort = False
        events.publish("busy", {"busy": True})
        m["pinging"] = True
        m["pingCount"] = (m.get("pingCount") or 0) + 1
        store.save_mission(m)
        events.publish("mission", m)
        kick_managers: list[str] = []
        had_fail = False
        try:
            template = self._template()
            orch_id = template.get("orchestratorRoleId") or "ceo"
            cards = store.list_cards()
            open_cards = [c for c in cards if c.get("status") != "done"]
            manager_ids = list(
                {
                    c["managerId"]
                    for c in open_cards
                    if c.get("managerId") and c["managerId"] != orch_id
                }
            )

            # Managers with open work first; skip orch spam when only mid-desk doing.
            needs_orch = (
                not manager_ids
                or self._all_subs_done()
                or any(c.get("status") in ("todo", "blocked") for c in open_cards)
            )
            targets: list[str] = []
            for mid in manager_ids:
                if mid not in targets:
                    targets.append(mid)
            if needs_orch and orch_id not in targets:
                targets.insert(0, orch_id)

            latest = m.get("taskState") or "in_progress"
            for tid in targets:
                if self._ping_abort or (store.get_mission() or {}).get("paused"):
                    return
                role = org.role_by_id(template, tid)
                if not role:
                    continue
                kind = org.normalize_role_kind(
                    role.get("roleKind"),
                    is_orchestrator=tid == orch_id,
                )
                mine = [c for c in open_cards if c.get("managerId") == tid]
                has_kanban = kind == "manager" and bool(mine)
                if kind == "manager" and not has_kanban:
                    continue

                summary = "\n".join(
                    f"- [{c.get('kind')}·{c.get('status')}] {c.get('assigneeId')} {c.get('title')}"
                    + (
                        " · FROZEN (done needs GATE: allow)"
                        if c.get("status") == "blocked"
                        else ""
                    )
                    for c in (mine or cards)[:12]
                )
                prompt = "\n".join(
                    [
                        f"You are the {role.get('title')}.",
                        "Recovery ping. Factory kanban by position:",
                        summary or "(no cards)",
                        "You OWN this board. CARD: <role_id> | <status>",
                        "Frozen/blocked → done requires GATE: allow",
                        "START ready work. RETRY API failures.",
                        "FORBIDDEN: Hermes t_* kanban.",
                        f"Original: {self._last_board or m.get('title')}",
                        f"End with TASK_STATE: <pending|in_progress|blocked|done>",
                    ]
                )
                self._edge("system", tid, f"Ping → {tid}")
                try:
                    result = self._role_turn(tid, prompt, kind="ping")
                except Exception as err:  # noqa: BLE001
                    had_fail = True
                    self._edge(tid, "you", f"Ping failed: {err}")
                    if self._note_hermes_fail():
                        return
                    continue
                reply = result["reply"]
                state = parse_task_state(reply, latest)
                latest = state
                self._mark_step(
                    tid,
                    status="done" if state == "done" else "queued",
                    task_state=state,
                    note=f"ping: {reply[:120]}",
                    roll_up=False,
                )
                self._edge(orch_id, tid, f"[ping · {state}] {reply}")

                if has_kanban:
                    directives = parse_kanban_directives(reply)
                    ready_now = ready_subs(store.list_cards(), tid)
                    if ready_now and re.search(
                        r"\b(start|retry|working|kick|unblock|resume)\b",
                        reply,
                        re.I,
                    ):
                        directives["start"] = True
                    cards2, applied = apply_kanban_directives(
                        store.list_cards(), tid, directives
                    )
                    self._persist_cards(cards2)
                    if applied.get("denied"):
                        self._edge(
                            tid,
                            "you",
                            f"Gate closed — {len(applied['denied'])} frozen card(s). Say GATE: allow then CARD: <role> | done",
                        )
                    if applied.get("moved") or applied.get("reopened"):
                        self._edge(
                            tid,
                            "you",
                            f"Kanban moves: {applied['moved']} · reopened {applied['reopened']}",
                        )
                    # Desk kicks run after ping (separate busy window)
                    if directives.get("start") or ready_now:
                        kick_managers.append(tid)

            if (store.get_mission() or {}).get("paused"):
                return
            if self._all_subs_done() or latest == "done":
                self._ceo_deliver(
                    self._run_id, template, self._last_board or m.get("title") or ""
                )
            else:
                delay = self._ping_backoff_ms() if had_fail else PROGRESS_PING_MS
                self._schedule_ping(delay)
                if kick_managers:
                    self._schedule_desk_kicks(kick_managers)
        finally:
            m2 = store.get_mission() or {}
            m2["pinging"] = False
            if m2.get("paused"):
                m2["activity"] = None
                m2["activeId"] = None
            store.save_mission(m2)
            events.publish("mission", m2)
            self._busy = False
            events.publish("busy", {"busy": False})

    def _kick_ready(self, template: dict, manager_id: str) -> None:
        cards = store.list_cards()
        for card in ready_subs(cards, manager_id):
            try:
                self._run_sub(
                    template,
                    manager_id,
                    card,
                    self._last_board
                    or (store.get_mission() or {}).get("title")
                    or "",
                )
            except Exception as err:  # noqa: BLE001
                self._edge(manager_id, "you", f"START failed: {err}")
                break
        if self._all_subs_done():
            self._run_qa(
                self._run_id,
                template,
                manager_id,
                self._last_board or "",
            )
