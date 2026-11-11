"""FastAPI entrypoint for the hardened localhost BidiRunSession proxy.

Security posture: this proxy holds local Application Default Credentials (ADC)
and opens CX Agent Studio (GECX) BidiRunSession streams with them. It is
intended strictly for localhost development (127.0.0.1) and MUST NOT be bound
to 0.0.0.0 or exposed remotely without authentication.

Defense-in-depth controls enforced here:
- Disabled OpenAPI/Swagger/ReDoc documentation endpoints.
- TrustedHostMiddleware Host-header validation and loopback client peer checks
  (unless explicitly overridden via PROXY_ALLOW_REMOTE=1), plus optional bearer
  secret authentication via PROXY_AUTH_TOKEN.
- Exact-match Origin validation (missing Origin rejected, zero wildcard/suffix
  fallthrough, exact PROXY_ALLOWED_ORIGINS override).
- Non-racy asyncio.Semaphore concurrent session cap acquired before ws.accept().
- Server-owned persona snapshots loaded from cloudbank/shared/personas/*.json,
  validated against cloudbank/shared/customer_snapshot.schema.json, with
  sessionId-to-persona binding and variable-free session resume.
"""
from __future__ import annotations

import asyncio
import collections
import contextlib
import copy
import datetime
import functools
import hmac
import ipaddress
import json
import logging
import math
import os
import re
import time
import uuid
from collections.abc import AsyncIterator, Mapping
from pathlib import Path
from typing import Any, cast

import jsonschema
import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from starlette.datastructures import Headers
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.responses import PlainTextResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from .auth import GoogleTokenProvider
from .protocol import (
    MAX_CLIENT_FRAME_BYTES,
    BinaryFrameError,
    BrowserDisconnectError,
    ClientStart,
    Persona,
    ServerError,
    TimeOfDay,
    parse_client_msg,
    serialize_server_msg,
)
from .relay import Relay

log = logging.getLogger("proxy")
logging.basicConfig(level=logging.INFO)

_tokens = GoogleTokenProvider()

_CLOUDBANK_DIR = Path(__file__).resolve().parents[3]
_DEFAULT_CONFIG_PATH = _CLOUDBANK_DIR / "gecx-config.json"
_SHARED_DIR = _CLOUDBANK_DIR / "shared"
_SNAPSHOT_SCHEMA_PATH = _SHARED_DIR / "customer_snapshot.schema.json"
_PERSONAS_DIR = _SHARED_DIR / "personas"

_DEFAULT_LOCAL_ORIGINS = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
)
_DEFAULT_LOCAL_HOSTS = frozenset(
    {
        "localhost",
        "127.0.0.1",
        "[::1]",
        "::1",
        "testserver",
    }
)

_SAFE_HOST_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9.\-]{0,252}\Z")
_SAFE_SLUG_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9\-]{0,120}\Z")

# Explicit ASCII character classes + \A...\Z anchors (never $, \s, or \d).
_FIRST_NAME_RE = re.compile(r"\A[A-Za-z][A-Za-z0-9 '\-]{0,59}\Z")
_DEMO_DATE_RE = re.compile(r"\A[0-9]{4}-[0-9]{2}-[0-9]{2}\Z")
_SESSION_ID_RE = re.compile(
    r"\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z"
)
_GCP_PROJECT_RE = re.compile(r"\A[a-z][a-z0-9-]{4,29}\Z")
_GCP_LOCATION_RE = re.compile(r"\A[a-z0-9-]+\Z")
_GCP_APP_ID_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")

_VALID_PERSONAS: tuple[Persona, ...] = ("chloe", "david", "tom", "sarah")
_VALID_TIMES_OF_DAY: frozenset[str] = frozenset({"morning", "afternoon", "evening"})

DEFAULT_DEMO_DATE = "2026-11-24"
DEFAULT_TIME_OF_DAY: TimeOfDay = "afternoon"
MAX_SNAPSHOT_BYTES = 32 * 1024
_MAX_UPSTREAM_FRAME_BYTES = 4 * 1024 * 1024

