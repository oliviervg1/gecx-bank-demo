"""Tests for the hardened Relay: keepalive, idle expiry, 3-tier UI sync, diagnostics, search, and farewell drain."""
from __future__ import annotations

import asyncio
import base64
import json
from typing import Any

import pytest

from conftest import FakeUpstream
from proxy.protocol import MAX_CLIENT_FRAME_BYTES, AudioFrame, ClientStart, ClientText
from proxy.relay import (
    SILENCE_100MS_16KHZ_B64,
    SILENCE_100MS_16KHZ_BYTES,
    Relay,
    _drain_exceptions,
)


class FakeBrowser:
    def __init__(self) -> None:
        self.outbox: list[str] = []
        self.closed = False
        self._inbox: asyncio.Queue[str | None] = asyncio.Queue()

    async def receive_text(self) -> str:
        item = await self._inbox.get()
        if item is None:
            raise asyncio.CancelledError
        return item

    async def send_text(self, raw: str) -> None:
        self.outbox.append(raw)

    async def push(self, raw: str) -> None:
        await self._inbox.put(raw)

    async def close(self) -> None:
        self.closed = True
        await self._inbox.put(None)

    def parsed_messages(self) -> list[dict[str, Any]]:
        return [json.loads(m) for m in self.outbox]


@pytest.mark.asyncio
async def test_drain_exceptions_consumes_all_failures_and_ignores_cancelled() -> None:
    async def boom(msg: str) -> None:
        raise RuntimeError(msg)

    t1 = asyncio.create_task(boom("upstream died"))
    t2 = asyncio.create_task(boom("browser died"))
    await asyncio.gather(t1, t2, return_exceptions=True)
    assert [str(e) for e in _drain_exceptions([t1, t2])] == [
        "upstream died",
        "browser died",
    ]


@pytest.mark.asyncio
async def test_relays_config_variables_ready_audio_text_and_transcript(
    fake_upstream: FakeUpstream,
) -> None:
    assert not hasattr(Relay, "_in_flight_calls")
    browser = FakeBrowser()
    relay = Relay(
        browser=browser,
        upstream=fake_upstream,
        app_resource="projects/p/locations/eu/apps/cloudbank",
        session_id="3f1c8a2e-9b47-4d6a-8e21-5c7b0d9f4a13",
        persona_variables={"persona_id": "chloe", "first_name": "Chloe"},
    )
    task = asyncio.create_task(
        relay.run(start=ClientStart(type="start", persona="chloe", variables={}))
    )
    try:
        cfg = await fake_upstream.recv_from_proxy()
        assert cfg["config"]["session"] == (
            "projects/p/locations/eu/apps/cloudbank/sessions/3f1c8a2e-9b47-4d6a-8e21-5c7b0d9f4a13"
        )
        assert cfg["config"]["inputAudioConfig"] == {
            "audioEncoding": "LINEAR16",
            "sampleRateHertz": 16000,
        }
        vars_frame = await fake_upstream.recv_from_proxy()
        assert vars_frame["realtimeInput"]["variables"]["first_name"] == "Chloe"

        await browser.push(AudioFrame(data="AAAA").model_dump_json())
        assert (await fake_upstream.recv_from_proxy())["realtimeInput"]["audio"] == "AAAA"

        await browser.push(ClientText(type="text", text="Hello").model_dump_json())
        assert (await fake_upstream.recv_from_proxy())["realtimeInput"]["text"] == "Hello"

        # Oversized, malformed, invalid-base64, and duplicate mid-session start frames are dropped safely
        await browser.push("x" * (MAX_CLIENT_FRAME_BYTES + 1))
        await browser.push("{not json")
        await browser.push('{"type":"audio","data":"!!!not-base64!!!"}')
        await browser.push('{"type":"tool_response","id":"1","response":{}}')
        await browser.push(
            '{"type":"start","persona":"david","variables":{"injected":"bad"}}'
        )
        await browser.push(AudioFrame(data="BBBB").model_dump_json())
        next_upstream = await fake_upstream.recv_from_proxy()
        assert next_upstream == {"realtimeInput": {"audio": "BBBB"}}

        await fake_upstream.inject(
            {"recognitionResult": {"transcript": "Hello there", "isFinal": True}}
        )
        await fake_upstream.inject({"interruptionSignal": {}})
        await fake_upstream.inject({"goAway": {}})
        await asyncio.sleep(0.05)

        msgs = browser.parsed_messages()
        assert msgs[0] == {
            "type": "ready",
            "sessionId": "3f1c8a2e-9b47-4d6a-8e21-5c7b0d9f4a13",
        }
        assert {"type": "transcript", "text": "Hello there", "isFinal": True} in msgs
        assert {"type": "interrupt"} in msgs
        assert {
            "type": "go_away",
            "sessionId": "3f1c8a2e-9b47-4d6a-8e21-5c7b0d9f4a13",
        } in msgs
    finally:
        await browser.close()
        await fake_upstream.close()
        await task


