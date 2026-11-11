"""Security, Host/Origin/Peer/Token gates, server-owned personas, session binding, semaphore cap, binary frame, and real-socket tests for main.py."""
from __future__ import annotations

import asyncio
import base64
import copy
import http
import json
import uuid
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
import websockets.asyncio.server
import websockets.datastructures
import websockets.exceptions
import websockets.http11
from fastapi.testclient import TestClient
from starlette.routing import WebSocketRoute
from starlette.types import Message
from starlette.websockets import WebSocketDisconnect

from conftest import DEFAULT_ORIGIN
from proxy import __main__ as cli_entry
from proxy import main
from proxy.main import app, build_session_variables, validate_persona_snapshot
from proxy.protocol import MAX_CLIENT_FRAME_BYTES, ClientStart

client = TestClient(app)
EVEN_PCM_B64 = base64.b64encode(b"\x01\x00\x02\x00").decode("ascii")


def _recv_error_payload(ws: Any) -> dict[str, Any]:
    payload = json.loads(ws.receive_text())
    assert payload["type"] == "error"
    return payload


def _set_valid_gcp_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CLOUDBANK_GCP_PROJECT_ID", "cloudbank-demo-01")
    monkeypatch.setenv("CLOUDBANK_LOCATION", "eu")
    monkeypatch.setenv("CLOUDBANK_APP_ID", "11111111-2222-4333-8444-555555555555")


def test_health_route_registered_and_openapi_docs_disabled() -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
    assert "/ws/agent" in [
        route.path for route in app.routes if isinstance(route, WebSocketRoute)
    ]

    for disabled_path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(disabled_path).status_code == 404


def test_trusted_host_middleware_accepts_local_ipv6_and_rejects_untrusted_hosts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PROXY_ALLOWED_HOSTS", raising=False)
    monkeypatch.delenv("WEB_HOST", raising=False)
    monkeypatch.delenv("CODESPACE_NAME", raising=False)

    for valid_host in (
        "localhost",
        "localhost:8765",
        "127.0.0.1",
        "127.0.0.1:8080",
        "[::1]",
        "[::1]:8765",
        "testserver",
    ):
        resp = client.get("/health", headers={"host": valid_host})
        assert resp.status_code == 200, valid_host

    for bad_host in (
        "evil.example",
        "dns-rebind.attacker.example:8765",
        "[::1",
        "[::1]:notaport",
        "localhost:notaport",
    ):
        resp = client.get("/health", headers={"host": bad_host})
        assert resp.status_code == 400, bad_host
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(
                "/ws/agent",
                headers={"host": bad_host, "origin": DEFAULT_ORIGIN},
            ):
                pass

    # Explicit PROXY_ALLOWED_HOSTS override replaces defaults cleanly
    monkeypatch.setenv("PROXY_ALLOWED_HOSTS", "custom.internal.example")
    assert (
        client.get("/health", headers={"host": "custom.internal.example:8765"}).status_code
        == 200
    )
    assert client.get("/health", headers={"host": "localhost"}).status_code == 400


