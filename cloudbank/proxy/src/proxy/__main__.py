"""CLI entrypoint launching the localhost BidiRunSession proxy via Uvicorn."""
from __future__ import annotations

import os

import uvicorn

from .protocol import MAX_CLIENT_FRAME_BYTES

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765


def _parse_port(raw: str | None) -> int:
    if not raw:
        return DEFAULT_PORT
    try:
        port = int(raw)
    except ValueError:
        return DEFAULT_PORT
    return port if 1 <= port <= 65535 else DEFAULT_PORT


def main() -> None:
    host = os.environ.get("PROXY_HOST", DEFAULT_HOST).strip() or DEFAULT_HOST
    port = _parse_port(os.environ.get("PROXY_PORT"))
    uvicorn.run(
        "proxy.main:app",
        host=host,
        port=port,
        ws_max_size=MAX_CLIENT_FRAME_BYTES,
    )


if __name__ == "__main__":
    main()