@pytest.mark.asyncio
async def test_silence_keepalive_streams_16khz_pcm_and_idle_timeout_emits_session_expired(
    fake_upstream: FakeUpstream,
) -> None:
    assert len(SILENCE_100MS_16KHZ_BYTES) == 3200
    assert base64.b64decode(SILENCE_100MS_16KHZ_B64) == b"\x00" * 3200

    browser = FakeBrowser()
    relay = Relay(
        browser=browser,
        upstream=fake_upstream,
        app_resource="apps/x",
        session_id="s-idle",
        keepalive_interval_seconds=0.04,
        max_idle_seconds=0.14,
    )
    assert Relay(browser=browser, upstream=fake_upstream, app_resource="apps/x", session_id="s-def").max_idle_seconds == 900.0
    assert Relay(browser=browser, upstream=fake_upstream, app_resource="apps/x", session_id="s-def").keepalive_interval_seconds == 10.0

    task = asyncio.create_task(
        relay.run(start=ClientStart(type="start", persona="chloe", variables={}))
    )
    cfg = await fake_upstream.recv_from_proxy()
    assert "config" in cfg

    # Keepalive fires while quiet without resetting max_idle_seconds
    keepalive_frame = await fake_upstream.recv_from_proxy(timeout=1.0)
    assert keepalive_frame == {"realtimeInput": {"audio": SILENCE_100MS_16KHZ_B64}}

    # Idle watchdog expires and emits ServerSessionExpired
    await asyncio.wait_for(task, timeout=1.5)
    assert relay.ended_cleanly is True
    msgs = browser.parsed_messages()
    assert any(m["type"] == "session_expired" for m in msgs)


