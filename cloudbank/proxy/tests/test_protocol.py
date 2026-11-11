"""Tests for client/server protocol types and ws_protocol.schema.json conformance."""
from __future__ import annotations

import base64
import json
from typing import Any

import jsonschema
import pytest

from conftest import SHARED_DIR
from proxy import protocol
from proxy.protocol import (
    AudioFrame,
    ClientMsg,
    ClientStart,
    ClientStop,
    ClientText,
    ServerEnd,
    ServerError,
    ServerGoAway,
    ServerInterrupt,
    ServerMsg,
    ServerReady,
    ServerSearchSuggestions,
    ServerSessionExpired,
    ServerText,
    ServerTranscript,
    ServerTurnComplete,
    ServerTurnDiagnostics,
    ServerUiState,
    parse_client_msg,
    parse_server_msg,
    serialize_client_msg,
    serialize_server_msg,
)

WS_PROTOCOL_SCHEMA_PATH = SHARED_DIR / "ws_protocol.schema.json"


def _subschema_validator(definition: str) -> jsonschema.Draft7Validator:
    root_schema = json.loads(WS_PROTOCOL_SCHEMA_PATH.read_text(encoding="utf-8"))
    jsonschema.Draft7Validator.check_schema(root_schema)
    scoped: dict[str, Any] = {
        "$schema": root_schema["$schema"],
        "definitions": root_schema["definitions"],
        "$ref": f"#/definitions/{definition}",
    }
    return jsonschema.Draft7Validator(scoped)


def test_legacy_client_tool_messages_and_seed_variables_removed() -> None:
    assert "ClientToolResponse" not in vars(protocol)
    assert "ServerClientFunction" not in vars(protocol)
    assert "variables" not in ClientStart.model_fields
    assert "customer_snapshot" not in ClientStart.model_fields
    with pytest.raises(ValueError, match="unknown client message"):
        parse_client_msg('{"type":"tool_response","id":"tc_1","response":{"output":{}}}')


def test_every_client_msg_round_trips_and_validates_against_ws_protocol_schema() -> None:
    validator = _subschema_validator("ClientMsg")
    even_pcm_b64 = base64.b64encode(b"\x00\x01\x02\x03").decode("ascii")

    cases: list[ClientMsg] = [
        ClientStart(type="start", persona="chloe"),
        ClientStart(
            type="start",
            persona="david",
            timeOfDay="morning",
            demoDate="2026-11-24",
            sessionId="3f1c8a2e-9b47-4d6a-8e21-5c7b0d9f4a13",
            lastUiSeq=4,
        ),
        ClientStart(
            type="start",
            persona="tom",
            timeOfDay="evening",
            lastUiSeq=0,
        ),
        AudioFrame(type="audio", data=even_pcm_b64),
        ClientText(type="text", text="How much did I spend this month?"),
        ClientStop(type="stop"),
    ]

    for msg in cases:
        raw = serialize_client_msg(msg)
        decoded = json.loads(raw)
        validator.validate(decoded)
        round_tripped = parse_client_msg(raw)
        assert round_tripped == msg


