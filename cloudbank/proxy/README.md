# Cloudbank BidiRunSession Proxy

Authenticates locally with Google Cloud Application Default Credentials (`ADC`) and relays WebSocket frames between the browser workbench and CX Agent Studio (GECX) `BidiRunSession` (`wss://ces.googleapis.com/ws/google.cloud.ces.v1.SessionService/BidiRunSession/locations/<location>`).

```bash
cd cloudbank/proxy
uv run --locked python -m proxy
```

`python -m proxy` binds Uvicorn strictly to `127.0.0.1:8765` (override port with `PROXY_PORT`) with `ws_max_size=1048576` (`1 MiB`). When launching `uvicorn` directly, always pass `--host 127.0.0.1 --ws-max-size 1048576`:

```bash
cd cloudbank/proxy
uv run --locked uvicorn proxy.main:app --host 127.0.0.1 --port 8765 --ws-max-size 1048576
```

## Security Posture: Localhost Only

**This proxy uses local developer `ADC` credentials and must only bind to `127.0.0.1`.** Because every accepted session opens a billed CX Agent Studio (GECX) stream under your workstation identity, never bind it to `0.0.0.0` on an untrusted network or expose it publicly without end-user authentication.

When running in Google Cloud Shell or GitHub Codespaces, keep the proxy port (`8765` / `8080`) **private** and access the workbench through Vite's dev server (`5173`), which proxies `/ws/agent` over loopback `127.0.0.1` while forwarding your workspace `Origin` header (`WEB_HOST` or `CODESPACE_NAME`).

| Control | Policy | Environment Override |
|---|---|---|
| Loopback peer check | Rejects non-loopback client peer addresses (`127.0.0.1`, `::1`, `localhost`) before accepting the WebSocket upgrade. | `PROXY_ALLOW_REMOTE=1` (local container bridges only) |
| Optional bearer secret | When configured, requires `Authorization: Bearer <token>` or `x-proxy-token: <token>` via constant-time comparison before upgrade. | `PROXY_AUTH_TOKEN` |
| `Host` & `Origin` allowlists | `TrustedHostMiddleware` validates `Host` (`localhost`, `127.0.0.1`, `[::1]`, plus validated workspace hosts), and `/ws/agent` requires a non-empty `Origin` matching `http://localhost:5173` or `http://127.0.0.1:5173` (plus `WEB_HOST` / `CODESPACE_NAME` workspace origins) with zero wildcard fallthrough. OpenAPI routes (`/docs`, `/redoc`, `/openapi.json`) are disabled. | `PROXY_ALLOWED_HOSTS`, `PROXY_ALLOWED_ORIGINS` |
| Server-owned persona snapshots | Browser `ClientStart` (validated against [ws_protocol.schema.json](../shared/ws_protocol.schema.json)) sends only `persona`, optional `timeOfDay`, optional `demoDate`, and optional resume fields (`sessionId`, `lastUiSeq`). The proxy loads [personas](../shared/personas/) server-side, validates against [customer_snapshot.schema.json](../shared/customer_snapshot.schema.json), derives `first_name` from `snapshot.user.first_name`, binds `sessionId` to `persona`, and skips variable re-seeding on resume. | None |
| Frame & session caps | Rejects binary WebSocket frames with close code `1003`, enforces even-byte PCM16 base64 payloads, caps inbound frames at `MAX_CLIENT_FRAME_BYTES` (`1 MiB`) and upstream frames at `4 MiB`, and enforces a non-racy `asyncio.Semaphore` session cap (`4` default). | `PROXY_MAX_SESSIONS` |
| Handshake, keepalive & idle timeouts | Closes sockets that do not send `ClientStart` within `10 s`, streams `100 ms` of `16 kHz` `LINEAR16` silence every `10 s` while quiet, and expires inactive sessions after `900 s` with `ServerSessionExpired`. | `PROXY_START_TIMEOUT_SECONDS`, `PROXY_KEEPALIVE_SECONDS`, `PROXY_MAX_IDLE_SECONDS` |
| GCP app configuration | Regex-validates GCP project, location, and app ID from environment overrides first, falling back to `../gecx-config.json`. | `CLOUDBANK_GCP_PROJECT_ID`, `CLOUDBANK_LOCATION`, `CLOUDBANK_APP_ID`, `GECX_CONFIG` |

## Tests, Typecheck, and Lint

```bash
cd cloudbank/proxy
uv run --locked ruff check .
uv run --locked pyright
uv run --locked pytest -v
```
