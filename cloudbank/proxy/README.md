# Cloudbank BidiRunSession proxy

Authenticates with Google Cloud (Application Default Credentials) and relays
WebSocket frames between the browser and `wss://ces.googleapis.com/.../BidiRunSession`.

```bash
uvicorn proxy.main:app --reload --host 127.0.0.1 --port 8080
```

## Security posture — localhost only

**This proxy is unauthenticated by design and must not be exposed on a routable
interface.** It holds ADC credentials and opens CES sessions with them, so
anyone who can reach the port can spend the developer's GCP quota under the
developer's identity. `--host 127.0.0.1` is passed explicitly above rather than
relying on uvicorn's default. Never add `--host 0.0.0.0` without first adding
authentication; `--reload` should never run on a shared host either.

Controls that *are* in place (see the module docstring in `src/proxy/main.py`):

| Control | Default | Override |
|---|---|---|
| Origin allowlist — CORS does not apply to WebSockets, so without this any page you visit while the proxy runs could open a session | `http://localhost:5173`, `http://127.0.0.1:5173`, plus hosted dev suffixes (below) | `PROXY_ALLOWED_ORIGINS` (comma-separated; replaces the exact list) |
| Concurrent session cap — each socket opens a *new* upstream CES session | 4 | `PROXY_MAX_SESSIONS` |
| Inbound frame cap | 1 MiB | `MAX_CLIENT_FRAME_BYTES` in `protocol.py` |
| Upstream frame cap | 4 MiB | `_MAX_UPSTREAM_FRAME_BYTES` in `main.py` |
| Session-variable allowlist — variables are templated into the system instruction, so an unfiltered dict is a prompt-injection channel | read from `app.json`'s `variableDeclarations` | — |

Requests with **no** `Origin` header are allowed: only browsers set it, and a
non-browser client already needs network access to the port.

### Hosted dev environments

Cloud Shell, Cloud Workstations, Codespaces and Gitpod serve the Vite app from a
generated per-user HTTPS host and reach the proxy through Vite's own
`/ws/agent` proxy, so the `Origin` is that host rather than `localhost`. These
suffixes are accepted **over TLS** alongside the exact list:

```
.cloudshell.dev  .cloudworkstations.dev  .github.dev  .gitpod.io
```

They are per-user workspaces behind the provider's SSO, so reaching one already
requires being signed in as the developer. Matching is on the parsed hostname,
never the raw string, so `https://evil.example/?x=.cloudshell.dev` and
`https://cloudshell.dev.evil.example` are both still rejected.

**If the pill sits on "Retry" and nothing seems wrong upstream, check this
first.** A rejected origin logs `rejecting websocket from disallowed origin`
and returns 403; the browser burns its three auto-retries and gives up, which
looks exactly like the proxy being down. Set `PROXY_ALLOWED_ORIGINS` if you
serve the app from anywhere else.

Error envelopes sent to the browser are deliberately generic ("server
configuration error"); the detail stays in the server log so filesystem paths
and exception text don't reach the client.

## Dependencies

`websockets>=15` is a hard floor, not a preference — `main.py` catches
`websockets.exceptions.InvalidStatus`, which does not exist before v15.

`uv.lock` is committed; regenerate with `uv lock` after changing
`pyproject.toml`.

## Tests and lint

```bash
python -m pytest      # from cloudbank/proxy/
uvx ruff check .
```
