"""Browser ↔ proxy WebSocket message types.

Mirrors ``cloudbank/web/src/agent/protocol.ts``. All client-function round-trip
messages (``ClientToolResponse`` / ``ServerClientFunction``) have been removed:
screen state flows strictly server-to-browser via ``ServerUiState``.
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
    TypeAdapter,
    ValidationError,
    field_validator,
)

Persona = Literal["chloe", "david", "tom", "sarah"]

# Cap on a single inbound browser frame (100ms 16 kHz PCM16 is ~4.3 KB base64;
# ClientStart with a 15 KB customer_snapshot is <32 KB).
MAX_CLIENT_FRAME_BYTES = 1024 * 1024
_MAX_AUDIO_B64_LEN = MAX_CLIENT_FRAME_BYTES
_MAX_TEXT_LEN = 8192


# ── Client → Proxy ──────────────────────────────────────────────────────────


class ClientStart(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["start"]
    persona: Persona
    variables: dict[str, Any]
    sessionId: str | None = None


class AudioFrame(BaseModel):
    """Used in both directions; ``type='audio'``."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["audio"] = "audio"
    data: str = Field(min_length=1, max_length=_MAX_AUDIO_B64_LEN)

    @field_validator("data")
    @classmethod
    def _validate_base64(cls, value: str) -> str:
        try:
            decoded = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("audio data must be valid standard base64") from exc
        if not decoded:
            raise ValueError("audio data must not decode to empty bytes")
        return value


class ClientText(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["text"]
    text: str = Field(max_length=_MAX_TEXT_LEN)


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


# ── Proxy → Client ──────────────────────────────────────────────────────────


class ServerReady(BaseModel):
    type: Literal["ready"] = "ready"
    sessionId: str


class ServerTranscript(BaseModel):
    type: Literal["transcript"] = "transcript"
    text: str
    isFinal: bool = False


class ServerText(BaseModel):
    type: Literal["text"] = "text"
    text: str
    partial: bool = False


class ServerUiState(BaseModel):
    type: Literal["ui_state"] = "ui_state"
    state: dict[str, Any]
    tier: Literal[1, 2, 3] = 1


class ServerTurnDiagnostics(BaseModel):
    type: Literal["turn_diagnostics"] = "turn_diagnostics"
    turnIndex: int | None = None
    agentTransfers: list[dict[str, Any]] = Field(default_factory=list)
    toolCalls: list[dict[str, Any]] = Field(default_factory=list)
    toolResponses: list[dict[str, Any]] = Field(default_factory=list)
    updatedVariables: dict[str, Any] = Field(default_factory=dict)
    rootSpan: dict[str, Any] | None = None


class ServerSearchSuggestions(BaseModel):
    type: Literal["search_suggestions"] = "search_suggestions"
    htmls: list[str] = Field(default_factory=list)
    webSearchQueries: list[str] = Field(default_factory=list)
    citations: list[dict[str, Any]] = Field(default_factory=list)


class ServerTurnComplete(BaseModel):
    type: Literal["turn_complete"] = "turn_complete"
    turnIndex: int | None = None


class ServerGoAway(BaseModel):
    type: Literal["go_away"] = "go_away"
    sessionId: str


class ServerSessionExpired(BaseModel):
    type: Literal["session_expired"] = "session_expired"
    message: str = "Session paused due to inactivity"


class ServerInterrupt(BaseModel):
    type: Literal["interrupt"] = "interrupt"


class ServerEnd(BaseModel):
    type: Literal["end"] = "end"


class ServerError(BaseModel):
    type: Literal["error"] = "error"
    message: str
    field: str | None = None


ServerMsg = (
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
    | ServerError
)


def serialize_server_msg(msg: ServerMsg) -> str:
    return json.dumps(
        msg.model_dump(mode="json", exclude_none=True),
        separators=(",", ":"),
    )
