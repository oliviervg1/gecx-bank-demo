# Security Policy

Cloudbank is a multi-product retail banking reference application built on CX Agent Studio (GECX) (`CXAS`). All customer personas, sort codes (`00-00-99`), account numbers, balances, and transactions in this repository are synthetic demonstration data.

## Security Boundaries

### 1. WebSocket & Static SPA Proxy (`cloudbank/proxy`)

`cloudbank/proxy` bridges the browser workbench and CX Agent Studio (GECX) `BidiRunSession` streams across two explicit operating modes:

- **Localhost workstation mode (`127.0.0.1:8765`, developer `ADC`):** Binds to `127.0.0.1:8765` by default with `proxy_headers=False` (preventing `X-Forwarded-For` headers from spoofing loopback peer checks) and rejects non-loopback client peer addresses unless `PROXY_ALLOW_REMOTE=1` is paired with `PROXY_AUTH_TOKEN` or a valid `PROXY_IAP_AUDIENCE`. When `PROXY_AUTH_TOKEN` is set locally, Vite's dev and preview servers (`cloudbank/web/vite.config.ts`) inject `x-proxy-token` server-side on `/ws/agent` so bearer secrets never enter browser JavaScript. In Google Cloud Shell or GitHub Codespaces, keep **both** port `8765` (proxy) and port `5173` (Vite) set to **Private** (authenticated to your account), because Vite forwards `/ws/agent` over loopback.
- **Single-origin Cloud Run Direct IAP mode (`PROXY_IAP_AUDIENCE` + `PROXY_STATIC_DIR`, dedicated service account):** Deployed via `cloudbank/Dockerfile` and `cloudbank/scripts/deploy_cloud_run.sh` with `--no-allow-unauthenticated`, `--iap`, `--session-affinity`, and an explicit least-privilege `--service-account` (refusing default Compute Engine and App Engine service accounts, `allUsers`, `allAuthenticatedUsers`, and `PROXY_AUTH_TOKEN`). Inside `_ProxyTrustedHostMiddleware`, pure ASGI `_ProxyIapMiddleware` cryptographically verifies `x-goog-iap-jwt-assertion` (`ES256` pinned on the unverified header before `google.auth.jwt.decode`, `<= 8192` byte cap, duplicate-header rejection, single-flight cached keys from `https://www.gstatic.com/iap/verify/public_key` with a 24-hour maximum stale bound, `iss == "https://cloud.google.com/iap"`, exact `aud`, bounded token lifetime, and non-empty `sub` and `email`) on every non-`/health` HTTP request and before `ws.accept()` on `/ws/agent`. Startup in IAP mode fails closed unless both `PROXY_ALLOWED_ORIGINS` (exact `https://` non-loopback origins) and `PROXY_ALLOWED_HOSTS` (bare non-loopback hostnames, zero `*` wildcards) are explicitly set and `PROXY_ALLOW_TEST_HOSTS` is unset; combining `PROXY_STATIC_DIR` with a non-loopback bind or `PROXY_ALLOW_REMOTE=1` requires `PROXY_IAP_AUDIENCE`, and setting both `PROXY_AUTH_TOKEN` and `PROXY_IAP_AUDIENCE` enforces both checks.
- **Per-user session binding & protocol limits:** Enforces standalone ASGI `Host` validation (zero `*` wildcard support in any mode) and exact `Origin` allowlisting, disables OpenAPI documentation routes (`/docs`, `/redoc`, `/openapi.json`) with `redirect_slashes=False`, serves `GET`/`HEAD` static SPA responses only on `/` and `/assets/*` with a startup-validated Content Security Policy (`script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`) and `X-Content-Type-Options: nosniff`, rejects binary WebSocket frames (`1003`), caps concurrent sessions globally (`PROXY_MAX_SESSIONS`) and per verified IAP subject (`PROXY_MAX_SESSIONS_PER_USER`, default `2`), binds resumed sessions to `(persona, iap_sub)` (logging `sub` only, never email or raw JWTs), caps inbound WebSocket frames at `1 MiB` and PCM16 audio chunks at `64 KB` (`87,384` base64 characters), disconnects after `5` malformed client frames (`1008`), resets `PROXY_MAX_IDLE_SECONDS` (`900 s`) strictly on `ClientText`, non-empty speech transcripts, or `sessionOutput` events, and enforces `PROXY_MAX_SESSION_SECONDS` (`3600 s` default, `3300 s` in Cloud Run below `--timeout=3600`).
- Never bind `cloudbank/proxy` to `0.0.0.0` on an untrusted network without Cloud Run Direct IAP (`PROXY_IAP_AUDIENCE`), per-user IAM authorization (`roles/iap.httpsResourceAccessor`), and a dedicated least-privilege service account.

