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
    ValidationInfo,
    field_validator,
)
from pydantic_core import PydanticCustomError

Persona = Literal["chloe", "david", "tom", "sarah"]
TimeOfDay = Literal["morning", "afternoon", "evening"]

# Cap on a single inbound browser frame (1 MiB outer envelope; 64 KiB PCM16 = 87,384 base64 chars).
MAX_CLIENT_FRAME_BYTES = 1024 * 1024
MAX_AUDIO_B64_LEN = 87_384
_MAX_AUDIO_B64_LEN = MAX_AUDIO_B64_LEN
_MAX_SERVER_AUDIO_B64_LEN = 4 * 1024 * 1024
_MAX_TEXT_LEN = 8192


class BinaryFrameError(ValueError):
    """Raised when a client sends an unsupported binary WebSocket frame."""


class BrowserDisconnectError(Exception):
    """Raised when the browser WebSocket closes cleanly."""


class ClientProtocolError(ValueError):
    """Raised when an inbound client JSON message fails schema/protocol validation."""

    def __init__(
        self,
        detail: str,
        *,
        client_message: str = "malformed client message",
        field: str | None = None,
    ) -> None:
        self.client_message = client_message
        self.field = field
        super().__init__(detail)


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
    data: StrictStr = Field(min_length=1, max_length=_MAX_SERVER_AUDIO_B64_LEN)

    @field_validator("data")
    @classmethod
    def _validate_base64(cls, value: str, info: ValidationInfo) -> str:
        is_server = isinstance(info.context, dict) and info.context.get("direction") == "server"
        if not is_server and len(value) > _MAX_AUDIO_B64_LEN:
            raise PydanticCustomError(
                "string_too_long",
                "String should have at most {max_length} characters",
                {"max_length": _MAX_AUDIO_B64_LEN},
            )
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
_SAFE_CLIENT_FIELDS = frozenset(
    {"type", "persona", "timeOfDay", "demoDate", "sessionId", "lastUiSeq", "data", "text"}
)


def _classify_validation_error(exc: ValidationError) -> tuple[str, str | None]:
    """Derive a safe client-facing message and field name from a ValidationError."""
    errors = exc.errors()
    for err in errors:
        if err["type"] in _UNKNOWN_TYPE_CODES:
            return "unknown client message", "type"
        if err["type"] == "json_invalid":
            return "malformed client message", None

    if errors:
        first = errors[0]
        err_type = first["type"]
        loc_strs = [str(part) for part in first.get("loc", ()) if isinstance(part, str)]
        field = next(
            (part for part in reversed(loc_strs) if part in _SAFE_CLIENT_FIELDS),
            None,
        )
        if err_type == "string_too_long" and field == "text":
            return "text exceeds maximum length", "text"
        if err_type == "string_too_long" and field == "data":
            return "audio frame exceeds maximum length", "data"
        if field == "data":
            return "invalid audio frame", "data"
        if field is not None:
            return f"invalid {field}", field
    return "malformed client message", None


def parse_client_msg(raw: str) -> ClientMsg:
    try:
        return _client_adapter.validate_json(raw)
    except ValidationError as exc:
        client_message, field = _classify_validation_error(exc)
        if client_message == "unknown client message":
            raise ClientProtocolError(
                "unknown client message",
                client_message=client_message,
                field=field,
            ) from exc
        raise ClientProtocolError(
            str(exc),
            client_message=client_message,
            field=field,
        ) from exc


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
        return _server_adapter.validate_json(raw, context={"direction": "server"})
    except ValidationError as exc:
        raise ValueError(str(exc)) from exc


def serialize_server_msg(msg: ServerMsg) -> str:
    return json.dumps(
        msg.model_dump(mode="json", exclude_none=True),
        separators=(",", ":"),
    )
