# Security Policy

Cloudbank is a multi-product retail banking reference application built on CX Agent Studio (GECX) (`CXAS`). All customer personas, sort codes (`00-00-99`), account numbers, balances, and transactions in this repository are synthetic demonstration data.

## Security Boundaries

### 1. Localhost-Only ADC WebSocket Proxy (`cloudbank/proxy`)

`cloudbank/proxy` is a local development bridge between the browser workbench and CX Agent Studio (GECX) `BidiRunSession` streams. Because it uses local Google Cloud Application Default Credentials (`ADC`) from the developer's workstation, it is designed strictly for localhost execution:

- Binds to `127.0.0.1` by default and rejects non-loopback client peer addresses unless explicitly overridden for local container networking (`PROXY_ALLOW_REMOTE=1`).
- Enforces strict `Origin` and `Host` header validation (`TrustedHostMiddleware` plus explicit origin allowlisting without wildcard suffix matching), disables OpenAPI documentation routes, caps concurrent WebSocket sessions and frame sizes (`1 MiB`), and supports an optional bearer secret (`PROXY_AUTH_TOKEN`).
- Never bind `cloudbank/proxy` to `0.0.0.0` on an untrusted network or deploy it to a public endpoint without adding end-user authentication, per-user authorization, and server-managed service credentials.

### 2. Server-Owned Persona Snapshot Trust Boundary (`cloudbank/shared/personas/*.json`)

Financial snapshots and prompt-interpolated customer attributes are owned by the server rather than supplied by the browser:

- Inbound `start` WebSocket frames (validated against `cloudbank/shared/ws_protocol.schema.json`) carry only the selected `persona` identifier (`chloe`, `david`, `tom`, or `sarah`), optional `timeOfDay`, optional `demoDate`, and optional session resume fields (`sessionId`, `lastUiSeq`).
- `cloudbank/proxy` loads the canonical fixture from `cloudbank/shared/personas/{persona}.json` on the server, validates it against `cloudbank/shared/customer_snapshot.schema.json`, derives `first_name` directly from `snapshot.user.first_name`, binds each `sessionId` to its initial `persona`, and skips variable re-seeding when resuming an existing session.
- Neither `{customer_snapshot}` nor `{ui_view_state}` is interpolated into any CXAS system instruction.

### 3. Wrapped Web Search Domain Allowlisting (`search_help`)

Subscription cancellation guidance in `assist_everyday_banking` invokes the wrapped `search_help` (`googleSearchTool`) tool under layered controls to mitigate indirect prompt injection and scam phone-number readout:

- Live web lookups run only for canonical subscription vendors present in the active customer's `transactions` list.
- Returned result URLs must match an exact registrable-domain allowlist of official vendor help domains; non-allowlisted hosts are discarded in favor of deterministic in-controller cancellation guidance.
- Snippets have phone numbers, email addresses, and URLs stripped before being enclosed in `<untrusted_web_snippet>` delimiters as non-imperative reference data, and browser citation HTML renders inside a scriptless `sandbox` iframe restricted to `http:` and `https:` links.
- CXAS model callbacks hide `transfer_to_agent`, `end_session`, and `search_help` on every model pass, validate `target_agent` against the four known CXAS agents, and fail closed on unexpected callback errors.

### 4. Local Configuration Hygiene

Keep your GCP project ID and deployed app UUID in `cloudbank/gecx-config.json` (which is ignored by Git) or pass `CLOUDBANK_GCP_PROJECT_ID` and `CLOUDBANK_APP_ID` via environment variables. Commit only placeholder values in `cloudbank/gecx-config.example.json`.

## Reporting a Vulnerability

Please do **not** report security vulnerabilities through public GitHub issues, discussions, or pull requests.

- **Repository vulnerabilities:** Use GitHub's private vulnerability reporting feature (**Security** -> **Report a vulnerability**) on this repository so findings can be triaged and remediated privately before disclosure.
- **Google Cloud or CX Agent Studio (GECX) platform vulnerabilities:** Report issues affecting Google Cloud APIs, SDKs, or CX Agent Studio (GECX) directly through the Google Vulnerability Reward Program at <https://bughunters.google.com/>.
