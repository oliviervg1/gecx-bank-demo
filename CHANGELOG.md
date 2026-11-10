# Changelog

All notable changes to the Cloudbank Multi-Product Retail Banking Reference Application are documented in this file. Entries follow **Why / Fix / Test / Docs** so engineers and reviewers can trace both intent and verification.

## [Unreleased] - 2026-11-10

### Multi-Product 4-Agent Tool-First Topology & Composite v2 Voice Bundle

- **Why:** Expand Cloudbank from a single-journey spending prototype using browser `clientFunction` round-trips into a full multi-product retail banking reference across Everyday Banking, Savings Goals, and Mortgages on `gemini-composite-v2` (`locations/eu`), with deterministic routing and zero hallucinated figures.
- **Fix:**
  - Replaced the legacy 2-agent (`root_agent` + `spending_agent`) and 6 browser `clientFunction` tools with a 4-agent hub-and-spoke bundle (`root_agent`, `everyday_banking_agent`, `savings_agent`, `mortgage_agent`) backed by four server-side Python controllers (`route_banking_intent`, `assist_everyday_banking`, `assist_savings`, `assist_mortgages`) and a wrapped Google Search tool (`search_help` with `toolFakeConfig`).
  - Implemented silent callback-driven transfers (`context.state["target_agent"]` → `before_model_callback` `Part.from_agent_transfer`, with `after_model_callback` `agent_transfer` as defense-in-depth), cross-spoke `handoff_context.freed_monthly_pence` pivot memory, local spoke handling for `NAVIGATE_HOME`, `NAVIGATE_PROFILE`, and `CAPABILITIES`, and a non-terminating 2-strike `unclear_count`.
  - Configured `en-GB-Chirp3-HD-Aoede` voice, `bargeInAwareness: true`, `{@startModalityVOICE}` / `{@startModalityTEXT}` global formatting rules, and three `respondImmediately` guardrails (`prompt_security_guardrail`, `model_safety_guardrail`, `fca_vulnerability_guardrail` using Ofcom drama-reserved Freephone `0808 157 0100` and Samaritans `116 123`).
- **Test:** `cxas lint` (`0` errors, `0` warnings including `T012` and `E001`–`E011`), `audit_agent.py` (`0` P0/P1/P2 findings), 40 offline `pytest` tests in `cloudbank/tests/` covering AST/bundle integrity, controller branches, callback chains, and `manage_ces_app.py` overwrite/orphan checks, plus multi-segment NAIVE golden YAMLs and `SimulationEvals`.
- **Docs:** Documented in `cloudbank/README.md`, `docs/architecture/banking_flows.md`, `docs/architecture/tool_first_architecture_guide.md`, and `docs/tools/*.md`.

### Web-Owned Integer `customer_snapshot` & Cross-Language Parity Vectors

- **Why:** Eliminate floating-point rounding drift between spoken agent calculations and visual UI calculators while keeping customer account and transaction payloads at `0` LLM prompt tokens.
- **Fix:**
  - Migrated all four persona fixtures (`chloe`, `david`, `tom`, `sarah`) to month-anchored (`month_offset: 0 | 1 | 2`, `day_of_month`) integer pence (`*_pence`) and integer basis points (`*_bps`, separating `gross_rate_bps` for monthly compounding from `aer_bps` for display/speech).
  - Authored `cloudbank/shared/customer_snapshot.schema.json`, `cloudbank/shared/ui_view_state.schema.json`, and `cloudbank/shared/parity_vectors.json`.
  - Implemented identical integer `half_up(n, d)` rounding, month-by-month savings/mortgage simulations, and integer bisection for fixed-rate renewal payments across Python controllers and TypeScript (`savingsMath.ts`, `mortgageMath.ts`, `spendingSummary.ts`, `spendingViews.ts`), normalizing `google.protobuf.Struct` float coercion at controller entry.
- **Test:** Verified every vector and edge case (including exact payment equality payoff and 600-month cap boundaries) in both `cloudbank/tests/test_parity_vectors.py` and `cloudbank/web/src/__tests__/parityVectors.test.ts`, plus AST bans on floating-point division, exponentiation, and `round` / `Math.round` / `toFixed`.
- **Docs:** Documented in `cloudbank/README.md` and `docs/architecture/tool_first_architecture_guide.md`.

### Three-Tier `ui_view_state` Synchronisation & Hardened Bidi WebSocket Proxy

- **Why:** Synchronise all five banking screens (`Home`, `Spending`, `Savings`, `Mortgage`, `Profile`) monotonically from server-side controllers without client-tool round-trips, while hardening the localhost WebSocket proxy against Cross-Site WebSocket Hijacking (CSWSH) and unvalidated variable injection.
- **Fix:**
  - Implemented monotonic `ui_view_state.seq` updates across Tier 1 (`capture_utterance` `partial=True` `Part.from_json`), Tier 2 (`release_line` persisted `Part.from_json`), and Tier 3 (`relay.py` fallback from `diagnostic_info` `updated_variables`), deduplicated by `(sessionId, Math.trunc(Number(seq)))`.
  - Hardened `cloudbank/proxy` with strict `Origin` matching (no wildcard suffix fallthrough), an explicit 5-key `CLIENT_SEEDABLE_VARIABLES` allowlist validated against `customer_snapshot.schema.json`, a 10-second `16 kHz` `LINEAR16` silence keepalive, `PROXY_MAX_IDLE_SECONDS = 900` (`ServerSessionExpired`), `ServerSearchSuggestions` forwarding, and farewell audio drain before `ServerEnd`.
- **Test:** 53 `pytest` tests in `cloudbank/proxy/tests/` and zero-warning `ruff check .` with PyPI-only `uv.lock`.
- **Docs:** Documented in `cloudbank/proxy/README.md` and `docs/architecture/bidi_ui_sync_and_session_runtime.md`.

### Cross-Rate `AudioWorklet`, 11-Row Session Machine & Executive Split-Screen UI

- **Why:** Support `44.1 kHz` and `48 kHz` browser hardware sample rates cleanly, eliminate race conditions across barge-in, farewell drain, and persona switching, and present a calm, executive-friendly banking and conversation experience free of technical jargon.
- **Fix:**
  - Replaced fixed-rate capture with a stateful cross-rate `AudioWorklet` (`16 / 44.1 / 48 kHz → 16 kHz`, `100 ms` chunks) that flushes partial speech immediately on release before streaming up to `2.5 s` of trailing endpointer silence.
  - Built a pure 11-row `sessionMachine.ts` handling barge-in playback epochs, farewell TTS drain, 15-second thinking watchdog, `ServerGoAway` session continuation, StrictMode idempotency, microphone-permission guidance with live text fallback, and instant persona switching.
  - Built the 5-tab Cloudbank app (`HomePage`, `SpendingPage`, `SavingsPage`, `MortgagePage`, `ProfilePage`) paired with the Flat Editorial Split-Screen `WorkbenchLayout.tsx` and executive `ConciergePanel.tsx` (starter prompts, plain-English specialist pills, sanitized prose stream, and sandboxed Google Search suggestion chips).
- **Test:** 44 Vitest test files (254 tests), `tsc -b`, `eslint --max-warnings 0`, and `vite build`.
- **Docs:** Documented in `README.md`, `docs/architecture/bidi_ui_sync_and_session_runtime.md`, `docs/guides/developer_workflow_and_cicd_guide.md`, and `docs/guides/qa_tester_guide.md`.
