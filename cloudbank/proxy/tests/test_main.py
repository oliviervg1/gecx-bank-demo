"""Security, Origin allowlist, seed-variable validation, and error-envelope tests for main.py."""
from __future__ import annotations

import copy
import json
import uuid
from typing import Any

import pytest
import websockets.exceptions
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from conftest import DEFAULT_ORIGIN, make_seed_variables
from proxy import main
from proxy.main import CLIENT_SEEDABLE_VARIABLES, _resolve_session_id, app

client = TestClient(app)


def _recv_error_payload(ws: Any) -> dict[str, Any]:
    payload = json.loads(ws.receive_text())
    assert payload["type"] == "error"
    return payload


def test_health_and_ws_route_registered() -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
    assert "/ws/agent" in [r.path for r in app.routes]


def test_client_seedable_variables_exact_five_keys() -> None:
    assert CLIENT_SEEDABLE_VARIABLES == frozenset(
        {
            "persona_id",
            "first_name",
            "demo_date",
            "time_of_day",
            "customer_snapshot",
        }
    )


def test_resolve_session_id_validates_strict_uuid() -> None:
    valid = "3f1c8a2e-9b47-4d6a-8e21-5c7b0d9f4a13"
    assert _resolve_session_id(valid) == valid
    assert uuid.UUID(_resolve_session_id(None))

    for hostile in (
        "../../../other-project/sessions/steal",
        "not-a-uuid",
        "",
        f"{valid}\n",
        f"{valid}/../evil",
        "3f1c8a2e_9b47_4d6a_8e21_5c7b0d9f4a13",
        "{3f1c8a2e-9b47-4d6a-8e21-5c7b0d9f4a13}",
    ):
        resolved = _resolve_session_id(hostile)
        assert resolved != hostile
        assert uuid.UUID(resolved)


# ── Strict CSWSH Origin Validation ──────────────────────────────────────────


def test_rejects_missing_or_empty_origin() -> None:
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/agent") as ws:
            ws.receive_text()

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/agent", headers={"origin": ""}) as ws:
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
        "https://5173-cs-123.cloudshell.dev",
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
            ws.receive_text()


def test_proxy_allowed_origins_override_has_zero_fallthrough(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PROXY_ALLOWED_ORIGINS", "https://workbench.internal.example")
    monkeypatch.setenv("CODESPACE_NAME", "my-space")
    monkeypatch.setenv("WEB_HOST", "my-host.cloudworkstations.dev")

    # Exact override origin allowed
    with client.websocket_connect(
        "/ws/agent", headers={"origin": "https://workbench.internal.example"}
    ) as ws:
        ws.send_text("not json")
        assert "malformed" in _recv_error_payload(ws)["message"]

    # Default localhost and Codespace/WEB_HOST fallthroughs MUST be rejected
    for rejected in (
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://my-space-5173.app.github.dev",
        "https://my-host.cloudworkstations.dev",
    ):
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(
                "/ws/agent", headers={"origin": rejected}
            ) as ws:
                ws.receive_text()


def test_single_workspace_codespace_origin_excludes_other_workspaces(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PROXY_ALLOWED_ORIGINS", raising=False)
    monkeypatch.setenv("CODESPACE_NAME", "team-demo-abc")

    with client.websocket_connect(
        "/ws/agent", headers={"origin": "https://team-demo-abc-5173.app.github.dev"}
    ) as ws:
        ws.send_text("not json")
        assert "malformed" in _recv_error_payload(ws)["message"]

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            "/ws/agent", headers={"origin": "https://attacker-xyz-5173.app.github.dev"}
        ) as ws:
            ws.receive_text()


# ── Strict 5-Key Seed Variable Validation & R4 Adversarial Probes ───────────


def test_rejects_unknown_or_missing_seed_variables_with_field_error(
    persona_snapshots: dict[str, dict[str, Any]],
) -> None:
    # Unknown extra key is REJECTED (never silently dropped)
    vars_with_extra = make_seed_variables(persona_snapshots, "chloe")
    vars_with_extra["target_agent"] = "mortgage_agent"
    with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}) as ws:
        ws.send_text(
            json.dumps({"type": "start", "persona": "chloe", "variables": vars_with_extra})
        )
        err = _recv_error_payload(ws)
    assert err["field"] == "target_agent"
    assert "target_agent" in err["message"]

    # Missing required key is REJECTED naming the missing field
    for key in sorted(CLIENT_SEEDABLE_VARIABLES):
        incomplete = make_seed_variables(persona_snapshots, "chloe")
        del incomplete[key]
        with client.websocket_connect(
            "/ws/agent", headers={"origin": DEFAULT_ORIGIN}
        ) as ws:
            ws.send_text(
                json.dumps({"type": "start", "persona": "chloe", "variables": incomplete})
            )
            err = _recv_error_payload(ws)
        assert err["field"] == key
        assert key in err["message"]


