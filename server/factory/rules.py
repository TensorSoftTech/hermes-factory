"""Kanban / ping / profile rules ported from the factory UI."""

from __future__ import annotations

import re
from typing import Any, Iterable


COLUMNS = ("todo", "blocked", "doing", "review", "done")


def normalize_depends(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    return list({str(x).strip() for x in raw if str(x).strip()})


def deps_met(card: dict, by_id: dict[str, dict]) -> bool:
    deps = normalize_depends(card.get("dependsOn"))
    if not deps:
        return True
    return all(by_id.get(d, {}).get("status") == "done" for d in deps)


def is_api_failed(card: dict | None) -> bool:
    note = (card or {}).get("note") or ""
    return bool(
        re.search(
            r"recovery ping to retry|API/process failed|reopened for manager|Manager retry after kanban",
            note,
            re.I,
        )
    )


def is_dep_blocked(card: dict | None, by_id: dict[str, dict]) -> bool:
    if not card or card.get("kind") == "main":
        return False
    if card.get("status") not in ("blocked", "todo"):
        return False
    if is_api_failed(card):
        return False
    deps = normalize_depends(card.get("dependsOn"))
    if not deps:
        return False
    return any(by_id.get(d, {}).get("status") != "done" for d in deps)


def is_frozen(card: dict | None, by_id: dict[str, dict]) -> bool:
    if not card or card.get("kind") == "main" or card.get("status") == "done":
        return False
    if card.get("status") == "blocked":
        return True
    if is_dep_blocked(card, by_id):
        return True
    if is_api_failed(card):
        return True
    return bool(
        re.search(
            r"waiting on|frozen|stuck|API/process failed|recovery ping to retry",
            card.get("note") or "",
            re.I,
        )
    )


def ready_subs(cards: list[dict], manager_id: str) -> list[dict]:
    by_id = {c["id"]: c for c in cards}
    return [
        c
        for c in cards
        if c.get("managerId") == manager_id
        and c.get("kind") != "main"
        and c.get("assigneeId")
        and c.get("status") == "todo"
        and deps_met(c, by_id)
    ]


def refresh_blocked(cards: list[dict], manager_id: str | None = None) -> list[dict]:
    by_id = {c["id"]: c for c in cards}
    out = []
    for card in cards:
        c = dict(card)
        if manager_id and c.get("managerId") != manager_id:
            out.append(c)
            continue
        if c.get("kind") == "main":
            out.append(c)
            continue
        if c.get("status") in ("doing", "review", "done"):
            out.append(c)
            continue
        ready = deps_met(c, by_id)
        c["status"] = "todo" if ready else "blocked"
        if not ready and normalize_depends(c.get("dependsOn")):
            waiting = [
                by_id.get(d, {}).get("title") or d
                for d in normalize_depends(c.get("dependsOn"))
                if by_id.get(d, {}).get("status") != "done"
            ][:3]
            if waiting:
                c["note"] = f"Waiting on: {', '.join(waiting)}"
        out.append(c)
        by_id[c["id"]] = c
    return out


def parse_task_state(text: str, fallback: str = "in_progress") -> str:
    m = re.search(
        r"TASK_STATE:\s*(pending|in_progress|blocked|done)\b", text or "", re.I
    )
    return m.group(1).lower() if m else fallback


def parse_delivered(text: str) -> bool | None:
    m = re.search(r"DELIVERED:\s*(yes|no)\b", text or "", re.I)
    if not m:
        return None
    return m.group(1).lower() == "yes"


def parse_manager_plan(text: str, executor_ids: Iterable[str]) -> dict[str, Any]:
    ids = {str(x).lower() for x in executor_ids}
    main_m = re.search(r"MAIN:\s*(.+)", text or "", re.I)
    main_title = (
        main_m.group(1).split("\n")[0].strip()[:180] if main_m else None
    )
    tasks = []
    for m in re.finditer(
        r"TASK:\s*([a-z0-9_-]+)\s*\|\s*([^|\n]+?)(?:\|\s*AFTER:\s*([^\n]+))?$",
        text or "",
        re.I | re.M,
    ):
        rid = m.group(1).lower()
        if rid not in ids:
            continue
        title = m.group(2).strip()[:140]
        if not title:
            continue
        after_raw = [
            s.strip()
            for s in re.split(r"[,+\s]+", m.group(3) or "")
            if s.strip()
        ]
        tasks.append(
            {
                "assigneeId": rid,
                "title": title,
                "dependsOn": after_raw,
                "index": len(tasks) + 1,
            }
        )
    return {"mainTitle": main_title, "tasks": tasks}


def parse_kanban_directives(text: str) -> dict[str, Any]:
    moves = []
    for m in re.finditer(
        r"(?:CARD|STATUS|MOVE):\s*([a-z0-9_-]+)\s*\|\s*(todo|blocked|doing|review|done)\b",
        text or "",
        re.I,
    ):
        moves.append({"roleId": m.group(1).lower(), "status": m.group(2).lower()})
    return {
        "moves": moves,
        "retry": bool(re.search(r"\bRETRY\b", text or "", re.I)),
        "start": bool(
            re.search(r"\bSTART\b", text or "", re.I)
            or re.search(r"\bRETRY\b", text or "", re.I)
        ),
        "gateAllow": bool(re.search(r"\bGATE:\s*allow\b", text or "", re.I)),
    }


def resolve_run_profile(
    requested: str | None,
    settings: dict,
    known_ids: Iterable[str],
) -> tuple[str, dict]:
    known = set(known_ids)
    parent = str(settings.get("parentProfile") or "default").strip() or "default"
    req = str(requested or "").strip()
    if req and req not in known:
        req = ""
    if parent in known and parent != "default" and (not req or req == "default"):
        chosen = parent
    else:
        chosen = req or (parent if parent in known else "") or (
            "default" if "default" in known else parent
        )
    return chosen, {
        "id": chosen,
        "parentProfile": parent,
        "requested": requested or None,
    }


def apply_kanban_directives(
    cards: list[dict],
    manager_id: str,
    directives: dict,
) -> tuple[list[dict], dict]:
    by_id = {c["id"]: dict(c) for c in cards}
    cards_out = [dict(c) for c in cards]
    index = {c["id"]: i for i, c in enumerate(cards_out)}
    moved = reopened = gated = 0
    denied: list[dict] = []

    def set_card(cid: str, **fields: Any) -> None:
        nonlocal cards_out, index, by_id
        i = index.get(cid)
        if i is None:
            return
        c = dict(cards_out[i])
        c.update(fields)
        cards_out[i] = c
        by_id[cid] = c

    for mv in directives.get("moves") or []:
        open_cards = [
            c
            for c in cards_out
            if c.get("managerId") == manager_id
            and c.get("kind") != "main"
            and c.get("assigneeId") == mv["roleId"]
            and c.get("status") != "done"
        ]
        for card in open_cards:
            if mv["status"] == "done":
                frozen = is_frozen(card, by_id)
                if frozen and not directives.get("gateAllow"):
                    denied.append(
                        {
                            "roleId": mv["roleId"],
                            "title": card.get("title"),
                            "reason": "frozen — need GATE: allow",
                        }
                    )
                    continue
                set_card(
                    card["id"],
                    status="done",
                    note=(
                        "Manager GATE: allow → forced done (was frozen)"
                        if frozen
                        else "Manager marked done on ping"
                    ),
                )
                if frozen:
                    gated += 1
            else:
                note = (
                    "Manager set working on ping"
                    if mv["status"] == "doing"
                    else f"Manager moved → {mv['status']}"
                )
                set_card(card["id"], status=mv["status"], note=note)
            moved += 1

    if directives.get("retry"):
        for card in list(cards_out):
            if card.get("managerId") != manager_id or card.get("kind") == "main":
                continue
            if is_dep_blocked(card, by_id):
                continue
            if card.get("status") == "blocked":
                set_card(
                    card["id"],
                    status="todo",
                    note="Manager retry after kanban check",
                )
                reopened += 1

    cards_out = refresh_blocked(cards_out, manager_id)
    return cards_out, {
        "moved": moved,
        "reopened": reopened,
        "gated": gated,
        "denied": denied,
    }
