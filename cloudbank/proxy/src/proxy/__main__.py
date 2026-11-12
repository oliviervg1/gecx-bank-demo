"""CLI entrypoint launching the localhost BidiRunSession proxy via Uvicorn."""
from __future__ import annotations

import logging
import os

import uvicorn

from .main import DEFAULT_BIND_HOST, validate_runtime_security_config
from .protocol import MAX_CLIENT_FRAME_BYTES

DEFAULT_HOST = DEFAULT_BIND_HOST
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
    logging.basicConfig(level=logging.INFO)
    host = os.environ.get("PROXY_HOST", DEFAULT_HOST).strip() or DEFAULT_HOST
    port = _parse_port(os.environ.get("PROXY_PORT"))
    validate_runtime_security_config(bind_host=host)
    uvicorn.run(
        "proxy.main:app",
        host=host,
        port=port,
        ws_max_size=MAX_CLIENT_FRAME_BYTES,
        proxy_headers=False,
    )


if __name__ == "__main__":
    main()
