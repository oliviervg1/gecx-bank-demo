# Security Policy

Cloudbank is a multi-product retail banking reference application built on CX Agent Studio (GECX) (`CXAS`). All customer personas, sort codes (`00-00-99`), account numbers, balances, and transactions in this repository are synthetic demonstration data.

## Security Boundaries

### 1. Localhost-Only ADC WebSocket Proxy (`cloudbank/proxy`)

`cloudbank/proxy` is a local development bridge between the browser workbench and CX Agent Studio (GECX) `BidiRunSession` streams. Because it uses local Google Cloud Application Default Credentials (`ADC`) from the developer's workstation, it is designed strictly for localhost execution:

- Binds to `127.0.0.1:8765` by default with `proxy_headers=False` (preventing `X-Forwarded-For` headers from spoofing or breaking loopback peer checks) and rejects non-loopback client peer addresses unless `PROXY_ALLOW_REMOTE=1` is explicitly set alongside a non-empty `PROXY_AUTH_TOKEN`. Startup fails closed whenever `PROXY_ALLOW_REMOTE=1` or a non-loopback `PROXY_HOST` (such as `0.0.0.0`) is configured without `PROXY_AUTH_TOKEN`.
- When `PROXY_AUTH_TOKEN` is set, Vite's dev and preview servers (`cloudbank/web/vite.config.ts`) inject `x-proxy-token` server-side on `/ws/agent` so bearer secrets are never exposed in client-side JavaScript. In Google Cloud Shell or GitHub Codespaces, keep **both** port `8765` (proxy) and port `5173` (Vite) set to **Private** (authenticated to your account), because Vite forwards `/ws/agent` over loopback.
- Enforces standalone ASGI `Host` validation (rejecting invalid WebSocket `Host` headers cleanly via `websocket.http.response.start` or close code `1008`) and exact `Origin` allowlisting without wildcard suffix matching, disables OpenAPI documentation routes, rejects binary WebSocket frames (`1003`), caps concurrent sessions (`PROXY_MAX_SESSIONS`), caps inbound WebSocket frames at `1 MiB` and PCM16 audio chunks at `64 KB` (`87,384` base64 characters), disconnects after `5` malformed client frames (`1008`), resets `PROXY_MAX_IDLE_SECONDS` (`900 s`) strictly on `ClientText`, non-empty speech transcripts, or `sessionOutput` events (never on raw ambient audio frames), and enforces a hard upper session lifetime via `PROXY_MAX_SESSION_SECONDS` (`3600 s`).
- Production web builds tighten the browser Content Security Policy (`script-src 'self'`, `connect-src 'self'`). Never bind `cloudbank/proxy` to `0.0.0.0` on an untrusted network or deploy it to a public endpoint without end-user authentication, per-user authorization, and server-managed service credentials.

### 2. Server-Owned Persona Snapshot Trust Boundary (`cloudbank/shared/personas/*.json`)

Financial snapshots and prompt-interpolated customer attributes are owned by the server rather than supplied by the browser:

- Inbound `start` WebSocket frames (validated against `cloudbank/shared/ws_protocol.schema.json`) carry only the selected `persona` identifier (`chloe`, `david`, `tom`, or `sarah`), optional `timeOfDay`, optional `demoDate`, and optional session resume fields (`sessionId`, `lastUiSeq`).
- `cloudbank/proxy` loads the canonical fixture from `cloudbank/shared/personas/{persona}.json` on the server, validates it against `cloudbank/shared/customer_snapshot.schema.json`, derives `first_name` directly from `snapshot.user.first_name`, records each `sessionId`-to-`persona` binding only after upstream connection succeeds, and skips variable re-seeding only when resuming a verified active session bound to the same `persona`. Any unrecognized, post-restart, or evicted `sessionId` mints a fresh server-generated UUID with `is_resume=False` and seeds `customer_snapshot` cleanly.
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
