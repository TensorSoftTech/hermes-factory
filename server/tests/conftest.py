"""Isolate factory paths under a temp dir for every test."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

SERVER = Path(__file__).resolve().parents[1]
if str(SERVER) not in sys.path:
    sys.path.insert(0, str(SERVER))


@pytest.fixture()
def factory_home(tmp_path, monkeypatch):
    home = tmp_path / "factory"
    home.mkdir()
    ws = home / "workspace"
    ws.mkdir()
    templates = home / "templates"
    templates.mkdir()
    userhome = tmp_path / "userhome"
    userhome.mkdir()

    tmpl = {
        "id": "software-company",
        "name": "Software Company",
        "orchestratorRoleId": "ceo",
        "rooms": [],
        "desks": [],
        "roles": [
            {
                "id": "ceo",
                "title": "CEO",
                "roleKind": "orchestrator",
                "hermesProfile": "sparky",
            },
            {
                "id": "cto",
                "title": "CTO",
                "roleKind": "manager",
                "takesOrdersFrom": "ceo",
                "hermesProfile": "sparky",
            },
            {
                "id": "swe",
                "title": "SWE",
                "roleKind": "executor",
                "takesOrdersFrom": "cto",
                "hermesProfile": "sparky",
            },
            {
                "id": "qa",
                "title": "QA",
                "roleKind": "evaluator",
                "takesOrdersFrom": "cto",
                "hermesProfile": "sparky",
            },
        ],
    }
    (templates / "software-company.json").write_text(json.dumps(tmpl, indent=2))

    settings = {
        "templateId": "software-company",
        "parentProfile": "sparky",
        "roleProfiles": {
            "ceo": {"hermesProfile": "sparky"},
            "cto": {"hermesProfile": "sparky"},
            "swe": {"hermesProfile": "sparky"},
            "qa": {"hermesProfile": "sparky"},
        },
        "hermesBin": "hermes",
        "workspacePath": str(ws),
        "orchestration": "server",
        "themeId": "paper-sky",
        "avatarStyle": "robot",
    }
    (home / "settings.json").write_text(json.dumps(settings, indent=2))

    import factory.paths as paths
    import factory.compat as compat
    import factory.settings as settings_mod
    import factory.workspace as workspace_mod

    for mod in (paths, compat, settings_mod):
        monkeypatch.setattr(mod, "FACTORY_HOME", home, raising=False)
        monkeypatch.setattr(mod, "SETTINGS_PATH", home / "settings.json", raising=False)
        monkeypatch.setattr(mod, "STATE_PATH", home / "state.json", raising=False)
        monkeypatch.setattr(mod, "HISTORY_PATH", home / "history.json", raising=False)
        monkeypatch.setattr(mod, "TEMPLATES_DIR", templates, raising=False)

    monkeypatch.setattr(paths, "DB_PATH", home / "factory.db")
    monkeypatch.setattr(paths, "DEFAULT_WORKSPACE", ws)
    monkeypatch.setattr(paths, "SEED_DIR", SERVER / "seed")
    monkeypatch.setattr(compat, "SEED_DIR", SERVER / "seed")
    monkeypatch.setattr(settings_mod, "DEFAULT_WORKSPACE", ws, raising=False)
    monkeypatch.setattr(workspace_mod, "DEFAULT_WORKSPACE", ws, raising=False)
    monkeypatch.setattr(workspace_mod, "FACTORY_HOME", home, raising=False)

    monkeypatch.setenv("HOME", str(userhome))

    from factory import store

    store.init_db()
    yield home


@pytest.fixture()
def fake_hermes(tmp_path, monkeypatch, factory_home):
    """Scripted hermes binary that replies based on prompt keywords."""
    script = tmp_path / "fake-hermes"
    log = tmp_path / "hermes-calls.jsonl"
    script.write_text(
        f"""#!/usr/bin/env python3
import json, sys, os
from pathlib import Path

log = Path({str(log)!r})
argv = sys.argv[1:]
profile = "default"
prompt = ""
cwd = os.getcwd()
i = 0
while i < len(argv):
    if argv[i] == "-p" and i + 1 < len(argv):
        profile = argv[i + 1]
        i += 2
        continue
    if argv[i] == "-z" and i + 1 < len(argv):
        prompt = argv[i + 1]
        i += 2
        continue
    if argv[i] == "--usage-file" and i + 1 < len(argv):
        Path(argv[i + 1]).write_text(json.dumps({{"tokens": 1}}))
        i += 2
        continue
    i += 1

entry = {{"profile": profile, "cwd": cwd, "prompt": prompt[:500]}}
with log.open("a") as f:
    f.write(json.dumps(entry) + "\\n")

p = prompt.lower()
# Order matters: CEO close-out prompt also contains TASK_STATE / DELIVERED hints
if "close out to the board" in p or "board delivery report" in p or "board contact" in p:
    print("Board complete. All good.\\nTASK_STATE: done\\nDELIVERED: yes")
elif "valid managers" in p:
    print("Delegating to CTO.\\nDELEGATE: cto\\nTASK_STATE: in_progress")
elif "you own the factory kanban" in p:
    print("Plan:\\nMAIN: Ship feature\\nTASK: swe | Implement feature\\nTASK_STATE: in_progress")
elif "evaluator" in p or "you are the qa" in p:
    print("QA notes look good.\\nTASK_STATE: done")
elif "recovery ping" in p or "you own this board" in p:
    print("CARD: swe | done\\nGATE: allow\\nTASK_STATE: in_progress")
elif "an executor" in p or "your subtask" in p:
    print("Done implementing.\\nTASK_STATE: done")
else:
    print("Acknowledged.\\nTASK_STATE: in_progress")
sys.exit(0)
"""
    )
    script.chmod(0o755)

    profiles = [
        {"id": "sparky", "provider": "local", "model": "qwen", "path": ""},
        {"id": "default", "provider": "nous", "model": "hermes", "path": ""},
    ]

    def load_settings():
        return {
            **json.loads((factory_home / "settings.json").read_text()),
            "hermesBin": str(script),
            "workspacePath": str(factory_home / "workspace"),
            "parentProfile": "sparky",
            "orchestration": "server",
        }

    monkeypatch.setattr("factory.settings.load_settings", load_settings)
    monkeypatch.setattr("factory.hermes_runner.load_settings", load_settings)
    monkeypatch.setattr("factory.orch.engine.load_settings", load_settings)
    monkeypatch.setattr("factory.compat.list_profiles", lambda: profiles)
    monkeypatch.setattr("factory.hermes_runner.list_profiles", lambda: profiles)

    # Pin template to the fixture copy (avoid real ~/.hermes-factory merge)
    tmpl = json.loads(
        (factory_home / "templates" / "software-company.json").read_text()
    )

    def load_template(tid: str):
        if tid in (None, "", "software-company"):
            return dict(tmpl)
        path = factory_home / "templates" / f"{tid}.json"
        if path.exists():
            return json.loads(path.read_text())
        return None

    monkeypatch.setattr("factory.compat.load_template", load_template)
    monkeypatch.setattr("factory.orch.engine.load_template", load_template, raising=False)
    return {"bin": script, "log": log}
