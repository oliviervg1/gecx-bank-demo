# Cloudbank BidiRunSession & Static SPA Proxy

Relays WebSocket frames between the browser workbench and CX Agent Studio (GECX) `BidiRunSession` (`wss://ces.googleapis.com/ws/google.cloud.ces.v1.SessionService/BidiRunSession/locations/<location>`), supporting both localhost workstation development (`ADC` on `127.0.0.1:8765`) and single-origin Google Cloud Run Direct IAP hosting (`PROXY_IAP_AUDIENCE` + `PROXY_STATIC_DIR`).

```bash
cd cloudbank/proxy
uv run --locked python -m proxy
```

By default, `python -m proxy` binds Uvicorn strictly to `127.0.0.1:8765` (override port with `PROXY_PORT`; `PORT` is honored as a fallback only when `PROXY_PORT` is unset and `K_SERVICE` is non-empty) with `proxy_headers=False` and `ws_max_size=1048576` (`1 MiB`). When launching `uvicorn` directly for auto-reload, pass `--host 127.0.0.1 --port 8765 --ws-max-size 1048576`:

```bash
cd cloudbank/proxy
uv run --locked uvicorn proxy.main:app --reload --host 127.0.0.1 --port 8765 --ws-max-size 1048576
```

## Security Posture: Localhost Workstation vs. Cloud Run Direct IAP

`cloudbank/proxy` operates in two explicit modes and fails closed on unauthenticated remote exposure:

1. **Localhost workstation mode (`127.0.0.1:8765`, developer `ADC`):** Uses local developer `ADC` credentials and binds strictly to `127.0.0.1:8765`. Because every accepted session opens a billed CX Agent Studio (GECX) stream under your workstation identity, never bind local `ADC` mode to `0.0.0.0` on an untrusted network. When running in Google Cloud Shell or GitHub Codespaces, keep **both** the proxy port (`8765`) and Vite's dev-server port (`5173`) **Private** (authenticated to your account): Vite's dev server proxies `/ws/agent` to `ws://127.0.0.1:8765` over loopback (`VITE_PROXY_TARGET` overrides the server-side upstream URL) while forwarding your workspace `Origin` header (`WEB_HOST` or `CODESPACE_NAME`) and injecting `x-proxy-token` server-side when `PROXY_AUTH_TOKEN` is configured.
2. **Single-origin Cloud Run Direct IAP mode (`PROXY_IAP_AUDIENCE` + `PROXY_STATIC_DIR`, dedicated service account):** Deployed via [`../Dockerfile`](../Dockerfile) and [`../scripts/deploy_cloud_run.sh`](../scripts/deploy_cloud_run.sh) with `--no-allow-unauthenticated`, `--iap`, `--session-affinity`, and an explicit least-privilege `--service-account` (see the [Developer & CI/CD Guide](../../docs/guides/developer_workflow_and_cicd_guide.md) for required Google Cloud APIs, IAM roles, and offline verification notes). Serves the compiled React SPA (`/` and `/assets/*`) and `/ws/agent` from one HTTPS origin while cryptographically verifying `x-goog-iap-jwt-assertion` inside the container.

