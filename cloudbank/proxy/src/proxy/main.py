"""FastAPI entrypoint for the hardened localhost BidiRunSession proxy.

Security posture: this proxy holds local Application Default Credentials (ADC)
and opens CX Agent Studio BidiRunSession streams with them. It is intended
strictly for localhost development (127.0.0.1) and MUST NOT be bound to 0.0.0.0
or exposed remotely without authentication.

Defense-in-depth controls enforced here:
- Exact-match Origin validation (missing Origin rejected, zero wildcard/suffix
  fallthrough, exact PROXY_ALLOWED_ORIGINS override).
- Concurrent session cap (PROXY_MAX_SESSIONS, default 4).
- Explicit 5-key CLIENT_SEEDABLE_VARIABLES allowlist rejecting unknown or
  missing keys, ASCII-strict validation on scalar variables, and full Draft-07
  JSON Schema validation on customer_snapshot loaded directly from
  cloudbank/shared/customer_snapshot.schema.json.
"""
from __future__ import annotations

import datetime
import functools
import json
import logging
import os
import re
import uuid
from pathlib import Path
from typing import Any

import jsonschema
import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .auth import GoogleTokenProvider
from .protocol import (
    MAX_CLIENT_FRAME_BYTES,
    ClientStart,
    Persona,
    ServerError,
    parse_client_msg,
    serialize_server_msg,
)
from .relay import Relay

log = logging.getLogger("proxy")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Cloudbank BidiRunSession proxy")
_tokens = GoogleTokenProvider()

# Default resolves to <repo>/cloudbank/gecx-config.json when launched from
# cloudbank/proxy/ (or falls back relative to this file). Override via GECX_CONFIG.
_DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[3] / "gecx-config.json"
_SNAPSHOT_SCHEMA_PATH = (
    Path(__file__).resolve().parents[3] / "shared" / "customer_snapshot.schema.json"
)

_DEFAULT_LOCAL_ORIGINS = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
)
_SAFE_HOST_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9.\-]{0,252}\Z")
_SAFE_SLUG_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9\-]{0,120}\Z")

CLIENT_SEEDABLE_VARIABLES: frozenset[str] = frozenset(
    {
        "persona_id",
        "first_name",
        "demo_date",
        "time_of_day",
        "customer_snapshot",
    }
)
MAX_SNAPSHOT_BYTES = 32 * 1024

# Explicit ASCII character classes + \A...\Z anchors (never $, \s, or \d).
_FIRST_NAME_RE = re.compile(r"\A[A-Za-z][A-Za-z0-9 '\-]{0,59}\Z")
_DEMO_DATE_RE = re.compile(r"\A[0-9]{4}-[0-9]{2}-[0-9]{2}\Z")
_VALID_PERSONAS = frozenset({"chloe", "david", "tom", "sarah"})
_VALID_TIMES_OF_DAY = frozenset({"morning", "afternoon", "evening"})

_MAX_UPSTREAM_FRAME_BYTES = 4 * 1024 * 1024
_MAX_CONCURRENT_SESSIONS = int(os.environ.get("PROXY_MAX_SESSIONS", "4"))
DEFAULT_MAX_IDLE_SECONDS = 900.0
DEFAULT_KEEPALIVE_SECONDS = 10.0

_active_sessions = 0


class VariableValidationError(ValueError):
    """Raised when a ClientStart variable fails allowlist or schema validation."""

    def __init__(self, field: str, reason: str) -> None:
        self.field = field
        self.reason = reason
        super().__init__(f"invalid {field}: {reason}")


@functools.lru_cache(maxsize=1)
def _snapshot_validator() -> jsonschema.Draft7Validator:
    """Load and compile cloudbank/shared/customer_snapshot.schema.json once."""
    schema = json.loads(_SNAPSHOT_SCHEMA_PATH.read_text(encoding="utf-8"))
    jsonschema.Draft7Validator.check_schema(schema)
    return jsonschema.Draft7Validator(schema)