DEFAULT_MAX_SESSIONS = 4
DEFAULT_START_TIMEOUT_SECONDS = 10.0
DEFAULT_MAX_IDLE_SECONDS = 900.0
DEFAULT_KEEPALIVE_SECONDS = 10.0
MAX_TRACKED_SESSIONS = 256
SESSION_BINDING_TTL_SECONDS = 3600.0


def _env_positive_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        val = float(raw)
    except ValueError:
        return default
    return val if math.isfinite(val) and val > 0 else default


def _env_positive_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        val = int(raw)
    except ValueError:
        return default
    return val if val > 0 else default


def _max_concurrent_sessions() -> int:
    return _env_positive_int("PROXY_MAX_SESSIONS", DEFAULT_MAX_SESSIONS)


def _start_timeout_seconds() -> float:
    return _env_positive_float(
        "PROXY_START_TIMEOUT_SECONDS", DEFAULT_START_TIMEOUT_SECONDS
    )


def _max_idle_seconds() -> float:
    return _env_positive_float("PROXY_MAX_IDLE_SECONDS", DEFAULT_MAX_IDLE_SECONDS)


def _keepalive_seconds() -> float:
    return _env_positive_float("PROXY_KEEPALIVE_SECONDS", DEFAULT_KEEPALIVE_SECONDS)


_session_semaphore_limit = _max_concurrent_sessions()
_session_semaphore = asyncio.Semaphore(_session_semaphore_limit)
_active_session_count = 0

_session_personas: collections.OrderedDict[str, Persona] = collections.OrderedDict()
_session_persona_timestamps: dict[str, float] = {}


def _get_session_semaphore() -> asyncio.Semaphore:
    global _session_semaphore, _session_semaphore_limit
    desired = _max_concurrent_sessions()
    if _active_session_count == 0 and desired != _session_semaphore_limit:
        _session_semaphore = asyncio.Semaphore(desired)
        _session_semaphore_limit = desired
    return _session_semaphore


class VariableValidationError(ValueError):
    """Raised when a ClientStart parameter or persona snapshot fails validation."""

    def __init__(
        self,
        field: str,
        reason: str,
        *,
        client_message: str | None = None,
    ) -> None:
        self.field = field
        self.reason = reason
        self.client_message = client_message or f"invalid {field}"
        super().__init__(f"invalid {field}: {reason}")


@functools.lru_cache(maxsize=1)
def _snapshot_validator() -> jsonschema.Draft7Validator:
    """Load and compile cloudbank/shared/customer_snapshot.schema.json once."""
    schema = json.loads(_SNAPSHOT_SCHEMA_PATH.read_text(encoding="utf-8"))
    jsonschema.Draft7Validator.check_schema(schema)
    return jsonschema.Draft7Validator(schema)


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


def validate_persona_snapshot(snapshot: Any, *, persona: str) -> dict[str, Any]:
    """Validate a persona snapshot dictionary against size, JSON Schema, and dates."""
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

    errors = sorted(_snapshot_validator().iter_errors(snapshot), key=lambda e: list(e.path))
    if errors:
        err = errors[0]
        loc = ".".join(str(p) for p in err.path) or "root"
        raise VariableValidationError(
            "customer_snapshot", f"schema violation at {loc}: {err.message}"
        )

    user = snapshot.get("user")
    first_name = user.get("first_name") if isinstance(user, dict) else None
    if not isinstance(first_name, str) or not _FIRST_NAME_RE.fullmatch(first_name):
        raise VariableValidationError(
            "customer_snapshot",
            f"persona {persona} user.first_name failed strict ASCII name validation",
        )

    mortgage = (snapshot.get("accounts") or {}).get("mortgage")
    if isinstance(mortgage, dict) and "fixed_until" in mortgage:
        try:
            _parse_strict_iso_date(str(mortgage["fixed_until"]), "customer_snapshot")
        except VariableValidationError as exc:
            raise VariableValidationError(
                "customer_snapshot",
                f"invalid accounts.mortgage.fixed_until: {exc.reason}",
            ) from exc

    return snapshot


