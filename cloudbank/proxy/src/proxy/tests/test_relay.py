"""Tests for the bidirectional frame relay."""
from __future__ import annotations

import asyncio
import json

import pytest

from proxy.protocol import MAX_CLIENT_FRAME_BYTES, AudioFrame, ClientStart
from proxy.relay import Relay, _drain_exceptions


class FakeBrowser:
    def __init__(self) -> None:
        self.outbox: list[str] = []
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
        await self._inbox.put(None)


@pytest.mark.asyncio
async def test_drain_exceptions_retrieves_every_failure_not_just_the_first() -> None:
    """When both pumps fail, every exception must be *retrieved*.

    `run()` used to do `for task in done: task.result()`, which raises on the
    first member of a set and leaves the sibling's exception unretrieved —
    asyncio then logs "Task exception was never retrieved" with a full
    traceback at GC time, which is the noise seen in the live proxy log.
    Returning both is what proves both were consumed.
    """

    async def boom(message: str) -> None:
        raise RuntimeError(message)

    first = asyncio.create_task(boom("upstream died"))
    second = asyncio.create_task(boom("browser died"))
    await asyncio.gather(first, second, return_exceptions=True)

    errors = _drain_exceptions([first, second])

    assert [str(e) for e in errors] == ["upstream died", "browser died"]


@pytest.mark.asyncio
async def test_drain_exceptions_ignores_cancelled_and_clean_tasks() -> None:
    async def fine() -> None:
        return None

    async def forever() -> None:
        await asyncio.sleep(3600)

    clean = asyncio.create_task(fine())
    cancelled = asyncio.create_task(forever())
    await asyncio.sleep(0)
    cancelled.cancel()
    await asyncio.gather(clean, cancelled, return_exceptions=True)

    assert _drain_exceptions([clean, cancelled]) == []


@pytest.mark.asyncio
async def test_relays_audio_browser_to_upstream(fake_upstream) -> None:
    browser = FakeBrowser()
    relay = Relay(browser=browser, upstream=fake_upstream, app_resource="apps/x", session_id="s-1")
    task = asyncio.create_task(relay.run(start=ClientStart(type="start", persona="chloe", variables={})))
    try:
        # First frame upstream sees is the session `config`; the browser's
        # audio frame is forwarded as the next `realtimeInput`.
        config_frame = await fake_upstream.recv_from_proxy()
        assert "config" in config_frame
        await browser.push(AudioFrame(type="audio", data="AAAA").model_dump_json())
        audio_frame = await fake_upstream.recv_from_proxy()
        assert audio_frame["realtimeInput"]["audio"] == "AAAA"
    finally:
        await browser.close()
        await fake_upstream.close()
        await task


@pytest.mark.asyncio
async def test_relays_audio_upstream_to_browser(fake_upstream) -> None:
    browser = FakeBrowser()
    relay = Relay(browser=browser, upstream=fake_upstream, app_resource="apps/x", session_id="s-1")
    task = asyncio.create_task(relay.run(start=ClientStart(type="start", persona="chloe", variables={})))
    try:
        await fake_upstream.inject({"sessionOutput": {"audio": "BBBB"}})
        # Allow relay to forward.
        await asyncio.sleep(0.05)
        msgs = [json.loads(m) for m in browser.outbox]
        types = [m["type"] for m in msgs]
        assert "ready" in types
        audio_msgs = [m for m in msgs if m["type"] == "audio"]
        assert audio_msgs and audio_msgs[0]["data"] == "BBBB"
    finally:
        await browser.close()
        await fake_upstream.close()
        await task


@pytest.mark.asyncio
async def test_forwards_recognition_transcript(fake_upstream) -> None:
    browser = FakeBrowser()
    relay = Relay(browser=browser, upstream=fake_upstream, app_resource="apps/x", session_id="s-1")
    task = asyncio.create_task(relay.run(start=ClientStart(type="start", persona="chloe", variables={})))
    try:
        await fake_upstream.inject({"recognitionResult": {"transcript": "hello"}})
        await asyncio.sleep(0.05)
        msgs = [json.loads(m) for m in browser.outbox]
        transcripts = [m for m in msgs if m["type"] == "transcript"]
        assert transcripts and transcripts[0]["text"] == "hello"
    finally:
        await browser.close()
        await fake_upstream.close()
        await task


@pytest.mark.asyncio
async def test_forwards_interruption_signal(fake_upstream) -> None:
    browser = FakeBrowser()
    relay = Relay(browser=browser, upstream=fake_upstream, app_resource="apps/x", session_id="s-1")
    task = asyncio.create_task(relay.run(start=ClientStart(type="start", persona="chloe", variables={})))
    try:
        await fake_upstream.inject({"interruptionSignal": {}})
        await asyncio.sleep(0.05)
        msgs = [json.loads(m) for m in browser.outbox]
        assert any(m["type"] == "interrupt" for m in msgs)
    finally:
        await browser.close()
        await fake_upstream.close()
        await task