@pytest.mark.asyncio
async def test_loopback_peer_enforcement_and_proxy_allow_remote(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for loopback in (
        "127.0.0.1",
        "127.0.0.5",
        "::1",
        "[::1]",
        "::ffff:127.0.0.1",
        "localhost",
        "testclient",
    ):
        assert main._is_loopback_host(loopback) is True

    for remote in ("192.168.1.25", "10.0.0.8", "203.0.113.5", "", "not-an-ip"):
        assert main._is_loopback_host(remote) is False

    async def _run_raw_ws_handshake(
        peer: tuple[str, int] | None,
    ) -> list[dict[str, Any]]:
        sent_events: list[dict[str, Any]] = []
        inbox: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        await inbox.put({"type": "websocket.connect"})
        await inbox.put({"type": "websocket.disconnect", "code": 1000})

        scope: dict[str, Any] = {
            "type": "websocket",
            "asgi": {"version": "3.0"},
            "scheme": "ws",
            "path": "/ws/agent",
            "raw_path": b"/ws/agent",
            "query_string": b"",
            "headers": [
                (b"host", b"localhost:8765"),
                (b"origin", DEFAULT_ORIGIN.encode("ascii")),
            ],
            "client": peer,
            "subprotocols": [],
        }

        async def receive() -> Message:
            return await inbox.get()

        async def send(message: Message) -> None:
            sent_events.append(dict(message))

        await app(scope, receive, send)
        return sent_events

    # 1. Default: remote peer rejected BEFORE websocket.accept
    monkeypatch.delenv("PROXY_ALLOW_REMOTE", raising=False)
    events_rejected = await _run_raw_ws_handshake(("203.0.113.10", 51234))
    assert events_rejected == [{"type": "websocket.close", "code": 1008, "reason": ""}]

    events_none = await _run_raw_ws_handshake(None)
    assert events_none == [{"type": "websocket.close", "code": 1008, "reason": ""}]

    # 2. PROXY_ALLOW_REMOTE=1 permits remote peer past peer gate
    monkeypatch.setenv("PROXY_ALLOW_REMOTE", "1")
    events_allowed = await _run_raw_ws_handshake(("203.0.113.10", 51234))
    assert events_allowed[0]["type"] == "websocket.accept"


def test_optional_proxy_auth_token_header_enforcement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PROXY_AUTH_TOKEN", "s3cr3t-local-token")

    # Missing token rejected before accept
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}):
            pass

    # Wrong token or wrong scheme rejected
    for bad_headers in (
        {"origin": DEFAULT_ORIGIN, "authorization": "Bearer wrong-token"},
        {"origin": DEFAULT_ORIGIN, "authorization": "Basic s3cr3t-local-token"},
        {"origin": DEFAULT_ORIGIN, "x-proxy-token": "wrong-token"},
    ):
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws/agent", headers=bad_headers):
                pass

    # Valid Authorization: Bearer <token> accepted
    with client.websocket_connect(
        "/ws/agent",
        headers={
            "origin": DEFAULT_ORIGIN,
            "authorization": "Bearer s3cr3t-local-token",
        },
    ) as ws:
        ws.send_text("not json")
        assert "malformed" in _recv_error_payload(ws)["message"]

    # Valid x-proxy-token accepted
    with client.websocket_connect(
        "/ws/agent",
        headers={
            "origin": DEFAULT_ORIGIN,
            "x-proxy-token": "s3cr3t-local-token",
        },
    ) as ws:
        ws.send_text("not json")
        assert "malformed" in _recv_error_payload(ws)["message"]


# -- Strict CSWSH Origin Validation -------------------------------------------


def test_rejects_missing_or_empty_origin() -> None:
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/agent") as ws:
            ws.send_text("probe")
            ws.receive_text()

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/agent", headers={"origin": ""}) as ws:
            ws.send_text("probe")
            ws.receive_text()


@pytest.mark.parametrize(
    "bad_origin",
    [
        "https://evil.example",
        "http://localhost:5173/",
        "http://localhost:5173?x=1",
        "http://localhost:9999",
        "https://fluffy-space-1234-5173.app.github.dev",
        "https://5173-myworkspace.ws-eu01.gitpod.io",
        "https://5173-cs-123.devpreview.example",
        "https://5173-abc.cluster.cloudworkstations.dev",
    ],
)
def test_rejects_disallowed_and_wildcard_suffix_origins(
    bad_origin: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("PROXY_ALLOWED_ORIGINS", raising=False)
    monkeypatch.delenv("WEB_HOST", raising=False)
    monkeypatch.delenv("CODESPACE_NAME", raising=False)
    assert not main._origin_allowed(bad_origin)
    assert not main._origin_allowed("http://localhost:5173\n")
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            "/ws/agent", headers={"origin": bad_origin}
        ) as ws:
            ws.send_text("probe")
            ws.receive_text()


def test_proxy_allowed_origins_override_has_zero_fallthrough(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PROXY_ALLOWED_ORIGINS", "https://workbench.internal.example")
    monkeypatch.setenv("CODESPACE_NAME", "my-space")
    monkeypatch.setenv("WEB_HOST", "my-host.devpreview.example")

    with client.websocket_connect(
        "/ws/agent", headers={"origin": "https://workbench.internal.example"}
    ) as ws:
        ws.send_text("not json")
        assert "malformed" in _recv_error_payload(ws)["message"]

    for rejected in (
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://my-space-5173.app.github.dev",
        "https://my-host.devpreview.example",
    ):
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(
                "/ws/agent", headers={"origin": rejected}
            ) as ws:
                ws.send_text("probe")
                ws.receive_text()


def test_single_workspace_codespace_and_web_host_origins_work_over_loopback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PROXY_ALLOWED_ORIGINS", raising=False)
    monkeypatch.setenv("CODESPACE_NAME", "team-demo-abc")
    monkeypatch.setenv("WEB_HOST", "5173-workspace.devpreview.example")

    for allowed_origin in (
        "https://team-demo-abc-5173.app.github.dev",
        "https://5173-workspace.devpreview.example",
    ):
        with client.websocket_connect(
            "/ws/agent", headers={"origin": allowed_origin}
        ) as ws:
            ws.send_text("not json")
            assert "malformed" in _recv_error_payload(ws)["message"]

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            "/ws/agent", headers={"origin": "https://attacker-xyz-5173.app.github.dev"}
        ) as ws:
            ws.receive_text()


