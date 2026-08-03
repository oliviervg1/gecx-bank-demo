"""Tests for the ADC-backed token provider."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from proxy.auth import GoogleTokenProvider


class _FakeCreds:
    def __init__(self, token: str, expired: bool = False) -> None:
        self.token = token
        self.expired = expired
        self.refresh_calls = 0

    def refresh(self, _request) -> None:
        self.refresh_calls += 1
        self.expired = False


@pytest.mark.asyncio
async def test_returns_token_on_first_call() -> None:
    creds = _FakeCreds(token="t-1")
    with patch("proxy.auth.google.auth.default", return_value=(creds, "proj-x")):
        provider = GoogleTokenProvider()
        token = await provider.get_token()
    assert token == "t-1"


@pytest.mark.asyncio
async def test_refreshes_when_expired() -> None:
    creds = _FakeCreds(token="t-1", expired=True)
    with patch("proxy.auth.google.auth.default", return_value=(creds, "proj-x")), \
         patch("proxy.auth.Request", return_value=MagicMock()):
        provider = GoogleTokenProvider()
        await provider.get_token()
    assert creds.refresh_calls == 1


@pytest.mark.asyncio
async def test_caches_credentials_across_calls() -> None:
    creds = _FakeCreds(token="t-1")
    with patch("proxy.auth.google.auth.default", return_value=(creds, "proj-x")) as m:
        provider = GoogleTokenProvider()
        await provider.get_token()
        await provider.get_token()
    assert m.call_count == 1
