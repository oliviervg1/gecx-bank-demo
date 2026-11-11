"""Application Default Credentials token provider.

Caches credentials in-process and refreshes them off the event loop. The proxy
holds these credentials so the browser never sees them.

Known limitation: the token is fetched once per session before the upstream
connect. A voice session that outlives the ~1h token lifetime will not
re-authenticate mid-stream; CX Agent Studio (GECX) will close the socket and
the browser's reconnect will open a session with a refreshed token.
"""
from __future__ import annotations

import asyncio
from typing import Any

import google.auth
from google.auth.credentials import Credentials
from google.auth.transport.requests import Request

# `cloud-platform` is broader than SessionService strictly needs. Under a
# developer's local ADC it grants nothing they do not already hold. If this
# code is ever adapted to run under a service account, bind a dedicated
# identity with only the least-privilege CXAS session role.
_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]
_AUTH_REFRESH_TIMEOUT_SECONDS = 10


class _TimedRequest(Request):
    """google-auth HTTP transport enforcing an explicit token-refresh timeout."""

    def __init__(
        self,
        base_request: Request | None = None,
        *,
        timeout: int = _AUTH_REFRESH_TIMEOUT_SECONDS,
    ) -> None:
        super().__init__()
        self._base_request = base_request
        self._timeout = timeout

    def __call__(
        self,
        url: str,
        method: str = "GET",
        body: Any = None,
        headers: Any = None,
        timeout: Any = None,
        **kwargs: Any,
    ) -> Any:
        effective_timeout = self._timeout if timeout is None else timeout
        if self._base_request is not None:
            return self._base_request(
                url,
                method=method,
                body=body,
                headers=headers,
                timeout=effective_timeout,
                **kwargs,
            )
        return super().__call__(
            url,
            method=method,
            body=body,
            headers=headers,
            timeout=effective_timeout,
            **kwargs,
        )


class GoogleTokenProvider:
    """Thread-offloaded ADC token cache for upstream BidiRunSession handshakes."""

    def __init__(self) -> None:
        self._creds: Credentials | None = None
        self._lock = asyncio.Lock()

    async def get_token(self) -> str:
        async with self._lock:
            creds = self._creds
            if creds is None:
                creds, _ = await asyncio.to_thread(
                    google.auth.default, scopes=_SCOPES
                )
                self._creds = creds
            if not creds.token or creds.expired:
                timed_request = _TimedRequest(
                    Request(), timeout=_AUTH_REFRESH_TIMEOUT_SECONDS
                )
                await asyncio.to_thread(creds.refresh, timed_request)
            if creds.token is None:
                # Not an assert: `python -O` strips assertions, and a refresh
                # yielding no token must fail loudly rather than send None.
                raise RuntimeError("ADC refresh produced no access token")
            return str(creds.token)