# -- Server-Owned Persona Fixtures & Start Parameter Validation ---------------


def test_server_owned_personas_derive_first_name_and_deep_copy(
    persona_snapshots: dict[str, dict[str, Any]],
) -> None:
    for pid in ("chloe", "david", "tom", "sarah"):
        built_a = build_session_variables(ClientStart(type="start", persona=pid))
        assert built_a["persona_id"] == pid
        assert built_a["first_name"] == persona_snapshots[pid]["user"]["first_name"]
        assert built_a["demo_date"] == "2026-11-24"
        assert built_a["time_of_day"] == "afternoon"
        assert built_a["customer_snapshot"] == persona_snapshots[pid]

        # Mutating returned snapshot must never mutate cached server fixture
        built_a["customer_snapshot"]["user"]["first_name"] = "Mutated"
        built_b = build_session_variables(
            ClientStart(
                type="start",
                persona=pid,
                timeOfDay="morning",
                demoDate="2026-12-01",
            )
        )
        assert built_b["first_name"] == persona_snapshots[pid]["user"]["first_name"]
        assert built_b["time_of_day"] == "morning"
        assert built_b["demo_date"] == "2026-12-01"


@pytest.mark.parametrize(
    "bad_date",
    [
        "2026-11-24\n",
        "\u0662\u0660\u0662\u0666-\u0661\u0661-\u0662\u0664",
        "2026-02-30",
        "2026-13-01",
        "2026-11-4",
        "1999-12-31",
        "2101-01-01",
    ],
)
def test_rejects_invalid_demo_date_without_leaking_schema_internals(
    bad_date: str,
) -> None:
    with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}) as ws:
        ws.send_text(
            json.dumps({"type": "start", "persona": "chloe", "demoDate": bad_date})
        )
        err = _recv_error_payload(ws)
    assert err == {"type": "error", "message": "invalid demoDate", "field": "demoDate"}


def test_validate_persona_snapshot_rejects_adversarial_mutations(
    persona_snapshots: dict[str, dict[str, Any]],
) -> None:
    def _mut(fn: Any) -> dict[str, Any]:
        snap = copy.deepcopy(persona_snapshots["chloe"])
        fn(snap)
        return snap

    adversarial_cases: list[Any] = [
        "not-an-object",
        _mut(lambda s: s.update({"injected": True})),
        _mut(lambda s: s["user"].pop("first_name")),
        _mut(lambda s: s["user"].update({"first_name": "Chloe\n"})),
        _mut(lambda s: s["user"].update({"first_name": "<img src=x>"})),
        _mut(lambda s: s["user"].update({"location": "Manchester\x07"})),
        _mut(lambda s: s["user"].update({"email": "chloe@evil.com"})),
        _mut(lambda s: s["user"].update({"age": 12})),
        _mut(lambda s: s["accounts"]["current"].update({"sort_code": "04-00-75\n"})),
        _mut(lambda s: s["accounts"]["current"].update({"balance_pence": 4250.5})),
        _mut(lambda s: s["accounts"]["savings"].update({"goal_name": "x" * 121})),
        _mut(lambda s: s["accounts"]["savings"].update({"aer_bps": -1})),
        _mut(lambda s: s["accounts"]["mortgage"].update({"fixed_until": "2027-02-29"})),
        _mut(lambda s: s["transactions"][0].update({"vendor": "Tesco<script>"})),
    ]

    schema_valid_oversize = _mut(
        lambda s: s.__setitem__(
            "transactions",
            [
                {
                    "id": f"txn-oversize-{i:03d}",
                    "month_offset": 0,
                    "day": 1,
                    "vendor": "M" * 115,
                    "category": "shopping",
                    "amount_pence": 100,
                }
                for i in range(245)
            ],
        )
    )
    assert main._snapshot_validator().is_valid(schema_valid_oversize)
    adversarial_cases.append(schema_valid_oversize)

    for bad_snap in adversarial_cases:
        with pytest.raises(main.VariableValidationError) as exc_info:
            validate_persona_snapshot(bad_snap, persona="chloe")
        assert exc_info.value.field == "customer_snapshot"


# -- Session Binding, Resume, and Bounded TTL Map -----------------------------


