"""Bidirectional frame relay between the browser and CES BidiRunSession.

The relay is intentionally thin — it does not interpret frames except to:
 1. Send an initial `config` to upstream.
 2. Convert `audio`/`text` browser frames into `realtimeInput` upstream frames.
 3. Map upstream `sessionOutput`/`recognitionResult`/`interruptionSignal`
    into our typed browser frames.
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Protocol

from .protocol import (
    MAX_CLIENT_FRAME_BYTES,
    AudioFrame,
    ClientStart,
    ClientStop,
    ClientText,
    ClientToolResponse,
    ServerClientFunction,
    ServerEnd,
    ServerInterrupt,
    ServerReady,
    ServerText,
    ServerTranscript,
    parse_client_msg,
    serialize_server_msg,
)

log = logging.getLogger(__name__)


class _BrowserSocket(Protocol):
    async def receive_text(self) -> str: ...
    async def send_text(self, raw: str) -> None: ...


class _UpstreamSocket(Protocol):
    async def send(self, raw: str) -> None: ...
    def __aiter__(self) -> AsyncIterator[str]: ...
    async def close(self) -> None: ...


@dataclass
class Relay:
    browser: _BrowserSocket
    upstream: _UpstreamSocket
    app_resource: str   # e.g. "projects/p/locations/us/apps/a"
    session_id: str
    persona_variables: dict[str, Any] | None = None
    # {tool_call_id → tool_resource_path} for in-flight tool calls. CES
    # requires the `tool` resource on the ToolResponse to match it to the
    # originating call (verified empirically: omitting it triggers
    # `invalid_argument: BadRequest` and closes the upstream WS). The
    # browser doesn't know the resource path — only the displayName — so
    # the relay tracks the mapping itself.
    _in_flight_calls: dict[str, str] = field(default_factory=dict)

    async def run(self, *, start: ClientStart) -> None:
        await self._send_initial_config()
        if self.persona_variables is not None:
            # CES `BidiSessionClientMessage.realtime_input.variables` is a
            # `google.protobuf.Struct` oneof. The platform merges these into
            # `callback_context.state`, which `instruction.txt` references
            # via `{first_name}`-style templating.
            await self.upstream.send(
                json.dumps({"realtimeInput": {"variables": self.persona_variables}})
            )
        log.info("relay starting for persona=%s", start.persona)
        await self.browser.send_text(serialize_server_msg(ServerReady()))

        # When either pump finishes the session is over, so cancel the other
        # rather than leaving it awaiting. A bare gather() propagates the first
        # exception but does NOT cancel its sibling, which then surfaced only
        # as a "Task exception was never retrieved" warning at GC time.
        tasks = [
            asyncio.create_task(self._pump_browser_to_upstream()),
            asyncio.create_task(self._pump_upstream_to_browser()),
        ]
        try:
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            # Re-raise the first real failure so main.py's handlers can map it
            # onto an error envelope for the browser.
            for task in done:
                task.result()
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()

    async def _send_initial_config(self) -> None:
        config = {
            "config": {
                "session": f"{self.app_resource}/sessions/{self.session_id}",
                "inputAudioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": 16000},
                "outputAudioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": 24000},
            }
        }
        await self.upstream.send(json.dumps(config))

    async def _pump_browser_to_upstream(self) -> None:
        try:
            while True:
                raw = await self.browser.receive_text()
                if len(raw) > MAX_CLIENT_FRAME_BYTES:
                    log.warning("dropping oversized client frame (%d bytes)", len(raw))
                    continue
                try:
                    msg = parse_client_msg(raw)
                except ValueError:
                    # A malformed mid-session frame must not propagate out of
                    # the pump and tear down the whole session. Drop it and
                    # keep the conversation alive.
                    log.warning("dropping malformed client frame")
                    continue
                if isinstance(msg, ClientStop):
                    break
                if isinstance(msg, AudioFrame):
                    await self.upstream.send(json.dumps({"realtimeInput": {"audio": msg.data}}))
                elif isinstance(msg, ClientText):
                    await self.upstream.send(json.dumps({"realtimeInput": {"text": msg.text}}))
                elif isinstance(msg, ClientToolResponse):
                    # CES requires the `tool` resource path on the response
                    # (despite the proto marking it as part of a oneof;
                    # verified empirically — omitting it gets the frame
                    # rejected with `invalid_argument: BadRequest` and the
                    # upstream WS is closed). Look up the resource from the
                    # in-flight map populated when the matching tool_call
                    # was forwarded to the browser.
                    #
                    # The outer wrap is double-nested because CES's
                    # SessionInput.tool_responses field is the ToolResponses
                    # *wrapper message* with its own `tool_responses` array
                    # inside; a flat array at the outer key is rejected
                    # with `Unknown name "toolResponses" at 'realtime_input'`.
                    entry: dict[str, Any] = {
                        "id": msg.id,
                        "response": msg.response,
                    }
                    tool_resource = self._in_flight_calls.pop(msg.id, "")
                    if tool_resource:
                        entry["tool"] = tool_resource
                    await self.upstream.send(json.dumps({
                        "realtimeInput": {
                            "toolResponses": {"toolResponses": [entry]}
                        }
                    }))
                elif isinstance(msg, ClientStart):
                    # Already handled in run().
                    pass
        except asyncio.CancelledError:
            pass
        finally:
            await self.upstream.close()

    async def _pump_upstream_to_browser(self) -> None:
        async for raw in self.upstream:
            try:
                frame: dict[str, Any] = json.loads(raw)
            except json.JSONDecodeError:
                log.warning("dropping non-JSON upstream frame")
                continue
            # Record each tool_call's (id → tool_resource) so the matching
            # ToolResponse from the browser can be enriched with the
            # `tool` field CES requires.
            so = frame.get("sessionOutput", {})
            if "toolCalls" in so:
                for call in so["toolCalls"].get("toolCalls", []):
                    cid = call.get("id", "")
                    tool = call.get("tool", "")
                    if cid and tool:
                        self._in_flight_calls[cid] = tool
            for out in _translate_upstream(frame):
                await self.browser.send_text(serialize_server_msg(out))


def _translate_upstream(frame: dict[str, Any]):
    if "sessionOutput" in frame:
        out = frame["sessionOutput"]
        if "audio" in out and out["audio"]:
            yield AudioFrame(type="audio", data=out["audio"])
        if "text" in out and out["text"]:
            yield ServerText(text=out["text"])
        if "toolCalls" in out:
            for call in out["toolCalls"].get("toolCalls", []):
                # CES sends `displayName` (e.g. `navigate_to`) right on the
                # ToolCall alongside the resource path. The frontend
                # clientFunctions registry is keyed by displayName, so use
                # that. Fall back to the resource tail (the tool's UUID)
                # only if displayName is somehow missing — the frontend
                # will surface `unknown_function` rather than silently
                # dropping the call.
                tool_resource = call.get("tool", "")
                display_name = (
                    call.get("displayName")
                    or (tool_resource.rsplit("/", 1)[-1] if tool_resource else "")
                )
                yield ServerClientFunction(
                    id=call.get("id", ""),
                    name=display_name,
                    args=call.get("args", {}),
                )
    if "recognitionResult" in frame:
        rr = frame["recognitionResult"]
        text = rr.get("transcript", "")
        if text:
            yield ServerTranscript(text=text, isFinal=bool(rr.get("isFinal", False)))
    if "interruptionSignal" in frame:
        yield ServerInterrupt()
    if "endSession" in frame:
        yield ServerEnd()