def _allowed_origins() -> frozenset[str]:
    """Return exact permitted browser Origin values with zero wildcard fallthrough."""
    override = os.environ.get("PROXY_ALLOWED_ORIGINS")
    if override is not None:
        return frozenset(
            item.strip()
            for item in override.split(",")
            if item.strip() and "\n" not in item and "\r" not in item
        )

    allowed = set(_DEFAULT_LOCAL_ORIGINS)
    web_host = os.environ.get("WEB_HOST", "")
    if web_host and _SAFE_HOST_RE.fullmatch(web_host):
        allowed.add(f"https://{web_host}")

    codespace = os.environ.get("CODESPACE_NAME", "")
    cs_domain = os.environ.get(
        "GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN", "app.github.dev"
    )
    if (
        codespace
        and _SAFE_SLUG_RE.fullmatch(codespace)
        and _SAFE_HOST_RE.fullmatch(cs_domain)
    ):
        allowed.add(f"https://{codespace}-5173.{cs_domain}")

    return frozenset(allowed)


def _origin_allowed(origin: str | None) -> bool:
    """Require a non-empty Origin header matching an exact allowed origin."""
    if not origin or "\n" in origin or "\r" in origin:
        return False
    return origin in _allowed_origins()


def _parse_strict_iso_date(value: str, field_name: str) -> datetime.date:
    """Validate YYYY-MM-DD with ASCII digits and real calendar bounds."""
    if not isinstance(value, str) or not _DEMO_DATE_RE.fullmatch(value):
        raise VariableValidationError(field_name, "expected ASCII YYYY-MM-DD date")
    year = int(value[0:4])
    month = int(value[5:7])
    day = int(value[8:10])
    if year < 2000 or year > 2100:
        raise VariableValidationError(field_name, "year out of range 2000..2100")
    try:
        return datetime.date(year, month, day)
    except ValueError as exc:
        raise VariableValidationError(field_name, "invalid calendar date") from exc