@pytest.mark.asyncio
async def test_emits_variables_frame_after_config(fake_upstream) -> None:
    browser = FakeBrowser()
    relay = Relay(
        browser=browser,
        upstream=fake_upstream,
        app_resource="apps/x",
        session_id="s-1",
        persona_variables={"first_name": "Chloe"},
    )
    task = asyncio.create_task(relay.run(start=ClientStart(type="start", persona="chloe", variables={})))
    try:
        first = await fake_upstream.recv_from_proxy()
        assert "config" in first
        second = await fake_upstream.recv_from_proxy()
        assert second["realtimeInput"]["variables"] == {"first_name": "Chloe"}
    finally:
        await browser.close()
        await fake_upstream.close()
        await task


@pytest.mark.asyncio
async def test_skips_variables_frame_when_none(fake_upstream) -> None:
    browser = FakeBrowser()
    relay = Relay(
        browser=browser,
        upstream=fake_upstream,
        app_resource="apps/x",
        session_id="s-1",
        persona_variables=None,
    )
    task = asyncio.create_task(relay.run(start=ClientStart(type="start", persona="chloe", variables={})))
    try:
        first = await fake_upstream.recv_from_proxy()
        assert "config" in first
        # No variables frame: the next thing upstream sees should come
        # from the browser pump, so an audio frame round-trips cleanly.
        await browser.push(AudioFrame(type="audio", data="AAAA").model_dump_json())
        second = await fake_upstream.recv_from_proxy()
        assert "realtimeInput" in second and "audio" in second["realtimeInput"]
    finally:
        await browser.close()
        await fake_upstream.close()
        await task


@pytest.mark.asyncio
async def test_forwards_tool_calls_as_client_function_frames(fake_upstream) -> None:
    # CES emits the tool resource as `projects/.../tools/{UUID}` and includes
    # `displayName` alongside. The frontend registry is keyed by displayName.
    tool_uuid = "fb1c881d-b7fa-46d8-8e2d-f622fd3319fd"
    tool_resource = f"projects/p/locations/us/apps/a/tools/{tool_uuid}"
    browser = FakeBrowser()
    relay = Relay(browser=browser, upstream=fake_upstream, app_resource="apps/x", session_id="s-1")
    task = asyncio.create_task(relay.run(start=ClientStart(type="start", persona="chloe", variables={})))
    try:
        await fake_upstream.inject({
            "sessionOutput": {
                "toolCalls": {
                    "toolCalls": [
                        {"id": "tc_1", "tool": tool_resource, "displayName": "navigate_to", "args": {"pageId": "spending"}},
                        {"id": "tc_2", "tool": tool_resource, "displayName": "navigate_to", "args": {"pageId": "savings"}},
                    ]
                }
            }
        })
        await asyncio.sleep(0.05)
        msgs = [json.loads(m) for m in browser.outbox]
        cfs = [m for m in msgs if m["type"] == "client_function"]
        assert len(cfs) == 2
        assert cfs[0] == {"type": "client_function", "id": "tc_1", "name": "navigate_to", "args": {"pageId": "spending"}}
        assert cfs[1] == {"type": "client_function", "id": "tc_2", "name": "navigate_to", "args": {"pageId": "savings"}}
    finally:
        await browser.close()
        await fake_upstream.close()
        await task


@pytest.mark.asyncio
async def test_tool_call_falls_back_to_resource_tail_when_displayname_missing(fake_upstream) -> None:
    # Defensive fallback: if CES ever omits displayName, use the resource
    # tail so the frontend can at least surface an `unknown_function` error
    # instead of the call being silently dropped.
    browser = FakeBrowser()
    relay = Relay(browser=browser, upstream=fake_upstream, app_resource="apps/x", session_id="s-1")
    task = asyncio.create_task(relay.run(start=ClientStart(type="start", persona="chloe", variables={})))
    try:
        await fake_upstream.inject({
            "sessionOutput": {
                "toolCalls": {
                    "toolCalls": [
                        {"id": "tc_x", "tool": "projects/p/locations/us/apps/a/tools/abc-123", "args": {}}
                    ]
                }
            }
        })
        await asyncio.sleep(0.05)
        msgs = [json.loads(m) for m in browser.outbox]
        cfs = [m for m in msgs if m["type"] == "client_function"]
        assert len(cfs) == 1
        assert cfs[0]["name"] == "abc-123"
    finally:
        await browser.close()
        await fake_upstream.close()
        await task


