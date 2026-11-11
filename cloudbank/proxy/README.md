# Cloudbank BidiRunSession Proxy

Authenticates locally with Google Cloud Application Default Credentials (`ADC`) and relays WebSocket frames between the browser workbench and CX Agent Studio (GECX) `BidiRunSession` (`wss://ces.googleapis.com/ws/google.cloud.ces.v1.SessionService/BidiRunSession/locations/<location>`).

```bash
cd cloudbank/proxy
uv run --locked python -m proxy
```

`python -m proxy` binds Uvicorn strictly to `127.0.0.1:8765` (override port with `PROXY_PORT`) with `proxy_headers=False` and `ws_max_size=1048576` (`1 MiB`). When launching `uvicorn` directly for auto-reload, pass `--host 127.0.0.1 --port 8765 --ws-max-size 1048576`:

```bash
cd cloudbank/proxy
uv run --locked uvicorn proxy.main:app --reload --host 127.0.0.1 --port 8765 --ws-max-size 1048576
```

## Security Posture: Localhost Only

**This proxy uses local developer `ADC` credentials and must only bind to `127.0.0.1`.** Because every accepted session opens a billed CX Agent Studio (GECX) stream under your workstation identity, never bind it to `0.0.0.0` on an untrusted network or expose it publicly without end-user authentication.

When running in Google Cloud Shell or GitHub Codespaces, keep **both** the proxy port (`8765`) and Vite's dev-server port (`5173`) **Private** (authenticated to your account). Vite's dev server proxies `/ws/agent` to `ws://127.0.0.1:8765` over loopback (`VITE_PROXY_TARGET` overrides the server-side upstream URL) while forwarding your workspace `Origin` header (`WEB_HOST` or `CODESPACE_NAME`) and injecting `x-proxy-token` server-side when `PROXY_AUTH_TOKEN` is configured.

| Control | Policy | Environment Override |
|---|---|---|
| Loopback peer & fail-closed remote guard | Runs Uvicorn with `proxy_headers=False` so `X-Forwarded-For` cannot spoof `ws.client.host`, rejects non-loopback peer addresses (`127.0.0.1`, `::1`, `localhost`), and refuses startup whenever `PROXY_ALLOW_REMOTE=1` or a non-loopback `PROXY_HOST` lacks a non-empty `PROXY_AUTH_TOKEN`. | `PROXY_ALLOW_REMOTE=1` + `PROXY_AUTH_TOKEN` |
| Shared bearer secret & Vite forwarding | When set, requires `Authorization: Bearer <token>` or `x-proxy-token: <token>` via constant-time comparison before upgrade; `cloudbank/web/vite.config.ts` injects `x-proxy-token` server-side on `/ws/agent`. | `PROXY_AUTH_TOKEN` |
| ASGI `Host` & `Origin` allowlists | Standalone ASGI `Host` middleware validates `Host` (`localhost`, `127.0.0.1`, `[::1]`, plus validated workspace hosts) using ASGI-compliant WebSocket rejection (`websocket.http.response.start` or close code `1008`), and `/ws/agent` requires a non-empty `Origin` matching `http://localhost:5173` or `http://127.0.0.1:5173` (plus `WEB_HOST` / `CODESPACE_NAME` workspace origins) with zero wildcard fallthrough. OpenAPI routes (`/docs`, `/redoc`, `/openapi.json`) are disabled. | `PROXY_ALLOWED_HOSTS`, `PROXY_ALLOWED_ORIGINS` |
| Server-owned snapshots & session binding | Browser `ClientStart` (validated against [ws_protocol.schema.json](../shared/ws_protocol.schema.json)) sends only `persona`, optional `timeOfDay`, optional `demoDate`, and optional resume fields (`sessionId`, `lastUiSeq`). The proxy loads [personas](../shared/personas/) server-side, validates against [customer_snapshot.schema.json](../shared/customer_snapshot.schema.json), derives `first_name` from `snapshot.user.first_name`, records `sessionId` bindings only after upstream connection succeeds, and mints a fresh server UUID (`is_resume=False`, seeding `customer_snapshot`) whenever `sessionId` is unrecognized, restarted, or evicted. | None |
| Frame, audio & malformed-frame caps | Rejects binary WebSocket frames with close code `1003`, caps PCM16 base64 audio payloads at `64 KB` (`87,384` base64 chars, even-byte aligned), caps inbound frames at `MAX_CLIENT_FRAME_BYTES` (`1 MiB`) and upstream frames at `4 MiB`, emits non-closing `ServerError` frames on validation errors while disconnecting after `5` malformed frames (`1008`), and enforces an `asyncio.Semaphore` session cap (`4` default). | `PROXY_MAX_SESSIONS` |
| Handshake, keepalive, speech-only idle & max lifetime | Closes sockets that do not send `ClientStart` within `10 s`, streams `100 ms` of `16 kHz` `LINEAR16` silence every `10 s` while quiet, resets `PROXY_MAX_IDLE_SECONDS` (`900 s`) strictly on `ClientText`, non-empty speech transcripts, or `sessionOutput` events (never on raw ambient `AudioFrame`s), and enforces an upper session lifetime of `3600 s` (`ServerSessionExpired`). | `PROXY_START_TIMEOUT_SECONDS`, `PROXY_KEEPALIVE_SECONDS`, `PROXY_MAX_IDLE_SECONDS`, `PROXY_MAX_SESSION_SECONDS` |
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
