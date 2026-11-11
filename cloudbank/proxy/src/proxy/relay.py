"""Bidirectional frame relay between the browser and CX Agent Studio (GECX) BidiRunSession.

Responsibilities:
1. Send initial `BidiSessionClientMessage.config` and server-owned seed
   `realtimeInput.variables` on new sessions (skipping variable re-seeding on
   verified resumed sessions), then emit `ServerReady(sessionId=...)`.
2. Relay browser `audio` and `text` frames to `BidiRunSession` `realtimeInput`,
   emitting non-closing `ServerError` frames on invalid client payloads and
   disconnecting with `1008` once malformed strikes reach `5`.
3. Stream a 10-second `16 kHz` `LINEAR16` silence keepalive so upstream does not
   drop quiet turns, while enforcing speech/transcript/output-only
   `max_idle_seconds` (default `900` seconds) and `max_session_seconds`
   (default `3600` seconds) watchdogs that emit `ServerSessionExpired`.
4. Extract and deduplicate 3-tier `ui_view_state` updates across
   `sessionOutput.payload` (Tier 1 `partial` and Tier 2 final) and
   `sessionOutput.diagnosticInfo.messages[].chunks[].updatedVariables` on
   `turnCompleted=True` (Tier 3 fallback), tracked monotonically via `_max_ui_seq`.
5. Sanitize outbound `ServerText` chunks (Composite v2 vocal tags,
   `[diagnosis context: ...]`, `<untrusted_web_snippet>` blocks), filter
   `ServerSearchSuggestions.citations` strictly to official HTTPS vendor help
   hosts, and drain trailing farewell audio before emitting `ServerEnd`.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import functools
import json
import logging
import math
import re
import time
import urllib.parse
from collections.abc import AsyncIterator, Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Protocol

from jsonschema.validators import validator_for

from .protocol import (
    MAX_CLIENT_FRAME_BYTES,
    AudioFrame,
    BinaryFrameError,
    BrowserDisconnectError,
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
    serialize_server_msg,
)

log = logging.getLogger(__name__)

# 100 ms of 16 kHz mono 16-bit little-endian PCM silence (1,600 samples = 3,200 zero bytes).
SILENCE_100MS_16KHZ_BYTES = b"\x00" * 3200
SILENCE_100MS_16KHZ_B64 = base64.b64encode(SILENCE_100MS_16KHZ_BYTES).decode("ascii")

MAX_MALFORMED_CLIENT_FRAMES = 5

_SHARED_DIR = Path(__file__).resolve().parents[3] / "shared"
_UI_VIEW_SCHEMA_PATH = _SHARED_DIR / "ui_view_state.schema.json"
_OFFICIAL_HELP_HOSTS_PATH = _SHARED_DIR / "official_help_hosts.json"
_COMPOSITE_TAGS_PATH = _SHARED_DIR / "composite_v2_tags.json"

_UI_INT_FIELDS = frozenset(
    {
        "seq",
        "extra_monthly_pence",
        "custom_target_pence",
        "monthly_overpayment_pence",
        "lump_sum_overpayment_pence",
    }
)

# Standalone built-in fallback matching `cloudbank/shared/official_help_hosts.json`.
_FALLBACK_OFFICIAL_HELP_HOSTS: frozenset[str] = frozenset(
    {
        "aviva.co.uk",
        "ee.co.uk",
        "help.audible.co.uk",
        "help.audible.com",
        "help.disneyplus.com",
        "help.giffgaff.com",
        "help.netflix.com",
        "help.nytimes.com",
        "help.ovoenergy.com",
        "helpx.adobe.com",
        "nationaltrust.org.uk",
        "octopus.energy",
        "puregym.com",
        "support.apple.com",
        "support.onepeloton.co.uk",
        "support.onepeloton.com",
        "support.spotify.com",
        "www.amazon.co.uk",
        "www.aviva.co.uk",
        "www.britishgas.co.uk",
        "www.bt.com",
        "www.nationaltrust.org.uk",
        "www.puregym.com",
        "www.sky.com",
    }
)

_AMAZON_HELP_PATH_PREFIXES: tuple[str, ...] = ("/gp/help", "/hz/contact-us")
_DEFAULT_RESTRICTED_HOST_PATHS: dict[str, tuple[str, ...]] = {
    "www.amazon.co.uk": _AMAZON_HELP_PATH_PREFIXES,
}

# Standalone built-in fallback matching `cloudbank/shared/composite_v2_tags.json` 1:1.
_FALLBACK_COMPOSITE_TAG_WORDS: frozenset[str] = frozenset(
    {
        "admiration",
        "adoration",
        "aggression",
        "agitation",
        "alarm",
        "amused",
        "amusement",
        "anger",
        "angry",
        "annoyance",
        "anxiety",
        "anxious",
        "apologetic",
        "apologetically",
        "argh",
        "audible",
        "awe",
        "beat",
        "bored",
        "breath",
        "breathe",
        "breathes",
        "breathing",
        "brief",
        "bright",
        "cackle",
        "cackles",
        "calm",
        "calmly",
        "cautious",
        "celebratory",
        "cheerful",
        "cheerfully",
        "chuckle",
        "chuckles",
        "clear",
        "clearly",
        "clears",
        "concerned",
        "confident",
        "confidently",
        "confused",
        "confusion",
        "conversational",
        "cough",
        "coughs",
        "cries",
        "cry",
        "crying",
        "curiosity",
        "curious",
        "curiously",
        "deadpan",
        "deep",
        "determination",
        "disgusted",
        "earnest",
        "empathetic",
        "empathetically",
        "encouraging",
        "enthusiasm",
        "enthusiastic",
        "excited",
        "excitedly",
        "excitement",
        "exhale",
        "exhales",
        "extremely",
        "fast",
        "faster",
        "fearful",
        "firm",
        "formal",
        "friendly",
        "frustrated",
        "frustration",
        "gasp",
        "gasps",
        "gentle",
        "gently",
        "giggle",
        "giggles",
        "grateful",
        "groan",
        "groans",
        "happy",
        "heavy",
        "hesitation",
        "hope",
        "inhale",
        "inhales",
        "interest",
        "kind",
        "laugh",
        "laughing",
        "laughs",
        "light",
        "lightly",
        "long",
        "low",
        "matter-of-fact",
        "measured",
        "medium",
        "natural",
        "negative",
        "nervousness",
        "neutral",
        "pace",
        "panic",
        "pant",
        "pants",
        "pause",
        "pauses",
        "polite",
        "politely",
        "positive",
        "professional",
        "quick",
        "quiet",
        "quietly",
        "reassuring",
        "reassuringly",
        "relaxed",
        "relief",
        "relieved",
        "robotic",
        "sad",
        "sarcasm",
        "scared",
        "serious",
        "seriously",
        "seriousness",
        "short",
        "shouting",
        "sigh",
        "sighing",
        "sighs",
        "sleepy",
        "slight",
        "slow",
        "slower",
        "slowly",
        "smile",
        "smiling",
        "sneeze",
        "sneezes",
        "snicker",
        "snickers",
        "snort",
        "snorts",
        "sob",
        "sobs",
        "soft",
        "softly",
        "speaking",
        "steady",
        "supportive",
        "surprised",
        "sympathetic",
        "tension",
        "thoughtful",
        "thoughtfully",
        "throat",
        "throat-clearing",
        "tone",
        "tsk",
        "uhm",
        "um",
        "understanding",
        "upbeat",
        "urgent",
        "voice",
        "warm",
        "warmly",
        "whimper",
        "whimpers",
        "whisper",
        "whispering",
        "whispers",
        "yawn",
        "yawns",
        "yelling",
    }
)

_PLATFORM_ENVELOPE_CLOSED_RE = re.compile(
    r"<\s*(?:state_update|context|event)\b[^>]*>.*?<\s*/\s*(?:state_update|context|event)\s*>",
    re.IGNORECASE | re.DOTALL,
)
_PLATFORM_ENVELOPE_UNCLOSED_RE = re.compile(
    r"<\s*(?:state_update|context|event)\b[^>]*>.*\Z",
    re.IGNORECASE | re.DOTALL,
)
_UNTRUSTED_SNIPPET_CLOSED_RE = re.compile(
    r"<\s*untrusted_web_snippet\b[^>]*>.*?<\s*/\s*untrusted_web_snippet\s*>",
    re.IGNORECASE | re.DOTALL,
)
_UNTRUSTED_SNIPPET_UNCLOSED_RE = re.compile(
    r"<\s*untrusted_web_snippet\b[^>]*>.*\Z",
    re.IGNORECASE | re.DOTALL,
)
_UNTRUSTED_SNIPPET_STRAY_CLOSE_RE = re.compile(
    r"<\s*/\s*untrusted_web_snippet\s*>",
    re.IGNORECASE,
)
_DIAGNOSIS_START_RE = re.compile(r"\[\s*diagnosis\s+context\s*:", re.IGNORECASE)
_PROSODY_OR_BREAK_TAG_RE = re.compile(
    r"<\s*/?\s*(?:prosody|break)\b[^>]*>",
    re.IGNORECASE,
)
_AGENT_TOKEN_RE = re.compile(r"\{@AGENT:\s*[A-Za-z0-9_]+\}", re.IGNORECASE)
_CANDIDATE_ANGLE_TAG_RE = re.compile(
    r"(?<![A-Za-z0-9])</?\s*([A-Za-z][A-Za-z-]*(?:\s+[A-Za-z][A-Za-z-]*){0,4})\s*/?>(?![A-Za-z0-9])"
)
_URL_CONTROL_OR_SPACE_RE = re.compile(r"[\x00-\x20\x7f]")


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
def _ui_view_validator() -> Any:
    schema = json.loads(_UI_VIEW_SCHEMA_PATH.read_text(encoding="utf-8"))
    validator_cls = validator_for(schema)
    validator_cls.check_schema(schema)
    return validator_cls(schema)


@functools.lru_cache(maxsize=1)
def _official_help_allowlist() -> tuple[frozenset[str], dict[str, tuple[str, ...]]]:
    """Load official HTTPS help hosts from shared JSON or standalone fallback."""
    path_rules: dict[str, tuple[str, ...]] = dict(_DEFAULT_RESTRICTED_HOST_PATHS)
    if not _OFFICIAL_HELP_HOSTS_PATH.is_file():
        return _FALLBACK_OFFICIAL_HELP_HOSTS, path_rules

    try:
        loaded = json.loads(_OFFICIAL_HELP_HOSTS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        log.warning("falling back to built-in official help hosts after read error")
        return _FALLBACK_OFFICIAL_HELP_HOSTS, path_rules

    hosts: set[str] = set()
    if isinstance(loaded, dict):
        raw_prefixes = loaded.get("path_prefixes")
        if isinstance(raw_prefixes, dict):
            for host_key, prefixes in raw_prefixes.items():
                if isinstance(host_key, str) and isinstance(prefixes, list):
                    valid_p = tuple(
                        p for p in prefixes if isinstance(p, str) and p.startswith("/")
                    )
                    if valid_p:
                        path_rules[host_key.strip().lower()] = valid_p

        vendors = loaded.get("vendors")
        if isinstance(vendors, dict):
            for entry in vendors.values():
                if isinstance(entry, list):
                    for item in entry:
                        if isinstance(item, str) and item.strip():
                            hosts.add(item.strip().lower())
                        elif isinstance(item, dict):
                            h = item.get("host")
                            if isinstance(h, str) and h.strip():
                                host_lc = h.strip().lower()
                                hosts.add(host_lc)
                                item_prefixes = item.get("path_prefixes")
                                if isinstance(item_prefixes, list):
                                    valid_p = tuple(
                                        p
                                        for p in item_prefixes
                                        if isinstance(p, str) and p.startswith("/")
                                    )
                                    if valid_p:
                                        path_rules[host_lc] = valid_p
                elif isinstance(entry, dict):
                    for h in entry.get("hosts") or []:
                        if isinstance(h, str) and h.strip():
                            host_lc = h.strip().lower()
                            hosts.add(host_lc)
                            entry_prefixes = entry.get("path_prefixes")
                            if isinstance(entry_prefixes, list):
                                valid_p = tuple(
                                    p
                                    for p in entry_prefixes
                                    if isinstance(p, str) and p.startswith("/")
                                )
                                if valid_p:
                                    path_rules[host_lc] = valid_p

    if not hosts:
        return _FALLBACK_OFFICIAL_HELP_HOSTS, path_rules
    return frozenset(hosts), path_rules


@functools.lru_cache(maxsize=1)
def _composite_tag_words() -> frozenset[str]:
    """Load Composite v2 vocal/emotion/pause words from shared JSON + fallback."""
    words: set[str] = set(_FALLBACK_COMPOSITE_TAG_WORDS)
    if not _COMPOSITE_TAGS_PATH.is_file():
        return frozenset(words)

    try:
        loaded = json.loads(_COMPOSITE_TAGS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        log.warning("falling back to built-in Composite v2 tag vocabulary")
        return frozenset(words)

    raw_items: list[Any] = []
    if isinstance(loaded, dict) and isinstance(loaded.get("words"), list):
        raw_items = loaded["words"]
    elif isinstance(loaded, list):
        raw_items = loaded

    for item in raw_items:
        if isinstance(item, str):
            for token in item.strip().lower().split():
                if token:
                    words.add(token)
    return frozenset(words)


def is_allowed_citation_url(raw_url: str) -> bool:
    """Return True strictly for official HTTPS vendor help URLs."""
    if not isinstance(raw_url, str):
        return False
    candidate = raw_url.strip()
    if (
        not candidate
        or len(candidate) > 2048
        or _URL_CONTROL_OR_SPACE_RE.search(candidate) is not None
    ):
        return False

    try:
        parsed = urllib.parse.urlsplit(candidate)
        port = parsed.port
    except ValueError:
        return False

    if parsed.scheme.lower() != "https":
        return False
    if parsed.username is not None or parsed.password is not None:
        return False
    if port not in (None, 443):
        return False

    # Require raw netloc hostname without trailing dot
    hostname = parsed.hostname
    if not hostname or hostname.endswith("."):
        return False
    host = hostname.lower()

    allowed_hosts, path_rules = _official_help_allowlist()
    if host not in allowed_hosts:
        return False

    raw_path = parsed.path or "/"
    unquoted_path = urllib.parse.unquote(raw_path)
    if "\\" in unquoted_path:
        return False
    if ".." in raw_path.split("/") or ".." in unquoted_path.split("/"):
        return False

    required_prefixes = path_rules.get(host)
    if required_prefixes is not None:
        return any(
            raw_path == prefix or raw_path.startswith(f"{prefix}/")
            for prefix in required_prefixes
        )
    return True


def _strip_diagnosis_blocks(text: str) -> str:
    """Strip bracket-balanced `[diagnosis context: ...]` notes case-insensitively."""
    cursor = 0
    chunks: list[str] = []
    n = len(text)
    while cursor < n:
        match = _DIAGNOSIS_START_RE.search(text, cursor)
        if match is None:
            chunks.append(text[cursor:])
            break
        start = match.start()
        chunks.append(text[cursor:start])
        depth = 0
        idx = start
        while idx < n:
            ch = text[idx]
            if ch == "[":
                depth += 1
            elif ch == "]":
                depth -= 1
                if depth == 0:
                    idx += 1
                    break
            idx += 1
        chunks.append(" ")
        cursor = idx
    return "".join(chunks)


def sanitize_server_text(raw: str) -> str:
    """Sanitize outbound assistant text before forwarding `ServerText` to clients."""
    if not raw:
        return ""

    cleaned = _PLATFORM_ENVELOPE_CLOSED_RE.sub(" ", raw)
    cleaned = _PLATFORM_ENVELOPE_UNCLOSED_RE.sub(" ", cleaned)
    cleaned = _UNTRUSTED_SNIPPET_CLOSED_RE.sub(" ", cleaned)
    cleaned = _UNTRUSTED_SNIPPET_UNCLOSED_RE.sub(" ", cleaned)
    cleaned = _UNTRUSTED_SNIPPET_STRAY_CLOSE_RE.sub(" ", cleaned)
    cleaned = _strip_diagnosis_blocks(cleaned)
    cleaned = _PROSODY_OR_BREAK_TAG_RE.sub(" ", cleaned)
    cleaned = _AGENT_TOKEN_RE.sub(" ", cleaned)

    vocab = _composite_tag_words()

    def _replace_angle_tag(match: re.Match[str]) -> str:
        inner_words = match.group(1).strip().lower().split()
        if inner_words and all(word in vocab for word in inner_words):
            return " "
        return match.group(0)

    cleaned = _CANDIDATE_ANGLE_TAG_RE.sub(_replace_angle_tag, cleaned)
    return " ".join(cleaned.split())


def _frame_has_meaningful_activity(frame: Mapping[str, Any]) -> bool:
    """Return True only for real speech recognition transcripts or model outputs."""
    rr = _pick(frame, "recognitionResult", "recognition_result")
    if isinstance(rr, dict):
        transcript = rr.get("transcript", "")
        if isinstance(transcript, str) and bool(transcript.strip()):
            return True

    so = _pick(frame, "sessionOutput", "session_output")
    if isinstance(so, dict):
        text_val = so.get("text")
        if isinstance(text_val, str) and bool(text_val.strip()):
            return True
        audio_val = so.get("audio")
        if isinstance(audio_val, str) and bool(audio_val):
            return True
        if so.get("payload") is not None:
            return True
        if bool(_pick(so, "turnCompleted", "turn_completed")):
            return True

    return False


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
    async def close(self, code: int = 1000) -> None: ...


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
    is_resume: bool | None = None
    keepalive_interval_seconds: float = 10.0
    max_idle_seconds: float = 900.0
    max_session_seconds: float = 3600.0

    ended_cleanly: bool = field(default=False, init=False)
    _max_ui_seq: int = field(default=0, init=False)
    _malformed_frame_strikes: int = field(default=0, init=False)
    _turn_in_progress: bool = field(default=False, init=False)
    _pending_end_session: bool = field(default=False, init=False)
    _end_emitted: bool = field(default=False, init=False)
    _closing: asyncio.Event = field(default_factory=asyncio.Event, init=False)
    _tasks: list[asyncio.Task[None]] = field(default_factory=list, init=False)
    _session_started_monotonic: float = field(default_factory=time.monotonic, init=False)
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
        self._malformed_frame_strikes = 0
        self._session_started_monotonic = now
        self._last_activity_monotonic = now
        self._last_upstream_send_monotonic = now

        resuming = (
            self.is_resume
            if self.is_resume is not None
            else (
                bool(start.sessionId)
                and start.sessionId.lower() == self.session_id.lower()
            )
        )
        self._max_ui_seq = (start.lastUiSeq or 0) if resuming else 0

        await self._send_initial_config()
        if not resuming and self.persona_variables is not None:
            await self._send_upstream(
                {"realtimeInput": {"variables": self.persona_variables}}
            )
        log.info(
            "relay starting for persona=%s session=%s resume=%s",
            start.persona,
            self.session_id,
            resuming,
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
        """Close sessions cleanly with ServerSessionExpired on idle or max lifetime."""
        while not self._closing.is_set():
            now = time.monotonic()
            idle_remaining = self.max_idle_seconds - (
                now - self._last_activity_monotonic
            )
            lifetime_remaining = self.max_session_seconds - (
                now - self._session_started_monotonic
            )
            if idle_remaining <= 0 or lifetime_remaining <= 0:
                self.ended_cleanly = True
                expiry_message = (
                    "Session paused due to inactivity"
                    if idle_remaining <= 0
                    else "Session maximum duration reached"
                )
                await self.browser.send_text(
                    serialize_server_msg(ServerSessionExpired(message=expiry_message))
                )
                await self.browser.close()
                await self.upstream.close()
                self._stop_siblings()
                return
            try:
                async with asyncio.timeout(min(idle_remaining, lifetime_remaining)):
                    await self._closing.wait()
                    return
            except TimeoutError:
                continue

    async def _record_malformed_client_frame(
        self,
        client_message: str,
        *,
        field: str | None = None,
    ) -> bool:
        """Emit a non-closing ServerError and return True once strikes reach 5."""
        self._malformed_frame_strikes += 1
        log.warning(
            "dropping invalid client frame (strike %d/%d): %s",
            self._malformed_frame_strikes,
            MAX_MALFORMED_CLIENT_FRAMES,
            client_message,
        )
        await self.browser.send_text(
            serialize_server_msg(ServerError(message=client_message, field=field))
        )
        if self._malformed_frame_strikes >= MAX_MALFORMED_CLIENT_FRAMES:
            self.ended_cleanly = True
            await self.browser.close(code=1008)
            return True
        return False

    async def _pump_browser_to_upstream(self) -> None:
        try:
            while not self._closing.is_set():
                try:
                    raw = await self.browser.receive_text()
                except BrowserDisconnectError:
                    self.ended_cleanly = True
                    break
                if len(raw.encode("utf-8")) > MAX_CLIENT_FRAME_BYTES:
                    if await self._record_malformed_client_frame("frame too large"):
                        break
                    continue
                try:
                    msg = parse_client_msg(raw)
                except ClientProtocolError as exc:
                    if await self._record_malformed_client_frame(
                        exc.client_message, field=exc.field
                    ):
                        break
                    continue
                except ValueError:
                    if await self._record_malformed_client_frame(
                        "malformed client message"
                    ):
                        break
                    continue
                if isinstance(msg, ClientStop):
                    self.ended_cleanly = True
                    break
                if isinstance(msg, AudioFrame):
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

                if _frame_has_meaningful_activity(frame):
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
                    audio_msg = AudioFrame.model_validate(
                        {"type": "audio", "data": audio_b64},
                        context={"direction": "server"},
                    )
                except ValueError:
                    log.warning("dropping invalid base64 upstream audio frame")
                else:
                    self._turn_in_progress = True
                    yield audio_msg

            text_val = so.get("text")
            if isinstance(text_val, str) and text_val:
                clean_text = sanitize_server_text(text_val)
                if clean_text:
                    self._turn_in_progress = True
                    yield ServerText(text=clean_text, partial=not turn_completed)

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


def _filter_citation_item(item: dict[str, Any]) -> dict[str, Any] | None:
    """Validate that a citation dict carries only official HTTPS help URLs."""
    uri_val = item.get("uri")
    url_val = item.get("url")
    if uri_val is None and url_val is None:
        return None
    if uri_val is not None and not (
        isinstance(uri_val, str) and is_allowed_citation_url(uri_val)
    ):
        return None
    if url_val is not None and not (
        isinstance(url_val, str) and is_allowed_citation_url(url_val)
    ):
        return None
    return item


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
                safe = _filter_citation_item(item)
                if safe is not None:
                    citations.append(safe)
        inline = _pick(cit, "inlineCitations", "inline_citations") or []
        for item in inline:
            if isinstance(item, dict):
                safe = _filter_citation_item(item)
                if safe is not None:
                    citations.append(safe)

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