@pytest.mark.asyncio
async def test_three_tier_ui_state_extraction_float_seq_coercion_and_session_reset(
    fake_upstream: FakeUpstream,
) -> None:
    browser = FakeBrowser()
    relay = Relay(
        browser=browser,
        upstream=fake_upstream,
        app_resource="apps/x",
        session_id="sess-a",
    )
    task = asyncio.create_task(
        relay.run(start=ClientStart(type="start", persona="chloe", variables={}))
    )
    try:
        # Tier 1 partial payload (seq=1) -> emitted once with tier=1
        await fake_upstream.inject(
            {
                "sessionOutput": {
                    "payload": {
                        "seq": 1.0,
                        "page": "spending",
                        "view": "overview",
                        "period": "this_month",
                        "highlight_vendor": "Netflix",
                    }
                }
            }
        )
        # Duplicate seq=1 in Tier 2 payload AND Tier 3 updatedVariables on turnCompleted -> deduplicated!
        await fake_upstream.inject(
            {
                "sessionOutput": {
                    "text": "Overview spoken.",
                    "payload": {
                        "seq": 1,
                        "page": "spending",
                        "view": "overview",
                        "period": "this_month",
                        "highlight_vendor": "Netflix",
                    },
                    "turnCompleted": True,
                    "turnIndex": 1,
                    "diagnosticInfo": {
                        "messages": [
                            {
                                "chunks": [
                                    {
                                        "updatedVariables": {
                                            "ui_view_state": {
                                                "seq": 1.0,
                                                "page": "spending",
                                                "view": "overview",
                                                "period": "this_month",
                                                "highlight_vendor": "Netflix",
                                            },
                                            "customer_snapshot": {"huge": "omitted"},
                                        }
                                    }
                                ]
                            }
                        ]
                    },
                }
            }
        )

        # Turn 2: Tier 1/2 absent, Tier 3 delivers seq=3.0 as float on turn_completed=True (snake_case & camelCase)
        await fake_upstream.inject(
            {
                "session_output": {
                    "turn_completed": False,
                    "diagnostic_info": {
                        "messages": [
                            {
                                "chunks": [
                                    {
                                        "updated_variables": {
                                            "ui_view_state": {
                                                "seq": 2.0,
                                                "page": "home",
                                            }
                                        }
                                    }
                                ]
                            }
                        ]
                    },
                }
            }
        )  # Not turn_completed -> Tier 3 ignored!

        await fake_upstream.inject(
            {
                "session_output": {
                    "turn_completed": True,
                    "turn_index": 2,
                    "diagnostic_info": {
                        "messages": [
                            {
                                "chunks": [
                                    {
                                        "agent_transfer": {
                                            "targetAgent": "savings_agent",
                                            "internalDebug": "secret-not-forwarded",
                                        },
                                        "tool_call": {"displayName": "assist_savings"},
                                        "tool_response": {"displayName": "assist_savings"},
                                        "updated_variables": {
                                            "ui_view_state": {
                                                "seq": 3.0,
                                                "page": "savings",
                                                "extra_monthly_pence": 4500.0,
                                            },
                                            "ui_emitted_seq": "3",
                                        },
                                    }
                                ]
                            }
                        ],
                        "root_span": {"durationMs": 410},
                    },
                }
            }
        )

        # Invalid seq=0 or schema-invalid page dropped safely
        await fake_upstream.inject(
            {"sessionOutput": {"payload": {"seq": 0, "page": "home"}}}
        )
        await fake_upstream.inject(
            {"sessionOutput": {"payload": {"seq": 99, "page": "nonexistent"}}}
        )
        await asyncio.sleep(0.06)

        msgs = browser.parsed_messages()
        ui_msgs = [m for m in msgs if m["type"] == "ui_state"]
        assert ui_msgs == [
            {
                "type": "ui_state",
                "tier": 1,
                "state": {
                    "seq": 1,
                    "page": "spending",
                    "view": "overview",
                    "period": "this_month",
                    "highlight_vendor": "Netflix",
                },
            },
            {
                "type": "ui_state",
                "tier": 3,
                "state": {
                    "seq": 3,
                    "page": "savings",
                    "extra_monthly_pence": 4500,
                },
            },
        ]

        diag_msgs = [m for m in msgs if m["type"] == "turn_diagnostics"]
        assert len(diag_msgs) == 1
        assert diag_msgs[0]["agentTransfers"] == [{"targetAgent": "savings_agent"}]
        assert "toolResponses" not in diag_msgs[0]
        assert "updatedVariables" not in diag_msgs[0]
        assert "rootSpan" not in diag_msgs[0]
    finally:
        await browser.close()
        await fake_upstream.close()
        await task

    # New session resets deduplication cursor so seq=1 emits cleanly again
    upstream_b = FakeUpstream()
    browser_b = FakeBrowser()
    relay_b = Relay(
        browser=browser_b,
        upstream=upstream_b,
        app_resource="apps/x",
        session_id="sess-b",
    )
    task_b = asyncio.create_task(
        relay_b.run(start=ClientStart(type="start", persona="david", variables={}))
    )
    try:
        await upstream_b.inject(
            {"sessionOutput": {"payload": {"seq": 1, "page": "home"}}}
        )
        await asyncio.sleep(0.05)
        ui_b = [m for m in browser_b.parsed_messages() if m["type"] == "ui_state"]
        assert len(ui_b) == 1 and ui_b[0]["state"]["seq"] == 1
    finally:
        await browser_b.close()
        await upstream_b.close()
        await task_b


