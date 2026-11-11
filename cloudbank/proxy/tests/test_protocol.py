"""Tests for client/server protocol types and removal of legacy client tools."""
from __future__ import annotations

import json

import pytest

from proxy import protocol
from proxy.protocol import (
    AudioFrame,
    ClientStart,
    ClientStop,
    ClientText,
    ServerEnd,
    ServerError,
    ServerGoAway,
    ServerInterrupt,
    ServerReady,
    ServerSearchSuggestions,
    ServerSessionExpired,
    ServerText,
    ServerTranscript,
    ServerTurnComplete,
    ServerTurnDiagnostics,
    ServerUiState,
    parse_client_msg,
    serialize_server_msg,
)


def test_legacy_client_tool_messages_removed() -> None:
    assert not hasattr(protocol, "ClientToolResponse")
    assert not hasattr(protocol, "ServerClientFunction")
    with pytest.raises(ValueError, match="unknown client message"):
        parse_client_msg('{"type":"tool_response","id":"tc_1","response":{"output":{}}}')


def test_parses_valid_client_messages() -> None:
    start = parse_client_msg(
        '{"type":"start","persona":"chloe","variables":{"first_name":"Chloe"}}'
    )
    assert isinstance(start, ClientStart)
    assert start.persona == "chloe"
    assert start.sessionId is None

    audio = parse_client_msg('{"type":"audio","data":"AAAA"}')
    assert isinstance(audio, AudioFrame)
    assert audio.data == "AAAA"

    txt = parse_client_msg('{"type":"text","text":"How much did I spend?"}')
    assert isinstance(txt, ClientText)

    stop = parse_client_msg('{"type":"stop"}')
    assert isinstance(stop, ClientStop)


def test_rejects_unknown_or_malformed_client_frames() -> None:
    with pytest.raises(ValueError, match="unknown client message"):
        parse_client_msg('{"type":"mystery"}')
    with pytest.raises(ValueError):
        parse_client_msg('{"type":"start","persona":"unknown","variables":{}}')
    with pytest.raises(ValueError):
        parse_client_msg('{"type":"stop","unexpected":1}')
    with pytest.raises(ValueError):
        parse_client_msg(
            '{"type":"start","persona":"chloe","variables":{},"extraTopKey":1}'
        )
    with pytest.raises(ValueError):
        parse_client_msg('{"type":"text","text":"hi","extraTopKey":1}')
    with pytest.raises(ValueError, match="base64"):
        parse_client_msg('{"type":"audio","data":"!!!not-base64!!!"}')
    with pytest.raises(ValueError):
        parse_client_msg('{"type":"audio","data":""}')


def test_serializes_all_server_message_variants() -> None:
    cases = [
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
            ServerUiState(state={"seq": 1, "page": "home"}, tier=1),
            {"type": "ui_state", "state": {"seq": 1, "page": "home"}, "tier": 1},
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
        (ServerGoAway(sessionId="s-1"), {"type": "go_away", "sessionId": "s-1"}),
        (
            ServerSessionExpired(),
            {"type": "session_expired", "message": "Session paused due to inactivity"},
        ),
        (ServerInterrupt(), {"type": "interrupt"}),
        (ServerEnd(), {"type": "end"}),
        (ServerError(message="bad"), {"type": "error", "message": "bad"}),
        (
            ServerError(message="invalid demo_date: bad", field="demo_date"),
            {"type": "error", "message": "invalid demo_date: bad", "field": "demo_date"},
        ),
    ]
    for msg, expected in cases:
        assert json.loads(serialize_server_msg(msg)) == expected
