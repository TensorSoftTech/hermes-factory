#!/usr/bin/env python3
"""Hermes Factory bridge — real profiles, settings, oneshot runs."""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
HERMES_HOME = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
FACTORY_HOME = Path.home() / ".hermes-factory"
SETTINGS_PATH = FACTORY_HOME / "settings.json"
TEMPLATES_DIR = FACTORY_HOME / "templates"
SEED_DIR = ROOT / "server" / "seed"
HERMES_BIN = os.environ.get("HERMES_BIN", str(Path.home() / ".local" / "bin" / "hermes"))
HOST = os.environ.get("FACTORY_HOST", "127.0.0.1")
PORT = int(os.environ.get("FACTORY_PORT", "8787"))

DEFAULT_SETTINGS = {
    "templateId": "software-company",
    "parentProfile": "default",
    "roleProfiles": {},
    "hermesBin": HERMES_BIN,
    "themeId": "paper-sky",
    "avatarStyle": "robot",
}


def ensure_factory_dirs() -> None:
    FACTORY_HOME.mkdir(parents=True, exist_ok=True)
    TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)


def ensure_settings_dir() -> None:
    ensure_factory_dirs()


def slugify(value: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (value or "").strip().lower())
    s = re.sub(r"-+", "-", s).strip("-")
    return s or f"role-{uuid.uuid4().hex[:6]}"


def seed_templates() -> None:
    """Copy bundled seeds into ~/.hermes-factory/templates if missing."""
    ensure_factory_dirs()
    if not SEED_DIR.is_dir():
        return
    for seed in SEED_DIR.glob("*.json"):
        dest = TEMPLATES_DIR / seed.name
        if not dest.exists():
            dest.write_text(seed.read_text())


