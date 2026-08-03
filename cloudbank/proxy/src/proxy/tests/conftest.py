"""Shared pytest fixtures for proxy tests."""
from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest


class FakeUpstream:
    """In-memory stand-in for a CES BidiRunSession WebSocket.

    `recv_from_proxy()` returns frames the proxy sent us (client→upstream).
    `inject(...)` lets the test push a server→client frame back to the proxy.
    """

    def __init__(self) -> None:
        self._to_proxy: asyncio.Queue[str | None] = asyncio.Queue()
        self._from_proxy: asyncio.Queue[str] = asyncio.Queue()
        self.closed = False

    # --- API the proxy.relay code uses ---
    async def send(self, raw: str) -> None:
        await self._from_proxy.put(raw)

    def __aiter__(self) -> FakeUpstream:
        return self

    async def __anext__(self) -> str:
        item = await self._to_proxy.get()
        if item is None:
            raise StopAsyncIteration
        return item

    async def close(self) -> None:
        self.closed = True
        await self._to_proxy.put(None)

    # --- API the test uses ---
    async def inject(self, payload: dict[str, Any]) -> None:
        await self._to_proxy.put(json.dumps(payload))

    async def recv_from_proxy(self, timeout: float = 1.0) -> dict[str, Any]:
        raw = await asyncio.wait_for(self._from_proxy.get(), timeout=timeout)
        return json.loads(raw)


@pytest.fixture
def fake_upstream() -> FakeUpstream:
    return FakeUpstream()