@pytest.mark.asyncio
async def test_forwards_search_suggestions_and_drains_farewell_audio_before_end(
    fake_upstream: FakeUpstream,
) -> None:
    browser = FakeBrowser()
    relay = Relay(
        browser=browser,
        upstream=fake_upstream,
        app_resource="apps/x",
        session_id="sess-farewell",
    )
    task = asyncio.create_task(
        relay.run(start=ClientStart(type="start", persona="chloe", variables={}))
    )
    try:
        await fake_upstream.inject(
            {
                "sessionOutput": {
                    "googleSearchSuggestions": {
                        "htmls": ["<div class='chip'>Cancel Netflix</div>"],
                        "webSearchQueries": ["how to cancel Netflix subscription UK"],
                    },
                    "citations": {
                        "citedChunks": [
                            {"uri": "https://help.netflix.com/en/node/407", "title": "Netflix Help"}
                        ]
                    },
                    "turnCompleted": True,
                }
            }
        )

        chunk1 = base64.b64encode(b"farewell-pcm-1").decode("ascii")
        chunk2 = base64.b64encode(b"farewell-pcm-2").decode("ascii")

        # Farewell turn where endSession arrives alongside text BEFORE trailing TTS audio chunks!
        await fake_upstream.inject(
            {
                "sessionOutput": {
                    "text": "You are very welcome, Chloe, and goodbye.",
                    "endSession": {},
                }
            }
        )
        await fake_upstream.inject({"sessionOutput": {"audio": chunk1}})
        await fake_upstream.inject(
            {
                "sessionOutput": {
                    "audio": chunk2,
                    "turnCompleted": True,
                    "endSession": {},
                }
            }
        )
        await asyncio.sleep(0.06)

        msgs = browser.parsed_messages()
        search_msgs = [m for m in msgs if m["type"] == "search_suggestions"]
        assert search_msgs == [
            {
                "type": "search_suggestions",
                "htmls": ["<div class='chip'>Cancel Netflix</div>"],
                "webSearchQueries": ["how to cancel Netflix subscription UK"],
                "citations": [
                    {"uri": "https://help.netflix.com/en/node/407", "title": "Netflix Help"}
                ],
            }
        ]

        # Every farewell audio frame MUST precede ServerEnd, and ServerEnd emits exactly once
        end_indices = [i for i, m in enumerate(msgs) if m["type"] == "end"]
        assert len(end_indices) == 1
        end_idx = end_indices[0]
        audio_indices = [
            i
            for i, m in enumerate(msgs)
            if m["type"] == "audio" and m["data"] in (chunk1, chunk2)
        ]
        assert len(audio_indices) == 2
        assert all(a_idx < end_idx for a_idx in audio_indices)
        assert relay.ended_cleanly is True
    finally:
        await browser.close()
        await fake_upstream.close()
        await task


