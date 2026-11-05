#!/usr/bin/env python3
"""Hermes Factory entrypoint — launches the FastAPI harness on :8787."""

from __future__ import annotations

import sys
from pathlib import Path

# Allow `python3 server/bridge.py` from hermes-factory/
_SERVER = Path(__file__).resolve().parent
if str(_SERVER) not in sys.path:
    sys.path.insert(0, str(_SERVER))


def main() -> None:
    from factory.app import main as app_main

    app_main()


if __name__ == "__main__":
    main()