@pytest.mark.asyncio
async def test_forwards_tool_response_as_realtime_input(fake_upstream) -> None:
    # Round-trip: simulate an upstream tool_call landing first (so the
    # relay records the in-flight {id → tool_resource} mapping), then push
    # the browser's tool_response and assert the upstream frame includes
    # both the response and the original `tool` resource.
    tool_resource = "projects/p/locations/us/apps/a/tools/fb1c881d"
    browser = FakeBrowser()
    relay = Relay(browser=browser, upstream=fake_upstream, app_resource="apps/x", session_id="s-1")
    task = asyncio.create_task(relay.run(start=ClientStart(type="start", persona="chloe", variables={})))
    try:
        _ = await fake_upstream.recv_from_proxy()  # drain config
        # Inject the tool_call so the relay records id → tool mapping.
        await fake_upstream.inject({
            "sessionOutput": {
                "toolCalls": {
                    "toolCalls": [
                        {"id": "tc_1", "tool": tool_resource, "displayName": "navigate_to", "args": {}}
                    ]
                }
            }
        })
        await asyncio.sleep(0.05)
        # Now push the browser's response and assert the upstream frame.
        await browser.push(
            '{"type":"tool_response","id":"tc_1","response":{"output":{}}}'
        )
        frame = await fake_upstream.recv_from_proxy()
        # CES requires the `tool` resource on the ToolResponse (verified
        # empirically — omitting it triggers BadRequest). The outer wrap is
        # double-nested because SessionInput.tool_responses is the
        # ToolResponses wrapper, not an array directly.
        assert frame == {
            "realtimeInput": {
                "toolResponses": {
                    "toolResponses": [
                        {"id": "tc_1", "tool": tool_resource, "response": {"output": {}}}
                    ]
                }
            }
        }
    finally:
        await browser.close()
        await fake_upstream.close()
        await task


@pytest.mark.asyncio
async def test_tool_response_without_prior_call_omits_tool_field(fake_upstream) -> None:
    # Defensive: if a tool_response arrives without a matching in-flight
    # call (shouldn't happen in practice), forward it without the `tool`
    # field. CES will reject, but the proxy doesn't crash.
    browser = FakeBrowser()
    relay = Relay(browser=browser, upstream=fake_upstream, app_resource="apps/x", session_id="s-1")
    task = asyncio.create_task(relay.run(start=ClientStart(type="start", persona="chloe", variables={})))
    try:
        _ = await fake_upstream.recv_from_proxy()
        await browser.push(
            '{"type":"tool_response","id":"orphan_tc","response":{"output":{}}}'
        )
        frame = await fake_upstream.recv_from_proxy()
        assert frame == {
            "realtimeInput": {
                "toolResponses": {
                    "toolResponses": [{"id": "orphan_tc", "response": {"output": {}}}]
                }
            }
        }
    finally:
        await browser.close()
        await fake_upstream.close()
        await task


@pytest.mark.asyncio
async def test_malformed_mid_session_frame_does_not_kill_the_session(fake_upstream) -> None:
    """One bad frame must not propagate ValueError out of the pump and tear the
    whole session down. It must be dropped, with the conversation continuing."""
    browser = FakeBrowser()
    relay = Relay(browser=browser, upstream=fake_upstream, app_resource="apps/x", session_id="s-1")
    task = asyncio.create_task(relay.run(start=ClientStart(type="start", persona="chloe", variables={})))
    try:
        await fake_upstream.recv_from_proxy()          # config
        await browser.push("}{ not json at all")       # dropped
        await browser.push('{"type":"kaboom"}')        # unknown discriminator, dropped
        # The session is still alive and still relaying.
        await browser.push(AudioFrame(type="audio", data="AAAA").model_dump_json())
        frame = await fake_upstream.recv_from_proxy()
        assert frame["realtimeInput"]["audio"] == "AAAA"
    finally:
        await browser.close()
        await fake_upstream.close()
        await task


@pytest.mark.asyncio
async def test_oversized_mid_session_frame_is_dropped(fake_upstream) -> None:
    browser = FakeBrowser()
    relay = Relay(browser=browser, upstream=fake_upstream, app_resource="apps/x", session_id="s-1")
    task = asyncio.create_task(relay.run(start=ClientStart(type="start", persona="chloe", variables={})))
    try:
        await fake_upstream.recv_from_proxy()          # config
        await browser.push("x" * (MAX_CLIENT_FRAME_BYTES + 1))
        await browser.push(AudioFrame(type="audio", data="AAAA").model_dump_json())
        frame = await fake_upstream.recv_from_proxy()
        assert frame["realtimeInput"]["audio"] == "AAAA"
    finally:
        await browser.close()
        await fake_upstream.close()
        await task
