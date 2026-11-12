"""Tests for the thread-offloaded ADC token provider and FastAPI lifespan warm-up."""
from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from proxy import main
from proxy.auth import GoogleTokenProvider


class _FakeCreds:
    def __init__(self, token: str | None, expired: bool = False) -> None:
        self.token = token
        self.expired = expired
        self.refresh_calls = 0
        self.last_request: Any = None

    def refresh(self, request: Any) -> None:
        self.refresh_calls += 1
        self.last_request = request
        self.expired = False


@pytest.mark.asyncio
async def test_returns_token_on_first_call_off_event_loop() -> None:
    creds = _FakeCreds(token="t-1")
    to_thread_calls: list[object] = []
    real_to_thread = asyncio.to_thread

    async def spy_to_thread(
        func: Callable[..., Any], /, *args: Any, **kwargs: Any
    ) -> Any:
        to_thread_calls.append(func)
        return await real_to_thread(func, *args, **kwargs)

    with (
        patch("proxy.auth.google.auth.default", return_value=(creds, "proj-x")) as mock_default,
        patch("proxy.auth.asyncio.to_thread", side_effect=spy_to_thread),
    ):
        provider = GoogleTokenProvider()
        token = await provider.get_token()
    assert token == "t-1"
    assert mock_default in to_thread_calls


@pytest.mark.asyncio
async def test_refreshes_when_expired_with_explicit_10s_timeout() -> None:
    creds = _FakeCreds(token="t-1", expired=True)
    mock_transport = MagicMock(return_value="ok-resp")

    class _CallingCreds(_FakeCreds):
        def refresh(self, request: Any) -> None:
            super().refresh(request)
            request("https://oauth2.googleapis.com/token", method="POST")

    calling_creds = _CallingCreds(token="t-refreshed", expired=True)
    with (
        patch("proxy.auth.google.auth.default", return_value=(calling_creds, "proj-x")),
        patch("proxy.auth.Request", return_value=mock_transport),
    ):
        provider = GoogleTokenProvider()
        tok = await provider.get_token()

    assert tok == "t-refreshed"
    assert calling_creds.refresh_calls == 1
    mock_transport.assert_called_once_with(
        "https://oauth2.googleapis.com/token",
        method="POST",
        body=None,
        headers=None,
        timeout=10,
    )
    assert creds.refresh_calls == 0


@pytest.mark.asyncio
async def test_caches_credentials_across_concurrent_calls() -> None:
    creds = _FakeCreds(token="t-1")
    with patch("proxy.auth.google.auth.default", return_value=(creds, "proj-x")) as mock_default:
        provider = GoogleTokenProvider()
        results = await asyncio.gather(*(provider.get_token() for _ in range(5)))
    assert results == ["t-1"] * 5
    assert mock_default.call_count == 1


@pytest.mark.asyncio
async def test_raises_when_refresh_leaves_token_none() -> None:
    creds = _FakeCreds(token=None, expired=True)
    with (
        patch("proxy.auth.google.auth.default", return_value=(creds, "proj-x")),
        patch("proxy.auth.Request", return_value=MagicMock()),
    ):
        provider = GoogleTokenProvider()
        with pytest.raises(RuntimeError, match="no access token"):
            await provider.get_token()


def test_lifespan_warms_credentials_when_enabled_and_tolerates_missing_adc(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 1. Explicit warm-up enabled: calls _tokens.get_token() during startup.
    monkeypatch.setenv("PROXY_WARM_CREDENTIALS", "1")
    warm_mock = AsyncMock(return_value="warm-token")
    monkeypatch.setattr(main._tokens, "get_token", warm_mock)
    with TestClient(main.app) as tc:
        assert tc.get("/health").status_code == 200
    assert warm_mock.await_count == 1

    # 2. Missing local ADC during startup does not crash lifespan.
    failing_mock = AsyncMock(side_effect=RuntimeError("no local ADC"))
    monkeypatch.setattr(main._tokens, "get_token", failing_mock)
    with TestClient(main.app) as tc:
        assert tc.get("/health").status_code == 200
    assert failing_mock.await_count == 1

    # 3. Disabled in tests by default: skips ADC warm-up cleanly.
    monkeypatch.delenv("PROXY_WARM_CREDENTIALS", raising=False)
    skipped_mock = AsyncMock(return_value="unused")
    monkeypatch.setattr(main._tokens, "get_token", skipped_mock)
    with TestClient(main.app) as tc:
        assert tc.get("/health").status_code == 200
    assert skipped_mock.await_count == 0
