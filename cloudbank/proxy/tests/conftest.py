"""Shared pytest fixtures for Cloudbank BidiRunSession proxy tests."""
from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from proxy import main, relay

SHARED_DIR = Path(__file__).resolve().parents[2] / "shared"
PERSONAS_DIR = SHARED_DIR / "personas"
DEFAULT_ORIGIN = "http://localhost:5173"


class FakeUpstream:
    """In-memory stand-in for a CX Agent Studio (GECX) BidiRunSession WebSocket."""

    def __init__(self) -> None:
        self._to_proxy: asyncio.Queue[str | None] = asyncio.Queue()
        self._from_proxy: asyncio.Queue[str] = asyncio.Queue()
        self.closed = False

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
        if not self.closed:
            self.closed = True
            await self._to_proxy.put(None)

    async def inject(self, payload: dict[str, Any]) -> None:
        await self._to_proxy.put(json.dumps(payload))

    async def recv_from_proxy(self, timeout: float = 1.0) -> dict[str, Any]:
        raw = await asyncio.wait_for(self._from_proxy.get(), timeout=timeout)
        return json.loads(raw)


@pytest.fixture
def fake_upstream() -> FakeUpstream:
    return FakeUpstream()


@pytest.fixture(autouse=True)
def _isolated_proxy_state(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Keep start-frame waits fast and isolate in-memory session state per test."""
    monkeypatch.setenv("PROXY_START_TIMEOUT_SECONDS", "0.08")
    main._session_personas.clear()
    main._session_persona_timestamps.clear()
    main._active_session_ids.clear()
    main._active_session_count = 0
    main._get_session_semaphore()
    relay._official_help_allowlist.cache_clear()
    relay._composite_tag_words.cache_clear()
    yield
    main._session_personas.clear()
    main._session_persona_timestamps.clear()
    main._active_session_ids.clear()
    main._active_session_count = 0
    main._get_session_semaphore()
    relay._official_help_allowlist.cache_clear()
    relay._composite_tag_words.cache_clear()


@pytest.fixture(scope="session")
def persona_snapshots() -> dict[str, dict[str, Any]]:
    return {
        pid: json.loads((PERSONAS_DIR / f"{pid}.json").read_text(encoding="utf-8"))
        for pid in ("chloe", "david", "tom", "sarah")
    }
