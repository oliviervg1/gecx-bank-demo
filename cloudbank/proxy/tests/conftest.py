"""Shared pytest fixtures for Cloudbank BidiRunSession proxy tests."""
from __future__ import annotations

import asyncio
import copy
import json
from pathlib import Path
from typing import Any

import pytest

FIXTURES_DIR = Path(__file__).resolve().parents[2] / "web" / "src" / "fixtures"
DEFAULT_ORIGIN = "http://localhost:5173"


class FakeUpstream:
    """In-memory stand-in for a CES BidiRunSession WebSocket."""

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
def _fast_start_timeout_for_mutation_runs(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep un-sent start-frame waits fast in tests so broken-gate mutants fail in <100ms."""
    monkeypatch.setenv("PROXY_START_TIMEOUT_SECONDS", "0.08")


@pytest.fixture(scope="session")
def persona_snapshots() -> dict[str, dict[str, Any]]:
    return {
        pid: json.loads((FIXTURES_DIR / f"{pid}.json").read_text(encoding="utf-8"))
        for pid in ("chloe", "david", "tom", "sarah")
    }


def make_seed_variables(
    snapshots: dict[str, dict[str, Any]],
    persona: str = "chloe",
) -> dict[str, Any]:
    snap = copy.deepcopy(snapshots[persona])
    return {
        "persona_id": persona,
        "first_name": snap["user"]["first_name"],
        "demo_date": "2026-11-24",
        "time_of_day": "afternoon",
        "customer_snapshot": snap,
    }