@pytest.mark.parametrize(
    ("field_name", "bad_value"),
    [
        ("persona_id", "david"),  # mismatches start.persona="chloe"
        ("persona_id", "chloe\n"),
        ("persona_id", "unknown"),
        ("first_name", ""),
        ("first_name", "Chloe\n"),
        ("first_name", "Chloe\t"),
        ("first_name", "Chloe<script>"),
        ("first_name", "1Chloe"),
        ("first_name", "Chloe\u0661"),  # Arabic-Indic digit
        ("first_name", "x" * 61),
        ("demo_date", "2026-11-24\n"),
        ("demo_date", "\u0662\u0660\u0662\u0666-\u0661\u0661-\u0662\u0664"),  # non-ASCII digits
        ("demo_date", "2026-02-30"),
        ("demo_date", "2026-13-01"),
        ("demo_date", "2026-11-4"),
        ("demo_date", "1999-12-31"),
        ("time_of_day", "afternoon\n"),
        ("time_of_day", "midnight"),
        ("time_of_day", 12),
    ],
)
def test_scalar_seed_variables_reject_adversarial_inputs(
    field_name: str,
    bad_value: Any,
    persona_snapshots: dict[str, dict[str, Any]],
) -> None:
    seed = make_seed_variables(persona_snapshots, "chloe")
    seed[field_name] = bad_value
    with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}) as ws:
        ws.send_text(json.dumps({"type": "start", "persona": "chloe", "variables": seed}))
        err = _recv_error_payload(ws)
    assert err["field"] == field_name
    assert field_name in err["message"]


def test_customer_snapshot_accepts_all_four_real_fixtures_and_rejects_adversarial_mutations(
    persona_snapshots: dict[str, dict[str, Any]],
) -> None:
    for pid in ("chloe", "david", "tom", "sarah"):
        valid = make_seed_variables(persona_snapshots, pid)
        cleaned = main.validate_seed_variables(valid, expected_persona=pid)  # type: ignore[arg-type]
        assert cleaned["persona_id"] == pid

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
        _mut(lambda s: s["user"].update({"email": "chloe@example.com\n"})),
        _mut(lambda s: s["user"].update({"age": 12})),
        _mut(lambda s: s["accounts"]["current"].update({"sort_code": "04-00-75\n"})),
        _mut(
            lambda s: s["accounts"]["current"].update(
                {"sort_code": "\u0660\u0664-\u0660\u0660-\u0667\u0665"}
            )
        ),
        _mut(
            lambda s: s["accounts"]["current"].update(
                {"account_number_last4": "\u0664\u0668\u0662\u0661"}
            )
        ),
        _mut(lambda s: s["accounts"]["current"].update({"balance_pence": 4250.5})),
        _mut(lambda s: s["accounts"]["savings"].update({"goal_name": "x" * 121})),
        _mut(lambda s: s["accounts"]["savings"].update({"aer_bps": -1})),
        _mut(lambda s: s["accounts"]["mortgage"].update({"fixed_until": "2027-02-29"})),
        _mut(lambda s: s["accounts"]["mortgage"].update({"fixed_until": "2027-09-30\n"})),
        _mut(lambda s: s["transactions"][0].update({"id": "txn-1\n"})),
        _mut(lambda s: s["transactions"][0].update({"vendor": "Tesco<script>"})),
        _mut(
            lambda s: s["transactions"].extend(
                [
                    {
                        "id": f"txn-pad-{i}",
                        "month_offset": 0,
                        "day": 1,
                        "vendor": "Padding Merchant Name For 32KB Cap Check",
                        "category": "shopping",
                        "amount_pence": 100,
                    }
                    for i in range(400)
                ]
            )
        ),
    ]

    for idx, bad_snap in enumerate(adversarial_cases):
        seed = make_seed_variables(persona_snapshots, "chloe")
        seed["customer_snapshot"] = bad_snap
        with client.websocket_connect(
            "/ws/agent", headers={"origin": DEFAULT_ORIGIN}
        ) as ws:
            ws.send_text(
                json.dumps({"type": "start", "persona": "chloe", "variables": seed})
            )
            err = _recv_error_payload(ws)
        assert err["field"] == "customer_snapshot", f"Case #{idx} failed: {err}"
        assert "customer_snapshot" in err["message"]


