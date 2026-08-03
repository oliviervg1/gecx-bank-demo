"""Application Default Credentials token provider.

Caches credentials in-process and refreshes them on demand. The proxy
holds these credentials so the browser never sees them.

Known limitation: the token is fetched once per session, before the upstream
connect. A voice session that outlives the ~1h token lifetime will not re-auth
mid-stream — CES would close the socket and the browser's retry would open a
fresh session with a new token. Acceptable for demo-length conversations.
"""
from __future__ import annotations

import asyncio

import google.auth
from google.auth.credentials import Credentials
from google.auth.transport.requests import Request

# `cloud-platform` is broader than the CES SessionService strictly needs. It is
# kept deliberately: under a user's own ADC it grants nothing they don't already
# have, and CES has not been verified to accept a narrower scope. If this ever
# runs under a SERVICE ACCOUNT, narrow it first — a project-wide scope on a
# long-lived SA identity is a real escalation, and the right fix is a dedicated
# SA with only the CES role rather than a scope string.
_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]


class GoogleTokenProvider:
    def __init__(self) -> None:
        self._creds: Credentials | None = None
        self._lock = asyncio.Lock()

    async def get_token(self) -> str:
        async with self._lock:
            if self._creds is None:
                self._creds, _ = google.auth.default(scopes=_SCOPES)
            if not self._creds.token or self._creds.expired:
                # google-auth's refresh is sync; run in default executor to avoid blocking.
                await asyncio.to_thread(self._creds.refresh, Request())
            if self._creds.token is None:
                # Not an assert: `python -O` strips those, and this function's
                # return type is `str`. A refresh that silently yields no token
                # must fail loudly, not hand None to the Authorization header.
                raise RuntimeError("ADC refresh produced no access token")
            return self._creds.token
