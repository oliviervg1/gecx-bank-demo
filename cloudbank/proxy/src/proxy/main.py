"""FastAPI entrypoint for the hardened Cloudbank BidiRunSession proxy.

Security posture: this proxy holds upstream Google Cloud credentials (local
Application Default Credentials in workstation development, or a dedicated
least-privilege service account in Cloud Run) and opens CX Agent Studio (GECX)
BidiRunSession streams on behalf of the browser.

Supported deployment modes:
1. Localhost workstation mode (`127.0.0.1:8765`, Vite dev/preview on `5173`/`4173`).
2. Single-origin Cloud Run Direct IAP mode (`PROXY_IAP_AUDIENCE` + `PROXY_STATIC_DIR`),
   cryptographically verifying `x-goog-iap-jwt-assertion` on every non-`/health`
   HTTP request and WebSocket upgrade before `ws.accept()`.

Defense-in-depth controls enforced here:
- Disabled OpenAPI/Swagger/ReDoc documentation endpoints and `redirect_slashes=False`.
- Standalone ASGI Host-header validation (first) and pure ASGI IAP ES256 JWT
  verification (second, inside Host middleware), emitting spec-compliant
  WebSocket rejection responses before `ws.accept()`.
- Fail-closed startup and peer guards requiring `PROXY_AUTH_TOKEN` or valid
  `PROXY_IAP_AUDIENCE` on non-loopback binds or `PROXY_ALLOW_REMOTE=1`,
  requiring `PROXY_IAP_AUDIENCE` whenever `PROXY_STATIC_DIR` is combined with
  non-loopback/remote access, and enforcing both token and IAP checks if both
  are configured.
- Exact-match Origin validation (missing Origin rejected, zero wildcard/suffix
  fallthrough, explicit `https://` non-loopback `PROXY_ALLOWED_ORIGINS` and
  bare-hostname `PROXY_ALLOWED_HOSTS` required in IAP mode).
- Non-racy `asyncio.Semaphore` global session cap plus per-`iap_sub` concurrent
  session cap (`PROXY_MAX_SESSIONS_PER_USER`, default `2`) acquired before
  `ws.accept()`.
- Server-owned persona snapshots loaded from `cloudbank/shared/personas/*.json`,
  validated against `cloudbank/shared/customer_snapshot.schema.json`, with
  post-connect `(persona, iap_sub)` session binding, active-session eviction
  protection, and fresh server-minted UUIDs whenever an unrecognized or
  cross-user `sessionId` is presented.
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
import mimetypes
import os
import re
import time
import urllib.parse
import uuid
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, cast

import websockets
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from jsonschema.validators import validator_for
from starlette.datastructures import Headers
from starlette.responses import PlainTextResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from .auth import GoogleTokenProvider
from .iap import (
    IapAuthError,
    IapCertUnavailableError,
    IapPrincipal,
    IapVerifier,
    extract_iap_jwt_from_scope,
    parse_iap_audiences,
)
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

_tokens = GoogleTokenProvider()
_iap_verifier = IapVerifier()

DEFAULT_BIND_HOST = "127.0.0.1"

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
_GCP_PROJECT_RE = re.compile(
    r"\A(?:[a-z0-9.-]+:)?[a-z][a-z0-9-]{4,28}[a-z0-9]\Z"
)
_GCP_LOCATION_RE = re.compile(r"\A[a-z0-9-]+\Z")
_GCP_APP_ID_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")

_VALID_PERSONAS: tuple[Persona, ...] = ("chloe", "david", "tom", "sarah")
_VALID_TIMES_OF_DAY: frozenset[str] = frozenset({"morning", "afternoon", "evening"})

DEFAULT_DEMO_DATE = "2026-11-24"
DEFAULT_TIME_OF_DAY: TimeOfDay = "afternoon"
MAX_SNAPSHOT_BYTES = 32 * 1024
_MAX_UPSTREAM_FRAME_BYTES = 4 * 1024 * 1024

DEFAULT_MAX_SESSIONS = 4
DEFAULT_MAX_SESSIONS_PER_USER = 2
DEFAULT_START_TIMEOUT_SECONDS = 10.0
DEFAULT_MAX_IDLE_SECONDS = 900.0
DEFAULT_MAX_SESSION_SECONDS = 3600.0
DEFAULT_KEEPALIVE_SECONDS = 10.0
MAX_TRACKED_SESSIONS = 256
SESSION_BINDING_TTL_SECONDS = 3600.0

_EXPLICIT_ASSET_MEDIA_TYPES: Mapping[str, str] = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".json": "application/json",
    ".wasm": "application/wasm",
}


@dataclass(frozen=True, slots=True)
class _StaticBundle:
    static_root: Path
    index_path: Path
    assets_root: Path
    security_headers: Mapping[str, str]


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


def _max_sessions_per_user() -> int:
    return _env_positive_int(
        "PROXY_MAX_SESSIONS_PER_USER", DEFAULT_MAX_SESSIONS_PER_USER
    )


def _start_timeout_seconds() -> float:
    return _env_positive_float(
        "PROXY_START_TIMEOUT_SECONDS", DEFAULT_START_TIMEOUT_SECONDS
    )


def _max_idle_seconds() -> float:
    return _env_positive_float("PROXY_MAX_IDLE_SECONDS", DEFAULT_MAX_IDLE_SECONDS)


def _max_session_seconds() -> float:
    return _env_positive_float(
        "PROXY_MAX_SESSION_SECONDS", DEFAULT_MAX_SESSION_SECONDS
    )


def _keepalive_seconds() -> float:
    return _env_positive_float("PROXY_KEEPALIVE_SECONDS", DEFAULT_KEEPALIVE_SECONDS)


_session_semaphore_limit = _max_concurrent_sessions()
_session_semaphore = asyncio.Semaphore(_session_semaphore_limit)
_active_session_count = 0

_session_personas: collections.OrderedDict[str, tuple[Persona, str | None]] = (
    collections.OrderedDict()
)
_session_persona_timestamps: dict[str, float] = {}
_active_session_ids: dict[str, int] = {}
_active_user_sessions: dict[str, int] = {}


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
def _snapshot_validator() -> Any:
    """Load and compile cloudbank/shared/customer_snapshot.schema.json once."""
    schema = json.loads(_SNAPSHOT_SCHEMA_PATH.read_text(encoding="utf-8"))
    validator_cls = validator_for(schema)
    validator_cls.check_schema(schema)
    return validator_cls(schema)


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

    errors = sorted(
        _snapshot_validator().iter_errors(snapshot), key=lambda e: list(e.path)
    )
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


def _mint_fresh_session_id() -> str:
    candidate = str(uuid.uuid4())
    while candidate in _session_personas or candidate in _active_session_ids:
        candidate = str(uuid.uuid4())
    return candidate


def _prune_expired_session_bindings(now: float) -> None:
    cutoff = now - SESSION_BINDING_TTL_SECONDS
    expired = [
        sid
        for sid, ts in _session_persona_timestamps.items()
        if ts < cutoff and sid not in _active_session_ids
    ]
    for sid in expired:
        _session_personas.pop(sid, None)
        _session_persona_timestamps.pop(sid, None)


def _validate_session_id_and_persona(
    requested_session_id: str | None,
    persona: Persona,
    *,
    iap_sub: str | None = None,
    now: float | None = None,
) -> tuple[str, bool]:
    """Validate optional resumed sessionId and enforce `(persona, iap_sub)` ownership."""
    ts = time.monotonic() if now is None else now
    _prune_expired_session_bindings(ts)

    if requested_session_id is None:
        return _mint_fresh_session_id(), False

    if not _SESSION_ID_RE.fullmatch(requested_session_id):
        raise VariableValidationError(
            "sessionId",
            "must be a canonical UUID",
            client_message="invalid sessionId",
        )

    canonical = requested_session_id.lower()
    binding = _session_personas.get(canonical)
    if binding is None:
        # Unrecognized, post-restart, or TTL/LRU-expired UUIDs NEVER resume unseeded
        # or rebind an existing upstream session ID: mint a fresh server-owned UUID.
        return _mint_fresh_session_id(), False

    bound_persona, bound_sub = binding
    if bound_sub != iap_sub:
        # Cross-user mismatch is treated identically to an unrecognized UUID so one
        # user cannot resume or probe another user's bound persona.
        return _mint_fresh_session_id(), False

    if bound_persona != persona:
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
    iap_sub: str | None = None,
    now: float | None = None,
) -> None:
    ts = time.monotonic() if now is None else now
    _prune_expired_session_bindings(ts)
    if session_id in _session_personas:
        _session_personas.move_to_end(session_id)
    _session_personas[session_id] = (persona, iap_sub)
    _session_persona_timestamps[session_id] = ts

    while len(_session_personas) > MAX_TRACKED_SESSIONS:
        evict_sid = next(
            (sid for sid in _session_personas if sid not in _active_session_ids),
            None,
        )
        if evict_sid is None:
            break
        _session_personas.pop(evict_sid, None)
        _session_persona_timestamps.pop(evict_sid, None)


def _mark_session_active(session_id: str) -> None:
    _active_session_ids[session_id] = _active_session_ids.get(session_id, 0) + 1


def _mark_session_inactive(session_id: str) -> None:
    remaining = _active_session_ids.get(session_id, 0) - 1
    if remaining <= 0:
        _active_session_ids.pop(session_id, None)
    else:
        _active_session_ids[session_id] = remaining
    if session_id in _session_personas:
        _session_persona_timestamps[session_id] = time.monotonic()


def _in_test_mode() -> bool:
    if "PYTEST_CURRENT_TEST" in os.environ:
        return True
    return os.environ.get("PROXY_ALLOW_TEST_HOSTS", "").strip().lower() in (
        "1",
        "true",
        "yes",
    )


def _allowed_origins() -> frozenset[str]:
    """Return exact permitted browser Origin values with zero wildcard fallthrough."""
    override = os.environ.get("PROXY_ALLOWED_ORIGINS")
    if override is not None:
        return frozenset(
            item.strip()
            for item in override.split(",")
            if item.strip() and "\n" not in item and "\r" not in item and "*" not in item
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
    if not origin or "\n" in origin or "\r" in origin or "*" in origin:
        return False
    return origin in _allowed_origins()


def _allowed_hosts() -> frozenset[str]:
    """Return exact permitted HTTP/WebSocket Host header hostnames."""
    override = os.environ.get("PROXY_ALLOWED_HOSTS")
    if override is not None:
        return frozenset(
            item.strip().lower()
            for item in override.split(",")
            if item.strip() and "\n" not in item and "\r" not in item and "*" not in item
        )

    hosts: set[str] = set(_DEFAULT_LOCAL_HOSTS)
    if _in_test_mode():
        hosts.add("testserver")

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
        if rest and not (
            rest.startswith(":") and rest[1:].isascii() and rest[1:].isdigit()
        ):
            return None
        return raw_host[: end + 1].lower()
    if ":" in raw_host:
        host_part, _, port_part = raw_host.partition(":")
        if not port_part.isascii() or not port_part.isdigit():
            return None
        return host_part.lower()
    return raw_host.lower()


async def _reject_asgi_websocket(
    scope: Scope,
    send: Send,
    *,
    http_status: int,
    body: bytes,
    close_code: int = 1008,
) -> None:
    extensions = scope.get("extensions") or {}
    if "websocket.http.response" in extensions:
        await send(
            {
                "type": "websocket.http.response.start",
                "status": http_status,
                "headers": [
                    (b"content-type", b"text/plain; charset=utf-8"),
                    (b"content-length", str(len(body)).encode("ascii")),
                    (b"cache-control", b"no-store"),
                ],
            }
        )
        await send(
            {
                "type": "websocket.http.response.body",
                "body": body,
                "more_body": False,
            }
        )
    else:
        await send({"type": "websocket.close", "code": close_code})


class _ProxyTrustedHostMiddleware:
    """Standalone ASGI Host-header validator for HTTP and WebSocket scopes."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        scope_type = scope["type"]
        if scope_type not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        hostname = _extract_host_header_name(headers.get("host", ""))
        allowed = _allowed_hosts()
        if hostname is not None and hostname in allowed:
            await self.app(scope, receive, send)
            return

        if scope_type == "websocket":
            await _reject_asgi_websocket(
                scope,
                send,
                http_status=400,
                body=b"Invalid host header",
                close_code=1008,
            )
            return

        response = PlainTextResponse("Invalid host header", status_code=400)
        await response(scope, receive, send)


