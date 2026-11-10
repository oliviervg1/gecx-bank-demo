"""Bidirectional frame relay between the browser and CES BidiRunSession.

Responsibilities:
1. Send initial ``BidiSessionClientMessage.config`` and validated seed
   ``realtimeInput.variables`` to CES, then emit ``ServerReady(sessionId=...)``.
2. Relay browser ``audio`` and ``text`` frames to CES ``realtimeInput``.
3. Stream a 10-second ``16 kHz`` ``LINEAR16`` silence keepalive so CES does not
   drop quiet turns, while enforcing a separate ``max_idle_seconds`` (default
   ``900`` seconds) inactivity timeout that emits ``ServerSessionExpired``.
4. Extract and deduplicate 3-tier ``ui_view_state`` updates across
   ``sessionOutput.payload`` (Tier 1 ``partial`` & Tier 2 final) and
   ``sessionOutput.diagnosticInfo.messages[].chunks[].updatedVariables`` on
   ``turnCompleted=True`` (Tier 3 fallback), keyed by ``(session_id, trunc(seq))``.
5. Forward ``ServerSearchSuggestions``, ``ServerTurnDiagnostics``,
   ``ServerTurnComplete``, ``ServerGoAway``, and drain trailing farewell audio
   before emitting ``ServerEnd``.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import functools
import json
import logging
import math
import time
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Protocol

import jsonschema

from .protocol import (
    MAX_CLIENT_FRAME_BYTES,
    AudioFrame,
    ClientStart,
    ClientStop,
    ClientText,
    ServerEnd,
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
    serialize_server_msg,
)

log = logging.getLogger(__name__)

# 100 ms of 16 kHz mono 16-bit little-endian PCM silence (1,600 samples = 3,200 zero bytes).
SILENCE_100MS_16KHZ_BYTES = b"\x00" * 3200
SILENCE_100MS_16KHZ_B64 = base64.b64encode(SILENCE_100MS_16KHZ_BYTES).decode("ascii")

_UI_VIEW_SCHEMA_PATH = (
    Path(__file__).resolve().parents[3] / "shared" / "ui_view_state.schema.json"
)
_UI_INT_FIELDS = frozenset(
    {
        "seq",
        "extra_monthly_pence",
        "custom_target_pence",
        "monthly_overpayment_pence",
        "lump_sum_overpayment_pence",
    }
)


@functools.lru_cache(maxsize=1)
def _ui_view_validator() -> jsonschema.Draft7Validator:
    schema = json.loads(_UI_VIEW_SCHEMA_PATH.read_text(encoding="utf-8"))
    jsonschema.Draft7Validator.check_schema(schema)
    return jsonschema.Draft7Validator(schema)


def _drain_exceptions(tasks: list[asyncio.Task[None]]) -> list[BaseException]:
    """Retrieve exceptions from all completed non-cancelled tasks in order."""
    errors: list[BaseException] = []
    for task in tasks:
        if not task.done() or task.cancelled():
            continue
        exc = task.exception()
        if exc is not None:
            errors.append(exc)
    return errors


def _normalize_ui_view_state(raw: Any) -> tuple[int, dict[str, Any]] | None:
    """Coerce protobuf Struct floats on ui_view_state and validate against schema."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return None
    if not isinstance(raw, dict):
        return None

    raw_seq = raw.get("seq")
    if (
        isinstance(raw_seq, bool)
        or not isinstance(raw_seq, (int, float))
        or not math.isfinite(raw_seq)
    ):
        return None
    seq_int = math.trunc(float(raw_seq))
    if seq_int < 1:
        return None

    cleaned: dict[str, Any] = {}
    for key, val in raw.items():
        if key in _UI_INT_FIELDS:
            if (
                isinstance(val, bool)
                or not isinstance(val, (int, float))
                or not math.isfinite(val)
            ):
                return None
            cleaned[key] = math.trunc(float(val))
        else:
            cleaned[key] = val
    cleaned["seq"] = seq_int

    if not _ui_view_validator().is_valid(cleaned):
        log.warning("dropping schema-invalid ui_view_state payload")
        return None
    return seq_int, cleaned


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
    app_resource: str
    session_id: str
    persona_variables: dict[str, Any] | None = None
    keepalive_interval_seconds: float = 10.0
    max_idle_seconds: float = 900.0

    ended_cleanly: bool = field(default=False, init=False)
    _emitted_ui_keys: set[tuple[str, int]] = field(default_factory=set, init=False)
    _max_ui_seq: int = field(default=0, init=False)
    _turn_in_progress: bool = field(default=False, init=False)
    _pending_end_session: bool = field(default=False, init=False)
    _end_emitted: bool = field(default=False, init=False)
    _last_activity_monotonic: float = field(default_factory=time.monotonic, init=False)
    _last_upstream_send_monotonic: float = field(
        default_factory=time.monotonic, init=False
    )

    async def run(self, *, start: ClientStart) -> None:
        now = time.monotonic()
        self._last_activity_monotonic = now
        self._last_upstream_send_monotonic = now

        await self._send_initial_config()
        if self.persona_variables is not None:
            await self._send_upstream(
                {"realtimeInput": {"variables": self.persona_variables}}
            )
        log.info("relay starting for persona=%s session=%s", start.persona, self.session_id)
        await self.browser.send_text(
            serialize_server_msg(ServerReady(sessionId=self.session_id))
        )

        browser_pump = asyncio.create_task(self._pump_browser_to_upstream())
        upstream_pump = asyncio.create_task(self._pump_upstream_to_browser())
        keepalive_task = asyncio.create_task(self._keepalive_loop())
        idle_task = asyncio.create_task(self._idle_watchdog_loop())
        tasks = [upstream_pump, browser_pump, keepalive_task, idle_task]
        try:
            _done, pending = await asyncio.wait(
                tasks, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            errors = _drain_exceptions(tasks)
            if errors:
                raise errors[0]
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()

    async def _send_upstream(self, payload: dict[str, Any]) -> None:
        await self.upstream.send(json.dumps(payload))
        self._last_upstream_send_monotonic = time.monotonic()

    async def _send_initial_config(self) -> None:
        config = {
            "config": {
                "session": f"{self.app_resource}/sessions/{self.session_id}",
                "inputAudioConfig": {
                    "audioEncoding": "LINEAR16",
                    "sampleRateHertz": 16000,
                },
                "outputAudioConfig": {
                    "audioEncoding": "LINEAR16",
                    "sampleRateHertz": 24000,
                },
            }
        }
        await self._send_upstream(config)

    async def _keepalive_loop(self) -> None:
        """Send 100ms 16 kHz LINEAR16 silence every keepalive_interval_seconds when quiet."""
        try:
            while True:
                await asyncio.sleep(self.keepalive_interval_seconds)
                elapsed = time.monotonic() - self._last_upstream_send_monotonic
                if elapsed >= self.keepalive_interval_seconds * 0.9:
                    await self._send_upstream(
                        {"realtimeInput": {"audio": SILENCE_100MS_16KHZ_B64}}
                    )
        except asyncio.CancelledError:
            pass

    async def _idle_watchdog_loop(self) -> None:
        """Close idle sessions cleanly with ServerSessionExpired after max_idle_seconds."""
        try:
            while True:
                remaining = self.max_idle_seconds - (
                    time.monotonic() - self._last_activity_monotonic
                )
                if remaining <= 0:
                    self.ended_cleanly = True
                    await self.browser.send_text(
                        serialize_server_msg(ServerSessionExpired())
                    )
                    close_browser = getattr(self.browser, "close", None)
                    if callable(close_browser):
                        await close_browser()
                    await self.upstream.close()
                    return
                await asyncio.sleep(min(remaining, 1.0))
        except asyncio.CancelledError:
            pass

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
                    log.warning("dropping malformed client frame")
                    continue
                if isinstance(msg, ClientStop):
                    self.ended_cleanly = True
                    break
                if isinstance(msg, AudioFrame):
                    self._last_activity_monotonic = time.monotonic()
                    await self._send_upstream({"realtimeInput": {"audio": msg.data}})
                elif isinstance(msg, ClientText):
                    self._last_activity_monotonic = time.monotonic()
                    await self._send_upstream({"realtimeInput": {"text": msg.text}})
                elif isinstance(msg, ClientStart):
                    pass
        except asyncio.CancelledError:
            pass
        finally:
            await self.upstream.close()

    async def _pump_upstream_to_browser(self) -> None:
        try:
            async for raw in self.upstream:
                try:
                    frame: dict[str, Any] = json.loads(raw)
                except json.JSONDecodeError:
                    log.warning("dropping non-JSON upstream frame")
                    continue

                if (
                    "sessionOutput" in frame
                    or "session_output" in frame
                    or "recognitionResult" in frame
                    or "recognition_result" in frame
                ):
                    self._last_activity_monotonic = time.monotonic()

                for out_msg in self._translate_upstream(frame):
                    await self.browser.send_text(serialize_server_msg(out_msg))
        finally:
            if self._pending_end_session and not self._end_emitted:
                self._pending_end_session = False
                self._end_emitted = True
                with contextlib.suppress(Exception):
                    await self.browser.send_text(serialize_server_msg(ServerEnd()))

    def _maybe_emit_ui_state(
        self, raw_state: Any, tier: Literal[1, 2, 3]
    ) -> ServerUiState | None:
        parsed = _normalize_ui_view_state(raw_state)
        if parsed is None:
            return None
        seq_int, cleaned = parsed
        dedup_key = (self.session_id, seq_int)
        if seq_int <= self._max_ui_seq or dedup_key in self._emitted_ui_keys:
            return None
        self._max_ui_seq = seq_int
        self._emitted_ui_keys.add(dedup_key)
        return ServerUiState(state=cleaned, tier=tier)

    def _translate_upstream(self, frame: dict[str, Any]) -> Iterator[ServerMsg]:
        so = frame.get("sessionOutput") or frame.get("session_output")
        has_end_session = ("endSession" in frame) or ("end_session" in frame)

        if isinstance(so, dict):
            turn_completed = bool(
                so.get("turnCompleted") or so.get("turn_completed")
            )
            raw_turn_idx = so.get("turnIndex")
            if raw_turn_idx is None:
                raw_turn_idx = so.get("turn_index")
            turn_idx = (
                int(raw_turn_idx)
                if isinstance(raw_turn_idx, (int, float))
                and not isinstance(raw_turn_idx, bool)
                else None
            )

            audio_b64 = so.get("audio")
            if isinstance(audio_b64, str) and audio_b64:
                try:
                    audio_msg = AudioFrame(type="audio", data=audio_b64)
                except ValueError:
                    log.warning("dropping invalid base64 upstream audio frame")
                else:
                    self._turn_in_progress = True
                    yield audio_msg

            text_val = so.get("text")
            if isinstance(text_val, str) and text_val:
                self._turn_in_progress = True
                yield ServerText(text=text_val, partial=not turn_completed)

            if "payload" in so and so["payload"] is not None:
                tier: Literal[1, 2] = 2 if turn_completed else 1
                ui_msg = self._maybe_emit_ui_state(so["payload"], tier=tier)
                if ui_msg is not None:
                    yield ui_msg

            search_msg = _extract_search_suggestions(so)
            if search_msg is not None:
                yield search_msg

            diag = so.get("diagnosticInfo") or so.get("diagnostic_info")
            if turn_completed and isinstance(diag, dict):
                diag_msg, latest_tier3_ui = _extract_turn_diagnostics(
                    diag, turn_idx
                )
                if latest_tier3_ui is not None:
                    tier3_msg = self._maybe_emit_ui_state(latest_tier3_ui, tier=3)
                    if tier3_msg is not None:
                        yield tier3_msg
                if diag_msg is not None:
                    yield diag_msg

            if "endSession" in so or "end_session" in so:
                has_end_session = True

            if turn_completed:
                self._turn_in_progress = False
                yield ServerTurnComplete(turnIndex=turn_idx)
                if self._pending_end_session and not self._end_emitted:
                    self._pending_end_session = False
                    self._end_emitted = True
                    self.ended_cleanly = True
                    yield ServerEnd()

        rr = frame.get("recognitionResult") or frame.get("recognition_result")
        if isinstance(rr, dict):
            transcript = rr.get("transcript", "")
            if isinstance(transcript, str) and transcript:
                is_final = bool(rr.get("isFinal") or rr.get("is_final"))
                yield ServerTranscript(text=transcript, isFinal=is_final)

        if "interruptionSignal" in frame or "interruption_signal" in frame:
            self._turn_in_progress = False
            yield ServerInterrupt()

        if "goAway" in frame or "go_away" in frame:
            yield ServerGoAway(sessionId=self.session_id)

        if has_end_session and not self._end_emitted:
            self.ended_cleanly = True
            if self._turn_in_progress:
                # Hold end-of-session until trailing farewell TTS audio chunks complete.
                self._pending_end_session = True
            else:
                self._pending_end_session = False
                self._end_emitted = True
                yield ServerEnd()


def _extract_search_suggestions(so: dict[str, Any]) -> ServerSearchSuggestions | None:
    gss = so.get("googleSearchSuggestions") or so.get("google_search_suggestions")
    cit = so.get("citations")

    htmls: list[str] = []
    queries: list[str] = []
    citations: list[dict[str, Any]] = []

    if isinstance(gss, dict):
        for h in gss.get("htmls") or []:
            if isinstance(h, str) and h.strip():
                htmls.append(h)
        raw_queries = (
            gss.get("webSearchQueries") or gss.get("web_search_queries") or []
        )
        for q in raw_queries:
            if isinstance(q, str) and q.strip():
                queries.append(q)

    if isinstance(cit, dict):
        chunks = cit.get("citedChunks") or cit.get("cited_chunks") or []
        for item in chunks:
            if isinstance(item, dict):
                citations.append(item)
        inline = cit.get("inlineCitations") or cit.get("inline_citations") or []
        for item in inline:
            if isinstance(item, dict):
                citations.append(item)

    if not htmls and not queries and not citations:
        return None
    return ServerSearchSuggestions(
        htmls=htmls,
        webSearchQueries=queries,
        citations=citations,
    )


def _extract_turn_diagnostics(
    diag: dict[str, Any],
    turn_index: int | None,
) -> tuple[ServerTurnDiagnostics | None, Any]:
    transfers: list[dict[str, Any]] = []
    tool_calls: list[dict[str, Any]] = []
    tool_responses: list[dict[str, Any]] = []
    merged_vars: dict[str, Any] = {}
    latest_ui_view: Any = None

    for message in diag.get("messages") or []:
        if not isinstance(message, dict):
            continue
        for chunk in message.get("chunks") or []:
            if not isinstance(chunk, dict):
                continue
            xfer = chunk.get("agentTransfer") or chunk.get("agent_transfer")
            if isinstance(xfer, dict):
                transfers.append(xfer)
            tc = chunk.get("toolCall") or chunk.get("tool_call")
            if isinstance(tc, dict):
                tool_calls.append(tc)
            tr = chunk.get("toolResponse") or chunk.get("tool_response")
            if isinstance(tr, dict):
                tool_responses.append(tr)
            uv = chunk.get("updatedVariables") or chunk.get("updated_variables")
            if isinstance(uv, dict):
                if "ui_view_state" in uv:
                    latest_ui_view = uv["ui_view_state"]
                for k, v in uv.items():
                    if k != "customer_snapshot":
                        merged_vars[k] = v

    root_span = diag.get("rootSpan") or diag.get("root_span")
    clean_span = root_span if isinstance(root_span, dict) else None

    if (
        not transfers
        and not tool_calls
        and not tool_responses
        and not merged_vars
        and clean_span is None
    ):
        return None, latest_ui_view

    return (
        ServerTurnDiagnostics(
            turnIndex=turn_index,
            agentTransfers=transfers,
            toolCalls=tool_calls,
            toolResponses=tool_responses,
            updatedVariables=merged_vars,
            rootSpan=clean_span,
        ),
        latest_ui_view,
    )