@pytest.mark.asyncio
async def test_f4_1_held_end_session_flushed_even_when_upstream_drops_with_connection_closed() -> None:
    """Regression F4-1: held ServerEnd must still be delivered if upstream drops abnormally before turnCompleted."""
    import websockets.exceptions

    chunk = base64.b64encode(b"farewell-pcm").decode("ascii")

    class DroppingUpstream:
        def __init__(self) -> None:
            self.sent: list[str] = []
            self._frames = [
                json.dumps({"sessionOutput": {"audio": chunk}}),
                json.dumps({"endSession": {}}),
            ]

        async def send(self, raw: str) -> None:
            self.sent.append(raw)

        def __aiter__(self) -> DroppingUpstream:
            return self

        async def __anext__(self) -> str:
            if self._frames:
                return self._frames.pop(0)
            raise websockets.exceptions.ConnectionClosedError(None, None)

        async def close(self) -> None:
            pass

    browser = FakeBrowser()
    upstream = DroppingUpstream()
    relay = Relay(
        browser=browser,
        upstream=upstream,
        app_resource="apps/x",
        session_id="sess-f4-1",
    )
    with pytest.raises(websockets.exceptions.ConnectionClosedError):
        await relay.run(start=ClientStart(type="start", persona="chloe", variables={}))

    assert relay.ended_cleanly is True
    msgs = browser.parsed_messages()
    types = [m["type"] for m in msgs]
    assert types == ["ready", "audio", "end"]


@pytest.mark.asyncio
async def test_emits_server_end_from_diagnostic_tool_call_signal_alone(
    fake_upstream: FakeUpstream,
) -> None:
    """T7-1a: toolCall displayName=='end_session' alone triggers ServerEnd on turnCompleted."""
    browser = FakeBrowser()
    relay = Relay(
        browser=browser,
        upstream=fake_upstream,
        app_resource="apps/x",
        session_id="sess-diag-tc-only",
    )
    task = asyncio.create_task(
        relay.run(start=ClientStart(type="start", persona="chloe", variables={}))
    )
    try:
        chunk = base64.b64encode(b"farewell-pcm").decode("ascii")
        await fake_upstream.inject({"sessionOutput": {"audio": chunk, "turnIndex": 1}})
        await fake_upstream.inject(
            {
                "sessionOutput": {
                    "turnCompleted": True,
                    "turnIndex": 1,
                    "diagnosticInfo": {
                        "messages": [
                            {
                                "role": "mortgage_agent",
                                "chunks": [
                                    {
                                        "toolCall": {
                                            "displayName": "end_session",
                                            "tool": "apps/x/tools/end_session",
                                        }
                                    },
                                ],
                            }
                        ]
                    },
                }
            }
        )
        await asyncio.sleep(0.05)

        msgs = browser.parsed_messages()
        assert [m["type"] for m in msgs] == ["ready", "audio", "turn_complete", "end"]
        assert relay.ended_cleanly is True
    finally:
        await browser.close()
        await fake_upstream.close()
        await task


@pytest.mark.asyncio
async def test_emits_server_end_from_diagnostic_call_complete_released_signal_alone(
    fake_upstream: FakeUpstream,
) -> None:
    """T7-1b: updatedVariables call_complete=='released' alone triggers ServerEnd on turnCompleted."""
    browser = FakeBrowser()
    relay = Relay(
        browser=browser,
        upstream=fake_upstream,
        app_resource="apps/x",
        session_id="sess-diag-var-only",
    )
    task = asyncio.create_task(
        relay.run(start=ClientStart(type="start", persona="chloe", variables={}))
    )
    try:
        chunk = base64.b64encode(b"farewell-pcm").decode("ascii")
        await fake_upstream.inject({"sessionOutput": {"audio": chunk, "turnIndex": 1}})
        await fake_upstream.inject(
            {
                "sessionOutput": {
                    "turnCompleted": True,
                    "turnIndex": 1,
                    "diagnosticInfo": {
                        "messages": [
                            {
                                "role": "mortgage_agent",
                                "chunks": [
                                    {"updatedVariables": {"call_complete": "released"}},
                                ],
                            }
                        ]
                    },
                }
            }
        )
        await asyncio.sleep(0.05)

        msgs = browser.parsed_messages()
        assert [m["type"] for m in msgs] == ["ready", "audio", "turn_complete", "end"]
        assert relay.ended_cleanly is True
    finally:
        await browser.close()
        await fake_upstream.close()
        await task