# ── Inbound Frame, Config, Auth, Session Cap & Upstream Error Handling ──────


def test_inbound_frame_errors_and_session_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}) as ws:
        ws.send_text('{"type":"nonsense"}')
        assert "malformed" in _recv_error_payload(ws)["message"]

    with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}) as ws:
        ws.send_text(json.dumps({"type": "audio", "data": "AAAA"}))
        assert "expected start frame" in _recv_error_payload(ws)["message"]

    with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}) as ws:
        ws.send_text("x" * (main.MAX_CLIENT_FRAME_BYTES + 1))
        assert "too large" in _recv_error_payload(ws)["message"]

    monkeypatch.setattr(main, "_active_sessions", main._MAX_CONCURRENT_SESSIONS)
    with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}) as ws:
        assert "too many active sessions" in _recv_error_payload(ws)["message"]


def test_config_auth_and_upstream_errors_reported_safely(
    monkeypatch: pytest.MonkeyPatch,
    persona_snapshots: dict[str, dict[str, Any]],
) -> None:
    valid_start = json.dumps(
        {
            "type": "start",
            "persona": "chloe",
            "variables": make_seed_variables(persona_snapshots, "chloe"),
        }
    )

    def missing_cfg() -> tuple[str, str]:
        raise FileNotFoundError("/home/secret/gecx-config.json")

    monkeypatch.setattr(main, "_load_app_resource", missing_cfg)
    with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}) as ws:
        ws.send_text(valid_start)
        msg = _recv_error_payload(ws)["message"]
    assert msg == "server configuration error"
    assert "secret" not in msg

    monkeypatch.setattr(
        main, "_load_app_resource", lambda: ("projects/p/locations/eu/apps/a", "eu")
    )

    async def bad_token() -> str:
        raise RuntimeError("ADC broken")

    monkeypatch.setattr(main._tokens, "get_token", bad_token)
    with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}) as ws:
        ws.send_text(valid_start)
        assert _recv_error_payload(ws)["message"] == "server authentication error"

    async def ok_token() -> str:
        return "tok-1"

    monkeypatch.setattr(main._tokens, "get_token", ok_token)

    class FakeResp:
        status_code = 403

    monkeypatch.setattr(
        main.websockets,
        "connect",
        lambda *_a, **_kw: (_ for _ in ()).throw(
            websockets.exceptions.InvalidStatus(FakeResp())
        ),
    )
    with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}) as ws:
        ws.send_text(valid_start)
        assert "403" in _recv_error_payload(ws)["message"]

    monkeypatch.setattr(
        main.websockets,
        "connect",
        lambda *_a, **_kw: (_ for _ in ()).throw(
            websockets.exceptions.ConnectionClosedError(None, None)
        ),
    )
    with client.websocket_connect("/ws/agent", headers={"origin": DEFAULT_ORIGIN}) as ws:
        ws.send_text(valid_start)
        assert "upstream closed" in _recv_error_payload(ws)["message"]
