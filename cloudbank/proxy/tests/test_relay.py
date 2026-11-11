"""Tests for the hardened Relay: TaskGroup lifecycle, resume state, keepalive, idle expiry, 3-tier UI sync, and farewell drain."""
from __future__ import annotations

import asyncio
import base64
import json
from typing import Any

import pytest
import websockets.exceptions

from conftest import FakeUpstream
from proxy.protocol import (
    MAX_CLIENT_FRAME_BYTES,
    AudioFrame,
    BrowserDisconnectError,
    ClientStart,
    ClientStop,
    ClientText,
)
from proxy.relay import (
    SILENCE_100MS_16KHZ_B64,
    SILENCE_100MS_16KHZ_BYTES,
    Relay,
)

PCM_CHUNK_A = base64.b64encode(b"\x01\x00\x02\x00").decode("ascii")
PCM_CHUNK_B = base64.b64encode(b"\x03\x00\x04\x00").decode("ascii")


class FakeBrowser:
    def __init__(self) -> None:
        self.outbox: list[str] = []
        self.closed = False
        self._inbox: asyncio.Queue[str | None] = asyncio.Queue()

    async def receive_text(self) -> str:
        item = await self._inbox.get()
        if item is None:
            raise BrowserDisconnectError()
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
async def test_relays_config_variables_ready_audio_text_and_transcript(
    fake_upstream: FakeUpstream,
) -> None:
    assert "_in_flight_calls" not in Relay.__dataclass_fields__
    assert "_emitted_ui_keys" not in Relay.__dataclass_fields__

    browser = FakeBrowser()
    relay = Relay(
        browser=browser,
        upstream=fake_upstream,
        app_resource="projects/demo-proj-01/locations/eu/apps/cloudbank",
        session_id="3f1c8a2e-9b47-4d6a-8e21-5c7b0d9f4a13",
        persona_variables={"persona_id": "chloe", "first_name": "Chloe"},
    )
    task = asyncio.create_task(
        relay.run(start=ClientStart(type="start", persona="chloe"))
    )
    try:
        cfg = await fake_upstream.recv_from_proxy()
        assert cfg["config"]["session"] == (
            "projects/demo-proj-01/locations/eu/apps/cloudbank/sessions/3f1c8a2e-9b47-4d6a-8e21-5c7b0d9f4a13"
        )
        assert cfg["config"]["inputAudioConfig"] == {
            "audioEncoding": "LINEAR16",
            "sampleRateHertz": 16000,
        }
        vars_frame = await fake_upstream.recv_from_proxy()
        assert vars_frame["realtimeInput"]["variables"]["first_name"] == "Chloe"

        await browser.push(AudioFrame(data=PCM_CHUNK_A).model_dump_json())
        assert (
            await fake_upstream.recv_from_proxy()
        )["realtimeInput"]["audio"] == PCM_CHUNK_A

        await browser.push(ClientText(type="text", text="Hello").model_dump_json())
        assert (await fake_upstream.recv_from_proxy())["realtimeInput"]["text"] == "Hello"

        # Oversized UTF-8, malformed, odd-byte PCM, invalid-base64, and mid-session start frames are dropped safely
        await browser.push("\U0001f600" * ((MAX_CLIENT_FRAME_BYTES // 4) + 10))
        await browser.push("{not json")
        await browser.push('{"type":"audio","data":"AAAA"}')  # 3 decoded bytes -> odd PCM16
        await browser.push('{"type":"audio","data":"!!!not-base64!!!"}')
        await browser.push('{"type":"tool_response","id":"1","response":{}}')
        await browser.push('{"type":"start","persona":"david"}')
        await browser.push(AudioFrame(data=PCM_CHUNK_B).model_dump_json())
        next_upstream = await fake_upstream.recv_from_proxy()
        assert next_upstream == {"realtimeInput": {"audio": PCM_CHUNK_B}}

        # Odd-byte upstream audio is also dropped safely
        await fake_upstream.inject({"sessionOutput": {"audio": "AAAA"}})
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
        assert not any(m["type"] == "audio" for m in msgs)
        assert {"type": "transcript", "text": "Hello there", "isFinal": True} in msgs
        assert {"type": "interrupt"} in msgs
        assert {
            "type": "go_away",
            "sessionId": "3f1c8a2e-9b47-4d6a-8e21-5c7b0d9f4a13",
        } in msgs
    finally:
        await browser.push(ClientStop(type="stop").model_dump_json())
        await task
    assert relay.ended_cleanly is True


@pytest.mark.asyncio
async def test_session_resume_skips_variable_reseeding_and_honors_last_ui_seq(
    fake_upstream: FakeUpstream,
) -> None:
    browser = FakeBrowser()
    sid = "3f1c8a2e-9b47-4d6a-8e21-5c7b0d9f4a13"
    relay = Relay(
        browser=browser,
        upstream=fake_upstream,
        app_resource="projects/demo-proj-01/locations/eu/apps/cloudbank",
        session_id=sid,
        persona_variables={"persona_id": "chloe", "first_name": "Chloe"},
    )
    task = asyncio.create_task(
        relay.run(
            start=ClientStart(
                type="start",
                persona="chloe",
                sessionId=sid,
                lastUiSeq=4,
            )
        )
    )
    try:
        first_frame = await fake_upstream.recv_from_proxy()
        assert first_frame["config"]["session"].endswith(f"/sessions/{sid}")

        # Next client frame must immediately be audio (no realtimeInput.variables sent on resume)
        await browser.push(AudioFrame(data=PCM_CHUNK_A).model_dump_json())
        second_frame = await fake_upstream.recv_from_proxy()
        assert second_frame == {"realtimeInput": {"audio": PCM_CHUNK_A}}

        # Stale Tier 3 updatedVariables carrying seq=4 on a non-UI turn is suppressed
        await fake_upstream.inject(
            {
                "sessionOutput": {
                    "text": "Anything else?",
                    "turnCompleted": True,
                    "turnIndex": 0,
                    "diagnosticInfo": {
                        "messages": [
                            {
                                "chunks": [
                                    {
                                        "updatedVariables": {
                                            "ui_view_state": {
                                                "seq": 4.0,
                                                "page": "spending",
                                                "view": "subscriptions",
                                            }
                                        }
                                    }
                                ]
                            }
                        ]
                    },
                }
            }
        )
        # Fresh seq=5 update emits cleanly
        await fake_upstream.inject(
            {"sessionOutput": {"payload": {"seq": 5, "page": "savings"}}}
        )
        await asyncio.sleep(0.05)

        msgs = browser.parsed_messages()
        ui_msgs = [m for m in msgs if m["type"] == "ui_state"]
        assert ui_msgs == [
            {"type": "ui_state", "tier": 1, "state": {"seq": 5, "page": "savings"}}
        ]
        # turnIndex=0 is preserved (not treated as falsy None)
        tc_msgs = [m for m in msgs if m["type"] == "turn_complete"]
        assert tc_msgs == [{"type": "turn_complete", "turnIndex": 0}]
    finally:
        await browser.close()
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
    default_relay = Relay(
        browser=browser,
        upstream=fake_upstream,
        app_resource="apps/x",
        session_id="s-def",
    )
    assert default_relay.max_idle_seconds == 900.0
    assert default_relay.keepalive_interval_seconds == 10.0

    task = asyncio.create_task(
        relay.run(start=ClientStart(type="start", persona="chloe"))
    )
    cfg = await fake_upstream.recv_from_proxy()
    assert "config" in cfg

    # Keepalive fires while quiet without resetting max_idle_seconds
    keepalive_frame = await fake_upstream.recv_from_proxy(timeout=1.0)
    assert keepalive_frame == {"realtimeInput": {"audio": SILENCE_100MS_16KHZ_B64}}

    # Idle watchdog expires via asyncio.timeout and emits ServerSessionExpired
    await asyncio.wait_for(task, timeout=1.5)
    assert relay.ended_cleanly is True
    assert browser.closed is True
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
        relay.run(start=ClientStart(type="start", persona="chloe"))
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
        # Duplicate seq=1 in Tier 2 payload and Tier 3 updatedVariables on turnCompleted -> deduplicated
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

        # Turn 2: Tier 1/2 absent, Tier 3 ignored when turn_completed=False
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
        )

        # Tier 3 delivers seq=3.0 as float on turn_completed=True
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

    # New non-resumed session resets deduplication cursor so seq=1 emits cleanly again
    upstream_b = FakeUpstream()
    browser_b = FakeBrowser()
    relay_b = Relay(
        browser=browser_b,
        upstream=upstream_b,
        app_resource="apps/x",
        session_id="sess-b",
    )
    task_b = asyncio.create_task(
        relay_b.run(start=ClientStart(type="start", persona="david"))
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
        relay.run(start=ClientStart(type="start", persona="chloe"))
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

        chunk1 = base64.b64encode(b"farewell-pcm01").decode("ascii")
        chunk2 = base64.b64encode(b"farewell-pcm02").decode("ascii")

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
async def test_held_end_session_flushed_when_upstream_drops_with_connection_closed() -> None:
    """Held ServerEnd must still be delivered if upstream drops abnormally before turnCompleted."""
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
        session_id="sess-drop",
    )
    with pytest.raises(websockets.exceptions.ConnectionClosedError):
        await relay.run(start=ClientStart(type="start", persona="chloe"))

    assert relay.ended_cleanly is True
    msgs = browser.parsed_messages()
    types = [m["type"] for m in msgs]
    assert types == ["ready", "audio", "end"]


@pytest.mark.asyncio
async def test_emits_server_end_from_diagnostic_tool_call_or_released_variable(
    fake_upstream: FakeUpstream,
) -> None:
    chunk = base64.b64encode(b"farewell-pcm").decode("ascii")

    # 1. toolCall displayName == 'end_session'
    browser_tc = FakeBrowser()
    relay_tc = Relay(
        browser=browser_tc,
        upstream=fake_upstream,
        app_resource="apps/x",
        session_id="sess-diag-tc",
    )
    task_tc = asyncio.create_task(
        relay_tc.run(start=ClientStart(type="start", persona="chloe"))
    )
    try:
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
        assert [m["type"] for m in browser_tc.parsed_messages()] == [
            "ready",
            "audio",
            "turn_complete",
            "end",
        ]
        assert relay_tc.ended_cleanly is True
    finally:
        await browser_tc.close()
        await fake_upstream.close()
        await task_tc

    # 2. updatedVariables call_complete == 'released'
    upstream_var = FakeUpstream()
    browser_var = FakeBrowser()
    relay_var = Relay(
        browser=browser_var,
        upstream=upstream_var,
        app_resource="apps/x",
        session_id="sess-diag-var",
    )
    task_var = asyncio.create_task(
        relay_var.run(start=ClientStart(type="start", persona="chloe"))
    )
    try:
        await upstream_var.inject({"sessionOutput": {"audio": chunk, "turnIndex": 1}})
        await upstream_var.inject(
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
        assert [m["type"] for m in browser_var.parsed_messages()] == [
            "ready",
            "audio",
            "turn_complete",
            "end",
        ]
        assert relay_var.ended_cleanly is True
    finally:
        await browser_var.close()
        await upstream_var.close()
        await task_var


@pytest.mark.asyncio
async def test_relay_task_group_propagates_external_cancellation_cleanly(
    fake_upstream: FakeUpstream,
) -> None:
    browser = FakeBrowser()
    relay = Relay(
        browser=browser,
        upstream=fake_upstream,
        app_resource="apps/x",
        session_id="sess-cancel",
    )
    task = asyncio.create_task(
        relay.run(start=ClientStart(type="start", persona="chloe"))
    )
    await fake_upstream.recv_from_proxy()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert fake_upstream.closed is True