| Control | Policy | Environment Override |
|---|---|---|
| Loopback peer & fail-closed remote guard | Runs Uvicorn with `proxy_headers=False` so `X-Forwarded-For` cannot spoof `ws.client.host`, rejects non-loopback peer addresses (`127.0.0.1`, `::1`, `localhost`) unless `PROXY_ALLOW_REMOTE=1` is set, and refuses startup whenever `PROXY_ALLOW_REMOTE=1` or a non-loopback `PROXY_HOST` lacks `PROXY_AUTH_TOKEN` or a valid `PROXY_IAP_AUDIENCE` (requiring `PROXY_IAP_AUDIENCE` whenever `PROXY_STATIC_DIR` is combined with a non-loopback `PROXY_HOST` or `PROXY_ALLOW_REMOTE=1`). | `PROXY_ALLOW_REMOTE=1`, `PROXY_AUTH_TOKEN`, `PROXY_IAP_AUDIENCE` |
| Direct IAP `ES256` JWT verification | Pure ASGI `_ProxyIapMiddleware` (ordered inside `_ProxyTrustedHostMiddleware`, exempting only exact `scope["path"] == "/health"` on HTTP) pins `alg == "ES256"` on the unverified header before `google.auth.jwt.decode`, caps JWT length (`<= 8192`), rejects duplicate `x-goog-iap-jwt-assertion` headers, caches `https://www.gstatic.com/iap/verify/public_key` under an `asyncio.Lock` (refetching once on unknown `kid` under cooldown, capped at a 24-hour stale bound, returning `503` on HTTP or denying WebSockets before `accept` if no usable keys exist), validates `iss == "https://cloud.google.com/iap"`, exact `aud`, bounded lifetime, and non-empty `sub` and `email`, and startup-requires explicit non-loopback `PROXY_ALLOWED_HOSTS` and `https://` `PROXY_ALLOWED_ORIGINS` (`PROXY_ALLOW_TEST_HOSTS` unset). When both `PROXY_AUTH_TOKEN` and `PROXY_IAP_AUDIENCE` are set, both checks must pass. | `PROXY_IAP_AUDIENCE` |
| Shared bearer secret & Vite forwarding | When set in localhost or loopback-proxied setups, requires `Authorization: Bearer <token>` or `x-proxy-token: <token>` via constant-time comparison before upgrade; `cloudbank/web/vite.config.ts` injects `x-proxy-token` server-side on `/ws/agent`. | `PROXY_AUTH_TOKEN` |
| ASGI `Host` & `Origin` allowlists | Standalone ASGI `_ProxyTrustedHostMiddleware` validates `Host` (`localhost`, `127.0.0.1`, `[::1]` by default, with zero `*` wildcard support in any mode) using ASGI-compliant WebSocket rejection (`websocket.http.response.start` or close code `1008`), and `/ws/agent` requires a non-empty `Origin` matching `http://localhost:5173` or `http://127.0.0.1:5173` (plus `WEB_HOST` / `CODESPACE_NAME` workspace origins in local mode, or explicit `https://` origins in IAP mode) with zero wildcard fallthrough. OpenAPI routes (`/docs`, `/redoc`, `/openapi.json`) are disabled and `redirect_slashes=False`. | `PROXY_ALLOWED_HOSTS`, `PROXY_ALLOWED_ORIGINS` |
| Static SPA serving & HTTP security headers | When `PROXY_STATIC_DIR` is set, registers `GET` and `HEAD` routes strictly on `/` (`index.html`, `Cache-Control: no-cache`) and `/assets/{asset_path:path}` (`Cache-Control: public, max-age=31536000, immutable`, rejecting traversal, dot-prefixed segments, and symlinks, with explicit `text/javascript` and `font/woff2` MIME types and `404` on all other paths). Parses `<meta http-equiv="Content-Security-Policy">` from `dist/index.html` at startup (failing closed on missing meta, `'unsafe-inline'` in `script-src`, or bare `ws:`/`wss:`), appends `; frame-ancestors 'none'`, and sets `Content-Security-Policy`, `Permissions-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and `X-Frame-Options: DENY`. | `PROXY_STATIC_DIR` |
| Server-owned snapshots & `(persona, iap_sub)` binding | Browser `ClientStart` (validated against [ws_protocol.schema.json](../shared/ws_protocol.schema.json)) sends only `persona`, optional `timeOfDay`, optional `demoDate`, and optional resume fields (`sessionId`, `lastUiSeq`). The proxy loads [personas](../shared/personas/) server-side, validates against [customer_snapshot.schema.json](../shared/customer_snapshot.schema.json), derives `first_name` from `snapshot.user.first_name`, records `(persona, iap_sub)` session bindings only after upstream connection succeeds (logging `sub` only, never email or raw JWTs), enforces a per-user concurrent session limit (`2` default), and mints a fresh server UUID (`is_resume=False`, seeding `customer_snapshot`) whenever `sessionId` is unrecognized, cross-user, restarted, or evicted. | `PROXY_MAX_SESSIONS_PER_USER` |
| Frame, audio & malformed-frame caps | Rejects binary WebSocket frames with close code `1003`, caps PCM16 base64 audio payloads at `64 KB` (`87,384` base64 chars, even-byte aligned), caps inbound frames at `MAX_CLIENT_FRAME_BYTES` (`1 MiB`) and upstream frames at `4 MiB`, emits non-closing `ServerError` frames on validation errors while disconnecting after `5` malformed frames (`1008`), and enforces a global `asyncio.Semaphore` session cap (`4` default). | `PROXY_MAX_SESSIONS` |
| Handshake, keepalive, speech-only idle & max lifetime | Closes sockets that do not send `ClientStart` within `10 s`, streams `100 ms` of `16 kHz` `LINEAR16` silence every `10 s` while quiet, resets `PROXY_MAX_IDLE_SECONDS` (`900 s`) strictly on `ClientText`, non-empty speech transcripts, or `sessionOutput` events (never on raw ambient `AudioFrame`s), and enforces an upper session lifetime of `3600 s` (`3300 s` in Cloud Run, emitting `ServerSessionExpired`). | `PROXY_START_TIMEOUT_SECONDS`, `PROXY_KEEPALIVE_SECONDS`, `PROXY_MAX_IDLE_SECONDS`, `PROXY_MAX_SESSION_SECONDS` |
| Outbound citation allowlisting & text sanitization | `relay.py` filters `SessionOutput.citations` strictly to exact `https://` official vendor help hosts in `../shared/official_help_hosts.json` (plus `/gp/help` or `/hz/contact-us` on `www.amazon.co.uk`) and strips closed/unclosed `<untrusted_web_snippet>` blocks, case-insensitive `[Diagnosis context: ...]` notes, and Composite v2 inline `<tag>`s (`../shared/composite_v2_tags.json`) from outbound `ServerText`. | None |
| GCP app configuration | Regex-validates GCP project (including domain-scoped IDs), location, and app ID from environment overrides first, falling back to `../gecx-config.json`. | `CLOUDBANK_GCP_PROJECT_ID`, `CLOUDBANK_LOCATION`, `CLOUDBANK_APP_ID`, `GECX_CONFIG` |

## Tests, Typecheck, Lint, and Dependency Audit

```bash
cd cloudbank/proxy
uv run --locked ruff check .
uv run --locked pyright
uv run --locked pytest -v
uv run --locked pip-audit
```