@functools.lru_cache(maxsize=len(_VALID_PERSONAS))
def _load_persona_snapshot(persona: Persona) -> dict[str, Any]:
    """Load and schema-validate the canonical server-owned persona snapshot."""
    if persona not in _VALID_PERSONAS:
        raise VariableValidationError("persona", "must be a known persona id")
    fixture_path = _PERSONAS_DIR / f"{persona}.json"
    raw = json.loads(fixture_path.read_text(encoding="utf-8"))
    return validate_persona_snapshot(raw, persona=persona)


def build_session_variables(start: ClientStart) -> dict[str, Any]:
    """Construct BidiRunSession variables from server-owned persona fixtures."""
    if start.persona not in _VALID_PERSONAS:
        raise VariableValidationError("persona", "must be a known persona id")

    demo_date = DEFAULT_DEMO_DATE
    if start.demoDate is not None:
        _parse_strict_iso_date(start.demoDate, "demoDate")
        demo_date = start.demoDate

    time_of_day: str = (
        start.timeOfDay if start.timeOfDay is not None else DEFAULT_TIME_OF_DAY
    )
    if time_of_day not in _VALID_TIMES_OF_DAY:
        raise VariableValidationError(
            "timeOfDay", "must be morning, afternoon, or evening"
        )

    snapshot = copy.deepcopy(_load_persona_snapshot(start.persona))
    first_name = str(snapshot["user"]["first_name"])

    return {
        "persona_id": start.persona,
        "first_name": first_name,
        "demo_date": demo_date,
        "time_of_day": time_of_day,
        "customer_snapshot": snapshot,
    }


def _prune_expired_session_bindings(now: float) -> None:
    cutoff = now - SESSION_BINDING_TTL_SECONDS
    expired = [
        sid
        for sid, ts in _session_persona_timestamps.items()
        if ts < cutoff
    ]
    for sid in expired:
        _session_personas.pop(sid, None)
        _session_persona_timestamps.pop(sid, None)


def _validate_session_id_and_persona(
    requested_session_id: str | None,
    persona: Persona,
    *,
    now: float | None = None,
) -> tuple[str, bool]:
    """Validate optional resumed sessionId and enforce persona binding."""
    ts = time.monotonic() if now is None else now
    _prune_expired_session_bindings(ts)

    if requested_session_id is None:
        return str(uuid.uuid4()), False

    if not _SESSION_ID_RE.fullmatch(requested_session_id):
        raise VariableValidationError(
            "sessionId",
            "must be a canonical UUID",
            client_message="invalid sessionId",
        )

    canonical = requested_session_id.lower()
    bound_persona = _session_personas.get(canonical)
    if bound_persona is not None and bound_persona != persona:
        raise VariableValidationError(
            "sessionId",
            f"already bound to {bound_persona}",
            client_message="sessionId bound to a different persona",
        )
    return canonical, True


def _record_session_binding(
    session_id: str,
    persona: Persona,
    *,
    now: float | None = None,
) -> None:
    ts = time.monotonic() if now is None else now
    _prune_expired_session_bindings(ts)
    if session_id in _session_personas:
        _session_personas.move_to_end(session_id)
    _session_personas[session_id] = persona
    _session_persona_timestamps[session_id] = ts
    while len(_session_personas) > MAX_TRACKED_SESSIONS:
        oldest_sid, _ = _session_personas.popitem(last=False)
        _session_persona_timestamps.pop(oldest_sid, None)


def _allowed_origins() -> frozenset[str]:
    """Return exact permitted browser Origin values with zero wildcard fallthrough."""
    override = os.environ.get("PROXY_ALLOWED_ORIGINS")
    if override is not None:
        return frozenset(
            item.strip()
            for item in override.split(",")
            if item.strip() and "\n" not in item and "\r" not in item
        )

    allowed: set[str] = set(_DEFAULT_LOCAL_ORIGINS)
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