def test_session_binding_resume_and_persona_swap_rejection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_valid_gcp_env(monkeypatch)
    captured_upstream_frames: list[dict[str, Any]] = []
    injected_upstream_frames: list[str] = []

    class CapturingUpstream:
        async def __aenter__(self) -> CapturingUpstream:
            return self

        async def __aexit__(self, *_exc: object) -> bool:
            return False

        async def send(self, raw: str) -> None:
            captured_upstream_frames.append(json.loads(raw))

        def __aiter__(self) -> CapturingUpstream:
            return self

        async def __anext__(self) -> str:
            if injected_upstream_frames:
                return injected_upstream_frames.pop(0)
            raise StopAsyncIteration

        async def close(self) -> None:
            pass

    async def ok_token() -> str:
        return "tok-eu"

    monkeypatch.setattr(main._tokens, "get_token", ok_token)
    monkeypatch.setattr(main.websockets, "connect", lambda *_a, **_kw: CapturingUpstream())

    # 1. Malformed sessionId values are rejected before opening upstream
    for hostile in (
        "../../../other-project/sessions/steal",
        "not-a-uuid",
        "3f1c8a2e-9b47-4d6a-8e21-5c7b0d9f4a13\n",
        "{3f1c8a2e-9b47-4d6a-8e21-5c7b0d9f4a13}",
    ):
        with client.websocket_connect(
            "/ws/agent", headers={"origin": DEFAULT_ORIGIN}
        ) as ws:
            ws.send_text(
                json.dumps({"type": "start", "persona": "chloe", "sessionId": hostile})
            )
            err = _recv_error_payload(ws)
        assert err == {
            "type": "error",
            "message": "invalid sessionId",
            "field": "sessionId",
        }
    assert captured_upstream_frames == []

    # 2. Fresh session seeds server-owned variables and binds sessionId -> chloe
    with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}) as ws:
        ws.send_text(json.dumps({"type": "start", "persona": "chloe"}))
        ready = json.loads(ws.receive_text())
    sid = ready["sessionId"]
    assert uuid.UUID(sid)
    assert len(captured_upstream_frames) == 2
    assert "config" in captured_upstream_frames[0]
    assert (
        captured_upstream_frames[1]["realtimeInput"]["variables"]["first_name"]
        == "Chloe"
    )
    assert main._session_personas[sid] == "chloe"

    # 3. Resuming the bound sessionId with a DIFFERENT persona is rejected cleanly
    captured_upstream_frames.clear()
    with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}) as ws:
        ws.send_text(
            json.dumps({"type": "start", "persona": "david", "sessionId": sid})
        )
        swap_err = _recv_error_payload(ws)
    assert swap_err == {
        "type": "error",
        "message": "sessionId bound to a different persona",
        "field": "sessionId",
    }
    assert captured_upstream_frames == []

    # 4. Resuming with the SAME persona skips variable re-seeding and preserves lastUiSeq
    injected_upstream_frames.extend(
        [
            json.dumps(
                {
                    "sessionOutput": {
                        "turnCompleted": True,
                        "diagnosticInfo": {
                            "messages": [
                                {
                                    "chunks": [
                                        {
                                            "updatedVariables": {
                                                "ui_view_state": {
                                                    "seq": 3.0,
                                                    "page": "spending",
                                                }
                                            }
                                        }
                                    ]
                                }
                            ]
                        },
                    }
                }
            ),
            json.dumps(
                {"sessionOutput": {"payload": {"seq": 4, "page": "mortgage"}}}
            ),
        ]
    )
    with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}) as ws:
        ws.send_text(
            json.dumps(
                {
                    "type": "start",
                    "persona": "chloe",
                    "sessionId": sid.upper(),
                    "lastUiSeq": 3,
                }
            )
        )
        resumed_msgs = [
            json.loads(ws.receive_text()),
            json.loads(ws.receive_text()),
            json.loads(ws.receive_text()),
        ]
    assert len(captured_upstream_frames) == 1
    assert "config" in captured_upstream_frames[0]
    assert resumed_msgs[0] == {"type": "ready", "sessionId": sid}
    assert resumed_msgs[1] == {"type": "turn_complete"}
    assert resumed_msgs[2] == {
        "type": "ui_state",
        "tier": 1,
        "state": {"seq": 4, "page": "mortgage"},
    }


def test_session_binding_map_enforces_lru_cap_and_ttl() -> None:
    base_time = 1000.0
    first_sid = str(uuid.uuid4())
    main._record_session_binding(first_sid, "chloe", now=base_time)

    for _ in range(main.MAX_TRACKED_SESSIONS):
        main._record_session_binding(str(uuid.uuid4()), "david", now=base_time + 1.0)

    assert len(main._session_personas) == main.MAX_TRACKED_SESSIONS
    assert first_sid not in main._session_personas

    # Expired TTL bindings are pruned automatically
    expiring_sid = str(uuid.uuid4())
    main._record_session_binding(expiring_sid, "chloe", now=2000.0)
    resolved, is_resume = main._validate_session_id_and_persona(
        expiring_sid,
        "tom",
        now=2000.0 + main.SESSION_BINDING_TTL_SECONDS + 1.0,
    )
    assert resolved == expiring_sid
    assert is_resume is True


