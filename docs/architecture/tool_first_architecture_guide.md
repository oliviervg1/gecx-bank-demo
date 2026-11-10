# Tool-First Architecture Guide

Cloudbank uses a strict **tool-first** architecture on [CX Agent Studio](https://docs.cloud.google.com/gemini-enterprise-cx/cx-agent-studio): Python controllers own every financial calculation, session state transition, screen navigation update, and specialist handoff, while `gemini-composite-v2` focuses exclusively on natural slot extraction and warm spoken or written phrasing.

## 1. Why Python Owns State, Math, and Routing

Conversational banking has zero tolerance for approximate arithmetic, skipped disclosures, or audible handoff chatter:

1. **Zero LLM Arithmetic:** Large language models should never sum transaction histories, compound monthly interest, or amortise mortgages in token space. Every figure spoken by Cloudbank is pre-formatted in pounds and percentages inside a Python controller's single-key `{"agent_action": "..."}` return value.
2. **Silent Callback-Driven Routing:** Prompt-driven transfers (`{@AGENT: ...}` or model-invoked `transfer_to_agent`) risk double-speaking ("Let me transfer you to our mortgage team...") or stalling after a tool call. Instead:
   - Neither `{@AGENT: ...}` nor the words `"transfer"`, `"transferring"`, or `"connecting"` appear anywhere in [instructions](https://docs.cloud.google.com/gemini-enterprise-cx/cx-agent-studio/instruction) or `agent_action`.
   - `capture_utterance` ([callbacks](https://docs.cloud.google.com/gemini-enterprise-cx/cx-agent-studio/callback)) hides `transfer_to_agent`, `end_session`, and `search_help` on every model pass.
   - When a controller needs another specialist, it writes `context.state["target_agent"] = "<agent>"`. On the post-tool `before_model_callback` pass (`_is_tool_response`), `capture_utterance` hides the returned controller first, clears `state["target_agent"] = ""`, and returns `LlmResponse.from_parts(parts=[Part.from_agent_transfer(agent=target)])`, skipping the source agent's post-tool speech pass completely (`after_model_callback` `agent_transfer` remains in place as defense-in-depth).
3. **One-Shot Cross-Spoke Pivot Memory (`handoff_context`):** When a customer cancels or reviews a recurring subscription (for example Chloe's `£45.00` Netflix charge) and pivots to Savings or Mortgages, `assist_everyday_banking` writes `handoff_context = {"from_agent": "everyday_banking_agent", "vendor": "Netflix", "freed_monthly_pence": 4500}`. On entry, `assist_savings` and `assist_mortgages` read `handoff_context` once, clear `context.state["handoff_context"] = {}` unconditionally so stale amounts never bleed into later turns, and default `extra_monthly_pence` / `monthly_overpayment_pence` when the caller did not specify a new figure.
4. **Spoke-Local Navigation & Non-Terminating 2-Strike Unclear Policy:** Every spoke handles `switch_intent="NAVIGATE_HOME" | "NAVIGATE_PROFILE" | "CAPABILITIES"` locally without hopping back to `root_agent`. Unclear or empty noisy-microphone turns increment shared `unclear_count`: Strike 1 asks a brief clarifying question; Strike 2 states Cloudbank's capabilities, resets `ui_view_state` to `Home`, resets `unclear_count = "0"`, and **keeps the session open**.

---

## 2. Zero-Prompt-Token `customer_snapshot` & `protobuf.Struct` Coercion

On WebSocket `ClientStart`, the browser seeds five session variables via `BidiRunSession` `realtimeInput.variables`: `persona_id`, `first_name`, `demo_date`, `time_of_day`, and `customer_snapshot` (the verbatim JSON fixture from `cloudbank/web/src/fixtures/<persona>.json`).

- **Zero Prompt Tokens:** In `app.json`, `customer_snapshot` and `ui_view_state` are declared as `{"type": "OBJECT", "required": []}` with no `properties` (`V001`), and neither `{customer_snapshot}` nor `{ui_view_state}` appears in `global_instruction.txt` or any `instruction.txt`. Only Python controllers inspect `context.state["customer_snapshot"]`.
- **`google.protobuf.Struct` Float Normalisation:** Because `realtimeInput.variables` travels over gRPC as a `protobuf.Struct`, JSON integers (`4500`) arrive in Python runtime state as floats (`4500.0`). Each spoke controller coerces snapshot fields back to exact Python `int` values once at entry via `_normalize_snapshot`, and `cloudbank/tests/conftest.py` round-trips every fixture through `google.protobuf.struct_pb2.Struct` so offline `pytest` exercises the exact live wire representation.

---

## 3. Exact Cross-Language Integer Financial Math

All monetary amounts in fixtures and calculators are stored in **integer pence** (`*_pence`) and all rates in **integer basis points** (`*_bps`). Both Python controllers and TypeScript selectors (`savingsMath.ts`, `mortgageMath.ts`, `spendingSummary.ts`, `spendingViews.ts`) implement the exact formulas frozen in `cloudbank/shared/parity_vectors.json`:

```python
# Half-up integer division for non-negative integers n >= 0, d > 0:
def _half_up(n: int, d: int) -> int:
    return (n * 2 + d) // (2 * d)

# Monthly compound interest step (rate_bps / 10,000 / 12 == rate_bps / 120,000):
interest_pence = _half_up(balance_pence * rate_bps, 120_000)
```

- **Savings Projections:** Iterate month `1..600` compounding `gross_rate_bps` first and adding `monthly_contribution_pence + extra_monthly_pence`, while quoting `aer_bps` in speech and UI headers. Goals not met within `600` months return `unreachable = True`.
- **Mortgage Overpayments & Year-One ERC Check:** Compare baseline `simulate_mortgage` against `balance_pence - effective_lump_pence` at `next_payment.amount_pence + monthly_overpayment_pence`. First-year overpayments clamp monthly contributions by `min(12, projected.months)` so short payoffs never overcount ERC usage, and test strict inequality (`first_year > remaining_allowance`) so exact-boundary overpayments remain ERC-free.
- **Renewal Deal Bisection:** `rate_options` finds the smallest integer `payment_pence` that amortises `balance_pence` within `term_remaining_months` using integer bisection over the exact same `simulate_mortgage` kernel (`low = half_up(balance * rate_bps, 120_000) + 1`, `high = balance + low`).
- **AST & Test Enforcement:** `test_bundle_integrity.py` parses controller ASTs to ban `/`, `**`, and `round(...)` inside financial helpers, and both `pytest` and `vitest` assert every vector in `cloudbank/shared/parity_vectors.json`.

---

## 4. Wrapped `tools.search_help` Grounding Design

To answer *"How do I cancel Netflix?"* with live UK help guidance without letting raw URLs or multi-paragraph snippets leak into speech:

1. `search_help` is declared in `everyday_banking_agent.json` (`T008`), negatively referenced in `everyday_banking_agent/instruction.txt` (`I012`), and hidden from direct model invocation in `capture_utterance`.
2. `assist_everyday_banking(query_type="cancel_subscription")` invokes `tools.search_help({"query": f"how to cancel {vendor} subscription UK"})` directly in Python.
3. Without brittle regex or sentence splitting on search output, Python returns an `agent_action` instructing a maximum two-sentence plain-spoken summary (no web addresses read aloud) plus `[Diagnosis context: <raw search text>]`, which `release_line` strips from the persisted transcript while `relay.py` forwards `SessionOutput.citations` and `SessionOutput.google_search_suggestions` to the `ConciergePanel`.
4. `tools/search_help/search_help.json` enables `toolFakeConfig` so `FAKE`-mode NAIVE golden evaluations and simulations remain 100% deterministic.

---

## 5. Items to Confirm Empirically in the Live `locations/eu` Spike

Offline tests validate every controller, callback, and mock wire frame, while the following live-platform behaviours remain **to be confirmed empirically during the `locations/eu` deployment spike** (with defensive fallbacks already wired in code):

- **Live `tools.search_help` return shape & latency:** Confirm the exact dictionary/string structure returned by `tools.search_help` inside the `locations/eu` Python sandbox across a 10-turn trial (`_lookup_cancellation_guidance` handles `dict`, `list`, and `str` shapes and falls back cleanly to generic account-settings advice on empty/error responses).
- **`gemini-3.1-flash-lite` guardrail model availability in `locations/eu`:** Confirm all three `llmPolicy` guardrails import without regional model warnings (`manage_ces_app.py push` fails closed on any `ImportAppResponse.warnings`).
