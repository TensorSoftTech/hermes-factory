"""Harden and resolve the factory default workspace path."""

from __future__ import annotations

import os
from pathlib import Path

from .paths import DEFAULT_WORKSPACE, FACTORY_HOME


class WorkspaceError(ValueError):
    pass


def _expand(raw: str | None) -> Path:
    text = (raw or "").strip()
    if not text:
        return DEFAULT_WORKSPACE.resolve()
    if text.startswith("~"):
        text = os.path.expanduser(text)
    return Path(text).expanduser()


def validate_workspace_path(raw: str | None, *, create: bool = False) -> Path:
    """
    Absolute path only. No '..' segments. Must resolve under $HOME or
    ~/.hermes-factory (or be the default workspace). Creates if create=True.
    """
    path = _expand(raw)
    if not path.is_absolute():
        raise WorkspaceError("workspacePath must be an absolute path")
    # Refuse path traversal before resolve
    if ".." in path.parts:
        raise WorkspaceError("workspacePath must not contain '..'")
    try:
        resolved = path.resolve(strict=False)
    except OSError as err:
        raise WorkspaceError(f"workspacePath invalid: {err}") from err
    if ".." in resolved.parts:
        raise WorkspaceError("workspacePath resolves outside allowed roots")

    home = Path.home().resolve()
    factory = FACTORY_HOME.resolve()
    allowed = False
    try:
        resolved.relative_to(home)
        allowed = True
    except ValueError:
        pass
    if not allowed:
        try:
            resolved.relative_to(factory)
            allowed = True
        except ValueError:
            pass
    if not allowed:
        raise WorkspaceError(
            "workspacePath must be under your home directory or ~/.hermes-factory"
        )

    if create:
        try:
            resolved.mkdir(parents=True, exist_ok=True)
        except OSError as err:
            raise WorkspaceError(f"cannot create workspace: {err}") from err
    elif not resolved.exists():
        # Allow missing until first run — caller may create
        pass
    elif not resolved.is_dir():
        raise WorkspaceError("workspacePath exists but is not a directory")

    return resolved


def ensure_workspace(raw: str | None) -> Path:
    return validate_workspace_path(raw, create=True)
