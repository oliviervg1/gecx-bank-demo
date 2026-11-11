# Tool-First Architecture Guide

Cloudbank uses a tool-first architecture on [CX Agent Studio](https://docs.cloud.google.com/gemini-enterprise-cx/cx-agent-studio) (`GECX`): Python controllers own every financial calculation, session state transition, screen navigation update, and specialist handoff, while `gemini-composite-v2` focuses on natural slot extraction and warm spoken or written phrasing.

## 1. Why Python Owns State, Math, and Routing

Conversational banking has zero tolerance for approximate arithmetic, skipped disclosures, or audible handoff chatter:

1. Zero LLM Arithmetic: large language models never sum transaction histories, compound monthly interest, or amortise mortgages in token space. Every figure spoken by Cloudbank is pre-formatted in pounds and percentages inside a Python controller's single-key `{"agent_action": "..."}` return value.
2. Fail-Closed Callbacks & Validated Silent Routing: prompt-driven transfers (`{@AGENT: ...}` or model-invoked `transfer_to_agent`) risk double-speaking or unauthorized target injection. Instead:
   - Neither `{@AGENT: ...}` nor the words `"transfer"`, `"transferring"`, or `"connecting"` appear anywhere in [instructions](https://docs.cloud.google.com/gemini-enterprise-cx/cx-agent-studio/instruction) or `agent_action`.
   - Two canonical [callbacks](https://docs.cloud.google.com/gemini-enterprise-cx/cx-agent-studio/callback) (`capture_utterance` and `release_line`, producing `8` synced callback files across the `4` agents) and shared pure controller helpers (`cloudbank/cxas_shared/controller_common.py`) sync deterministically via `cloudbank/scripts/sync_shared.py` (`--check` verified in `pytest` and CI).
   - `capture_utterance` hides `transfer_to_agent`, `end_session`, and `search_help` inside an isolated top-level guard on every model pass (wrapping `hide_tool` on post-tool `returned_tool` as well) so downstream errors cannot leave internal tools exposed, checks `_MAX_PASSES` before emitting Tier 1 partial UI updates, and fails closed with a safe canned `LlmResponse` on unexpected callback errors.
   - When a controller needs another specialist, it writes `context.state["target_agent"] = "<agent>"`. Both `capture_utterance` (post-tool `_is_tool_response` pass) and unified `release_line` (state-only defense-in-depth, stripping forbidden tool calls even in mixed multi-call responses with zero text regex scanning) validate `target_agent` against an explicit allowlist of the four known agents (`root_agent`, `everyday_banking_agent`, `savings_agent`, `mortgage_agent`) before clearing `target_agent` and emitting `Part.from_agent_transfer`.
3. Cross-Spoke Pivot Memory (`handoff_context`): when a customer cancels or reviews a recurring subscription (such as Chloe's `£45.00` Netflix charge) and pivots to Savings or Mortgages, `assist_everyday_banking` writes `handoff_context = {"from_agent": "everyday_banking_agent", "vendor": "Netflix", "freed_monthly_pence": 4500}`. `assist_savings` and `assist_mortgages` preserve `handoff_context` across intermediate domain `switch_intent` hops, clear it on `NAVIGATE_HOME` / `NAVIGATE_PROFILE`, and consume then clear `context.state["handoff_context"] = {}` once a local calculation runs so stale amounts never bleed into later turns.
4. Spoke-Local Navigation, Bounded Pivots & Non-Terminating 2-Strike Unclear Policy: every spoke handles `switch_intent="NAVIGATE_HOME" | "NAVIGATE_PROFILE" | "CAPABILITIES"` locally with unified spoken copy and pending-flag cleanup, and checks `int(pass_count) > 4` before staging cross-spoke pivots (`_MAX_PASSES = 8` in `capture_utterance`). Unclear or empty turns increment shared `unclear_count` even when a pending confirmation is armed: Strike 1 asks a brief clarifying question; Strike 2 clears stale pending flags, resets `ui_view_state` to `Home`, resets `unclear_count = "0"`, states Cloudbank's capabilities, and keeps the session open.

### Why Four Specialist Agents vs. a Single-Agent Design

Because Python controllers own all deterministic math, routing, and state transitions, a production team with a compact domain surface could alternatively attach all four controller tools to a single CXAS agent and eliminate `target_agent`, `handoff_context`, and multi-segment evaluation splits. Cloudbank intentionally uses the 4-agent hub-and-spoke topology as a reference blueprint on CX Agent Studio (GECX) to demonstrate:

- Silent, state-validated callback transfers (`Part.from_agent_transfer`) with zero audible handoff filler or model-exposed `transfer_to_agent` calls.
- Narrow per-spoke tool schemas and focused domain instructions (`everyday_banking_agent` sees only everyday banking slots, `savings_agent` sees only savings slots, and `mortgage_agent` sees only mortgage slots), scaling cleanly when individual product lines grow independently.
- Multi-segment NAIVE golden evaluation authoring (`toolCall -> agentResponse -> agentTransfer`) verified end-to-end by `run_golden_evals.py`.

---

## 2. Server-Owned `customer_snapshot` & `protobuf.Struct` Coercion

Customer financial fixtures are owned by the server at `cloudbank/shared/personas/{chloe,david,tom,sarah}.json` rather than supplied by the browser:

- Lean `ClientStart` & Session Binding: on WebSocket `ClientStart` (validated against `cloudbank/shared/ws_protocol.schema.json`), the browser sends only `persona`, optional `timeOfDay`, optional `demoDate`, and optional session resume fields (`sessionId`, `lastUiSeq`). `cloudbank/proxy` loads and validates `cloudbank/shared/personas/<persona>.json` against `cloudbank/shared/customer_snapshot.schema.json`, derives `first_name` directly from `snapshot.user.first_name`, records each `sessionId`-to-`persona` binding only after upstream connection succeeds, skips variable re-seeding strictly on verified active resumes (minting a fresh server UUID with `is_resume=False` whenever `sessionId` is unknown, restarted, or evicted), and seeds `persona_id`, `first_name`, `demo_date`, `time_of_day`, and `customer_snapshot` via `BidiRunSession` `realtimeInput.variables`.
- Zero Prompt Tokens: in `app.json`, `customer_snapshot` and `ui_view_state` are declared as `{"type": "OBJECT", "required": []}` with no `properties` (`V001`), and neither `{customer_snapshot}` nor `{ui_view_state}` appears in `global_instruction.txt` or any `instruction.txt`. Only Python controllers inspect `context.state["customer_snapshot"]`.
- `google.protobuf.Struct` Float Normalisation: because `realtimeInput.variables` in the upstream `BidiRunSession` WebSocket protocol maps to `google.protobuf.Struct` on the CXAS runtime, JSON integers (`4500`) arrive in Python session state as floats (`4500.0`). Each spoke controller coerces snapshot fields back to exact Python `int` values once at entry via `_normalize_snapshot`, and `cloudbank/tests/conftest.py` round-trips every fixture through `google.protobuf.struct_pb2.Struct` so offline `pytest` exercises the exact live wire representation.

---

## 3. Exact Cross-Language Integer Financial Math

All monetary amounts in fixtures and calculators are stored in integer pence (`*_pence`) and all rates in integer basis points (`*_bps`). Both Python controllers and TypeScript selectors (`savingsMath.ts`, `mortgageMath.ts`, `spendingSummary.ts`, `spendingViews.ts`) implement the exact formulas frozen in `cloudbank/shared/parity_vectors.json`:

```python
# Half-up integer division for non-negative integers n >= 0, d > 0:
def _half_up(n: int, d: int) -> int:
    return (n * 2 + d) // (2 * d)

# Monthly compound interest step (rate_bps / 10,000 / 12 == rate_bps / 120,000):
interest_pence = _half_up(balance_pence * rate_bps, 120_000)
```

- Savings Projections: iterate month `1..600` compounding `gross_rate_bps` first and adding `monthly_contribution_pence + extra_monthly_pence`, while quoting `aer_bps` in speech and UI headers (`savingsMath.ts` and `mortgageMath.ts` evaluate `halfUp` with `BigInt` so schema-maximum trajectories never overflow JavaScript `Number.MAX_SAFE_INTEGER`). Goals not met within `600` months return `unreachable = True`.
- Mortgage Overpayments, Negative-Amortisation Guard & Year-One ERC Check: compare baseline `simulate_mortgage` against `balance_pence - effective_lump_pence` at `next_payment.amount_pence + monthly_overpayment_pence`, exiting early if monthly `interest >= payment` so non-amortising inputs never compound over 600 iterations. First-year overpayments clamp monthly contributions by `min(12, projected.months)` and test strict inequality (`first_year > remaining_allowance`) so exact-boundary overpayments remain ERC-free.
- Renewal Deal Bisection: `rate_options` returns `0` immediately when `balance_pence <= 0` and otherwise finds the smallest integer `payment_pence` that amortises `balance_pence` within `term_remaining_months` using integer bisection over the identical `simulate_mortgage` kernel (`low = half_up(balance * rate_bps, 120_000) + 1`, `high = balance + low`).
- Unicode Vendor & Calendar Parity: Python (`ch.isalnum()`) and TypeScript (`/\p{L}|\p{N}/u`) apply identical Unicode vendor token normalisation and strict calendar date validation (`2000 <= year <= 2100`, defaulting to `2026-11-24`).
- Deterministic Sync & Test Enforcement: `sync_shared.py` splices shared pure helpers from `cloudbank/cxas_shared/controller_common.py` into all four single-file controllers; `test_bundle_integrity.py` verifies byte-exact sync and bans `/`, `**`, and `round(...)` inside financial kernels, while `pytest` and `vitest` (`ajv` schema validation + parity tests) verify every vector in `cloudbank/shared/parity_vectors.json`.

---

## 4. Allowlisted `tools.search_help` Grounding & Prompt-Injection Defence

To answer *"How do I cancel Netflix?"* with live UK help guidance while preventing indirect prompt injection, unverified third-party citation links, and scam phone-number readout:

1. `search_help` (`googleSearchTool`) is declared in `everyday_banking_agent.json` (`T008`), negatively referenced in `everyday_banking_agent/instruction.txt` (`I012`), and hidden from direct model invocation in `capture_utterance`.
2. `assist_everyday_banking(query_type="cancel_subscription")` invokes `tools.search_help` only when `vendor_name` resolves to a canonical recurring or subscription merchant present in the customer's `transactions` list.
3. `_lookup_cancellation_guidance` checks `urlsplit(url)` strictly for `https://` and an exact hostname match against `cloudbank/shared/official_help_hosts.json` (such as `help.netflix.com`, `support.spotify.com`, `helpx.adobe.com`, `support.apple.com`, plus `/gp/help` or `/hz/contact-us` path prefixes on `www.amazon.co.uk`), rejecting user-content subdomains (`community.*`, `discussions.*`, `forum.*`) and falling back cleanly to deterministic account-settings cancellation steps.
4. `_sanitize_diagnosis_text` normalises Unicode dashes, strips `tel:`/`phone:`/`call:` prefixes, separator-punctuated 5+ digit phone runs, email addresses, and general `label.tld` domains, caps length, and encloses snippet text inside `<untrusted_web_snippet>...</untrusted_web_snippet>` delimiters inside `[Diagnosis context: ...]`. `everyday_banking_agent/instruction.txt` forbids following instructions inside `<untrusted_web_snippet>` or reading phone numbers, emails, or URLs aloud; both `release_line` and `relay.py` strip closed and unclosed `<untrusted_web_snippet>` blocks and case-insensitive `[Diagnosis context: ...]` notes; and `relay.py` filters `SessionOutput.citations` against the exact `https://` `official_help_hosts.json` allowlist before forwarding citation chips to `ConciergePanel`.
5. `tools/search_help/search_help.json` keeps `"enableFakeMode": true` (`ToolFakeConfig`) because CX Agent Studio (`GECX`) requires per-tool `enableFakeMode` opt-in for `EvaluationToolCallBehaviour.FAKE` to intercept `tools.search_help` deterministically during NAIVE golden runs, while live `BidiRunSession` traffic executes real Google Search.

---

## 5. Live `locations/eu` Platform Verification Notes

Empirical verification against `locations/eu` confirms regional platform execution:

- Live `tools.search_help` (`googleSearchTool`) grounding & citations: invoking `tools.search_help` inside `assist_everyday_banking` in `locations/eu` returns a response wrapper whose `.json()` payload is `{"search_query": ..., "snippets": [{"url", "title", "text"}]}` in `~136 ms` (whereas `toolFakeConfig` returns that `dict` directly). `_unwrap_search_response` and `_lookup_cancellation_guidance` accept only allowlisted official vendor domains (`help.netflix.com`), strip contact details, and wrap text in `<untrusted_web_snippet>` inside `[Diagnosis context: ...]` while `SessionOutput.citations` streams to `ConciergePanel`.
- Regional guardrail execution (`gemini-3.1-flash-lite`): `fca_vulnerability_guardrail` (`llmPolicy` on `gemini-3.1-flash-lite` with `failOpen: false`), `prompt_security_guardrail` (`llmPromptSecurity`), and `model_safety_guardrail` (`modelSafety`) import into `locations/eu` with `0` `ImportAppResponse.warnings`, and `fca_vulnerability_guardrail` short-circuits acute vulnerability turns in `< 1.0 s` with `0808 157 0100` and `116 123`.