def _allowed_hosts() -> frozenset[str]:
    """Return exact permitted HTTP/WebSocket Host header hostnames."""
    override = os.environ.get("PROXY_ALLOWED_HOSTS")
    if override is not None:
        return frozenset(
            item.strip().lower()
            for item in override.split(",")
            if item.strip() and "\n" not in item and "\r" not in item
        )

    hosts: set[str] = set(_DEFAULT_LOCAL_HOSTS)
    web_host = os.environ.get("WEB_HOST", "")
    if web_host and _SAFE_HOST_RE.fullmatch(web_host):
        hosts.add(web_host.lower())

    codespace = os.environ.get("CODESPACE_NAME", "")
    cs_domain = os.environ.get(
        "GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN", "app.github.dev"
    )
    if (
        codespace
        and _SAFE_SLUG_RE.fullmatch(codespace)
        and _SAFE_HOST_RE.fullmatch(cs_domain)
    ):
        for port in (5173, 8765, 8080):
            hosts.add(f"{codespace}-{port}.{cs_domain}".lower())

    return frozenset(hosts)


def _extract_host_header_name(raw_host: str) -> str | None:
    """Extract lowercase hostname or bracketed IPv6 literal from a Host header."""
    if not raw_host or "\n" in raw_host or "\r" in raw_host:
        return None
    if raw_host.startswith("["):
        end = raw_host.find("]")
        if end == -1:
            return None
        rest = raw_host[end + 1 :]
        if rest and not (rest.startswith(":") and rest[1:].isascii() and rest[1:].isdigit()):
            return None
        return raw_host[: end + 1].lower()
    if ":" in raw_host:
        host_part, _, port_part = raw_host.partition(":")
        if not port_part.isascii() or not port_part.isdigit():
            return None
        return host_part.lower()
    return raw_host.lower()