class _ProxyIapMiddleware:
    """Pure ASGI IAP ES256 JWT validator for HTTP and WebSocket scopes."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        scope_type = scope["type"]
        if scope_type not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        raw_iap = os.environ.get("PROXY_IAP_AUDIENCE")
        if raw_iap is None or raw_iap == "":
            await self.app(scope, receive, send)
            return

        raw_path = scope.get("raw_path")
        if (
            scope_type == "http"
            and scope.get("path") == "/health"
            and raw_path in (None, b"", b"/health")
        ):
            await self.app(scope, receive, send)
            return

        try:
            audiences = parse_iap_audiences(raw_iap)
        except ValueError:
            log.warning("rejecting request: malformed PROXY_IAP_AUDIENCE configuration")
            await self._deny(scope_type, scope, receive, send, status=401, body=b"Unauthorized")
            return

        try:
            jwt_token = extract_iap_jwt_from_scope(scope)
            principal = await _iap_verifier.verify_token(jwt_token, audiences)
        except IapCertUnavailableError as exc:
            log.warning("rejecting request: IAP public keys unavailable (%s)", exc)
            await self._deny(
                scope_type,
                scope,
                receive,
                send,
                status=503,
                body=b"IAP verification keys unavailable",
                ws_close_code=1011,
            )
            return
        except IapAuthError as exc:
            log.warning("rejecting request with invalid IAP assertion: %s", exc)
            await self._deny(scope_type, scope, receive, send, status=401, body=b"Unauthorized")
            return

        if _configured_auth_token() and not _auth_token_valid(Headers(scope=scope)):
            log.warning("rejecting IAP request missing required proxy auth token")
            await self._deny(scope_type, scope, receive, send, status=401, body=b"Unauthorized")
            return

        state_map = scope.setdefault("state", {})
        if isinstance(state_map, dict):
            state_map["iap_principal"] = principal

        await self.app(scope, receive, send)

    @staticmethod
    async def _deny(
        scope_type: str,
        scope: Scope,
        receive: Receive,
        send: Send,
        *,
        status: int,
        body: bytes,
        ws_close_code: int = 1008,
    ) -> None:
        if scope_type == "websocket":
            await _reject_asgi_websocket(
                scope,
                send,
                http_status=status,
                body=body,
                close_code=ws_close_code,
            )
            return
        response = PlainTextResponse(
            body.decode("utf-8"),
            status_code=status,
            headers={"Cache-Control": "no-store"},
        )
        await response(scope, receive, send)


def _remote_peers_allowed() -> bool:
    return os.environ.get("PROXY_ALLOW_REMOTE", "").strip().lower() in ("1", "true")


def _configured_auth_token() -> str:
    return os.environ.get("PROXY_AUTH_TOKEN", "").strip()


def _has_valid_iap_config() -> bool:
    raw = os.environ.get("PROXY_IAP_AUDIENCE")
    if raw is None or raw == "":
        return False
    try:
        return bool(parse_iap_audiences(raw))
    except ValueError:
        return False


def _is_ip_loopback(host: str) -> bool:
    normalized = host.strip().lower()
    if normalized == "localhost":
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


def _is_disallowed_iap_hostname(host: str) -> bool:
    lowered = host.strip().lower()
    if (
        not lowered
        or "*" in lowered
        or _is_ip_loopback(lowered)
        or lowered.endswith(".localhost")
        or lowered in ("testserver", "testclient")
    ):
        return True
    return False


def _is_loopback_host(host: str) -> bool:
    normalized = host.strip().lower()
    if normalized == "testclient":
        return _in_test_mode()
    return _is_ip_loopback(normalized)


def _validate_iap_origins_and_hosts() -> None:
    """Enforce explicit `https://` non-loopback origins and bare hostnames in IAP mode."""
    if os.environ.get("PROXY_ALLOW_TEST_HOSTS", "").strip():
        raise RuntimeError(
            "PROXY_ALLOW_TEST_HOSTS must not be set when PROXY_IAP_AUDIENCE is configured"
        )

    raw_origins = os.environ.get("PROXY_ALLOWED_ORIGINS")
    if raw_origins is None or not raw_origins.strip():
        raise RuntimeError(
            "PROXY_IAP_AUDIENCE requires an explicit non-empty PROXY_ALLOWED_ORIGINS"
        )
    origin_parts = raw_origins.split(",")
    for raw_part in origin_parts:
        if "\r" in raw_part or "\n" in raw_part:
            raise RuntimeError("PROXY_ALLOWED_ORIGINS must not contain control characters")
        origin = raw_part.strip()
        if not origin or "*" in origin:
            raise RuntimeError(
                "PROXY_ALLOWED_ORIGINS in IAP mode must not contain empty or wildcard entries"
            )
        parsed = urllib.parse.urlsplit(origin)
        try:
            port = parsed.port
        except ValueError as exc:
            raise RuntimeError(f"Invalid port in PROXY_ALLOWED_ORIGINS entry {origin!r}") from exc
        if (
            parsed.scheme != "https"
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path != ""
            or parsed.query != ""
            or parsed.fragment != ""
            or parsed.hostname is None
            or (port is not None and not (1 <= port <= 65535))
        ):
            raise RuntimeError(
                "PROXY_ALLOWED_ORIGINS in IAP mode must contain exact https:// origins only"
            )
        origin_host = parsed.hostname.lower()
        if _is_disallowed_iap_hostname(origin_host) or not _SAFE_HOST_RE.fullmatch(origin_host):
            raise RuntimeError(
                f"Disallowed or loopback hostname {origin_host!r} in PROXY_ALLOWED_ORIGINS"
            )

    raw_hosts = os.environ.get("PROXY_ALLOWED_HOSTS")
    if raw_hosts is None or not raw_hosts.strip():
        raise RuntimeError(
            "PROXY_IAP_AUDIENCE requires an explicit non-empty PROXY_ALLOWED_HOSTS"
        )
    for raw_host_part in raw_hosts.split(","):
        if "\r" in raw_host_part or "\n" in raw_host_part:
            raise RuntimeError("PROXY_ALLOWED_HOSTS must not contain control characters")
        host = raw_host_part.strip().lower()
        if (
            not host
            or "*" in host
            or "://" in host
            or "/" in host
            or ":" in host
            or _is_disallowed_iap_hostname(host)
            or not _SAFE_HOST_RE.fullmatch(host)
        ):
            raise RuntimeError(
                "PROXY_ALLOWED_HOSTS in IAP mode must contain explicit non-loopback bare hostnames"
            )


class _CspMetaParser(HTMLParser):
    """Extract `<meta http-equiv="Content-Security-Policy" content="...">` values."""

    def __init__(self) -> None:
        super().__init__()
        self.csp_values: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "meta":
            return
        attr_map = {key.lower(): (val or "") for key, val in attrs}
        if attr_map.get("http-equiv", "").strip().lower() == "content-security-policy":
            self.csp_values.append(attr_map.get("content", ""))


def _extract_and_validate_production_csp(index_html: str) -> str:
    """Derive hardened HTTP CSP from built `dist/index.html` and append `frame-ancestors 'none'`."""
    parser = _CspMetaParser()
    parser.feed(index_html)
    if not parser.csp_values:
        raise RuntimeError(
            'Static index.html is missing <meta http-equiv="Content-Security-Policy">'
        )
    if len(parser.csp_values) > 1:
        raise RuntimeError(
            "Static index.html contains multiple Content-Security-Policy meta tags"
        )

    raw_csp = parser.csp_values[0].strip()
    if not raw_csp or "\r" in raw_csp or "\n" in raw_csp:
        raise RuntimeError("Static index.html Content-Security-Policy meta content is invalid")

    directives: dict[str, list[str]] = {}
    ordered_parts: list[str] = []
    for chunk in raw_csp.split(";"):
        cleaned = " ".join(chunk.strip().split())
        if not cleaned:
            continue
        tokens = cleaned.split(" ")
        name = tokens[0].lower()
        if name in directives:
            raise RuntimeError(f"Duplicate CSP directive {name!r} in static index.html")
        values = tokens[1:]
        directives[name] = values
        ordered_parts.append(cleaned)

    for required in ("default-src", "script-src", "connect-src"):
        if required not in directives or not directives[required]:
            raise RuntimeError(
                f"Static index.html CSP is missing required directive {required!r}"
            )

    script_tokens = {tok.lower() for tok in directives["script-src"]}
    if (
        "'unsafe-inline'" in script_tokens
        or "'unsafe-eval'" in script_tokens
        or "*" in script_tokens
    ):
        raise RuntimeError(
            "Refusing static index.html with unsafe script-src CSP (dev or unhardened build)"
        )

    connect_tokens = [tok.lower() for tok in directives["connect-src"]]
    if connect_tokens != ["'self'"]:
        raise RuntimeError(
            "Refusing static index.html whose connect-src is not strict same-origin 'self'"
        )

    for dir_values in directives.values():
        lowered_vals = {tok.lower() for tok in dir_values}
        if "ws:" in lowered_vals or "wss:" in lowered_vals:
            raise RuntimeError("Refusing static index.html containing bare ws: or wss: in CSP")

    if "frame-ancestors" in directives:
        if [tok.lower() for tok in directives["frame-ancestors"]] != ["'none'"]:
            raise RuntimeError("Static index.html CSP frame-ancestors must be 'none'")
    else:
        ordered_parts.append("frame-ancestors 'none'")

    return "; ".join(ordered_parts)


@functools.lru_cache(maxsize=8)
def _load_cached_static_bundle(
    resolved_root_str: str, index_mtime_ns: int
) -> _StaticBundle:
    del index_mtime_ns
    static_root = Path(resolved_root_str)
    raw_index = static_root / "index.html"
    if raw_index.is_symlink():
        raise RuntimeError("Static index.html must not be a symlink")
    try:
        index_path = raw_index.resolve(strict=True)
    except OSError as exc:
        raise RuntimeError("Static index.html does not exist") from exc
    if not index_path.is_relative_to(static_root) or not index_path.is_file():
        raise RuntimeError("Static index.html must be a regular file inside PROXY_STATIC_DIR")

    raw_assets = static_root / "assets"
    if raw_assets.is_symlink():
        raise RuntimeError("Static assets directory must not be a symlink")
    try:
        assets_root = raw_assets.resolve(strict=True)
    except OSError as exc:
        raise RuntimeError("Static assets directory does not exist inside PROXY_STATIC_DIR") from exc
    if not assets_root.is_relative_to(static_root) or not assets_root.is_dir():
        raise RuntimeError("Static assets path must be a directory inside PROXY_STATIC_DIR")

    csp_header = _extract_and_validate_production_csp(
        index_path.read_text(encoding="utf-8")
    )
    security_headers: dict[str, str] = {
        "Content-Security-Policy": csp_header,
        "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "X-Frame-Options": "DENY",
    }
    return _StaticBundle(
        static_root=static_root,
        index_path=index_path,
        assets_root=assets_root,
        security_headers=security_headers,
    )


def _load_static_bundle(raw_static_dir: str) -> _StaticBundle:
    try:
        static_root = Path(raw_static_dir).resolve(strict=True)
    except OSError as exc:
        raise RuntimeError(f"PROXY_STATIC_DIR does not exist: {raw_static_dir!r}") from exc
    if not static_root.is_dir():
        raise RuntimeError("PROXY_STATIC_DIR must point to a directory")
    index_candidate = static_root / "index.html"
    if index_candidate.is_symlink() or not index_candidate.is_file():
        raise RuntimeError("PROXY_STATIC_DIR is missing a regular index.html file")
    stat_res = index_candidate.stat()
    return _load_cached_static_bundle(str(static_root), stat_res.st_mtime_ns)


def validate_runtime_security_config(*, bind_host: str | None = None) -> None:
    """Fail closed if remote/non-loopback/IAP/static security invariants are violated."""
    has_token = bool(_configured_auth_token())
    raw_iap = os.environ.get("PROXY_IAP_AUDIENCE")
    has_iap = False
    if raw_iap is not None and raw_iap != "":
        try:
            iap_audiences = parse_iap_audiences(raw_iap)
        except ValueError as exc:
            raise RuntimeError(str(exc)) from exc
        has_iap = bool(iap_audiences)
        _validate_iap_origins_and_hosts()

    effective_host = (
        bind_host
        if bind_host is not None
        else (os.environ.get("PROXY_HOST", DEFAULT_BIND_HOST).strip() or DEFAULT_BIND_HOST)
    )
    non_loopback = not _is_ip_loopback(effective_host)
    remote_allowed = _remote_peers_allowed()

    raw_static_dir = os.environ.get("PROXY_STATIC_DIR", "").strip()
    if raw_static_dir:
        if (non_loopback or remote_allowed) and not has_iap:
            raise RuntimeError(
                "PROXY_STATIC_DIR with non-loopback PROXY_HOST or PROXY_ALLOW_REMOTE=1 "
                "requires a valid PROXY_IAP_AUDIENCE"
            )
        _load_static_bundle(raw_static_dir)

    if non_loopback and not (has_token or has_iap):
        raise RuntimeError(
            "Refusing to bind non-loopback PROXY_HOST without a non-empty "
            "PROXY_AUTH_TOKEN or valid PROXY_IAP_AUDIENCE"
        )
    if remote_allowed and not (has_token or has_iap):
        raise RuntimeError(
            "PROXY_ALLOW_REMOTE=1 requires a non-empty PROXY_AUTH_TOKEN "
            "or valid PROXY_IAP_AUDIENCE"
        )


def _peer_allowed(ws: WebSocket) -> bool:
    effective_bind = (
        os.environ.get("PROXY_HOST", DEFAULT_BIND_HOST).strip() or DEFAULT_BIND_HOST
    )
    has_token = bool(_configured_auth_token())
    has_iap = _has_valid_iap_config()
    has_static = bool(os.environ.get("PROXY_STATIC_DIR", "").strip())

    if not _is_ip_loopback(effective_bind):
        if has_static and not has_iap:
            return False
        if not (has_token or has_iap):
            return False
    if _remote_peers_allowed():
        if has_static and not has_iap:
            return False
        if not (has_token or has_iap):
            return False
        return True
    if ws.client is None or not ws.client.host:
        return False
    return _is_loopback_host(ws.client.host)


def _http_static_peer_allowed(request: Request) -> bool:
    if _remote_peers_allowed() and _has_valid_iap_config():
        return True
    if request.client is None or not request.client.host:
        return False
    return _is_loopback_host(request.client.host)


def _auth_token_valid(headers: Mapping[str, str]) -> bool:
    expected = _configured_auth_token()
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
    validate_runtime_security_config()
    for persona in _VALID_PERSONAS:
        _load_persona_snapshot(persona)
    if _should_warm_credentials():
        try:
            async with asyncio.timeout(2.0):
                await _tokens.get_token()
        except Exception:
            log.debug("skipping optional ADC warm-up during startup", exc_info=True)
    yield


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


def _resolve_asset_media_type(asset_file: Path) -> str:
    ext = asset_file.suffix.lower()
    explicit = _EXPLICIT_ASSET_MEDIA_TYPES.get(ext)
    if explicit is not None:
        return explicit
    guessed, _ = mimetypes.guess_type(asset_file.name)
    return guessed or "application/octet-stream"


def _static_not_found(bundle: _StaticBundle) -> PlainTextResponse:
    return PlainTextResponse(
        "Not Found",
        status_code=404,
        headers={**bundle.security_headers, "Cache-Control": "no-store"},
    )


def _register_static_spa_routes(fastapi_app: FastAPI, static_dir_raw: str) -> None:
    @fastapi_app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
    def serve_spa_index(request: Request) -> Response:
        if not _http_static_peer_allowed(request):
            return PlainTextResponse(
                "Forbidden", status_code=403, headers={"Cache-Control": "no-store"}
            )
        active_dir = os.environ.get("PROXY_STATIC_DIR", "").strip() or static_dir_raw
        bundle = _load_static_bundle(active_dir)
        return FileResponse(
            bundle.index_path,
            media_type="text/html",
            headers={**bundle.security_headers, "Cache-Control": "no-cache"},
        )

    @fastapi_app.api_route(
        "/assets/{asset_path:path}", methods=["GET", "HEAD"], include_in_schema=False
    )
    def serve_spa_asset(asset_path: str, request: Request) -> Response:
        if not _http_static_peer_allowed(request):
            return PlainTextResponse(
                "Forbidden", status_code=403, headers={"Cache-Control": "no-store"}
            )
        active_dir = os.environ.get("PROXY_STATIC_DIR", "").strip() or static_dir_raw
        bundle = _load_static_bundle(active_dir)

        if (
            not asset_path
            or "\x00" in asset_path
            or "\\" in asset_path
            or asset_path.startswith("/")
        ):
            return _static_not_found(bundle)

        segments = asset_path.split("/")
        if any(seg in ("", ".", "..") for seg in segments):
            return _static_not_found(bundle)

        cursor = bundle.assets_root
        for seg in segments:
            cursor = cursor / seg
            if cursor.is_symlink():
                return _static_not_found(bundle)

        try:
            resolved = cursor.resolve(strict=True)
        except OSError:
            return _static_not_found(bundle)

        if not resolved.is_relative_to(bundle.assets_root) or not resolved.is_file():
            return _static_not_found(bundle)

        return FileResponse(
            resolved,
            media_type=_resolve_asset_media_type(resolved),
            headers={
                **bundle.security_headers,
                "Cache-Control": "public, max-age=31536000, immutable",
            },
        )


async def _ws_agent_handler(ws: WebSocket) -> None:
    global _active_session_count

    if not _peer_allowed(ws):
        peer_host = ws.client.host if ws.client is not None else None
        log.warning("rejecting disallowed or unauthenticated websocket peer %r", peer_host)
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

    principal: IapPrincipal | None = getattr(ws.state, "iap_principal", None)
    raw_iap = os.environ.get("PROXY_IAP_AUDIENCE")
    if raw_iap is not None and raw_iap != "" and principal is None:
        log.warning("rejecting websocket missing verified IAP principal")
        await ws.close(code=1008)
        return
    iap_sub = principal.sub if principal is not None else None

    sem = _get_session_semaphore()
    if sem.locked():
        log.warning("rejecting websocket: concurrent session cap reached")
        await ws.accept()
        await _fail(ws, "server busy: too many active sessions")
        return

    if iap_sub is not None and _active_user_sessions.get(iap_sub, 0) >= _max_sessions_per_user():
        log.warning(
            "rejecting websocket: per-user session cap reached for sub=%s", iap_sub
        )
        await ws.accept()
        await _fail(ws, "server busy: too many active sessions")
        return

    await sem.acquire()
    if iap_sub is not None and _active_user_sessions.get(iap_sub, 0) >= _max_sessions_per_user():
        sem.release()
        log.warning(
            "rejecting websocket: per-user session cap reached for sub=%s", iap_sub
        )
        await ws.accept()
        await _fail(ws, "server busy: too many active sessions")
        return

    _active_session_count += 1
    if iap_sub is not None:
        _active_user_sessions[iap_sub] = _active_user_sessions.get(iap_sub, 0) + 1
    try:
        await ws.accept()
        if iap_sub is not None:
            await _run_session(ws, iap_sub=iap_sub)
        else:
            await _run_session(ws)
    finally:
        if iap_sub is not None:
            rem_user = _active_user_sessions.get(iap_sub, 0) - 1
            if rem_user <= 0:
                _active_user_sessions.pop(iap_sub, None)
            else:
                _active_user_sessions[iap_sub] = rem_user
        _active_session_count -= 1
        sem.release()


async def _run_session(ws: WebSocket, *, iap_sub: str | None = None) -> None:
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
            start.sessionId, start.persona, iap_sub=iap_sub
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
    if iap_sub is not None:
        log.info(
            "opening upstream WS for location=%s session=%s resume=%s sub=%s",
            location,
            resolved_session_id,
            is_resume,
            iap_sub,
        )
    else:
        log.info(
            "opening upstream WS for location=%s session=%s resume=%s",
            location,
            resolved_session_id,
            is_resume,
        )
    try:
        async with websockets.connect(
            upstream_url,
            additional_headers=upstream_headers,
            max_size=_MAX_UPSTREAM_FRAME_BYTES,
        ) as upstream:
            _record_session_binding(
                resolved_session_id, start.persona, iap_sub=iap_sub
            )
            _mark_session_active(resolved_session_id)
            try:
                relay = Relay(
                    browser=_FastApiBrowserAdapter(ws),
                    upstream=cast(Any, upstream),
                    app_resource=app_resource,
                    session_id=resolved_session_id,
                    persona_variables=persona_variables,
                    is_resume=is_resume,
                    keepalive_interval_seconds=_keepalive_seconds(),
                    max_idle_seconds=_max_idle_seconds(),
                    max_session_seconds=_max_session_seconds(),
                )
                await relay.run(start=start)
            finally:
                _mark_session_inactive(resolved_session_id)
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


def create_app(*, static_dir: str | None = None) -> FastAPI:
    """Construct the FastAPI proxy application with Host -> IAP middleware ordering."""
    fastapi_app = FastAPI(
        title="Cloudbank BidiRunSession proxy",
        lifespan=_lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        redirect_slashes=False,
    )
    # Starlette's `add_middleware` wraps LIFO: `_ProxyTrustedHostMiddleware` added
    # second is outermost (runs 1st), and `_ProxyIapMiddleware` runs 2nd.
    fastapi_app.add_middleware(_ProxyIapMiddleware)
    fastapi_app.add_middleware(_ProxyTrustedHostMiddleware)

    @fastapi_app.api_route("/health", methods=["GET", "HEAD"])
    def health() -> dict[str, str]:
        return {"status": "ok"}

    fastapi_app.add_api_websocket_route("/ws/agent", _ws_agent_handler)

    effective_static_dir = (
        static_dir
        if static_dir is not None
        else os.environ.get("PROXY_STATIC_DIR", "").strip()
    )
    if effective_static_dir:
        _register_static_spa_routes(fastapi_app, effective_static_dir)

    return fastapi_app


app = create_app()


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

    async def close(self, code: int = 1000) -> None:
        with contextlib.suppress(RuntimeError):
            await self._ws.close(code=code)
