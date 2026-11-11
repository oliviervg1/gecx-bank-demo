"""Browser-to-proxy and proxy-to-browser WebSocket message types.

Matches `cloudbank/shared/ws_protocol.schema.json` and mirrors
`cloudbank/web/src/agent/protocol.ts`. Persona financial snapshots are owned
and loaded strictly on the server; client-function round-trip messages are
absent because screen state flows strictly server-to-browser via `ServerUiState`.
"""
from __future__ import annotations

import base64
import binascii
import json
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    TypeAdapter,
    ValidationError,
    field_validator,
)

Persona = Literal["chloe", "david", "tom", "sarah"]
TimeOfDay = Literal["morning", "afternoon", "evening"]

# Cap on a single inbound browser frame (1 MiB; 100ms 16 kHz PCM16 is ~4.3 KB base64).
MAX_CLIENT_FRAME_BYTES = 1024 * 1024
_MAX_AUDIO_B64_LEN = MAX_CLIENT_FRAME_BYTES
_MAX_TEXT_LEN = 8192


class BinaryFrameError(ValueError):
    """Raised when a client sends an unsupported binary WebSocket frame."""


class BrowserDisconnectError(Exception):
    """Raised when the browser WebSocket closes cleanly."""


# -- Client -> Proxy ----------------------------------------------------------


class ClientStart(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["start"]
    persona: Persona
    timeOfDay: TimeOfDay | None = None
    demoDate: StrictStr | None = None
    sessionId: StrictStr | None = Field(default=None, min_length=1)
    lastUiSeq: StrictInt | None = Field(default=None, ge=0)


class AudioFrame(BaseModel):
    """Base64-encoded 16-bit PCM audio frame used in both directions (`type='audio'`)."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["audio"] = "audio"
    data: StrictStr = Field(min_length=1, max_length=_MAX_AUDIO_B64_LEN)

    @field_validator("data")
    @classmethod
    def _validate_base64(cls, value: str) -> str:
        try:
            decoded = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("audio data must be valid standard base64") from exc
        if not decoded:
            raise ValueError("audio data must not decode to empty bytes")
        if len(decoded) % 2 != 0:
            raise ValueError("PCM16 audio data must have an even byte length")
        return value


class ClientText(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["text"]
    text: StrictStr = Field(max_length=_MAX_TEXT_LEN)


class ClientStop(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["stop"]


ClientMsg = Annotated[
    ClientStart | AudioFrame | ClientText | ClientStop,
    Field(discriminator="type"),
]

_client_adapter: TypeAdapter[ClientMsg] = TypeAdapter(ClientMsg)
_UNKNOWN_TYPE_CODES = {"union_tag_invalid", "union_tag_not_found"}


def parse_client_msg(raw: str) -> ClientMsg:
    try:
        return _client_adapter.validate_json(raw)
    except ValidationError as exc:
        for err in exc.errors():
            if err["type"] in _UNKNOWN_TYPE_CODES:
                raise ValueError("unknown client message") from exc
        raise ValueError(str(exc)) from exc


def serialize_client_msg(msg: ClientMsg) -> str:
    return json.dumps(
        msg.model_dump(mode="json", exclude_none=True),
        separators=(",", ":"),
    )


# -- Proxy -> Client ----------------------------------------------------------


class ServerReady(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["ready"] = "ready"
    sessionId: StrictStr = Field(min_length=1)


class ServerTranscript(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["transcript"] = "transcript"
    text: StrictStr
    isFinal: StrictBool = False


class ServerText(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["text"] = "text"
    text: StrictStr
    partial: StrictBool = False


class ServerUiState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["ui_state"] = "ui_state"
    state: dict[str, Any]
    tier: Literal[1, 2, 3] = 1


class ServerTurnDiagnostics(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["turn_diagnostics"] = "turn_diagnostics"
    turnIndex: StrictInt | None = None
    agentTransfers: list[dict[str, Any]] = Field(default_factory=list)


class ServerSearchSuggestions(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["search_suggestions"] = "search_suggestions"
    htmls: list[str] = Field(default_factory=list)
    webSearchQueries: list[str] = Field(default_factory=list)
    citations: list[dict[str, Any]] = Field(default_factory=list)


class ServerTurnComplete(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["turn_complete"] = "turn_complete"
    turnIndex: StrictInt | None = None


class ServerGoAway(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["go_away"] = "go_away"
    sessionId: StrictStr = Field(min_length=1)


class ServerSessionExpired(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["session_expired"] = "session_expired"
    message: StrictStr = "Session paused due to inactivity"


class ServerInterrupt(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["interrupt"] = "interrupt"


class ServerEnd(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["end"] = "end"


class ServerError(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["error"] = "error"
    message: StrictStr
    field: StrictStr | None = None


ServerMsg = Annotated[
    ServerReady
    | ServerTranscript
    | ServerText
    | AudioFrame
    | ServerUiState
    | ServerTurnDiagnostics
    | ServerSearchSuggestions
    | ServerTurnComplete
    | ServerGoAway
    | ServerSessionExpired
    | ServerInterrupt
    | ServerEnd
    | ServerError,
    Field(discriminator="type"),
]

_server_adapter: TypeAdapter[ServerMsg] = TypeAdapter(ServerMsg)


def parse_server_msg(raw: str) -> ServerMsg:
    try:
        return _server_adapter.validate_json(raw)
    except ValidationError as exc:
        raise ValueError(str(exc)) from exc


def serialize_server_msg(msg: ServerMsg) -> str:
    return json.dumps(
        msg.model_dump(mode="json", exclude_none=True),
        separators=(",", ":"),
    )
