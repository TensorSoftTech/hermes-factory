"""Load/save ~/.hermes-factory/settings.json with workspacePath."""

from __future__ import annotations

import json
from typing import Any

from .paths import (
    DEFAULT_WORKSPACE,
    HERMES_BIN,
    SETTINGS_PATH,
    ensure_factory_dirs,
)
from .workspace import WorkspaceError, ensure_workspace, validate_workspace_path

DEFAULT_SETTINGS: dict[str, Any] = {
    "templateId": "software-company",
    "parentProfile": "default",
    "roleProfiles": {},
    "hermesBin": HERMES_BIN,
    "themeId": "paper-sky",
    "avatarStyle": "robot",
    "workspacePath": str(DEFAULT_WORKSPACE),
    "orchestration": "server",
}


def load_settings() -> dict[str, Any]:
    ensure_factory_dirs()
    if not SETTINGS_PATH.exists():
        out = dict(DEFAULT_SETTINGS)
        out["workspacePath"] = str(ensure_workspace(out["workspacePath"]))
        return out
    try:
        data = json.loads(SETTINGS_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        data = {}
    out = dict(DEFAULT_SETTINGS)
    if isinstance(data, dict):
        out.update(data)
    if not isinstance(out.get("roleProfiles"), dict):
        out["roleProfiles"] = {}
    # Normalize workspace
    try:
        ws = ensure_workspace(out.get("workspacePath"))
        out["workspacePath"] = str(ws)
    except WorkspaceError:
        out["workspacePath"] = str(ensure_workspace(None))
    if out.get("orchestration") not in ("server", "client"):
        out["orchestration"] = "server"
    return out


def save_settings(data: dict[str, Any]) -> dict[str, Any]:
    ensure_factory_dirs()
    merged = dict(DEFAULT_SETTINGS)
    if isinstance(data, dict):
        merged.update(data)
    if not isinstance(merged.get("roleProfiles"), dict):
        merged["roleProfiles"] = {}
    # Harden workspace on save
    ws = validate_workspace_path(merged.get("workspacePath"), create=True)
    merged["workspacePath"] = str(ws)
    if merged.get("orchestration") not in ("server", "client"):
        merged["orchestration"] = "server"
    SETTINGS_PATH.write_text(json.dumps(merged, indent=2) + "\n")
    return merged