def test_every_server_msg_round_trips_and_validates_against_ws_protocol_schema() -> None:
    validator = _subschema_validator("ServerMsg")
    even_pcm_b64 = base64.b64encode(b"\x00\x00\x01\x00").decode("ascii")

    cases: list[ tuple[ServerMsg, dict[str, Any]] ] = [
        (ServerReady(sessionId="s-1"), {"type": "ready", "sessionId": "s-1"}),
        (
            ServerTranscript(text="hi", isFinal=True),
            {"type": "transcript", "text": "hi", "isFinal": True},
        ),
        (
            ServerText(text="Hello", partial=True),
            {"type": "text", "text": "Hello", "partial": True},
        ),
        (
            AudioFrame(type="audio", data=even_pcm_b64),
            {"type": "audio", "data": even_pcm_b64},
        ),
        (
            ServerUiState(state={"seq": 1, "page": "home"}, tier=1),
            {"type": "ui_state", "state": {"seq": 1, "page": "home"}, "tier": 1},
        ),
        (
            ServerUiState(
                state={"seq": 2, "page": "savings", "extra_monthly_pence": 4500},
                tier=3,
            ),
            {
                "type": "ui_state",
                "state": {"seq": 2, "page": "savings", "extra_monthly_pence": 4500},
                "tier": 3,
            },
        ),
        (
            ServerTurnDiagnostics(
                turnIndex=1,
                agentTransfers=[{"targetAgent": "savings_agent"}],
            ),
            {
                "type": "turn_diagnostics",
                "turnIndex": 1,
                "agentTransfers": [{"targetAgent": "savings_agent"}],
            },
        ),
        (
            ServerSearchSuggestions(
                htmls=["<div>chip</div>"],
                webSearchQueries=["how to cancel Netflix subscription UK"],
                citations=[{"uri": "https://help.netflix.com"}],
            ),
            {
                "type": "search_suggestions",
                "htmls": ["<div>chip</div>"],
                "webSearchQueries": ["how to cancel Netflix subscription UK"],
                "citations": [{"uri": "https://help.netflix.com"}],
            },
        ),
        (ServerTurnComplete(turnIndex=2), {"type": "turn_complete", "turnIndex": 2}),
        (ServerTurnComplete(), {"type": "turn_complete"}),
        (ServerGoAway(sessionId="s-1"), {"type": "go_away", "sessionId": "s-1"}),
        (
            ServerSessionExpired(),
            {"type": "session_expired", "message": "Session paused due to inactivity"},
        ),
        (ServerInterrupt(), {"type": "interrupt"}),
        (ServerEnd(), {"type": "end"}),
        (ServerError(message="bad"), {"type": "error", "message": "bad"}),
        (
            ServerError(message="invalid demoDate", field="demoDate"),
            {"type": "error", "message": "invalid demoDate", "field": "demoDate"},
        ),
    ]

    for msg, expected in cases:
        raw = serialize_server_msg(msg)
        decoded = json.loads(raw)
        assert decoded == expected
        validator.validate(decoded)
        round_tripped = parse_server_msg(raw)
        assert round_tripped == msg


def test_rejects_malformed_client_frames_and_odd_byte_pcm() -> None:
    with pytest.raises(ValueError, match="unknown client message"):
        parse_client_msg('{"type":"mystery"}')
    with pytest.raises(ValueError):
        parse_client_msg('{"type":"start","persona":"unknown"}')
    with pytest.raises(ValueError):
        parse_client_msg('{"type":"start","persona":"chloe","variables":{"first_name":"Chloe"}}')
    with pytest.raises(ValueError):
        parse_client_msg('{"type":"start","persona":"chloe","customer_snapshot":{}}')
    with pytest.raises(ValueError):
        parse_client_msg('{"type":"start","persona":"chloe","timeOfDay":"midnight"}')
    with pytest.raises(ValueError):
        parse_client_msg('{"type":"start","persona":"chloe","sessionId":""}')
    with pytest.raises(ValueError):
        parse_client_msg('{"type":"start","persona":"chloe","lastUiSeq":-1}')
    with pytest.raises(ValueError):
        parse_client_msg('{"type":"start","persona":"chloe","lastUiSeq":true}')
    with pytest.raises(ValueError):
        parse_client_msg('{"type":"stop","unexpected":1}')
    with pytest.raises(ValueError):
        parse_client_msg('{"type":"text","text":"hi","extraTopKey":1}')
    with pytest.raises(ValueError, match="base64"):
        parse_client_msg('{"type":"audio","data":"!!!not-base64!!!"}')
    with pytest.raises(ValueError):
        parse_client_msg('{"type":"audio","data":""}')

    # Odd-byte PCM16 frames (1 byte and 3 bytes) must be rejected cleanly
    for odd_bytes in (b"\x00", b"\x00\x01\x02"):
        odd_b64 = base64.b64encode(odd_bytes).decode("ascii")
        with pytest.raises(ValueError, match="even byte length"):
            parse_client_msg(json.dumps({"type": "audio", "data": odd_b64}))
