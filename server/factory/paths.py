"""Filesystem roots for Hermes Factory."""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # hermes-factory/
HERMES_HOME = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
FACTORY_HOME = Path.home() / ".hermes-factory"
SETTINGS_PATH = FACTORY_HOME / "settings.json"
STATE_PATH = FACTORY_HOME / "state.json"
HISTORY_PATH = FACTORY_HOME / "history.json"
TEMPLATES_DIR = FACTORY_HOME / "templates"
DB_PATH = FACTORY_HOME / "factory.db"
SEED_DIR = Path(__file__).resolve().parents[1] / "seed"
HERMES_BIN = os.environ.get(
    "HERMES_BIN", str(Path.home() / ".local" / "bin" / "hermes")
)
HOST = os.environ.get("FACTORY_HOST", "127.0.0.1")
PORT = int(os.environ.get("FACTORY_PORT", "8787"))
HISTORY_CAP = 200
DEFAULT_WORKSPACE = FACTORY_HOME / "workspace"


def ensure_factory_dirs() -> None:
    FACTORY_HOME.mkdir(parents=True, exist_ok=True)
    TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
    DEFAULT_WORKSPACE.mkdir(parents=True, exist_ok=True)
