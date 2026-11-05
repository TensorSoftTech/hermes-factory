"""Org-chart helpers from a template dict."""

from __future__ import annotations

from typing import Any


ROLE_KINDS = ("orchestrator", "manager", "executor", "evaluator")


def normalize_role_kind(value: Any, *, is_orchestrator: bool = False) -> str:
    v = str(value or "").strip().lower()
    if v in ROLE_KINDS:
        return v
    return "orchestrator" if is_orchestrator else "executor"


def role_by_id(template: dict, role_id: str | None) -> dict | None:
    if not role_id:
        return None
    for r in template.get("roles") or []:
        if isinstance(r, dict) and r.get("id") == role_id:
            return r
    return None


def role_title(template: dict, role_id: str | None) -> str:
    r = role_by_id(template, role_id)
    return (r or {}).get("title") or role_id or "—"


def roles_of_kind(template: dict, kind: str) -> list[dict]:
    orch = template.get("orchestratorRoleId")
    out = []
    for r in template.get("roles") or []:
        if not isinstance(r, dict):
            continue
        k = normalize_role_kind(
            r.get("roleKind"), is_orchestrator=r.get("id") == orch
        )
        if k == kind:
            out.append(r)
    return out


def delegate_candidates(template: dict, from_id: str) -> list[dict]:
    role = role_by_id(template, from_id)
    if not role:
        return []
    kind = normalize_role_kind(
        role.get("roleKind"),
        is_orchestrator=from_id == template.get("orchestratorRoleId"),
    )
    if kind == "orchestrator":
        return roles_of_kind(template, "manager")
    if kind == "manager":
        return [
            r
            for r in roles_of_kind(template, "executor")
            if r.get("takesOrdersFrom") == from_id
        ]
    return []


def evaluator_for(template: dict) -> dict | None:
    evs = roles_of_kind(template, "evaluator")
    return evs[0] if evs else None


def profile_for_role(template: dict, settings: dict, role_id: str) -> str:
    ov = (settings.get("roleProfiles") or {}).get(role_id) or {}
    role = role_by_id(template, role_id) or {}
    for cand in (
        ov.get("hermesProfile"),
        role.get("hermesProfile"),
        settings.get("parentProfile"),
        "default",
    ):
        if cand:
            return str(cand)
    return "default"