### 2. Server-Owned Persona Snapshot Trust Boundary (`cloudbank/shared/personas/*.json`)

Financial snapshots and prompt-interpolated customer attributes are owned by the server rather than supplied by the browser:

- Inbound `start` WebSocket frames (validated against `cloudbank/shared/ws_protocol.schema.json`) carry only the selected `persona` identifier (`chloe`, `david`, `tom`, or `sarah`), optional `timeOfDay`, optional `demoDate`, and optional session resume fields (`sessionId`, `lastUiSeq`).
- `cloudbank/proxy` loads the canonical fixture from `cloudbank/shared/personas/{persona}.json` on the server, validates it against `cloudbank/shared/customer_snapshot.schema.json`, derives `first_name` directly from `snapshot.user.first_name`, records each `sessionId`-to-`(persona, iap_sub)` binding only after upstream connection succeeds, and skips variable re-seeding only when resuming a verified active session bound to the same `persona` and `iap_sub`. Any unrecognized, cross-user, post-restart, or evicted `sessionId` mints a fresh server-generated UUID with `is_resume=False` and seeds `customer_snapshot` cleanly.
- Neither `{customer_snapshot}` nor `{ui_view_state}` is interpolated into any CXAS system instruction.

### 3. Wrapped Web Search Host Allowlisting & Output Sanitization (`search_help` & `relay.py`)

Subscription cancellation guidance in `assist_everyday_banking` invokes the wrapped `search_help` (`googleSearchTool`) tool under layered controls to mitigate indirect prompt injection, unverified third-party links, and scam phone-number readout:

- Live web lookups run only for canonical subscription vendors present in the active customer's `transactions` list.
- Returned result URLs must use `https://` and match an exact official vendor help-host allowlist in `cloudbank/shared/official_help_hosts.json` (plus `/gp/help` or `/hz/contact-us` path prefixes on `www.amazon.co.uk`, rejecting user-content subdomains such as `community.*`, `discussions.*`, or `forum.*`); non-allowlisted hosts are discarded in favor of deterministic in-controller cancellation guidance.
- `_sanitize_diagnosis_text` normalises Unicode dashes and strips `tel:`/`phone:`/`call:` prefixes, separator-punctuated 5+ digit phone runs, email addresses, and general `label.tld` domains before enclosing snippet text in `<untrusted_web_snippet>` delimiters as non-imperative reference data.
- Both `release_line` and `relay.py` strip closed and unclosed `<untrusted_web_snippet>` blocks and case-insensitive `[Diagnosis context: ...]` notes (alongside Composite v2 inline audio tags from `cloudbank/shared/composite_v2_tags.json`). `relay.py` also filters outbound `SessionOutput.citations` against the exact `https://` official help-host allowlist, and browser Google Search suggestion HTML renders inside a scriptless `sandbox` iframe with an inner Content Security Policy (`default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; form-action 'none';`) labeled clearly as web search results.
- CXAS model callbacks (`capture_utterance` and `release_line`) hide `transfer_to_agent`, `end_session`, and `search_help` on every model pass, strip forbidden tool calls even in mixed multi-call responses, validate `target_agent` against the four known CXAS agents, and fail closed on unexpected callback errors.

### 4. Local Configuration Hygiene

Keep your GCP project ID and deployed app UUID in `cloudbank/gecx-config.json` (which is ignored by Git) or pass `CLOUDBANK_GCP_PROJECT_ID` and `CLOUDBANK_APP_ID` via environment variables. Commit only placeholder values in `cloudbank/gecx-config.example.json`.

## Reporting a Vulnerability

Please do **not** report security vulnerabilities through public GitHub issues, discussions, or pull requests.

- **Repository vulnerabilities:** Use GitHub's private vulnerability reporting feature (**Security** -> **Report a vulnerability**) on this repository so findings can be triaged and remediated privately before disclosure.
- **Google Cloud or CX Agent Studio (GECX) platform vulnerabilities:** Report issues affecting Google Cloud APIs, SDKs, or CX Agent Studio (GECX) directly through the Google Vulnerability Reward Program at <https://bughunters.google.com/>.
