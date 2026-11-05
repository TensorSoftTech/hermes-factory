"""Integration: fake hermes → board mission → waves → QA → CEO DELIVERED."""

from __future__ import annotations

import json
import time

import pytest


def test_full_board_mission_delivers(factory_home, fake_hermes, monkeypatch):
    from factory import store
    from factory.orch.engine import Orchestrator

    # Fresh orchestrator (bypass singleton leftover)
    orch = Orchestrator()

    result = orch.start_board_mission("Build a hello world CLI")
    assert result["ok"] is True

    # Wait for background thread
    deadline = time.time() + 15
    while time.time() < deadline:
        m = store.get_mission()
        if m and m.get("delivered"):
            break
        if not orch.busy and m and not m.get("delivered"):
            # May still be scheduling — give a beat
            time.sleep(0.2)
            if not orch.busy:
                break
        time.sleep(0.05)

    mission = store.get_mission()
    cards = store.list_cards()
    assert mission is not None
    # All sub cards done
    subs = [c for c in cards if c.get("kind") != "main"]
    assert subs, "expected materialized subtasks"
    assert all(c.get("status") == "done" for c in subs)
    assert mission.get("delivered") is True
    assert mission.get("pinging") is False

    # Profile enforce: never silent default when parent=sparky
    log_lines = fake_hermes["log"].read_text().strip().splitlines()
    assert log_lines
    for line in log_lines:
        entry = json.loads(line)
        assert entry["profile"] == "sparky"
        assert entry["cwd"] == str(factory_home / "workspace")


def test_ping_gate_force_done(factory_home, fake_hermes):
    from factory import store
    from factory.orch.engine import Orchestrator
    from factory.rules import apply_kanban_directives, parse_kanban_directives

    cards = [
        {
            "id": "main-1",
            "kind": "main",
            "managerId": "cto",
            "assigneeId": "cto",
            "title": "Main",
            "status": "doing",
            "dependsOn": [],
            "note": "",
            "createdAt": time.time(),
        },
        {
            "id": "sub-frozen",
            "kind": "sub",
            "managerId": "cto",
            "assigneeId": "swe",
            "title": "Frozen work",
            "status": "blocked",
            "dependsOn": [],
            "note": "Waiting on: upstream",
            "createdAt": time.time(),
        },
    ]
    for c in cards:
        store.upsert_card(c)

    # Without GATE — denied
    out, meta = apply_kanban_directives(
        store.list_cards(), "cto", parse_kanban_directives("CARD: swe | done")
    )
    assert meta["denied"]

    # With GATE — done
    out2, meta2 = apply_kanban_directives(
        store.list_cards(),
        "cto",
        parse_kanban_directives("CARD: swe | done\nGATE: allow"),
    )
    assert meta2["gated"] == 1
    assert any(c["id"] == "sub-frozen" and c["status"] == "done" for c in out2)


def test_ping_does_not_roll_mission_done_alone(factory_home, fake_hermes):
    """Regression: TASK_STATE: done on a ping must not settle without DELIVERED."""
    from factory import store
    from factory.orch.engine import Orchestrator

    orch = Orchestrator()
    store.save_mission(
        {
            "missionId": "m1",
            "title": "Open work",
            "taskState": "in_progress",
            "delivered": False,
            "paused": False,
            "pinging": False,
            "steps": [{"id": "ceo", "status": "queued"}],
            "phase": "open",
        }
    )
    store.upsert_card(
        {
            "id": "sub-open",
            "kind": "sub",
            "managerId": "cto",
            "assigneeId": "swe",
            "title": "Still open",
            "status": "todo",
            "dependsOn": [],
            "note": "",
        }
    )
    # Mark step via internal helper as ping would with roll_up=False
    orch._mark_step(  # noqa: SLF001
        "ceo",
        status="done",
        task_state="done",
        note="ping said done",
        roll_up=False,
    )
    m = store.get_mission()
    assert m["taskState"] == "in_progress"
    assert m["delivered"] is False


def test_health_and_settings_api(factory_home, fake_hermes):
    from fastapi.testclient import TestClient
    from factory.app import app

    client = TestClient(app)
    h = client.get("/api/health")
    assert h.status_code == 200
    assert h.json()["ok"] is True

    s = client.get("/api/settings")
    assert s.status_code == 200
    assert "workspacePath" in s.json()

    bad = client.put(
        "/api/settings",
        json={"workspacePath": "../escape"},
    )
    assert bad.status_code == 400
