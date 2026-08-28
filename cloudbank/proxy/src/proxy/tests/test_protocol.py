"""Tests for client/server message parsing — must mirror cloudbank/web/src/agent/protocol.ts."""
from __future__ import annotations

import json

import pytest

from proxy.protocol import (
    AudioFrame,
    ClientStart,
    ClientStop,
    ClientToolResponse,
    ServerClientFunction,
    ServerError,
    ServerReady,
    parse_client_msg,
    serialize_server_msg,
)


def test_parses_start_message() -> None:
    msg = parse_client_msg('{"type": "start", "persona": "chloe", "variables": {}}')
    assert isinstance(msg, ClientStart)
    assert msg.persona == "chloe"


def test_parses_audio_frame() -> None:
    msg = parse_client_msg('{"type": "audio", "data": "AAAA"}')
    assert isinstance(msg, AudioFrame)
    assert msg.data == "AAAA"


def test_parses_stop_message() -> None:
    msg = parse_client_msg('{"type": "stop"}')
    assert isinstance(msg, ClientStop)


def test_rejects_unknown_type() -> None:
    with pytest.raises(ValueError, match="unknown client message"):
        parse_client_msg('{"type": "mystery"}')


def test_rejects_bad_persona() -> None:
    with pytest.raises(ValueError):
        parse_client_msg('{"type": "start", "persona": "unknown"}')


def test_serialize_ready() -> None:
    assert serialize_server_msg(ServerReady()) == '{"type":"ready"}'


def test_serialize_error() -> None:
    out = serialize_server_msg(ServerError(message="auth"))
    assert out == '{"type":"error","message":"auth"}'


def test_parses_tool_response() -> None:
    msg = parse_client_msg(
        '{"type":"tool_response","id":"tc_1","response":{"output":{}}}'
    )
    assert isinstance(msg, ClientToolResponse)
    assert msg.id == "tc_1"
    assert msg.response == {"output": {}}


def test_serializes_client_function() -> None:
    raw = serialize_server_msg(
        ServerClientFunction(id="tc_1", name="navigate_to", args={"pageId": "spending"})
    )
    assert json.loads(raw) == {
        "type": "client_function",
        "id": "tc_1",
        "name": "navigate_to",
        "args": {"pageId": "spending"},
    }


def test_client_start_accepts_variables() -> None:
    msg = parse_client_msg('{"type": "start", "persona": "chloe", "variables": {"first_name": "Chloe"}}')
    assert isinstance(msg, ClientStart)
    assert msg.persona == "chloe"
    assert msg.variables == {"first_name": "Chloe"}


def test_client_start_requires_variables() -> None:
    with pytest.raises(ValueError):
        parse_client_msg('{"type": "start", "persona": "chloe"}')


def test_client_start_accepts_session_id() -> None:
    """The browser owns the CES session id so a reconnect can resume the same
    conversation; see _resolve_session_id for the validation that follows."""
    msg = parse_client_msg(
        '{"type": "start", "persona": "chloe", "variables": {},'
        ' "sessionId": "3f1c8a2e-9b47-4d6a-8e21-5c7b0d9f4a13"}'
    )
    assert isinstance(msg, ClientStart)
    assert msg.sessionId == "3f1c8a2e-9b47-4d6a-8e21-5c7b0d9f4a13"


def test_client_start_session_id_is_optional() -> None:
    """Older clients (and the very first connect) send no id at all."""
    msg = parse_client_msg('{"type": "start", "persona": "chloe", "variables": {}}')
    assert isinstance(msg, ClientStart)
    assert msg.sessionId is None
