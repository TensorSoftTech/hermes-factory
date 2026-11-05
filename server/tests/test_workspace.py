"""Workspace path hardening."""

from __future__ import annotations

import pytest

from factory.workspace import WorkspaceError, ensure_workspace, validate_workspace_path


def test_rejects_relative(factory_home):
    with pytest.raises(WorkspaceError, match="absolute"):
        validate_workspace_path("relative/path")


def test_rejects_dotdot(factory_home, tmp_path):
    with pytest.raises(WorkspaceError, match=r"\.\."):
        validate_workspace_path(str(tmp_path / "a" / ".." / "b"))


def test_creates_under_home(factory_home, tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "userhome"))
    (tmp_path / "userhome").mkdir(exist_ok=True)
    target = tmp_path / "userhome" / "my-ws"
    path = ensure_workspace(str(target))
    assert path.is_dir()
    assert path == target.resolve()


def test_default_under_factory(factory_home):
    from factory.paths import DEFAULT_WORKSPACE

    path = ensure_workspace(None)
    assert path == DEFAULT_WORKSPACE.resolve()
