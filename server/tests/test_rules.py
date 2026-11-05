"""Unit tests for kanban / ping / profile rules."""

from __future__ import annotations

from factory.rules import (
    apply_kanban_directives,
    deps_met,
    is_frozen,
    parse_delivered,
    parse_kanban_directives,
    parse_manager_plan,
    parse_task_state,
    ready_subs,
    refresh_blocked,
    resolve_run_profile,
)


def test_parse_manager_plan_main_and_after():
    text = """
MAIN: Ship the widget
TASK: swe | Build API
TASK: swe2 | Wire UI | AFTER: 1
TASK: evil | ignore me
"""
    plan = parse_manager_plan(text, ["swe", "swe2"])
    assert plan["mainTitle"] == "Ship the widget"
    assert len(plan["tasks"]) == 2
    assert plan["tasks"][0]["assigneeId"] == "swe"
    assert plan["tasks"][1]["dependsOn"] == ["1"]


def test_parse_kanban_directives_gate():
    d = parse_kanban_directives(
        "CARD: swe | done\nGATE: allow\nRETRY\nTASK_STATE: in_progress"
    )
    assert d["moves"] == [{"roleId": "swe", "status": "done"}]
    assert d["gateAllow"] is True
    assert d["retry"] is True
    assert d["start"] is True


def test_gate_required_for_frozen_force_done():
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
        },
        {
            "id": "sub-1",
            "kind": "sub",
            "managerId": "cto",
            "assigneeId": "swe",
            "title": "Stuck",
            "status": "blocked",
            "dependsOn": [],
            "note": "Waiting on: API",
        },
    ]
    denied = apply_kanban_directives(
        cards, "cto", parse_kanban_directives("CARD: swe | done")
    )[1]
    assert denied["denied"]
    assert denied["moved"] == 0

    ok = apply_kanban_directives(
        cards,
        "cto",
        parse_kanban_directives("CARD: swe | done\nGATE: allow"),
    )[1]
    assert ok["gated"] == 1
    assert ok["moved"] == 1


def test_deps_met_and_ready_beats_blocked():
    a = {
        "id": "a",
        "kind": "sub",
        "managerId": "cto",
        "assigneeId": "swe",
        "title": "A",
        "status": "done",
        "dependsOn": [],
    }
    b = {
        "id": "b",
        "kind": "sub",
        "managerId": "cto",
        "assigneeId": "swe",
        "title": "B",
        "status": "todo",
        "dependsOn": ["a"],
    }
    by = {"a": a, "b": b}
    assert deps_met(b, by) is True
    assert is_frozen(b, by) is False

    b2 = {**b, "dependsOn": ["missing"]}
    assert deps_met(b2, {"a": a, "b": b2}) is False

    refreshed = refresh_blocked([a, {**b, "status": "blocked", "dependsOn": []}], "cto")
    ready = ready_subs(refreshed, "cto")
    assert any(c["id"] == "b" and c["status"] == "todo" for c in ready)


def test_resolve_run_profile_enforces_parent_sparky():
    settings = {"parentProfile": "sparky"}
    known = ["sparky", "default"]
    chosen, meta = resolve_run_profile("default", settings, known)
    assert chosen == "sparky"
    assert meta["parentProfile"] == "sparky"

    chosen2, _ = resolve_run_profile(None, settings, known)
    assert chosen2 == "sparky"


def test_parse_task_state_and_delivered():
    assert parse_task_state("foo\nTASK_STATE: done") == "done"
    assert parse_delivered("DELIVERED: yes") is True
    assert parse_delivered("DELIVERED: no") is False
    assert parse_delivered("nothing") is None
