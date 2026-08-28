"""FastAPI entrypoint for the BidiRunSession proxy.

Security posture: this proxy holds Application Default Credentials and opens
CES sessions with them, so anyone who can open a WebSocket to it can spend the
developer's GCP quota under the developer's identity. It is intended for
localhost development only. The controls here (Origin allowlist, connection
cap, frame size caps, variable allowlist) make that stance explicit rather than
relying on uvicorn happening to default to 127.0.0.1 — but they are NOT a
substitute for authentication. Do not expose this on a routable interface
without adding one.
"""
from __future__ import annotations

import json
import logging
import os
import uuid
from pathlib import Path
from urllib.parse import urlparse

import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .auth import GoogleTokenProvider
from .protocol import (
    MAX_CLIENT_FRAME_BYTES,
    ClientStart,
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
# cloudbank/proxy/ (the documented run directory). Override via GECX_CONFIG.
_CONFIG_PATH = Path(os.environ.get("GECX_CONFIG", "../gecx-config.json"))

# Browser origins permitted to open a session. CORS does not apply to
# WebSockets, so without this check any page the developer happens to be
# visiting can connect to localhost:8080 and drive a fully-authenticated
# Gemini Live session billed to their project (cross-site WebSocket hijacking).
# Requests with NO Origin header are allowed through: only browsers set Origin,
# and a non-browser client already needs network access to the port.
_DEFAULT_ALLOWED_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"
_ALLOWED_ORIGINS = frozenset(
    o.strip()
    for o in os.environ.get("PROXY_ALLOWED_ORIGINS", _DEFAULT_ALLOWED_ORIGINS).split(",")
    if o.strip()
)

# Hosted dev environments serve the Vite app from a generated per-user HTTPS
# host and reach the proxy through Vite's own /ws/agent proxy, so the Origin is
# that host rather than localhost. An exact-match allowlist silently 403s every
# connection there, which reads in the browser as "the proxy is down".
#
# These suffixes are all per-user workspaces behind the provider's SSO, so
# accepting them is a much smaller concession than it looks: reaching one still
# requires being signed in as the developer. Set PROXY_ALLOWED_ORIGINS to
# override the whole policy if you want strict exact-matching.
_HOSTED_DEV_SUFFIXES = (
    ".cloudshell.dev",          # Google Cloud Shell
    ".cloudworkstations.dev",   # Cloud Workstations
    ".github.dev",              # GitHub Codespaces
    ".gitpod.io",
)


def _origin_allowed(origin: str) -> bool:
    if origin in _ALLOWED_ORIGINS:
        return True
    try:
        parsed = urlparse(origin)
    except ValueError:
        return False
    # Only over TLS, and match on the parsed hostname rather than the raw
    # string so `https://evil.com/?x=.cloudshell.dev` cannot sneak through.
    if parsed.scheme != "https" or not parsed.hostname:
        return False
    return any(parsed.hostname.endswith(suffix) for suffix in _HOSTED_DEV_SUFFIXES)

# Upstream frame cap. Set explicitly rather than left at max_size=None, which
# disables the websockets library's own limit and lets a client push arbitrarily
# large payloads through to Google. 4 MiB is far above any real audio frame
# (24 kHz PCM16 chunks are single-digit KB) while still being bounded.
_MAX_UPSTREAM_FRAME_BYTES = 4 * 1024 * 1024

# Ceiling on simultaneous sessions. Each accepted socket opens a NEW upstream
# CES session, so an unbounded connect loop is a cost-amplification vector.
_MAX_CONCURRENT_SESSIONS = int(os.environ.get("PROXY_MAX_SESSIONS", "4"))
_active_sessions = 0

_MAX_VARIABLE_VALUE_LEN = 200


def _load_app_resource() -> tuple[str, str]:
    cfg = json.loads(_CONFIG_PATH.read_text())
    project_id = cfg["gcp_project_id"]
    location = cfg["location"]
    app_id = cfg.get("deployed_app_id")
    if not app_id:
        raise KeyError("deployed_app_id not set in gecx-config.json — run `cxas push` (Task 16) first")
    resource = f"projects/{project_id}/locations/{location}/apps/{app_id}"
    return resource, location


def _allowed_variable_keys() -> frozenset[str]:
    """Variable names the app actually declares.

    Session variables are client-supplied and are templated into the system
    instruction (`{first_name}`), so relaying the dict unfiltered is a
    prompt-injection channel. Read the declared names from app.json so this
    cannot drift from the agent config; fall back to the one variable the app
    declares.
    """
    try:
        cfg = json.loads(_CONFIG_PATH.read_text())
        app_json = (
            _CONFIG_PATH.parent / cfg.get("app_dir", "cxas_app/") / cfg["app_name"] / "app.json"
        )
        declared = json.loads(app_json.read_text()).get("variableDeclarations", [])
        names = frozenset(d["name"] for d in declared if isinstance(d, dict) and "name" in d)
        if names:
            return names
    except (OSError, json.JSONDecodeError, KeyError, TypeError):
        log.warning("could not read variableDeclarations from app.json; using default allowlist")
    return frozenset({"first_name"})


def _resolve_session_id(requested: str | None) -> str:
    """Return the CES session id to use, generating one unless the client sent
    a well-formed UUID.

    The result is interpolated into `{app_resource}/sessions/{id}` by the relay,
    so a client-supplied value is a path-injection channel: `../../apps/other/
    sessions/x` would point the session at a different app. Parsing as a UUID
    and re-emitting the *parsed* value (rather than the input) means no caller
    string ever reaches the resource path verbatim.
    """
    if requested:
        try:
            return str(uuid.UUID(requested))
        except (ValueError, AttributeError, TypeError):
            log.warning("ignoring malformed sessionId from client")
    return str(uuid.uuid4())


def _sanitize_variables(variables: dict[str, str]) -> dict[str, str]:
    allowed = _allowed_variable_keys()
    clean: dict[str, str] = {}
    for key, value in variables.items():
        if key not in allowed:
            log.warning("dropping undeclared session variable %r", key)
            continue
        if not isinstance(value, str) or len(value) > _MAX_VARIABLE_VALUE_LEN:
            log.warning("dropping oversized/invalid session variable %r", key)
            continue
        clean[key] = value
    return clean


async def _fail(ws: WebSocket, message: str) -> None:
    """Send a typed error envelope, then close.

    Uses the Pydantic model rather than hand-built JSON: the previous
    f-string interpolated exception text straight into a JSON literal, which
    both leaked internals (filesystem paths out of FileNotFoundError) and
    produced malformed frames whenever the text contained a quote or backslash.
    """
    try:
        await ws.send_text(serialize_server_msg(ServerError(message=message)))
    except (WebSocketDisconnect, RuntimeError):
        pass
    try:
        await ws.close()
    except RuntimeError:
        pass


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.websocket("/ws/agent")
async def ws_agent(ws: WebSocket) -> None:
    global _active_sessions

    origin = ws.headers.get("origin")
    if origin is not None and not _origin_allowed(origin):
        log.warning("rejecting websocket from disallowed origin %r", origin)
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

    # parse_client_msg raises ValueError on anything malformed. Unguarded, a
    # single garbage first frame escaped the endpoint entirely — an unhandled
    # exception plus a traceback, with the browser seeing only a bare close.
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
        app_resource, location = _load_app_resource()
    except (FileNotFoundError, KeyError, json.JSONDecodeError):
        # Detail goes to the server log; the client is told only that it failed.
        log.exception("could not load gecx-config.json")
        await _fail(ws, "server configuration error")
        return

    persona_variables = _sanitize_variables(start.variables)

    # Expired or absent ADC is the most likely local-dev failure, and used to
    # produce no envelope at all because this call sat outside every try.
    try:
        token = await _tokens.get_token()
    except Exception:
        log.exception("could not obtain ADC token")
        await _fail(ws, "server authentication error")
        return

    # Canonical URL pattern from cxas_scrapi.core.sessions.BIDI_SESSION_URI —
    # the plan's `ces.{location}.rep.googleapis.com` host was wrong.
    upstream_url = (
        "wss://ces.googleapis.com/ws/"
        "google.cloud.ces.v1.SessionService/BidiRunSession/"
        f"locations/{location}"
    )

    log.info("opening upstream WS for app=%s", app_resource)
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
                session_id=_resolve_session_id(start.sessionId),
                persona_variables=persona_variables,
            )
            await relay.run(start=start)
    except websockets.exceptions.InvalidStatus as exc:
        # websockets v15+ renamed InvalidStatusCode -> InvalidStatus; the
        # dependency floor in pyproject.toml is >=15 for exactly this reason.
        status_code = getattr(exc.response, "status_code", "?")
        log.exception("upstream rejected connection (status=%s)", status_code)
        await _fail(ws, f"upstream {status_code}")
    except websockets.exceptions.ConnectionClosedError as exc:
        # CES closed the upstream WS *after* a successful handshake (e.g. the
        # transient `failed_precondition` on BidiRunSession documented in the
        # README). Without a final envelope the browser sees only ws.onclose
        # and cannot distinguish failure from a clean end_session.
        # Read the close frame off `rcvd` rather than `exc.code`/`exc.reason`:
        # those shortcuts are deprecated (websockets 13.1) and will be removed.
        # `rcvd` is None when the peer vanished without a close frame, which is
        # what 1006 means.
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
        # Proxy cannot reach CES at all — DNS, TLS, offline, malformed URL.
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
