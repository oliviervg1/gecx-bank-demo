# Changelog

All notable changes to the Cloudbank Multi-Product Retail Banking Reference Application are documented in this file. Entries follow Why / Fix / Test / Docs so engineers and reviewers can trace both intent and verification.

## [Unreleased] - 2026-11-11

### Public Repository Hygiene, Server-Owned Snapshots & Security Hardening

- **Why:** Eliminate client-seeded snapshot trust gaps, indirect web-search prompt injection risks, fail-open callback error paths, and tracked workspace configuration files while pinning CI and dependency workflows to strict public-registry and commit-SHA baselines.
- **Fix:**
  - Untracked and gitignored `cloudbank/gecx-config.json` in favor of committed `cloudbank/gecx-config.example.json` and `CLOUDBANK_GCP_PROJECT_ID` / `CLOUDBANK_LOCATION` / `CLOUDBANK_APP_ID` overrides; added root `Makefile`, Apache-2.0 `LICENSE`, `SECURITY.md`, and `cloudbank/scripts/VENDORED.md`; removed the vendored `.agents/skills/` tree; renamed `cloudbank/scripts/manage_app.py` and added `--yes` / TTY confirmation before `prod` `OVERWRITE` imports in `cloudbank/push.sh`.
  - Moved canonical persona fixtures to `cloudbank/shared/personas/{chloe,david,tom,sarah}.json` and added `cloudbank/shared/ws_protocol.schema.json`. The browser now sends a lean `ClientStart` (`persona`, `timeOfDay`, `demoDate`, optional `sessionId` and `lastUiSeq`) while `cloudbank/proxy` loads and validates snapshots server-side, derives `first_name` from `snapshot.user.first_name`, binds `sessionId` to `persona`, skips variable re-seeding on resume, enforces loopback peers (`PROXY_ALLOW_REMOTE=1` override), `TrustedHostMiddleware`, `asyncio.Semaphore` session caps, binary WebSocket frame `1003` rejection, `ws_max_size=1048576` (`python -m proxy`), and optional `PROXY_AUTH_TOKEN`.
  - Consolidated canonical callbacks into `cloudbank/cxas_shared/callbacks/` synced via `cloudbank/scripts/sync_shared.py`: isolated `hide_tool` calls so internal tools stay hidden on errors, failed closed with a safe canned `LlmResponse`, removed text-regex transfer scanning in favor of `_ALLOWED_AGENTS`-validated `target_agent` state, guarded `release_line` against `llm_response.partial`, set `failOpen: false` on `fca_vulnerability_guardrail`, restricted `search_help` lookups to canonical subscription rows with an official registrable-domain allowlist, stripped phone numbers/emails/URLs, and wrapped snippets in `<untrusted_web_snippet>` delimiters.
  - Keyed `anomaly_by_vendor` per merchant in `assist_everyday_banking`, added `confirm_pivot` to `assist_mortgages` so renters can decline the savings pivot cleanly, preserved `handoff_context` across `switch_intent` hops, and unified calendar date validation, zero-balance mortgage renewal handling, and negative-amortisation guards across Python and TypeScript.
- **Test:** Pinned all GitHub Actions in `.github/workflows/ci.yml` to 40-character commit SHAs with `persist-credentials: false`, added positive PyPI/npmjs lockfile host allowlists and zero-exemption tracked-file leak checks, added `/cloudbank` to `.github/dependabot.yml`, enabled repo-wide Ruff and Pyright across `cloudbank/` and `cloudbank/proxy/`, and expanded adversarial callback, search-domain, WebSocket schema, and real-socket proxy tests.
- **Docs:** Updated `README.md`, `AGENTS.md`, `GEMINI.md`, `SECURITY.md`, `docs/architecture/*.md`, `docs/tools/*.md`, and `docs/guides/*.md`.

### React 19, Tailwind CSS v4, Voice Floor Control & WCAG 2.1 AA Compliance

