"""Google Cloud Identity-Aware Proxy (IAP) signed header JWT verifier.

Provides defense-in-depth cryptographic verification of the
`x-goog-iap-jwt-assertion` HTTP/WebSocket header when Cloudbank runs behind
Cloud Run Direct IAP (`PROXY_IAP_AUDIENCE`).

Security invariants enforced here:
- Strict audience syntax (`/projects/<NUMBER>/locations/<REGION>/services/<NAME>`).
- Single-header enforcement (missing, duplicate, or comma-coalesced headers fail
  closed) and raw JWT byte/character cap (`<= 8192`) prior to base64 decoding.
- Unverified header `alg` pinned strictly to `"ES256"` with a non-empty `kid`
  before `google.auth.jwt.decode` selects a cryptographic verifier.
- Single-flight public-key cache (`https://www.gstatic.com/iap/verify/public_key`)
  fetched off the event loop via `asyncio.to_thread` + `_TimedRequest`, guarded
  by `asyncio.Lock` with TTL expiry and rate-limited once-on-unknown-`kid`
  key-rotation refresh. Malformed or failed refreshes never overwrite a valid
  cached keyset; cold-start failures with zero usable keys raise
  `IapCertUnavailableError` (`503`).
- Claim validation requiring `iss == "https://cloud.google.com/iap"`, exact
  string `aud`, finite numeric `iat`/`exp` (plus optional `nbf`), and non-empty
  printable `sub` and `email`. Only `sub` is exposed on `IapPrincipal` so email
  addresses and raw JWTs are never retained in session bindings or logs.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from google.auth import exceptions as google_exceptions
from google.auth import jwt as google_jwt
from google.auth.transport.requests import Request
from starlette.types import Scope

from .auth import _TimedRequest

log = logging.getLogger("proxy.iap")

IAP_JWT_HEADER = "x-goog-iap-jwt-assertion"
IAP_JWT_HEADER_BYTES = b"x-goog-iap-jwt-assertion"
IAP_ISSUER = "https://cloud.google.com/iap"
IAP_PUBLIC_KEY_URL = "https://www.gstatic.com/iap/verify/public_key"

MAX_IAP_JWT_LENGTH = 8192
MAX_CERT_RESPONSE_BYTES = 256 * 1024
CERT_FETCH_TIMEOUT_SECONDS = 5
DEFAULT_CLOCK_SKEW_SECONDS = 30
DEFAULT_CERT_CACHE_TTL_SECONDS = 3600.0
DEFAULT_CERT_REFRESH_MIN_INTERVAL_SECONDS = 30.0

_IAP_AUDIENCE_RE = re.compile(
    r"\A/projects/[0-9]+/locations/[a-z0-9-]+/services/[a-z0-9-]+\Z"
)


class IapAuthError(Exception):
    """Raised when an IAP assertion header is missing, malformed, or invalid."""


class IapCertUnavailableError(Exception):
    """Raised when IAP public keys cannot be loaded and no cached keys exist."""


@dataclass(frozen=True, slots=True)
class IapPrincipal:
    """Verified Cloud Run IAP caller identity exposing strictly the subject ID."""

    sub: str


CertFetcher = Callable[[], Awaitable[Mapping[str, str]]]


def parse_iap_audiences(raw: str | None) -> tuple[str, ...]:
    """Parse and strictly validate comma-separated Cloud Run IAP audience strings.

    Returns an empty tuple when `raw` is `None` or `""`. Raises `ValueError` if
    `raw` is non-empty (including whitespace-only or empty comma segments) or
    any entry violates `/projects/<NUMBER>/locations/<REGION>/services/<NAME>`.
    """
    if raw is None or raw == "":
        return ()
    parts = raw.split(",")
    validated: list[str] = []
    for part in parts:
        if "\r" in part or "\n" in part:
            raise ValueError("PROXY_IAP_AUDIENCE must not contain control characters")
        candidate = part.strip()
        if not candidate or not _IAP_AUDIENCE_RE.fullmatch(candidate):
            raise ValueError(
                "Invalid PROXY_IAP_AUDIENCE entry; expected "
                "/projects/<PROJECT_NUMBER>/locations/<REGION>/services/<SERVICE_NAME>"
            )
        validated.append(candidate)
    return tuple(dict.fromkeys(validated))


def extract_iap_jwt_from_scope(scope: Scope) -> str:
    """Extract a single bounded `x-goog-iap-jwt-assertion` header from an ASGI scope."""
    raw_headers = scope.get("headers") or ()
    matches: list[bytes] = [
        val for key, val in raw_headers if key.lower() == IAP_JWT_HEADER_BYTES
    ]
    if not matches:
        raise IapAuthError("missing IAP assertion header")
    if len(matches) > 1:
        raise IapAuthError("duplicate IAP assertion header")

    raw_bytes = matches[0]
    if not raw_bytes or len(raw_bytes) > MAX_IAP_JWT_LENGTH:
        raise IapAuthError("IAP assertion header absent or exceeds size limit")

    try:
        token = raw_bytes.decode("ascii")
    except UnicodeDecodeError as exc:
        raise IapAuthError("non-ASCII bytes in IAP assertion header") from exc

    if "," in token or "\r" in token or "\n" in token or " " in token or "\t" in token:
        raise IapAuthError("invalid delimiter or whitespace in IAP assertion header")
    return token


def _validate_cert_map(payload: Any) -> dict[str, str]:
    """Validate a mapping of `kid -> PEM` public keys, rejecting empty/malformed maps."""
    if not isinstance(payload, Mapping) or not payload:
        raise IapCertUnavailableError("IAP public key response must be a non-empty JSON object")

    validated: dict[str, str] = {}
    for raw_kid, raw_pem in payload.items():
        if (
            not isinstance(raw_kid, str)
            or not raw_kid.strip()
            or len(raw_kid) > 256
            or not isinstance(raw_pem, str)
            or "-----BEGIN " not in raw_pem
        ):
            raise IapCertUnavailableError("IAP public key map contains malformed entry")
        validated[raw_kid] = raw_pem
    return validated


def _fetch_iap_certs_sync(
    public_key_url: str = IAP_PUBLIC_KEY_URL,
    timeout_seconds: int = CERT_FETCH_TIMEOUT_SECONDS,
) -> dict[str, str]:
    """Fetch IAP ES256 public keys synchronously with an explicit HTTP timeout."""
    timed_request = _TimedRequest(Request(), timeout=timeout_seconds)
    try:
        response = timed_request(url=public_key_url, method="GET")
    except Exception as exc:
        raise IapCertUnavailableError("failed to fetch IAP public keys") from exc

    status = getattr(response, "status", None)
    if status != 200:
        raise IapCertUnavailableError(f"IAP public key endpoint returned HTTP {status}")

    data = getattr(response, "data", b"")
    if isinstance(data, str):
        raw_bytes = data.encode("utf-8")
    elif isinstance(data, bytes):
        raw_bytes = data
    else:
        raise IapCertUnavailableError("unexpected IAP public key response body type")

    if not raw_bytes or len(raw_bytes) > MAX_CERT_RESPONSE_BYTES:
        raise IapCertUnavailableError("IAP public key payload empty or oversized")

    try:
        decoded = json.loads(raw_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise IapCertUnavailableError("malformed JSON from IAP public key endpoint") from exc

    return _validate_cert_map(decoded)


class IapVerifier:
    """Single-flight cached ES256 verifier for Cloud Run Direct IAP assertions."""

    def __init__(
        self,
        *,
        cert_fetcher: CertFetcher | None = None,
        cache_ttl_seconds: float = DEFAULT_CERT_CACHE_TTL_SECONDS,
        min_refresh_interval_seconds: float = DEFAULT_CERT_REFRESH_MIN_INTERVAL_SECONDS,
        clock_skew_seconds: int = DEFAULT_CLOCK_SKEW_SECONDS,
        monotonic_clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
    ) -> None:
        self._cert_fetcher: CertFetcher = cert_fetcher or (
            lambda: asyncio.to_thread(_fetch_iap_certs_sync)
        )
        self._cache_ttl_seconds = cache_ttl_seconds
        self._min_refresh_interval_seconds = min_refresh_interval_seconds
        self._clock_skew_seconds = clock_skew_seconds
        self._monotonic = monotonic_clock
        self._wall_clock = wall_clock

        self._lock = asyncio.Lock()
        self._certs: dict[str, str] = {}
        self._fetched_at: float | None = None
        self._last_unknown_kid_refresh_at: float | None = None
        self._last_failed_ttl_refresh_at: float | None = None

    def clear_cache(self) -> None:
        """Reset cached keys and rate-limit timestamps (intended for test isolation)."""
        self._certs = {}
        self._fetched_at = None
        self._last_unknown_kid_refresh_at = None
        self._last_failed_ttl_refresh_at = None

    async def _get_certs_for_kid(self, kid: str) -> Mapping[str, str]:
        now = self._monotonic()
        if (
            self._certs
            and self._fetched_at is not None
            and (now - self._fetched_at) < self._cache_ttl_seconds
            and kid in self._certs
        ):
            return self._certs

        async with self._lock:
            now = self._monotonic()
            cache_fresh = (
                bool(self._certs)
                and self._fetched_at is not None
                and (now - self._fetched_at) < self._cache_ttl_seconds
            )
            if cache_fresh and kid in self._certs:
                return self._certs

            if cache_fresh:
                # Unknown `kid` while cache is fresh: allow at most one single-flight
                # key-rotation refresh per `min_refresh_interval_seconds`.
                if (
                    self._last_unknown_kid_refresh_at is not None
                    and (now - self._last_unknown_kid_refresh_at)
                    < self._min_refresh_interval_seconds
                ):
                    return self._certs
                self._last_unknown_kid_refresh_at = now
            elif (
                self._certs
                and self._last_failed_ttl_refresh_at is not None
                and (now - self._last_failed_ttl_refresh_at)
                < self._min_refresh_interval_seconds
            ):
                # TTL expired but a recent refresh failed: keep serving last-known-good keys
                # during cooldown rather than stalling every request on upstream timeout.
                return self._certs

            try:
                raw_fetched = await self._cert_fetcher()
                validated = _validate_cert_map(raw_fetched)
            except Exception as exc:
                if self._certs:
                    self._last_failed_ttl_refresh_at = self._monotonic()
                    log.warning(
                        "retaining cached IAP public keys after refresh failure: %s",
                        type(exc).__name__,
                    )
                    return self._certs
                if isinstance(exc, IapCertUnavailableError):
                    raise
                raise IapCertUnavailableError("unable to load IAP public keys") from exc

            refreshed_at = self._monotonic()
            self._certs = validated
            self._fetched_at = refreshed_at
            self._last_failed_ttl_refresh_at = None
            return self._certs

    async def verify_token(
        self,
        raw_token: str,
        allowed_audiences: Sequence[str],
    ) -> IapPrincipal:
        """Cryptographically verify an IAP ES256 JWT against `allowed_audiences`."""
        if not allowed_audiences:
            raise IapAuthError("no IAP audiences configured")
        if (
            not isinstance(raw_token, str)
            or not raw_token
            or len(raw_token) > MAX_IAP_JWT_LENGTH
            or "\r" in raw_token
            or "\n" in raw_token
            or " " in raw_token
            or "\t" in raw_token
            or "," in raw_token
        ):
            raise IapAuthError("malformed or oversized IAP JWT")

        try:
            header = google_jwt.decode_header(raw_token)
        except Exception as exc:
            raise IapAuthError("unable to decode JWT header") from exc

        if not isinstance(header, Mapping):
            raise IapAuthError("JWT header must be a JSON object")
        if header.get("alg") != "ES256":
            raise IapAuthError("JWT alg must be ES256")

        kid = header.get("kid")
        if not isinstance(kid, str) or not kid.strip() or len(kid) > 256:
            raise IapAuthError("JWT header missing valid kid")

        certs = await self._get_certs_for_kid(kid)
        pem = certs.get(kid)
        if pem is None:
            raise IapAuthError("unknown IAP signing key id")

        try:
            payload = google_jwt.decode(
                raw_token,
                certs={kid: pem},
                verify=True,
                audience=list(allowed_audiences),
                clock_skew_in_seconds=self._clock_skew_seconds,
            )
        except (
            google_exceptions.GoogleAuthError,
            ValueError,
            TypeError,
            KeyError,
        ) as exc:
            raise IapAuthError("IAP JWT cryptographic or claim verification failed") from exc

        if not isinstance(payload, Mapping):
            raise IapAuthError("JWT payload must be a JSON object")

        for numeric_claim in ("iat", "exp"):
            claim_val = payload.get(numeric_claim)
            if (
                isinstance(claim_val, bool)
                or not isinstance(claim_val, (int, float))
                or not math.isfinite(claim_val)
            ):
                raise IapAuthError(f"invalid {numeric_claim} claim")

        if "nbf" in payload:
            nbf_val = payload["nbf"]
            if (
                isinstance(nbf_val, bool)
                or not isinstance(nbf_val, (int, float))
                or not math.isfinite(nbf_val)
            ):
                raise IapAuthError("invalid nbf claim")
            if self._wall_clock() + self._clock_skew_seconds < nbf_val:
                raise IapAuthError("IAP JWT not yet valid (nbf)")

        if payload.get("iss") != IAP_ISSUER:
            raise IapAuthError("invalid IAP JWT issuer")

        aud = payload.get("aud")
        if not isinstance(aud, str) or aud not in allowed_audiences:
            raise IapAuthError("invalid IAP JWT audience")

        sub = payload.get("sub")
        if (
            not isinstance(sub, str)
            or not sub.strip()
            or len(sub) > 256
            or not sub.isprintable()
        ):
            raise IapAuthError("missing or invalid IAP JWT sub")

        email = payload.get("email")
        if (
            not isinstance(email, str)
            or not email.strip()
            or len(email) > 320
            or not email.isprintable()
        ):
            raise IapAuthError("missing or invalid IAP JWT email")

        return IapPrincipal(sub=sub.strip())
