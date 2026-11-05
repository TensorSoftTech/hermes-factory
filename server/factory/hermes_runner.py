"""Run Hermes oneshot with enforced profile + workspace cwd."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from .compat import list_profiles
from .paths import HERMES_BIN
from .rules import resolve_run_profile
from .settings import load_settings
from .workspace import ensure_workspace


def run_hermes(
    profile: str | None,
    prompt: str,
    *,
    hermes_bin: str | None = None,
    workspace: str | None = None,
    timeout: int = 300,
) -> dict[str, Any]:
    settings = load_settings()
    bin_path = hermes_bin or settings.get("hermesBin") or HERMES_BIN
    known = [p["id"] for p in list_profiles()]
    chosen, profile_meta = resolve_run_profile(profile, settings, known)
    # Enrich meta from live profiles
    for p in list_profiles():
        if p["id"] == chosen:
            profile_meta["provider"] = p.get("provider") or "unknown"
            profile_meta["model"] = p.get("model") or "unknown"
            break

    ws = ensure_workspace(workspace or settings.get("workspacePath"))
    usage_path = Path(tempfile.gettempdir()) / f"hf-usage-{uuid.uuid4().hex}.json"
    cmd = [bin_path]
    if chosen and chosen != "default":
        cmd.extend(["-p", chosen])
    cmd.extend(["-z", prompt, "--usage-file", str(usage_path)])
    cmd_display = [
        bin_path,
        *(["-p", chosen] if chosen and chosen != "default" else []),
        "-z",
        f"<prompt {len(prompt)} chars>",
        "--usage-file",
        str(usage_path),
        f"<cwd {ws}>",
    ]

    started = time.time()
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(ws),
            env={**os.environ, "TERM": "dumb"},
        )
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "error": f"Hermes timed out after {timeout}s",
            "profile": chosen,
            "profileMeta": profile_meta,
            "reply": "",
            "usage": None,
            "latencyMs": int((time.time() - started) * 1000),
            "returncode": None,
            "cmd": cmd_display,
            "stderr": "",
            "workspace": str(ws),
            "promptChars": len(prompt),
        }
    except FileNotFoundError:
        return {
            "ok": False,
            "error": f"Hermes binary not found: {bin_path}",
            "profile": chosen,
            "profileMeta": profile_meta,
            "reply": "",
            "usage": None,
            "latencyMs": int((time.time() - started) * 1000),
            "returncode": None,
            "cmd": cmd_display,
            "stderr": "",
            "workspace": str(ws),
            "promptChars": len(prompt),
        }

    latency_ms = int((time.time() - started) * 1000)
    reply = (proc.stdout or "").strip()
    lines = [ln for ln in reply.splitlines() if not ln.startswith("session_id:")]
    reply = "\n".join(lines).strip()

    usage = None
    if usage_path.exists():
        try:
            usage = json.loads(usage_path.read_text())
        except (OSError, json.JSONDecodeError):
            usage = None
        try:
            usage_path.unlink(missing_ok=True)
        except OSError:
            pass

    ok = proc.returncode == 0 and bool(reply)
    err = None if ok else (proc.stderr or proc.stdout or f"exit {proc.returncode}").strip()
    combined = f"{err or ''}\n{proc.stderr or ''}\n{proc.stdout or ''}"
    if not ok and (
        "402" in combined
        or "Insufficient available credits" in combined
        or "nousresearch.com" in combined.lower()
    ):
        hint = (
            f"[factory] HTTP 402 / Nous credits — used cloud Nous, not local AI. "
            f"Settings parentProfile={profile_meta.get('parentProfile')} "
            f"(provider={profile_meta.get('provider')}, model={profile_meta.get('model')}). "
            f"Run profile: {chosen}. Do not create Hermes Agent kanban (t_*)."
        )
        err = f"{err}\n{hint}" if err else hint

    return {
        "ok": ok,
        "error": err,
        "profile": chosen,
        "profileMeta": profile_meta,
        "reply": reply if ok else (reply or err or ""),
        "usage": usage,
        "stderr": (proc.stderr or "")[-8000:],
        "latencyMs": latency_ms,
        "returncode": proc.returncode,
        "cmd": cmd_display,
        "workspace": str(ws),
        "promptChars": len(prompt),
        "replyChars": len(reply),
    }