- **Why:** Modernize the frontend stack, remove heavy charting dependencies, fix continuous-listening and `ServerGoAway` reconnect edge cases, and achieve verified WCAG 2.1 AA compliance across all five tabs and both workbench modes.
- **Fix:**
  - Upgraded `cloudbank/web` to React 19 and Tailwind CSS v4 (`@tailwindcss/vite`), replaced `recharts` with lightweight accessible semantic SVG bar components, enabled `noUncheckedIndexedAccess` and `verbatimModuleSyntax`, bundled the TypeScript `pcm-capture` `AudioWorklet` with transferable buffers, opened playback `AudioContext` at native sample rate, renamed `BankingViewStateProvider`, fixed viewport `<Toast>` positioning, and lifted `"Log out securely"` to full app-level session sign-out.
  - Added `inputMode: 'ptt' | 'continuous'` to `sessionMachine.ts` (`?ptt=0` returns cleanly to `'capturing'` after playback drain with an active Mute/Stop pill), added Click and `Enter` Toggle-to-Talk with `aria-pressed`, granted the user floor when pressing PTT during `thinking`, added bounded exponential backoff with jitter on `ServerGoAway` reconnects while preserving `lastUiSeq`, and updated `streamSanitizer.ts` to preserve fixture vendor acronyms (`BT`, `OVO`).
  - Resolved WCAG 2.1 AA findings: re-enabled viewport pinch-to-zoom (`lang="en-GB"`), added `#8a6318` `brand-gold-text` (`5.32:1` on white) and `#8f8c84` control borders (`>= 3.1:1`), global `:focus-visible` rings, shared WAI-ARIA `<SegmentedTabs>`, mobile `<main>` landmark and skip link, `<640px` persona switcher and view toggle, polite finalized-turn and UI-navigation announcers, `role="progressbar"`, and `prefers-reduced-motion` guards.
- **Test:** Added live-browser Playwright + `@axe-core/playwright` E2E tests (`make e2e` and CI `e2e` job) against `cloudbank/proxy` (`FakeBidiUpstream`) and `vite preview`, alongside expanded Vitest unit, parity, and `ws_protocol.schema.json` conformance suites.
- **Docs:** Documented in `README.md`, `docs/architecture/bidi_ui_sync_and_session_runtime.md`, and `docs/guides/developer_workflow_and_cicd_guide.md`.

## [0.2.0] - 2026-11-10

### Multi-Product 4-Agent Tool-First Topology & Composite v2 Voice Bundle

- **Why:** Expand Cloudbank from a single-journey spending prototype using browser `clientFunction` round-trips into a full multi-product retail banking reference across Everyday Banking, Savings Goals, and Mortgages on `gemini-composite-v2` (`locations/eu`), with deterministic routing and zero hallucinated figures.
- **Fix:**
  - Replaced the legacy 2-agent (`root_agent` + `spending_agent`) and 6 browser `clientFunction` tools with a 4-agent hub-and-spoke bundle (`root_agent`, `everyday_banking_agent`, `savings_agent`, `mortgage_agent`) backed by four server-side Python controllers (`route_banking_intent`, `assist_everyday_banking`, `assist_savings`, `assist_mortgages`) and a wrapped Google Search tool (`search_help` with `toolFakeConfig`).
  - Implemented silent callback-driven transfers (`context.state["target_agent"]` -> `before_model_callback` `Part.from_agent_transfer`, with `after_model_callback` `agent_transfer` as defense-in-depth), cross-spoke `handoff_context.freed_monthly_pence` pivot memory, local spoke handling for `NAVIGATE_HOME`, `NAVIGATE_PROFILE`, and `CAPABILITIES`, and a non-terminating 2-strike `unclear_count`.
  - Configured `en-GB-Chirp3-HD-Aoede` voice, `bargeInAwareness: true`, `{@startModalityVOICE}` / `{@startModalityTEXT}` global formatting rules, and three `respondImmediately` guardrails (`prompt_security_guardrail`, `model_safety_guardrail`, `fca_vulnerability_guardrail` using Ofcom drama-reserved Freephone `0808 157 0100` and Samaritans `116 123`).
- **Test:** `cxas lint` (`0` errors, `0` warnings including `T012` and `E001`-`E011`), `audit_agent.py` (`0` P0/P1/P2 findings), offline `pytest` tests in `cloudbank/tests/` covering AST/bundle integrity, controller branches, and callback chains, plus multi-segment NAIVE golden YAMLs and `SimulationEvals`.
- **Docs:** Documented in `cloudbank/README.md`, `docs/architecture/banking_flows.md`, `docs/architecture/tool_first_architecture_guide.md`, and `docs/tools/*.md`.

### Integer `customer_snapshot` & Cross-Language Parity Vectors