class _ProxyTrustedHostMiddleware(TrustedHostMiddleware):
    """Starlette TrustedHostMiddleware with IPv6 literal and env-override support."""

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(
            app,
            allowed_hosts=["localhost", "127.0.0.1", "[::1]", "testserver"],
            www_redirect=False,
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        hostname = _extract_host_header_name(headers.get("host", ""))
        allowed = _allowed_hosts()
        if hostname is not None and ("*" in allowed or hostname in allowed):
            await self.app(scope, receive, send)
            return

        response = PlainTextResponse("Invalid host header", status_code=400)
        await response(scope, receive, send)


def _remote_peers_allowed() -> bool:
    return os.environ.get("PROXY_ALLOW_REMOTE", "").strip().lower() in ("1", "true")


def _is_loopback_host(host: str) -> bool:
    normalized = host.strip().lower()
    if normalized in ("localhost", "testclient"):
        return True
    if normalized.startswith("[") and normalized.endswith("]"):
        normalized = normalized[1:-1]
    try:
        addr = ipaddress.ip_address(normalized)
    except ValueError:
        return False
    if addr.is_loopback:
        return True
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        return addr.ipv4_mapped.is_loopback
    return False


def _peer_allowed(ws: WebSocket) -> bool:
    if _remote_peers_allowed():
        return True
    if ws.client is None or not ws.client.host:
        return False
    return _is_loopback_host(ws.client.host)


def _auth_token_valid(headers: Mapping[str, str]) -> bool:
    expected = os.environ.get("PROXY_AUTH_TOKEN", "")
    if not expected:
        return True
    auth_header = headers.get("authorization", "")
    if auth_header:
        if not auth_header.lower().startswith("bearer "):
            return False
        candidate = auth_header[7:].strip()
    else:
        candidate = headers.get("x-proxy-token", "").strip()
    if not candidate:
        return False
    return hmac.compare_digest(
        candidate.encode("utf-8"), expected.encode("utf-8")
    )


def _config_path() -> Path:
    raw = os.environ.get("GECX_CONFIG")
    if raw:
        return Path(raw)
    cwd_rel = Path("../gecx-config.json")
    return cwd_rel if cwd_rel.exists() else _DEFAULT_CONFIG_PATH


def _load_app_resource() -> tuple[str, str]:
    """Resolve and regex-validate GCP project, location, and app ID."""
    env_project = os.environ.get("CLOUDBANK_GCP_PROJECT_ID", "").strip()
    env_location = os.environ.get("CLOUDBANK_LOCATION", "").strip()
    env_app_id = os.environ.get("CLOUDBANK_APP_ID", "").strip()

    cfg: dict[str, Any] = {}
    if not (env_project and env_location and env_app_id):
        cfg_path = _config_path()
        if cfg_path.exists() or not (env_project and env_app_id):
            loaded = json.loads(cfg_path.read_text(encoding="utf-8"))
            if not isinstance(loaded, dict):
                raise ValueError("gecx-config.json root must be an object")
            cfg = loaded

    project_id = env_project or str(cfg.get("gcp_project_id") or "").strip()
    location = env_location or str(cfg.get("location") or "").strip() or (
        "eu" if (env_project and env_app_id) else ""
    )
    app_id = env_app_id or str(cfg.get("deployed_app_id") or "").strip()

    if not _GCP_PROJECT_RE.fullmatch(project_id):
        raise ValueError("invalid gcp_project_id")
    if not _GCP_LOCATION_RE.fullmatch(location):
        raise ValueError("invalid location")
    if not _GCP_APP_ID_RE.fullmatch(app_id):
        raise ValueError("invalid deployed_app_id")

    resource = f"projects/{project_id}/locations/{location}/apps/{app_id}"
    return resource, location


def _should_warm_credentials() -> bool:
    explicit = os.environ.get("PROXY_WARM_CREDENTIALS")
    if explicit is not None:
        return explicit.strip().lower() in ("1", "true", "yes")
    return "PYTEST_CURRENT_TEST" not in os.environ


@contextlib.asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    for persona in _VALID_PERSONAS:
        _load_persona_snapshot(persona)
    if _should_warm_credentials():
        try:
            async with asyncio.timeout(2.0):
                await _tokens.get_token()
        except Exception:
            log.debug("skipping optional ADC warm-up during startup", exc_info=True)
    yield


app = FastAPI(
    title="Cloudbank BidiRunSession proxy",
    lifespan=_lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
app.add_middleware(_ProxyTrustedHostMiddleware)


async def _receive_ws_text(ws: WebSocket) -> str:
    """Receive one UTF-8 text WebSocket frame, rejecting binary frames cleanly."""
    msg = await ws.receive()
    msg_type = msg.get("type")
    if msg_type == "websocket.disconnect":
        raw_code = msg.get("code")
        code = int(raw_code) if isinstance(raw_code, int) else 1000
        raise WebSocketDisconnect(code=code)
    if msg.get("bytes") is not None:
        raise BinaryFrameError("binary frames are not supported")
    text = msg.get("text")
    if not isinstance(text, str):
        raise BinaryFrameError("expected text WebSocket frame")
    return text


async def _fail(
    ws: WebSocket,
    message: str,
    *,
    field: str | None = None,
    code: int = 1008,
) -> None:
    """Send a structured ServerError envelope and close the WebSocket."""
    with contextlib.suppress(WebSocketDisconnect, RuntimeError):
        await ws.send_text(
            serialize_server_msg(ServerError(message=message, field=field))
        )
    with contextlib.suppress(RuntimeError):
        await ws.close(code=code)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.websocket("/ws/agent")
async def ws_agent(ws: WebSocket) -> None:
    global _active_session_count

    if not _peer_allowed(ws):
        peer_host = ws.client.host if ws.client is not None else None
        log.warning("rejecting non-loopback websocket peer %r", peer_host)
        await ws.close(code=1008)
        return

    origin = ws.headers.get("origin")
    if not _origin_allowed(origin):
        log.warning("rejecting websocket from missing or disallowed origin %r", origin)
        await ws.close(code=1008)
        return

    if not _auth_token_valid(ws.headers):
        log.warning("rejecting websocket with missing or invalid proxy auth token")
        await ws.close(code=1008)
        return

    sem = _get_session_semaphore()
    if sem.locked():
        log.warning("rejecting websocket: concurrent session cap reached")
        await ws.accept()
        await _fail(ws, "server busy: too many active sessions")
        return

    await sem.acquire()
    _active_session_count += 1
    try:
        await ws.accept()
        await _run_session(ws)
    finally:
        _active_session_count -= 1
        sem.release()


async def _run_session(ws: WebSocket) -> None:
    try:
        async with asyncio.timeout(_start_timeout_seconds()):
            start_raw = await _receive_ws_text(ws)
    except WebSocketDisconnect:
        return
    except BinaryFrameError:
        log.warning("rejecting binary frame before start handshake")
        await _fail(ws, "binary frames are not supported", code=1003)
        return
    except TimeoutError:
        log.warning("closing websocket that never sent start frame")
        await _fail(ws, "timed out waiting for start frame")
        return

    if len(start_raw.encode("utf-8")) > MAX_CLIENT_FRAME_BYTES:
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
        resolved_session_id, is_resume = _validate_session_id_and_persona(
            start.sessionId, start.persona
        )
        built_variables = build_session_variables(start)
    except VariableValidationError as exc:
        log.warning("rejecting start parameter %s: %s", exc.field, exc.reason)
        await _fail(ws, exc.client_message, field=exc.field)
        return
    except (OSError, json.JSONDecodeError):
        log.exception("could not load server-owned persona snapshot")
        await _fail(ws, "server configuration error", code=1011)
        return

    persona_variables: dict[str, Any] | None = None if is_resume else built_variables
    _record_session_binding(resolved_session_id, start.persona)

    try:
        app_resource, location = _load_app_resource()
    except (FileNotFoundError, KeyError, ValueError, json.JSONDecodeError):
        log.exception("could not load or validate GCP app resource configuration")
        await _fail(ws, "server configuration error", code=1011)
        return

    try:
        token = await _tokens.get_token()
    except Exception:
        log.exception("could not obtain ADC token")
        await _fail(ws, "server authentication error", code=1011)
        return

    upstream_url = (
        "wss://ces.googleapis.com/ws/"
        "google.cloud.ces.v1.SessionService/BidiRunSession/"
        f"locations/{location}"
    )

    project_id = (
        app_resource.split("/")[1] if app_resource.startswith("projects/") else ""
    )
    upstream_headers = {"Authorization": f"Bearer {token}"}
    if project_id:
        upstream_headers["x-goog-user-project"] = project_id

    relay: Relay | None = None
    log.info(
        "opening upstream WS for app=%s session=%s resume=%s",
        app_resource,
        resolved_session_id,
        is_resume,
    )
    try:
        async with websockets.connect(
            upstream_url,
            additional_headers=upstream_headers,
            max_size=_MAX_UPSTREAM_FRAME_BYTES,
        ) as upstream:
            relay = Relay(
                browser=_FastApiBrowserAdapter(ws),
                upstream=cast(Any, upstream),
                app_resource=app_resource,
                session_id=resolved_session_id,
                persona_variables=persona_variables,
                keepalive_interval_seconds=_keepalive_seconds(),
                max_idle_seconds=_max_idle_seconds(),
            )
            await relay.run(start=start)
    except BinaryFrameError:
        log.warning("closing session after unsupported binary client frame")
        await _fail(ws, "binary frames are not supported", code=1003)
    except websockets.exceptions.InvalidStatus as exc:
        status_code = exc.response.status_code
        log.warning("upstream rejected connection (status=%s)", status_code)
        await _fail(ws, "upstream connection rejected", code=1011)
    except websockets.exceptions.ConnectionClosedError as exc:
        if relay is not None and relay.ended_cleanly:
            with contextlib.suppress(RuntimeError):
                await ws.close()
            return
        code = int(exc.rcvd.code) if exc.rcvd is not None else 1006
        reason = exc.rcvd.reason.strip() if exc.rcvd is not None else ""
        if len(reason) > 200:
            reason = reason[:200] + "..."
        log.warning("upstream closed abnormally: code=%s reason=%s", code, reason)
        await _fail(ws, "upstream connection closed unexpectedly", code=1011)
    except WebSocketDisconnect:
        pass
    except (OSError, websockets.exceptions.InvalidURI, TimeoutError):
        log.exception("could not reach upstream")
        await _fail(ws, "could not reach upstream", code=1011)


class _FastApiBrowserAdapter:
    """Adapts FastAPI's WebSocket to the BrowserSocket Protocol."""

    def __init__(self, ws: WebSocket) -> None:
        self._ws = ws

    async def receive_text(self) -> str:
        try:
            return await _receive_ws_text(self._ws)
        except WebSocketDisconnect as exc:
            raise BrowserDisconnectError() from exc

    async def send_text(self, raw: str) -> None:
        await self._ws.send_text(raw)

    async def close(self) -> None:
        with contextlib.suppress(RuntimeError):
            await self._ws.close()