# -- Binary Frames (1003), UTF-8 Byte Cap & Concurrent Semaphore Cap ----------


def test_binary_frames_close_with_1003_and_oversized_utf8_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 1. Binary frame sent before start handshake closes cleanly with 1003 (zero KeyError)
    with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}) as ws:
        ws.send_bytes(b"\x00\x01\x02\x03")
        err = _recv_error_payload(ws)
        assert "binary" in err["message"]
        with pytest.raises(WebSocketDisconnect) as close_exc:
            ws.receive_text()
        assert close_exc.value.code == 1003

    # 2. Binary frame sent mid-session after ready also closes cleanly with 1003
    _set_valid_gcp_env(monkeypatch)
    upstream_closed = asyncio.Event()

    class HoldingUpstream:
        async def __aenter__(self) -> HoldingUpstream:
            return self

        async def __aexit__(self, *_exc: object) -> bool:
            return False

        async def send(self, _raw: str) -> None:
            pass

        def __aiter__(self) -> HoldingUpstream:
            return self

        async def __anext__(self) -> str:
            await upstream_closed.wait()
            raise StopAsyncIteration

        async def close(self) -> None:
            upstream_closed.set()

    async def ok_token() -> str:
        return "tok-1"

    monkeypatch.setattr(main._tokens, "get_token", ok_token)
    monkeypatch.setattr(main.websockets, "connect", lambda *_a, **_kw: HoldingUpstream())

    with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}) as ws:
        ws.send_text(json.dumps({"type": "start", "persona": "chloe"}))
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_bytes(b"\xff\xfe\xfd\xfc")
        mid_err = _recv_error_payload(ws)
        assert "binary" in mid_err["message"]
        with pytest.raises(WebSocketDisconnect) as close_exc:
            ws.receive_text()
        assert close_exc.value.code == 1003

    # 3. Multi-byte UTF-8 frame under code-point count but over 1 MiB UTF-8 byte cap is rejected
    multi_byte_oversized = "\U0001f600" * ((MAX_CLIENT_FRAME_BYTES // 4) + 10)
    assert len(multi_byte_oversized) < MAX_CLIENT_FRAME_BYTES
    assert len(multi_byte_oversized.encode("utf-8")) > MAX_CLIENT_FRAME_BYTES
    with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}) as ws:
        ws.send_text(multi_byte_oversized)
        assert "too large" in _recv_error_payload(ws)["message"]
        with pytest.raises(WebSocketDisconnect) as close_exc:
            ws.receive_text()
        assert close_exc.value.code == 1008


@pytest.mark.asyncio
async def test_concurrent_websocket_upgrades_enforce_semaphore_cap_without_race(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Invalid PROXY_MAX_SESSIONS values fall back safely without crashing
    for invalid_val in ("invalid", "0", "-5"):
        monkeypatch.setenv("PROXY_MAX_SESSIONS", invalid_val)
        assert main._max_concurrent_sessions() == main.DEFAULT_MAX_SESSIONS

    monkeypatch.setenv("PROXY_MAX_SESSIONS", "2")
    monkeypatch.setenv("PROXY_START_TIMEOUT_SECONDS", "5.0")
    main._get_session_semaphore()

    release_holders = asyncio.Event()
    active_inside_run = 0
    peak_inside_run = 0
    two_active = asyncio.Event()

    async def fake_run_session(_ws: Any) -> None:
        nonlocal active_inside_run, peak_inside_run
        active_inside_run += 1
        peak_inside_run = max(peak_inside_run, active_inside_run)
        if active_inside_run == 2:
            two_active.set()
        try:
            await release_holders.wait()
        finally:
            active_inside_run -= 1

    monkeypatch.setattr(main, "_run_session", fake_run_session)

    async def open_asgi_ws() -> list[dict[str, Any]]:
        sent: list[dict[str, Any]] = []
        inbox: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        await inbox.put({"type": "websocket.connect"})

        scope: dict[str, Any] = {
            "type": "websocket",
            "asgi": {"version": "3.0"},
            "scheme": "ws",
            "path": "/ws/agent",
            "raw_path": b"/ws/agent",
            "query_string": b"",
            "headers": [
                (b"host", b"localhost:8765"),
                (b"origin", DEFAULT_ORIGIN.encode("ascii")),
            ],
            "client": ("127.0.0.1", 50000),
            "subprotocols": [],
        }

        async def receive() -> Message:
            return await inbox.get()

        async def send(msg: Message) -> None:
            # Yield at websocket.accept to maximize race window across tasks
            await asyncio.sleep(0)
            sent.append(dict(msg))

        await app(scope, receive, send)
        return sent

    tasks = [asyncio.create_task(open_asgi_ws()) for _ in range(6)]
    await asyncio.wait_for(two_active.wait(), timeout=1.0)
    await asyncio.sleep(0.03)
    release_holders.set()
    results = await asyncio.gather(*tasks)

    assert peak_inside_run == 2
    busy_count = sum(
        1
        for events in results
        if any(
            e.get("type") == "websocket.send"
            and "too many active sessions" in str(e.get("text", ""))
            for e in events
        )
    )
    assert busy_count == 4
    assert main._active_session_count == 0
    assert not main._get_session_semaphore().locked()


def test_start_frame_timeout_releases_session_slot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PROXY_START_TIMEOUT_SECONDS", raising=False)
    assert main.DEFAULT_START_TIMEOUT_SECONDS == 10.0
    assert main._start_timeout_seconds() == 10.0

    for bad_float in ("not-a-float", "nan", "inf", "-2.5", "0"):
        monkeypatch.setenv("PROXY_MAX_IDLE_SECONDS", bad_float)
        assert main._max_idle_seconds() == main.DEFAULT_MAX_IDLE_SECONDS
        monkeypatch.setenv("PROXY_KEEPALIVE_SECONDS", bad_float)
        assert main._keepalive_seconds() == main.DEFAULT_KEEPALIVE_SECONDS

    monkeypatch.setenv("PROXY_START_TIMEOUT_SECONDS", "0.05")
    with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}) as ws:
        err = _recv_error_payload(ws)
        with pytest.raises(WebSocketDisconnect) as close_exc:
            ws.receive_text()
        assert close_exc.value.code == 1008
    assert "timed out waiting for start frame" in err["message"]
    assert main._active_session_count == 0
    assert not main._get_session_semaphore().locked()


