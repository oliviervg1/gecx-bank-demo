"""Tests for client/server protocol types and ws_protocol.schema.json conformance."""
from __future__ import annotations

import base64
import json
from typing import Any

import pytest
import referencing
from jsonschema.validators import validator_for

from conftest import SHARED_DIR
from proxy import protocol
from proxy.protocol import (
    MAX_AUDIO_B64_LEN,
    AudioFrame,
    ClientMsg,
    ClientProtocolError,
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
UI_VIEW_STATE_SCHEMA_PATH = SHARED_DIR / "ui_view_state.schema.json"


def _subschema_validator(definition: str) -> Any:
    root_schema = json.loads(WS_PROTOCOL_SCHEMA_PATH.read_text(encoding="utf-8"))
    ui_schema = json.loads(UI_VIEW_STATE_SCHEMA_PATH.read_text(encoding="utf-8"))

    validator_cls = validator_for(root_schema)
    validator_cls.check_schema(root_schema)

    root_id = str(
        root_schema.get("$id")
        or "https://cloudbank.example.com/schemas/ws_protocol.schema.json"
    )
    base_dir = root_id.rsplit("/", 1)[0]
    ui_id = str(
        ui_schema.get("$id") or f"{base_dir}/ui_view_state.schema.json"
    )

    root_resource = referencing.Resource.from_contents(root_schema)
    ui_resource = referencing.Resource.from_contents(ui_schema)
    registry: referencing.Registry[Any] = (
        referencing.Registry()
        .with_resource(root_id, root_resource)
        .with_resource(ui_id, ui_resource)
        .with_resource(f"{base_dir}/ui_view_state.schema.json", ui_resource)
        .with_resource("ui_view_state.schema.json", ui_resource)
    )

    defs_key = "definitions" if "definitions" in root_schema else "$defs"
    scoped: dict[str, Any] = {
        "$schema": root_schema["$schema"],
        "$id": f"{base_dir}/_scoped_{definition}.json",
        "allOf": [{"$ref": f"{root_id}#/{defs_key}/{definition}"}],
    }
    return validator_cls(scoped, registry=registry)


def test_legacy_client_tool_messages_and_seed_variables_removed() -> None:
    assert "ClientToolResponse" not in vars(protocol)
    assert "ServerClientFunction" not in vars(protocol)
    assert "variables" not in ClientStart.model_fields
    assert "customer_snapshot" not in ClientStart.model_fields
    with pytest.raises(ValueError, match="unknown client message"):
        parse_client_msg('{"type":"tool_response","id":"tc_1","response":{"output":{}}}')


def test_audio_ceiling_enforces_64kib_on_client_and_allows_larger_server_tts() -> None:
    assert MAX_AUDIO_B64_LEN == 87_384
    assert protocol._MAX_AUDIO_B64_LEN == 87_384

    root_schema = json.loads(WS_PROTOCOL_SCHEMA_PATH.read_text(encoding="utf-8"))
    defs = root_schema.get("definitions") or root_schema.get("$defs") or {}
    schema_max = defs["ClientAudio"]["properties"]["data"]["maxLength"]
    # Tolerates pre-merge 1048576 and post-merge 87384 in ws_protocol.schema.json
    assert schema_max in (87_384, 1_048_576)

    # Exact 64 KiB (65,536 bytes -> 87,384 base64 chars) client audio succeeds
    exact_64k_b64 = base64.b64encode(b"\x01\x00" * 32_768).decode("ascii")
    assert len(exact_64k_b64) == 87_384
    parsed_ok = parse_client_msg(json.dumps({"type": "audio", "data": exact_64k_b64}))
    assert isinstance(parsed_ok, AudioFrame)

    # 65,540 bytes (87,388 base64 chars) exceeds client ceiling and reports clean field error
    over_64k_b64 = base64.b64encode(b"\x01\x00" * 32_770).decode("ascii")
    assert len(over_64k_b64) == 87_388
    with pytest.raises(ValueError):
        AudioFrame(type="audio", data=over_64k_b64)
    with pytest.raises(ClientProtocolError) as exc_info:
        parse_client_msg(json.dumps({"type": "audio", "data": over_64k_b64}))
    assert exc_info.value.client_message == "audio frame exceeds maximum length"
    assert exc_info.value.field == "data"

    # Server-to-browser 24 kHz TTS chunks larger than 64 KiB remain valid
    server_tts = parse_server_msg(json.dumps({"type": "audio", "data": over_64k_b64}))
    assert isinstance(server_tts, AudioFrame)
    assert server_tts.data == over_64k_b64


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

    cases: list[tuple[ServerMsg, dict[str, Any]]] = [
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

    with pytest.raises(ClientProtocolError) as text_exc:
        parse_client_msg(json.dumps({"type": "text", "text": "x" * 8193}))
    assert text_exc.value.client_message == "text exceeds maximum length"
    assert text_exc.value.field == "text"

    # Odd-byte PCM16 frames (1 byte and 3 bytes) must be rejected cleanly
    for odd_bytes in (b"\x00", b"\x00\x01\x02"):
        odd_b64 = base64.b64encode(odd_bytes).decode("ascii")
        with pytest.raises(ValueError, match="even byte length"):
            parse_client_msg(json.dumps({"type": "audio", "data": odd_b64}))