def list_templates() -> list[dict]:
    seed_templates()
    out = []
    for path in sorted(TEMPLATES_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        out.append(
            {
                "id": data.get("id") or path.stem,
                "name": data.get("name") or path.stem,
                "roleCount": len(data.get("roles") or []),
                "orchestratorRoleId": data.get("orchestratorRoleId"),
                "path": str(path),
            }
        )
    return out


def load_template(template_id: str) -> dict | None:
    seed_templates()
    safe = slugify(template_id)
    path = TEMPLATES_DIR / f"{safe}.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    data["id"] = data.get("id") or safe
    return normalize_org_chart(data)


def _boss_or_none(value, role_ids: set, self_id: str | None) -> str | None:
    if value is None or value == "" or value == "board":
        return None
    sid = str(value)
    if sid == self_id or sid not in role_ids:
        return None
    return sid


ROLE_KINDS = ("orchestrator", "manager", "executor", "evaluator")


def _normalize_role_kind(value, is_orchestrator: bool = False) -> str:
    v = str(value or "").strip().lower()
    if v in ROLE_KINDS:
        return v
    return "orchestrator" if is_orchestrator else "executor"


def normalize_org_chart(data: dict) -> dict:
    """
    Always define takesOrdersFrom + reportsTo + roleKind on every role.
    - Board target (orchestratorRoleId): both null (Board), roleKind=orchestrator.
    - Everyone else: both required role ids; missing → orchestrator.
    roleKind: orchestrator | manager | executor | evaluator
    """
    data = dict(data)
    roles = [r for r in (data.get("roles") or []) if isinstance(r, dict)]
    role_ids = {r.get("id") for r in roles if r.get("id")}
    orch = data.get("orchestratorRoleId")
    if orch not in role_ids and roles:
        orch = roles[0].get("id")
        data["orchestratorRoleId"] = orch

    for role in roles:
        rid = role.get("id")
        is_orch = rid == orch
        kind = _normalize_role_kind(role.get("roleKind"), is_orchestrator=is_orch)
        if is_orch:
            role["roleKind"] = "orchestrator"
            role["takesOrdersFrom"] = None
            role["reportsTo"] = None
            continue
        if kind == "orchestrator":
            kind = "manager"
        role["roleKind"] = kind
        orders = _boss_or_none(role.get("takesOrdersFrom"), role_ids, rid)
        reports = _boss_or_none(role.get("reportsTo"), role_ids, rid)
        role["takesOrdersFrom"] = orders or orch
        role["reportsTo"] = reports or orch

    data["roles"] = roles
    return data


def save_template(data: dict) -> dict:
    ensure_factory_dirs()
    tid = slugify(str(data.get("id") or data.get("name") or "template"))
    data = dict(data)
    data["id"] = tid
    if not data.get("name"):
        data["name"] = tid
    if not isinstance(data.get("rooms"), list):
        data["rooms"] = []
    if not isinstance(data.get("desks"), list):
        data["desks"] = []
    if not isinstance(data.get("roles"), list):
        data["roles"] = []
    # Keep desks in sync with roles
    desks_by_id = {d.get("id"): d for d in data["desks"] if isinstance(d, dict)}
    for role in data["roles"]:
        if not isinstance(role, dict):
            continue
        desk_id = role.get("desk") or f"desk-{role.get('id')}"
        role["desk"] = desk_id
        home = role.get("home") or [2, 6]
        if desk_id not in desks_by_id:
            desks_by_id[desk_id] = {
                "id": desk_id,
                "room": role.get("department", "eng-bay").lower().replace(" ", "-")[:24]
                or "eng-bay",
                "tile": list(home),
            }
        else:
            desks_by_id[desk_id]["tile"] = list(home)
        role["home"] = list(home)
    data["desks"] = list(desks_by_id.values())
    data = normalize_org_chart(data)
    path = TEMPLATES_DIR / f"{tid}.json"
    path.write_text(json.dumps(data, indent=2) + "\n")
    return data


def delete_template(template_id: str) -> bool:
    safe = slugify(template_id)
    if safe == "software-company":
        return False
    path = TEMPLATES_DIR / f"{safe}.json"
    if not path.exists():
        return False
    path.unlink()
    return True


def load_settings() -> dict:
    ensure_settings_dir()
    if not SETTINGS_PATH.exists():
        return dict(DEFAULT_SETTINGS)
    try:
        data = json.loads(SETTINGS_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return dict(DEFAULT_SETTINGS)
    out = dict(DEFAULT_SETTINGS)
    out.update(data)
    if not isinstance(out.get("roleProfiles"), dict):
        out["roleProfiles"] = {}
    return out


def save_settings(data: dict) -> dict:
    ensure_settings_dir()
    merged = dict(DEFAULT_SETTINGS)
    merged.update(data)
    if not isinstance(merged.get("roleProfiles"), dict):
        merged["roleProfiles"] = {}
    SETTINGS_PATH.write_text(json.dumps(merged, indent=2) + "\n")
    return merged


def parse_model_provider(config_path: Path) -> tuple[str, str]:
    model = "unknown"
    provider = "unknown"
    if not config_path.exists():
        return model, provider
    text = config_path.read_text(errors="ignore")
    # Prefer first non-commented model.default / provider under model:
    in_model = False
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        if re.match(r"^model:\s*$", line):
            in_model = True
            continue
        if in_model and re.match(r"^[A-Za-z0-9_]+:\s*", line) and not line.startswith(" "):
            in_model = False
        if in_model:
            m = re.match(r'^\s+(?:default|model):\s*["\']?([^"\']+)["\']?\s*$', line)
            if m:
                model = m.group(1).strip()
            p = re.match(r'^\s+provider:\s*["\']?([^"\']+)["\']?\s*$', line)
            if p:
                provider = p.group(1).strip()
    return model, provider


def profile_paths() -> list[tuple[str, Path]]:
    items: list[tuple[str, Path]] = [("default", HERMES_HOME)]
    profiles_dir = HERMES_HOME / "profiles"
    if profiles_dir.is_dir():
        for child in sorted(profiles_dir.iterdir()):
            if not child.is_dir():
                continue
            markers = (
                "config.yaml",
                ".env",
                "SOUL.md",
                "profile.yaml",
                "auth.json",
                "state.db",
            )
            if any((child / m).exists() for m in markers):
                items.append((child.name, child))
    return items


def list_profiles() -> list[dict]:
    out = []
    for name, path in profile_paths():
        model, provider = parse_model_provider(path / "config.yaml")
        soul = (path / "SOUL.md").exists()
        out.append(
            {
                "id": name,
                "name": name,
                "path": str(path),
                "model": model,
                "provider": provider,
                "hasSoul": soul,
                "isDefault": name == "default",
            }
        )
    return out


def run_hermes(profile: str, prompt: str, hermes_bin: str | None = None) -> dict:
    bin_path = hermes_bin or load_settings().get("hermesBin") or HERMES_BIN
    usage_path = Path(tempfile.gettempdir()) / f"hf-usage-{uuid.uuid4().hex}.json"
    cmd = [bin_path]
    if profile and profile != "default":
        cmd.extend(["-p", profile])
    cmd.extend(["-z", prompt, "--usage-file", str(usage_path)])
    # Redacted command for API history (full prompt lives in request body)
    cmd_display = [
        bin_path,
        *(["-p", profile] if profile and profile != "default" else []),
        "-z",
        f"<prompt {len(prompt)} chars>",
        "--usage-file",
        str(usage_path),
    ]

    started = time.time()
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,
            env={**os.environ, "TERM": "dumb"},
        )
    except subprocess.TimeoutExpired:
        latency_ms = int((time.time() - started) * 1000)
        return {
            "ok": False,
            "error": "Hermes timed out after 300s",
            "profile": profile,
            "reply": "",
            "usage": None,
            "latencyMs": latency_ms,
            "returncode": None,
            "cmd": cmd_display,
            "stderr": "",
            "promptChars": len(prompt),
        }
    except FileNotFoundError:
        latency_ms = int((time.time() - started) * 1000)
        return {
            "ok": False,
            "error": f"Hermes binary not found: {bin_path}",
            "profile": profile,
            "reply": "",
            "usage": None,
            "latencyMs": latency_ms,
            "returncode": None,
            "cmd": cmd_display,
            "stderr": "",
            "promptChars": len(prompt),
        }

    latency_ms = int((time.time() - started) * 1000)
    reply = (proc.stdout or "").strip()
    # Drop trailing session_id lines from -Q style if present
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
    return {
        "ok": ok,
        "error": err,
        "profile": profile,
        "reply": reply if ok else (reply or err or ""),
        "usage": usage,
        "stderr": (proc.stderr or "")[-8000:],
        "latencyMs": latency_ms,
        "returncode": proc.returncode,
        "cmd": cmd_display,
        "promptChars": len(prompt),
        "replyChars": len(reply),
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        print(f"[factory] {self.address_string()} {fmt % args}")

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code: int, payload: dict | list) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode() or "{}")
        except json.JSONDecodeError:
            return {}
        return data if isinstance(data, dict) else {}

    def end_headers(self) -> None:  # noqa: N802
        # Local UI modules change often — never let the browser keep stale avatars/office JS
        path = urlparse(getattr(self, "path", "") or "").path
        if path.endswith((".js", ".css", ".html")) or path in ("", "/"):
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/health":
            return self._json(
                200,
                {
                    "ok": True,
                    "hermesHome": str(HERMES_HOME),
                    "hermesBin": HERMES_BIN,
                    "settingsPath": str(SETTINGS_PATH),
                    "templatesDir": str(TEMPLATES_DIR),
                },
            )
        if path == "/api/profiles":
            return self._json(200, {"profiles": list_profiles()})
        if path == "/api/settings":
            return self._json(200, load_settings())
        if path == "/api/templates":
            return self._json(200, {"templates": list_templates()})
        if path.startswith("/api/templates/"):
            tid = path[len("/api/templates/") :].strip("/")
            tmpl = load_template(tid)
            if not tmpl:
                return self._json(404, {"error": f"template not found: {tid}"})
            return self._json(200, tmpl)
        return super().do_GET()

    def do_PUT(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/settings":
            data = self._read_json()
            return self._json(200, save_settings(data))
        if path.startswith("/api/templates/"):
            tid = path[len("/api/templates/") :].strip("/")
            data = self._read_json()
            data["id"] = tid or data.get("id")
            return self._json(200, save_template(data))
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        data = self._read_json()
        if path == "/api/run":
            settings = load_settings()
            profile = (data.get("profile") or settings.get("parentProfile") or "default").strip()
            prompt = (data.get("prompt") or "").strip()
            if not prompt:
                return self._json(400, {"ok": False, "error": "prompt required"})
            result = run_hermes(profile, prompt, settings.get("hermesBin"))
            return self._json(200 if result["ok"] else 502, result)
        if path == "/api/templates":
            # Create new template (clone base or empty shell)
            base_id = data.get("cloneFrom") or "software-company"
            base = load_template(base_id) or load_template("software-company") or {
                "rooms": [],
                "desks": [],
                "roles": [],
                "orchestratorRoleId": "ceo",
            }
            new_id = slugify(str(data.get("id") or data.get("name") or f"company-{uuid.uuid4().hex[:6]}"))
            if load_template(new_id):
                return self._json(409, {"error": f"template already exists: {new_id}"})
            created = dict(base)
            created["id"] = new_id
            created["name"] = data.get("name") or new_id.replace("-", " ").title()
            return self._json(201, save_template(created))
        self._json(404, {"error": "not found"})

    def do_DELETE(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path.startswith("/api/templates/"):
            tid = path[len("/api/templates/") :].strip("/")
            if tid == "software-company":
                return self._json(400, {"error": "cannot delete built-in software-company"})
            ok = delete_template(tid)
            if not ok:
                return self._json(404, {"error": f"template not found: {tid}"})
            return self._json(200, {"ok": True, "deleted": tid})
        self._json(404, {"error": "not found"})


def main() -> None:
    ensure_factory_dirs()
    seed_templates()
    if not SETTINGS_PATH.exists():
        save_settings(DEFAULT_SETTINGS)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Hermes Factory → http://{HOST}:{PORT}")
    print(f"Settings → {SETTINGS_PATH}")
    print(f"Templates → {TEMPLATES_DIR}")
    print(f"Hermes → {HERMES_BIN}  home={HERMES_HOME}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