# -- GCP Resource Regex Validation, Env Overrides & Real Loopback WS ----------


def test_gcp_resource_env_overrides_and_regex_validation(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # 1. Env overrides succeed without needing gecx-config.json on disk
    missing_cfg = tmp_path / "absent.json"
    monkeypatch.setenv("GECX_CONFIG", str(missing_cfg))
    monkeypatch.setenv("CLOUDBANK_GCP_PROJECT_ID", "my-bank-proj-01")
    monkeypatch.delenv("CLOUDBANK_LOCATION", raising=False)
    monkeypatch.setenv("CLOUDBANK_APP_ID", "app_abc-123")
    resource, loc = main._load_app_resource()
    assert loc == "eu"
    assert resource == "projects/my-bank-proj-01/locations/eu/apps/app_abc-123"

    # 2. Config file loading + env partial override
    cfg_file = tmp_path / "gecx-config.json"
    cfg_file.write_text(
        json.dumps(
            {
                "gcp_project_id": "cfg-project-01",
                "location": "us-central1",
                "deployed_app_id": "cfg-app-99",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("GECX_CONFIG", str(cfg_file))
    monkeypatch.delenv("CLOUDBANK_GCP_PROJECT_ID", raising=False)
    monkeypatch.delenv("CLOUDBANK_APP_ID", raising=False)
    assert main._load_app_resource() == (
        "projects/cfg-project-01/locations/us-central1/apps/cfg-app-99",
        "us-central1",
    )

    # 3. Placeholders and traversal strings rejected by regex validation
    bad_configs = [
        {"gcp_project_id": "<your-gcp-project-id>", "location": "eu", "deployed_app_id": "app-1"},
        {"gcp_project_id": "UpperCaseProj", "location": "eu", "deployed_app_id": "app-1"},
        {"gcp_project_id": "ab", "location": "eu", "deployed_app_id": "app-1"},
        {"gcp_project_id": "valid-proj-1", "location": "eu/../../evil", "deployed_app_id": "app-1"},
        {"gcp_project_id": "valid-proj-1", "location": "eu", "deployed_app_id": "<your-deployed-app-uuid>"},
        {"gcp_project_id": "valid-proj-1", "location": "eu", "deployed_app_id": "../escape"},
    ]
    for bad in bad_configs:
        cfg_file.write_text(json.dumps(bad), encoding="utf-8")
        with pytest.raises(ValueError):
            main._load_app_resource()


def test_real_loopback_websockets_server_handshake_and_sanitized_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_valid_gcp_env(monkeypatch)
    monkeypatch.setattr(main._tokens, "get_token", _async_return("tok-live"))

    real_connect = websockets.connect

    # Run real server on a background thread event loop while TestClient exercises FastAPI
    import threading

    received_headers: dict[str, str] = {}
    upstream_received: list[dict[str, Any]] = []
    port_box: list[int] = []
    port_ready = threading.Event()
    stop_server = threading.Event()

    def _server_thread(mode: str) -> None:
        async def _serve() -> None:
            async def process_request(
                _conn: websockets.asyncio.server.ServerConnection,
                _req: websockets.http11.Request,
            ) -> websockets.http11.Response | None:
                if mode == "reject_403":
                    return websockets.http11.Response(
                        int(http.HTTPStatus.FORBIDDEN),
                        "Forbidden",
                        websockets.datastructures.Headers(),
                        b"internal-iam-policy-secret-detail",
                    )
                return None

            async def ws_handler(
                conn: websockets.asyncio.server.ServerConnection,
            ) -> None:
                if mode == "abnormal_close":
                    await conn.recv()
                    await conn.recv()
                    await conn.close(code=1011, reason="internal-stacktrace-secret-detail")
                    return
                if conn.request is not None:
                    for k, v in conn.request.headers.items():
                        received_headers[k.lower()] = v
                upstream_received.append(json.loads(await conn.recv()))
                upstream_received.append(json.loads(await conn.recv()))
                upstream_received.append(json.loads(await conn.recv()))
                await conn.send(
                    json.dumps(
                        {
                            "sessionOutput": {
                                "text": "Hello Chloe!",
                                "turnCompleted": True,
                                "turnIndex": 1,
                            }
                        }
                    )
                )

            async with websockets.asyncio.server.serve(
                ws_handler,
                "127.0.0.1",
                0,
                process_request=process_request,
            ) as srv:
                port_box.append(srv.sockets[0].getsockname()[1])
                port_ready.set()
                while not stop_server.is_set():
                    await asyncio.sleep(0.02)

        asyncio.run(_serve())

    # Subtest A: Happy-path real TCP WebSocket relay
    t_ok = threading.Thread(target=_server_thread, args=("happy",), daemon=True)
    t_ok.start()
    assert port_ready.wait(timeout=2.0)
    live_port = port_box[-1]
    monkeypatch.setattr(
        main.websockets,
        "connect",
        lambda _url, **kw: real_connect(f"ws://127.0.0.1:{live_port}/ws", **kw),
    )
    try:
        with client.websocket_connect(
            "/ws/agent", headers={"origin": DEFAULT_ORIGIN}
        ) as ws:
            ws.send_text(json.dumps({"type": "start", "persona": "chloe"}))
            assert json.loads(ws.receive_text())["type"] == "ready"
            ws.send_text(json.dumps({"type": "text", "text": "Check balance"}))
            reply_text = json.loads(ws.receive_text())
            reply_done = json.loads(ws.receive_text())
        assert reply_text == {"type": "text", "text": "Hello Chloe!", "partial": False}
        assert reply_done == {"type": "turn_complete", "turnIndex": 1}
        assert received_headers["authorization"] == "Bearer tok-live"
        assert received_headers["x-goog-user-project"] == "cloudbank-demo-01"
        assert upstream_received[1]["realtimeInput"]["variables"]["first_name"] == "Chloe"
        assert upstream_received[2] == {"realtimeInput": {"text": "Check balance"}}
    finally:
        stop_server.set()
        t_ok.join(timeout=2.0)

    # Subtest B: Real HTTP 403 InvalidStatus -> sanitized error message (no status/body leak)
    port_box.clear()
    port_ready.clear()
    stop_server.clear()
    t_403 = threading.Thread(target=_server_thread, args=("reject_403",), daemon=True)
    t_403.start()
    assert port_ready.wait(timeout=2.0)
    port_403 = port_box[-1]
    monkeypatch.setattr(
        main.websockets,
        "connect",
        lambda _url, **kw: real_connect(f"ws://127.0.0.1:{port_403}/ws", **kw),
    )
    try:
        with client.websocket_connect(
            "/ws/agent", headers={"origin": DEFAULT_ORIGIN}
        ) as ws:
            ws.send_text(json.dumps({"type": "start", "persona": "chloe"}))
            err_403 = _recv_error_payload(ws)
            with pytest.raises(WebSocketDisconnect) as close_exc:
                ws.receive_text()
            assert close_exc.value.code == 1011
        assert err_403 == {"type": "error", "message": "upstream connection rejected"}
        assert "403" not in err_403["message"]
        assert "secret" not in err_403["message"]
    finally:
        stop_server.set()
        t_403.join(timeout=2.0)

    # Subtest C: Real abnormal upstream close (1011 with internal reason) -> sanitized error
    port_box.clear()
    port_ready.clear()
    stop_server.clear()
    t_close = threading.Thread(
        target=_server_thread, args=("abnormal_close",), daemon=True
    )
    t_close.start()
    assert port_ready.wait(timeout=2.0)
    port_close = port_box[-1]
    monkeypatch.setattr(
        main.websockets,
        "connect",
        lambda _url, **kw: real_connect(f"ws://127.0.0.1:{port_close}/ws", **kw),
    )
    try:
        with client.websocket_connect(
            "/ws/agent", headers={"origin": DEFAULT_ORIGIN}
        ) as ws:
            ws.send_text(json.dumps({"type": "start", "persona": "chloe"}))
            ready_first = json.loads(ws.receive_text())
            assert ready_first["type"] == "ready"
            err_closed = _recv_error_payload(ws)
            with pytest.raises(WebSocketDisconnect) as close_exc:
                ws.receive_text()
            assert close_exc.value.code == 1011
        assert err_closed == {
            "type": "error",
            "message": "upstream connection closed unexpectedly",
        }
        assert "secret" not in err_closed["message"]
        assert "1011" not in err_closed["message"]
    finally:
        stop_server.set()
        t_close.join(timeout=2.0)


def _async_return(value: str) -> Any:
    async def _fn() -> str:
        return value

    return _fn


def test_config_auth_network_and_farewell_drop_errors_reported_safely(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    valid_start = json.dumps({"type": "start", "persona": "chloe"})

    def missing_cfg() -> tuple[str, str]:
        raise FileNotFoundError("/home/secret/gecx-config.json")

    monkeypatch.setattr(main, "_load_app_resource", missing_cfg)
    with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}) as ws:
        ws.send_text(valid_start)
        msg = _recv_error_payload(ws)["message"]
        with pytest.raises(WebSocketDisconnect) as close_exc:
            ws.receive_text()
        assert close_exc.value.code == 1011
    assert msg == "server configuration error"
    assert "secret" not in msg

    monkeypatch.setattr(
        main,
        "_load_app_resource",
        lambda: ("projects/cloudbank-demo-01/locations/eu/apps/app-1", "eu"),
    )

    async def bad_token() -> str:
        raise RuntimeError("ADC broken")

    monkeypatch.setattr(main._tokens, "get_token", bad_token)
    with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}) as ws:
        ws.send_text(valid_start)
        assert _recv_error_payload(ws)["message"] == "server authentication error"
        with pytest.raises(WebSocketDisconnect) as close_exc:
            ws.receive_text()
        assert close_exc.value.code == 1011

    monkeypatch.setattr(main._tokens, "get_token", _async_return("tok-1"))
    monkeypatch.setattr(
        main.websockets,
        "connect",
        lambda *_a, **_kw: (_ for _ in ()).throw(OSError("connection refused")),
    )
    with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}) as ws:
        ws.send_text(valid_start)
        assert _recv_error_payload(ws)["message"] == "could not reach upstream"
        with pytest.raises(WebSocketDisconnect) as close_exc:
            ws.receive_text()
        assert close_exc.value.code == 1011

    # Held ServerEnd still arrives over /ws/agent when upstream drops after farewell audio + endSession
    class FarewellDroppingUpstream:
        def __init__(self) -> None:
            self._frames = [
                json.dumps({"sessionOutput": {"audio": EVEN_PCM_B64}}),
                json.dumps({"endSession": {}}),
            ]

        async def __aenter__(self) -> FarewellDroppingUpstream:
            return self

        async def __aexit__(self, *_exc: object) -> bool:
            return False

        async def send(self, _raw: str) -> None:
            pass

        def __aiter__(self) -> FarewellDroppingUpstream:
            return self

        async def __anext__(self) -> str:
            if self._frames:
                return self._frames.pop(0)
            raise websockets.exceptions.ConnectionClosedError(None, None)

        async def close(self) -> None:
            pass

    monkeypatch.setattr(
        main.websockets, "connect", lambda *_a, **_kw: FarewellDroppingUpstream()
    )
    with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}) as ws:
        ws.send_text(valid_start)
        received = [
            json.loads(ws.receive_text())["type"],
            json.loads(ws.receive_text())["type"],
            json.loads(ws.receive_text())["type"],
        ]
    assert received == ["ready", "audio", "end"]


def test_cli_entrypoint_binds_loopback_8765_with_1mib_ws_max_size(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PROXY_HOST", raising=False)
    monkeypatch.delenv("PROXY_PORT", raising=False)

    with patch("proxy.__main__.uvicorn.run") as mock_run:
        cli_entry.main()

    mock_run.assert_called_once_with(
        "proxy.main:app",
        host="127.0.0.1",
        port=8765,
        ws_max_size=1_048_576,
    )

    assert cli_entry._parse_port("8080") == 8080
    assert cli_entry._parse_port("invalid") == 8765
    assert cli_entry._parse_port("70000") == 8765