def validate_seed_variables(
    variables: dict[str, Any],
    *,
    expected_persona: Persona | None = None,
) -> dict[str, Any]:
    """Validate ClientStart.variables strictly against CLIENT_SEEDABLE_VARIABLES."""
    if not isinstance(variables, dict):
        raise VariableValidationError("variables", "expected object")

    extra_keys = sorted(set(variables.keys()) - CLIENT_SEEDABLE_VARIABLES)
    if extra_keys:
        bad = str(extra_keys[0])
        raise VariableValidationError(bad, f"field {bad!r} is not client-seedable")

    missing_keys = sorted(CLIENT_SEEDABLE_VARIABLES - set(variables.keys()))
    if missing_keys:
        missing = missing_keys[0]
        raise VariableValidationError(missing, f"missing required field {missing!r}")

    persona_id = variables["persona_id"]
    if not isinstance(persona_id, str) or persona_id not in _VALID_PERSONAS:
        raise VariableValidationError("persona_id", "must be a known persona id")
    if expected_persona is not None and persona_id != expected_persona:
        raise VariableValidationError(
            "persona_id", "must match start.persona"
        )

    first_name = variables["first_name"]
    if not isinstance(first_name, str) or not _FIRST_NAME_RE.fullmatch(first_name):
        raise VariableValidationError(
            "first_name",
            "must be 1..60 ASCII letters, digits, spaces, apostrophes, or hyphens",
        )

    demo_date = variables["demo_date"]
    _parse_strict_iso_date(demo_date, "demo_date")

    time_of_day = variables["time_of_day"]
    if not isinstance(time_of_day, str) or time_of_day not in _VALID_TIMES_OF_DAY:
        raise VariableValidationError(
            "time_of_day", "must be morning, afternoon, or evening"
        )

    snapshot = variables["customer_snapshot"]
    if not isinstance(snapshot, dict):
        raise VariableValidationError("customer_snapshot", "must be an object")

    try:
        encoded = json.dumps(snapshot, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise VariableValidationError(
            "customer_snapshot", "contains non-finite or non-JSON values"
        ) from exc

    if len(encoded.encode("utf-8")) > MAX_SNAPSHOT_BYTES:
        raise VariableValidationError(
            "customer_snapshot", f"exceeds {MAX_SNAPSHOT_BYTES} byte limit"
        )

    validator = _snapshot_validator()
    errors = sorted(validator.iter_errors(snapshot), key=lambda e: list(e.path))
    if errors:
        err = errors[0]
        loc = ".".join(str(p) for p in err.path) or "root"
        raise VariableValidationError(
            "customer_snapshot", f"schema violation at {loc}: {err.message}"
        )

    mortgage = (snapshot.get("accounts") or {}).get("mortgage")
    if isinstance(mortgage, dict) and "fixed_until" in mortgage:
        try:
            _parse_strict_iso_date(str(mortgage["fixed_until"]), "customer_snapshot")
        except VariableValidationError as exc:
            raise VariableValidationError(
                "customer_snapshot", f"invalid accounts.mortgage.fixed_until: {exc.reason}"
            ) from exc

    return {
        "persona_id": persona_id,
        "first_name": first_name,
        "demo_date": demo_date,
        "time_of_day": time_of_day,
        "customer_snapshot": snapshot,
    }


def _config_path() -> Path:
    raw = os.environ.get("GECX_CONFIG")
    if raw:
        return Path(raw)
    cwd_rel = Path("../gecx-config.json")
    return cwd_rel if cwd_rel.exists() else _DEFAULT_CONFIG_PATH


def _load_app_resource() -> tuple[str, str]:
    cfg = json.loads(_config_path().read_text(encoding="utf-8"))
    project_id = cfg["gcp_project_id"]
    location = cfg["location"]
    app_id = cfg.get("deployed_app_id")
    if not app_id:
        raise KeyError("deployed_app_id not set in gecx-config.json")
    resource = f"projects/{project_id}/locations/{location}/apps/{app_id}"
    return resource, location


def _resolve_session_id(requested: str | None) -> str:
    """Return a canonical UUID session id, replacing any non-UUID input."""
    if requested and isinstance(requested, str) and "\n" not in requested and "\r" not in requested:
        try:
            parsed = uuid.UUID(requested)
            if str(parsed) == requested.lower():
                return str(parsed)
        except (ValueError, AttributeError, TypeError):
            log.warning("ignoring malformed sessionId from client")
    elif requested:
        log.warning("ignoring malformed sessionId from client")
    return str(uuid.uuid4())


def _max_idle_seconds() -> float:
    raw = os.environ.get("PROXY_MAX_IDLE_SECONDS")
    if not raw:
        return DEFAULT_MAX_IDLE_SECONDS
    try:
        val = float(raw)
        return val if val > 0 else DEFAULT_MAX_IDLE_SECONDS
    except ValueError:
        return DEFAULT_MAX_IDLE_SECONDS


def _keepalive_seconds() -> float:
    raw = os.environ.get("PROXY_KEEPALIVE_SECONDS")
    if not raw:
        return DEFAULT_KEEPALIVE_SECONDS
    try:
        val = float(raw)
        return val if val > 0 else DEFAULT_KEEPALIVE_SECONDS
    except ValueError:
        return DEFAULT_KEEPALIVE_SECONDS


async def _fail(ws: WebSocket, message: str, *, field: str | None = None) -> None:
    """Send a structured ServerError envelope and close the WebSocket."""
    try:
        await ws.send_text(
            serialize_server_msg(ServerError(message=message, field=field))
        )
    except (WebSocketDisconnect, RuntimeError):
        pass
    try:
        await ws.close(code=1008)
    except RuntimeError:
        pass


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.websocket("/ws/agent")
async def ws_agent(ws: WebSocket) -> None:
    global _active_sessions

    origin = ws.headers.get("origin")
    if not _origin_allowed(origin):
        log.warning("rejecting websocket from missing or disallowed origin %r", origin)
        await ws.close(code=1008)
        return

    if _active_sessions >= _MAX_CONCURRENT_SESSIONS:
        log.warning("rejecting websocket: %d sessions already active", _active_sessions)
        await ws.accept()
        await _fail(ws, "server busy — too many active sessions")
        return

    await ws.accept()
    _active_sessions += 1
    try:
        await _run_session(ws)
    finally:
        _active_sessions -= 1


async def _run_session(ws: WebSocket) -> None:
    try:
        start_raw = await ws.receive_text()
    except WebSocketDisconnect:
        return

    if len(start_raw) > MAX_CLIENT_FRAME_BYTES:
        await _fail(ws, "frame too large")
        return

    try:
        start = parse_client_msg(start_raw)
    except ValueError:
        log.warning("rejecting malformed start frame")
        await _fail(ws, "malformed start frame")
        return

    if not isinstance(start, ClientStart):
        await _fail(ws, "expected start frame first")
        return

    try:
        persona_variables = validate_seed_variables(
            start.variables, expected_persona=start.persona
        )
    except VariableValidationError as exc:
        log.warning("rejecting invalid start variable %s: %s", exc.field, exc.reason)
        await _fail(ws, str(exc), field=exc.field)
        return

    try:
        app_resource, location = _load_app_resource()
    except (FileNotFoundError, KeyError, json.JSONDecodeError):
        log.exception("could not load gecx-config.json")
        await _fail(ws, "server configuration error")
        return

    try:
        token = await _tokens.get_token()
    except Exception:
        log.exception("could not obtain ADC token")
        await _fail(ws, "server authentication error")
        return

    upstream_url = (
        "wss://ces.googleapis.com/ws/"
        "google.cloud.ces.v1.SessionService/BidiRunSession/"
        f"locations/{location}"
    )

    resolved_session_id = _resolve_session_id(start.sessionId)
    relay: Relay | None = None
    log.info("opening upstream WS for app=%s session=%s", app_resource, resolved_session_id)
    try:
        async with websockets.connect(
            upstream_url,
            additional_headers={"Authorization": f"Bearer {token}"},
            max_size=_MAX_UPSTREAM_FRAME_BYTES,
        ) as upstream:
            relay = Relay(
                browser=_FastApiBrowserAdapter(ws),
                upstream=upstream,
                app_resource=app_resource,
                session_id=resolved_session_id,
                persona_variables=persona_variables,
                keepalive_interval_seconds=_keepalive_seconds(),
                max_idle_seconds=_max_idle_seconds(),
            )
            await relay.run(start=start)
    except websockets.exceptions.InvalidStatus as exc:
        status_code = getattr(exc.response, "status_code", "?")
        log.exception("upstream rejected connection (status=%s)", status_code)
        await _fail(ws, f"upstream {status_code}")
    except websockets.exceptions.ConnectionClosedError as exc:
        if relay is not None and relay.ended_cleanly:
            return
        rcvd = getattr(exc, "rcvd", None)
        code = getattr(rcvd, "code", None) or 1006
        reason = (getattr(rcvd, "reason", "") or "").strip()
        if len(reason) > 200:
            reason = reason[:200] + "…"
        log.warning("upstream closed abnormally: code=%s reason=%s", code, reason)
        await _fail(
            ws,
            f"upstream closed ({code}): {reason}" if reason else f"upstream closed ({code})",
        )
    except WebSocketDisconnect:
        pass
    except (OSError, websockets.exceptions.InvalidURI, TimeoutError):
        log.exception("could not reach upstream")
        await _fail(ws, "could not reach upstream")


class _FastApiBrowserAdapter:
    """Adapts FastAPI's WebSocket to the Protocol the Relay expects."""

    def __init__(self, ws: WebSocket) -> None:
        self._ws = ws

    async def receive_text(self) -> str:
        return await self._ws.receive_text()

    async def send_text(self, raw: str) -> None:
        await self._ws.send_text(raw)

    async def close(self) -> None:
        try:
            await self._ws.close()
        except RuntimeError:
            pass
