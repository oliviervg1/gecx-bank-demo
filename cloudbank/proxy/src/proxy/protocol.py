"""Browser ↔ proxy WebSocket message types.

Mirrors cloudbank/web/src/agent/protocol.ts. Any change here must land there
too — the contract is symmetric.
"""
from __future__ import annotations

import json
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, TypeAdapter, ValidationError

Persona = Literal["chloe", "david", "tom", "sarah"]

# Cap on a single inbound browser frame. Audio arrives as small base64 PCM16
# chunks (a 100ms 16 kHz frame is ~4 KB), so 1 MiB is generous. Callers check
# this before parsing; the field limits below bound the parsed payloads too.
MAX_CLIENT_FRAME_BYTES = 1024 * 1024
_MAX_AUDIO_B64_LEN = MAX_CLIENT_FRAME_BYTES
_MAX_TEXT_LEN = 8192


# Client → proxy
class ClientStart(BaseModel):
    type: Literal["start"]
    persona: Persona
    # Session variables forwarded to CES as setSessionState entries.
    # The client (web) computes them from the persona fixture and sends
    # them on every start frame — the proxy is a dumb relay.
    variables: dict[str, str]


class AudioFrame(BaseModel):
    """Used in both directions; type='audio'."""
    type: Literal["audio"]
    data: str = Field(max_length=_MAX_AUDIO_B64_LEN)  # base64 PCM16


class ClientText(BaseModel):
    type: Literal["text"]
    text: str = Field(max_length=_MAX_TEXT_LEN)


class ClientToolResponse(BaseModel):
    type: Literal["tool_response"]
    id: str
    response: dict[str, Any]  # {"output": {...}} or {"error": "..."}


class ClientStop(BaseModel):
    type: Literal["stop"]


ClientMsg = Annotated[
    ClientStart | AudioFrame | ClientText | ClientToolResponse | ClientStop,
    Field(discriminator="type"),
]

_client_adapter: TypeAdapter[ClientMsg] = TypeAdapter(ClientMsg)


_UNKNOWN_TYPE_CODES = {"union_tag_invalid", "union_tag_not_found"}


def parse_client_msg(raw: str) -> ClientMsg:
    try:
        return _client_adapter.validate_json(raw)
    except ValidationError as exc:
        # Surface a friendly error when the `type` discriminator is unknown,
        # so callers don't have to inspect Pydantic's internal error model.
        for err in exc.errors():
            if err["type"] in _UNKNOWN_TYPE_CODES:
                raise ValueError("unknown client message") from exc
        raise ValueError(str(exc)) from exc


# Proxy → client
class ServerReady(BaseModel):
    type: Literal["ready"] = "ready"


class ServerTranscript(BaseModel):
    type: Literal["transcript"] = "transcript"
    text: str
    isFinal: bool = False


class ServerText(BaseModel):
    type: Literal["text"] = "text"
    text: str


class ServerClientFunction(BaseModel):
    type: Literal["client_function"] = "client_function"
    id: str
    name: str
    args: dict[str, Any]


class ServerInterrupt(BaseModel):
    type: Literal["interrupt"] = "interrupt"


class ServerEnd(BaseModel):
    type: Literal["end"] = "end"


class ServerError(BaseModel):
    type: Literal["error"] = "error"
    message: str


ServerMsg = (
    ServerReady | ServerTranscript | ServerText | AudioFrame
    | ServerClientFunction | ServerInterrupt | ServerEnd | ServerError
)


def serialize_server_msg(msg: ServerMsg) -> str:
    return json.dumps(msg.model_dump(mode="json"), separators=(",", ":"))
