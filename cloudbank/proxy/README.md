# Cloudbank BidiRunSession Proxy

Authenticates locally with Google Cloud Application Default Credentials (`ADC`) and relays WebSocket frames between the browser and CX Agent Studio `BidiRunSession` (`wss://ces.googleapis.com/ws/google.cloud.ces.v1.SessionService/BidiRunSession/locations/<location>`).

```bash
cd cloudbank/proxy
uv run --locked uvicorn proxy.main:app --reload --host 127.0.0.1 --port 8080
```

## Security Posture — Localhost Only

**This proxy is unauthenticated by design and must only bind to `127.0.0.1`.** Because it holds local `ADC` credentials and opens billed CX Agent Studio sessions with them, never pass `--host 0.0.0.0` or expose the port on a routable interface without adding authentication.

| Control | Policy | Environment Override |
|---|---|---|
| Exact `Origin` allowlist | Requires a non-empty `Origin` header matching `http://localhost:5173` or `http://127.0.0.1:5173` (plus optional single-workspace `https://$WEB_HOST` or `https://${CODESPACE_NAME}-5173.app.github.dev`). Missing `Origin` headers and wildcard domain suffixes are rejected. | `PROXY_ALLOWED_ORIGINS` (exact comma-separated origins; replaces defaults completely with no fallthrough) |
| Seedable variable allowlist | Strictly restricted to `CLIENT_SEEDABLE_VARIABLES` (`persona_id`, `first_name`, `demo_date`, `time_of_day`, `customer_snapshot`). Unknown or missing keys are rejected with a field-specific `ServerError` before opening an upstream session. | — |
| `customer_snapshot` schema validation | Validated directly against `../shared/customer_snapshot.schema.json` (max `32 KiB`, integer `*_pence`/`*_bps`, ASCII-safe bounds, zero `<`/`>`/control characters). | — |
| Initial handshake timeout | Closes any newly opened WebSocket that does not send its initial `ClientStart` message within `10 s`. | `PROXY_START_TIMEOUT_SECONDS` |
| Silence keepalive & idle timeout | Sends `100 ms` of `16 kHz` `LINEAR16` silence every `10 s` while idle, and closes sessions after `900 s` of user/agent inactivity with `ServerSessionExpired`. | `PROXY_KEEPALIVE_SECONDS`, `PROXY_MAX_IDLE_SECONDS` |
| Workspace config override | Resolves `gecx-config.json` from `../gecx-config.json` by default. | `GECX_CONFIG` |
| Concurrent session & frame caps | Max `4` concurrent upstream sessions; `1 MiB` inbound frame cap; `4 MiB` upstream frame cap. | `PROXY_MAX_SESSIONS` |

## Tests and Lint

```bash
cd cloudbank/proxy
uv run --locked --all-extras pytest -v
uv run --locked --all-extras ruff check .
```
