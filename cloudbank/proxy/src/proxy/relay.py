"""Bidirectional frame relay between the browser and CX Agent Studio (GECX) BidiRunSession.

Responsibilities:
1. Send initial `BidiSessionClientMessage.config` and server-owned seed
   `realtimeInput.variables` on new sessions (skipping variable re-seeding on
   resumed sessions), then emit `ServerReady(sessionId=...)`.
2. Relay browser `audio` and `text` frames to `BidiRunSession` `realtimeInput`.
3. Stream a 10-second `16 kHz` `LINEAR16` silence keepalive so upstream does not
   drop quiet turns, while enforcing a separate `max_idle_seconds` (default
   `900` seconds) inactivity timeout that emits `ServerSessionExpired`.
4. Extract and deduplicate 3-tier `ui_view_state` updates across
   `sessionOutput.payload` (Tier 1 `partial` and Tier 2 final) and
   `sessionOutput.diagnosticInfo.messages[].chunks[].updatedVariables` on
   `turnCompleted=True` (Tier 3 fallback), tracked monotonically via `_max_ui_seq`
   (initialized from `start.lastUiSeq` when resuming after `GoAway`).
5. Forward `ServerSearchSuggestions`, `ServerTurnDiagnostics`,
   `ServerTurnComplete`, `ServerGoAway`, and drain trailing farewell audio
   before emitting `ServerEnd`.
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
from collections.abc import AsyncIterator, Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Protocol

import jsonschema

from .protocol import (
    MAX_CLIENT_FRAME_BYTES,
    AudioFrame,
    BinaryFrameError,
    BrowserDisconnectError,
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


def _pick(mapping: Mapping[str, Any], camel: str, snake: str) -> Any:
    """Return `mapping[camel]` if present and non-None, else `mapping.get(snake)`."""
    val = mapping.get(camel)
    return val if val is not None else mapping.get(snake)


def _has_any(mapping: Mapping[str, Any], *keys: str) -> bool:
    """Return True when at least one key is present in `mapping`."""
    return any(key in mapping for key in keys)


def _unwrap_exception_group(eg: BaseExceptionGroup[Exception]) -> Exception:
    """Select the primary leaf exception from a TaskGroup ExceptionGroup."""
    leaves: list[Exception] = []

    def _collect(group: BaseExceptionGroup[Exception]) -> None:
        for exc in group.exceptions:
            if isinstance(exc, BaseExceptionGroup):
                _collect(exc)
            else:
                leaves.append(exc)

    _collect(eg)
    for exc in leaves:
        if isinstance(exc, BinaryFrameError):
            return exc
    return leaves[0]


@functools.lru_cache(maxsize=1)
def _ui_view_validator() -> jsonschema.Draft7Validator:
    schema = json.loads(_UI_VIEW_SCHEMA_PATH.read_text(encoding="utf-8"))
    jsonschema.Draft7Validator.check_schema(schema)
    return jsonschema.Draft7Validator(schema)


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


class BrowserSocket(Protocol):
    async def receive_text(self) -> str: ...
    async def send_text(self, raw: str) -> None: ...
    async def close(self) -> None: ...


class UpstreamSocket(Protocol):
    async def send(self, raw: str) -> None: ...
    def __aiter__(self) -> AsyncIterator[str]: ...
    async def close(self) -> None: ...


@dataclass
class Relay:
    browser: BrowserSocket
    upstream: UpstreamSocket
    app_resource: str
    session_id: str
    persona_variables: dict[str, Any] | None = None
    keepalive_interval_seconds: float = 10.0
    max_idle_seconds: float = 900.0

    ended_cleanly: bool = field(default=False, init=False)
    _max_ui_seq: int = field(default=0, init=False)
    _turn_in_progress: bool = field(default=False, init=False)
    _pending_end_session: bool = field(default=False, init=False)
    _end_emitted: bool = field(default=False, init=False)
    _closing: asyncio.Event = field(default_factory=asyncio.Event, init=False)
    _tasks: list[asyncio.Task[None]] = field(default_factory=list, init=False)
    _last_activity_monotonic: float = field(default_factory=time.monotonic, init=False)
    _last_upstream_send_monotonic: float = field(
        default_factory=time.monotonic, init=False
    )

    def _stop_siblings(self) -> None:
        self._closing.set()
        current = asyncio.current_task()
        for task in self._tasks:
            if task is not current and not task.done():
                task.cancel()

    async def run(self, *, start: ClientStart) -> None:
        now = time.monotonic()
        self._closing = asyncio.Event()
        self._tasks = []
        self._last_activity_monotonic = now
        self._last_upstream_send_monotonic = now

        is_resume = bool(start.sessionId)
        self._max_ui_seq = (start.lastUiSeq or 0) if is_resume else 0

        await self._send_initial_config()
        if not is_resume and self.persona_variables is not None:
            await self._send_upstream(
                {"realtimeInput": {"variables": self.persona_variables}}
            )
        log.info(
            "relay starting for persona=%s session=%s resume=%s",
            start.persona,
            self.session_id,
            is_resume,
        )
        await self.browser.send_text(
            serialize_server_msg(ServerReady(sessionId=self.session_id))
        )

        try:
            async with asyncio.TaskGroup() as tg:
                self._tasks.append(tg.create_task(self._pump_upstream_to_browser()))
                self._tasks.append(tg.create_task(self._pump_browser_to_upstream()))
                self._tasks.append(tg.create_task(self._keepalive_loop()))
                self._tasks.append(tg.create_task(self._idle_watchdog_loop()))
        except BaseExceptionGroup as eg:
            if isinstance(eg, ExceptionGroup):
                raise _unwrap_exception_group(eg) from None
            raise

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
        while not self._closing.is_set():
            try:
                async with asyncio.timeout(self.keepalive_interval_seconds):
                    await self._closing.wait()
                    return
            except TimeoutError:
                elapsed = time.monotonic() - self._last_upstream_send_monotonic
                if elapsed >= self.keepalive_interval_seconds * 0.9:
                    await self._send_upstream(
                        {"realtimeInput": {"audio": SILENCE_100MS_16KHZ_B64}}
                    )

    async def _idle_watchdog_loop(self) -> None:
        """Close idle sessions cleanly with ServerSessionExpired after max_idle_seconds."""
        while not self._closing.is_set():
            remaining = self.max_idle_seconds - (
                time.monotonic() - self._last_activity_monotonic
            )
            if remaining <= 0:
                self.ended_cleanly = True
                await self.browser.send_text(
                    serialize_server_msg(ServerSessionExpired())
                )
                await self.browser.close()
                await self.upstream.close()
                self._stop_siblings()
                return
            try:
                async with asyncio.timeout(remaining):
                    await self._closing.wait()
                    return
            except TimeoutError:
                continue

    async def _pump_browser_to_upstream(self) -> None:
        try:
            while not self._closing.is_set():
                try:
                    raw = await self.browser.receive_text()
                except BrowserDisconnectError:
                    self.ended_cleanly = True
                    break
                if len(raw.encode("utf-8")) > MAX_CLIENT_FRAME_BYTES:
                    log.warning(
                        "dropping oversized client frame (%d utf-8 bytes)",
                        len(raw.encode("utf-8")),
                    )
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
        finally:
            await self.upstream.close()
            self._stop_siblings()

    async def _pump_upstream_to_browser(self) -> None:
        try:
            async for raw in self.upstream:
                try:
                    frame: dict[str, Any] = json.loads(raw)
                except json.JSONDecodeError:
                    log.warning("dropping non-JSON upstream frame")
                    continue

                if _has_any(
                    frame,
                    "sessionOutput",
                    "session_output",
                    "recognitionResult",
                    "recognition_result",
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
            self._stop_siblings()

    def _maybe_emit_ui_state(
        self, raw_state: Any, tier: Literal[1, 2, 3]
    ) -> ServerUiState | None:
        parsed = _normalize_ui_view_state(raw_state)
        if parsed is None:
            return None
        seq_int, cleaned = parsed
        if seq_int <= self._max_ui_seq:
            return None
        self._max_ui_seq = seq_int
        return ServerUiState(state=cleaned, tier=tier)

    def _translate_upstream(self, frame: dict[str, Any]) -> Iterator[ServerMsg]:
        so = _pick(frame, "sessionOutput", "session_output")
        has_end_session = _has_any(frame, "endSession", "end_session")

        if isinstance(so, dict):
            turn_completed = bool(_pick(so, "turnCompleted", "turn_completed"))
            raw_turn_idx = _pick(so, "turnIndex", "turn_index")
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

            diag = _pick(so, "diagnosticInfo", "diagnostic_info")
            if turn_completed and isinstance(diag, dict):
                diag_msg, latest_tier3_ui, diag_ended = _extract_turn_diagnostics(
                    diag, turn_idx
                )
                if diag_ended:
                    has_end_session = True
                if latest_tier3_ui is not None:
                    tier3_msg = self._maybe_emit_ui_state(latest_tier3_ui, tier=3)
                    if tier3_msg is not None:
                        yield tier3_msg
                if diag_msg is not None:
                    yield diag_msg

            if _has_any(so, "endSession", "end_session"):
                has_end_session = True

            if turn_completed:
                self._turn_in_progress = False
                yield ServerTurnComplete(turnIndex=turn_idx)
                if self._pending_end_session and not self._end_emitted:
                    self._pending_end_session = False
                    self._end_emitted = True
                    self.ended_cleanly = True
                    yield ServerEnd()

        rr = _pick(frame, "recognitionResult", "recognition_result")
        if isinstance(rr, dict):
            transcript = rr.get("transcript", "")
            if isinstance(transcript, str) and transcript:
                is_final = bool(_pick(rr, "isFinal", "is_final"))
                yield ServerTranscript(text=transcript, isFinal=is_final)

        if _has_any(frame, "interruptionSignal", "interruption_signal"):
            self._turn_in_progress = False
            yield ServerInterrupt()

        if _has_any(frame, "goAway", "go_away"):
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
    gss = _pick(so, "googleSearchSuggestions", "google_search_suggestions")
    cit = so.get("citations")

    htmls: list[str] = []
    queries: list[str] = []
    citations: list[dict[str, Any]] = []

    if isinstance(gss, dict):
        for h in gss.get("htmls") or []:
            if isinstance(h, str) and h.strip():
                htmls.append(h)
        raw_queries = _pick(gss, "webSearchQueries", "web_search_queries") or []
        for q in raw_queries:
            if isinstance(q, str) and q.strip():
                queries.append(q)

    if isinstance(cit, dict):
        chunks = _pick(cit, "citedChunks", "cited_chunks") or []
        for item in chunks:
            if isinstance(item, dict):
                citations.append(item)
        inline = _pick(cit, "inlineCitations", "inline_citations") or []
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
) -> tuple[ServerTurnDiagnostics | None, Any, bool]:
    transfers: list[dict[str, Any]] = []
    latest_ui_view: Any = None
    saw_end_session = False

    for message in diag.get("messages") or []:
        if not isinstance(message, dict):
            continue
        for chunk in message.get("chunks") or []:
            if not isinstance(chunk, dict):
                continue
            xfer = _pick(chunk, "agentTransfer", "agent_transfer")
            if isinstance(xfer, dict):
                safe_xfer = {
                    k: v
                    for k, v in xfer.items()
                    if k in ("targetAgent", "target_agent", "displayName", "display_name")
                    and isinstance(v, str)
                }
                if safe_xfer:
                    transfers.append(safe_xfer)
            tc = _pick(chunk, "toolCall", "tool_call")
            if isinstance(tc, dict):
                tc_name = str(
                    _pick(tc, "displayName", "display_name")
                    or tc.get("tool")
                    or ""
                )
                if tc_name == "end_session" or tc_name.endswith("/tools/end_session"):
                    saw_end_session = True
            uv = _pick(chunk, "updatedVariables", "updated_variables")
            if isinstance(uv, dict):
                if "ui_view_state" in uv:
                    latest_ui_view = uv["ui_view_state"]
                if uv.get("call_complete") == "released":
                    saw_end_session = True

    if not transfers:
        return None, latest_ui_view, saw_end_session

    return (
        ServerTurnDiagnostics(
            turnIndex=turn_index,
            agentTransfers=transfers,
        ),
        latest_ui_view,
        saw_end_session,
    )