- **Why:** Eliminate floating-point rounding drift between spoken agent calculations and visual UI calculators while keeping customer account and transaction payloads at `0` LLM prompt tokens.
- **Fix:**
  - Migrated all four persona fixtures (`chloe`, `david`, `tom`, `sarah`) to month-anchored (`month_offset: 0 | 1 | 2`, `day_of_month`) integer pence (`*_pence`) and integer basis points (`*_bps`, separating `gross_rate_bps` for monthly compounding from `aer_bps` for display and speech).
  - Authored `cloudbank/shared/customer_snapshot.schema.json`, `cloudbank/shared/ui_view_state.schema.json`, and `cloudbank/shared/parity_vectors.json`.
  - Implemented identical integer `half_up(n, d)` rounding, month-by-month savings and mortgage simulations, and integer bisection for fixed-rate renewal payments across Python controllers and TypeScript (`savingsMath.ts`, `mortgageMath.ts`, `spendingSummary.ts`, `spendingViews.ts`), normalizing `google.protobuf.Struct` float coercion at controller entry.
- **Test:** Verified every vector and edge case (including exact payment equality payoff and 600-month cap boundaries) in both `cloudbank/tests/test_parity_vectors.py` and `cloudbank/web/src/__tests__/parityVectors.test.ts`, plus AST bans on floating-point division, exponentiation, and `round` / `Math.round` / `toFixed`.
- **Docs:** Documented in `cloudbank/README.md` and `docs/architecture/tool_first_architecture_guide.md`.

### Three-Tier `ui_view_state` Synchronisation & Bidi WebSocket Proxy

- **Why:** Synchronise all five banking screens (`Home`, `Spending`, `Savings`, `Mortgage`, `Profile`) monotonically from server-side controllers without client-tool round-trips, while hardening the localhost WebSocket proxy against Cross-Site WebSocket Hijacking (`CSWSH`).
- **Fix:**
  - Implemented monotonic `ui_view_state.seq` updates across Tier 1 (`capture_utterance` `partial=True` `Part.from_json`), Tier 2 (`release_line` persisted `Part.from_json`), and Tier 3 (`relay.py` fallback from `diagnostic_info` `updated_variables`), deduplicated by `(sessionId, Math.trunc(Number(seq)))`.
  - Hardened `cloudbank/proxy` with strict `Origin` matching (no wildcard suffix fallthrough), `customer_snapshot.schema.json` validation, a 10-second `16 kHz` `LINEAR16` silence keepalive, `PROXY_MAX_IDLE_SECONDS = 900` (`ServerSessionExpired`), `ServerSearchSuggestions` forwarding, and farewell audio drain before `ServerEnd`.
- **Test:** Offline `pytest` tests in `cloudbank/proxy/tests/` and zero-warning `ruff check .` with PyPI-only `uv.lock`.
- **Docs:** Documented in `cloudbank/proxy/README.md` and `docs/architecture/bidi_ui_sync_and_session_runtime.md`.

### Cross-Rate `AudioWorklet`, Session State Machine & Split-Screen UI

- **Why:** Support `44.1 kHz` and `48 kHz` browser hardware sample rates cleanly, eliminate race conditions across barge-in, farewell drain, and persona switching, and present a calm banking and conversation experience free of technical jargon.
- **Fix:**
  - Replaced fixed-rate capture with a stateful cross-rate `AudioWorklet` (`16 / 44.1 / 48 kHz -> 16 kHz`, `100 ms` chunks) that flushes partial speech immediately on release before streaming up to `2.5 s` of trailing endpointer silence.
  - Built a pure reducer in `sessionMachine.ts` handling barge-in playback epochs, farewell TTS drain, 15-second thinking watchdog, `ServerGoAway` session continuation, `StrictMode` idempotency, microphone-permission guidance with live text fallback, and instant persona switching.
  - Built the 5-tab Cloudbank app (`HomePage`, `SpendingPage`, `SavingsPage`, `MortgagePage`, `ProfilePage`) paired with the Split-Screen `WorkbenchLayout.tsx` and `ConciergePanel.tsx` (starter prompts, plain-English specialist pills, sanitized prose stream, and sandboxed Google Search suggestion chips).
- **Test:** Vitest unit and integration tests, `tsc -b`, `eslint --max-warnings 0`, and `vite build`.
- **Docs:** Documented in `README.md`, `docs/architecture/bidi_ui_sync_and_session_runtime.md`, `docs/guides/developer_workflow_and_cicd_guide.md`, and `docs/guides/qa_tester_guide.md`.
