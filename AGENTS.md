# Workspace Guide

This repository hosts the **Cloudbank Multi-Product Retail Banking Reference Application** built on **CX Agent Studio (GECX)** (`CXAS`). It pairs a 4-agent, tool-first `gemini-composite-v2` voice and chat application with a hardened FastAPI `BidiRunSession` WebSocket proxy and a React 5-tab Split-Screen Workbench.

## Repository Structure

```
.agents/skills/
└── cxas-agent-foundry/         # End-to-end GECX agent lifecycle skill and CLI hooks
cloudbank/                      # Cloudbank application workspace
├── cxas_app/Cloudbank/         # CXAS bundle (app.json, global_instruction.txt, guardrails, 4 agents, tools)
├── evals/                      # Multi-segment NAIVE golden evaluations and SimulationEvals
├── proxy/                      # Localhost FastAPI BidiRunSession WebSocket proxy
├── scripts/                    # Vendored Apache-2.0 lifecycle & audit scripts (zero external path deps)
├── shared/                     # Frozen cross-runtime JSON contracts (customer_snapshot.schema.json, parity_vectors.json)
├── tests/                      # Offline pytest suite (bundle integrity, controllers, state matrix, callbacks, parity)
├── web/                        # Vite + React 5-tab banking app & GECX Split-Screen Workbench
├── cxaslint.yaml               # Zero-warning CXAS structural & evaluation lint policy
├── gecx-config.json            # GCP project, location ("eu"), app_name, deployed_app_id
├── pyproject.toml              # Python environment for agent tests and CXAS tooling (PyPI pinned)
└── push.sh                     # Lint + Composite v2 audit + pytest + overwrite import + golden sync
docs/                           # Architecture guides, per-tool specs, and role-based runbooks
AGENTS.md                       # Workspace engineering rules (this file)
GEMINI.md                       # Agent delegation, manual authoring, and zero-warning mandates
README.md                       # Root onboarding and offline quickstart
CHANGELOG.md                    # Release history (Why / Fix / Test / Docs)
```

## Setup

Run the setup script to create `.venv`, install `cxas-scrapi` from PyPI, and sync `cloudbank/`, `cloudbank/proxy/`, and `cloudbank/web/`:

```bash
.agents/skills/cxas-agent-foundry/scripts/setup.sh --skip-config
source .venv/bin/activate
```

Requires Python 3.11+, [uv](https://docs.astral.sh/uv/getting-started/installation/), and Node.js 22+. Both `cloudbank/pyproject.toml` and `cloudbank/proxy/pyproject.toml` pin `[[tool.uv.index]]` to `https://pypi.org/simple` so `uv.lock` never records corporate mirror URLs.

## Local Verification Gates

Run all four gates locally before committing or deploying. CI (`.github/workflows/ci.yml`) enforces the exact same checks:

```bash
# 1. CXAS structural & evaluation lint (run from cloudbank/ WITHOUT --app-dir so E001-E011 execute) + Composite v2 audit
cd cloudbank && uv run --locked cxas lint
cd cloudbank && uv run --locked python scripts/audit_agent.py --workspace=cxas_app/Cloudbank --report

# 2. Offline Python agent suite (bundle AST/schema checks, controllers, state matrix, callback chains, parity vectors)
cd cloudbank && uv run --locked pytest -v

# 3. Bidi WebSocket proxy suite & Ruff lint
cd cloudbank/proxy && uv run --locked --all-extras pytest -v && uv run --locked --all-extras ruff check .

# 4. Web unit/parity/state-machine tests, TypeScript check, zero-warning ESLint, and production build
cd cloudbank/web && npm test && npm run typecheck && npm run lint && npm run build
```

## Core Architecture Invariants

### 1. Tool-First Hub-and-Spoke Topology (`4` Agents, Silent Callback Transfers)

- `root_agent` declares `"childAgents": ["everyday_banking_agent", "savings_agent", "mortgage_agent"]` (`S007` single-parent acyclic tree). Sub-agents declare `"childAgents": []` and omit `modelSettings` so they inherit `gemini-composite-v2` from `app.json`.
- **State-driven silent routing only:** Never place `{@AGENT: ...}` tokens in `instruction.txt`, never expose `transfer_to_agent` or `end_session` to the model (`capture_utterance` hides both on every pass), and never use the words `"transfer"`, `"transferring"`, or `"connecting"` in `instruction.txt` or `agent_action`.
- Python controllers (`route_banking_intent`, `assist_everyday_banking`, `assist_savings`, `assist_mortgages`) stage `context.state["target_agent"] = "<agent>"` and return a single-key `{"agent_action": "..."}` dictionary. On the post-tool pass (`_is_tool_response`), `before_model_callback` (`capture_utterance`) clears `state["target_agent"] = ""` and returns `LlmResponse.from_parts(parts=[Part.from_agent_transfer(agent=target)])`, skipping the source agent's post-tool LLM pass (`after_model_callback` `agent_transfer` serves as defense-in-depth).
- Spokes handle `switch_intent="NAVIGATE_HOME" | "NAVIGATE_PROFILE" | "CAPABILITIES"` locally without hopping back to `root_agent`, carry cross-spoke pivot values in `context.state["handoff_context"]`, and use a non-terminating 2-strike `unclear_count` that never hangs up on noisy microphone input.
- Every agent carries identical copies of three callbacks under `cxas pull`-compatible paths (`before_model_callbacks/capture_utterance/python_code.py`, `after_model_callbacks/agent_transfer/python_code.py`, `after_model_callbacks/release_line/python_code.py`). Note that `cxas lint` `S005` checks `strict-agent-path-layout` rather than callback content parity; byte-for-byte parity across all four agents is enforced by `cloudbank/tests/test_bundle_integrity.py`.

See the official CX Agent Studio documentation for [instructions](https://docs.cloud.google.com/gemini-enterprise-cx/cx-agent-studio/instruction) and [callbacks](https://docs.cloud.google.com/gemini-enterprise-cx/cx-agent-studio/callback).

### 2. Web-Owned `customer_snapshot` & Exact Cross-Language Integer Arithmetic

- `customer_snapshot` is identical verbatim to each persona fixture (`cloudbank/web/src/fixtures/{chloe,david,tom,sarah}.json`), validated against `cloudbank/shared/customer_snapshot.schema.json` in `pytest`, `vitest`, and `cloudbank/proxy`.
- All monetary fields use **integer pence** (`*_pence`) and all interest rates use **integer basis points** (`*_bps`, with both `gross_rate_bps` for monthly compounding and `aer_bps` for display/speech on savings accounts).
- On `ClientStart`, the browser seeds `{persona_id, first_name, demo_date, time_of_day, customer_snapshot}` via `BidiRunSession` `realtimeInput.variables`. All `OBJECT` variables in `app.json` are declared as `{"type": "OBJECT", "required": []}` with no `properties` (`V001`, avoiding `V102`/`V103`), and neither `{customer_snapshot}` nor `{ui_view_state}` is ever referenced in any prompt (`0` prompt tokens).
- Because `realtimeInput.variables` is a `google.protobuf.Struct`, JSON numbers arrive in Python as floats (`4500.0`). `cloudbank/tests/conftest.py` round-trips fixtures through `Struct`, and controllers coerce snapshot integers once at entry via `_normalize_snapshot`.
- Python controllers and TypeScript selectors (`spendingViews.ts`, `savingsMath.ts`, `mortgageMath.ts`) share exact integer `half_up(n, d)` rounding, month-by-month simulation loops, and integer bisection for fixed-rate renewal payments, verified against `cloudbank/shared/parity_vectors.json` in both `pytest` and `vitest`.

### 3. Three-Tier `ui_view_state` Dynamic Screen Synchronisation

Controllers increment `ui_view_state.seq` monotonically and never rely on browser `clientFunction` round-trips:

1. **Tier 1 (`capture_utterance` on `_is_tool_response`):** Hides `returned_tool` first; when not transferring and not in an `evaluation*` session, stamps `ui_emitted_seq = str(seq)` and returns a `partial = True` `LlmResponse.from_parts(parts=[Part.from_json(data=json.dumps(view))])` so the browser updates tabs and calculators before speech synthesis starts.
2. **Tier 2 (`release_line` in `after_model_callback`):** Re-stamps `ui_emitted_seq` on the persisted final pass and appends `Part.from_json` whenever `seq > prev_emitted_seq`.
3. **Tier 3 (`relay.py` fallback):** Extracts `ui_view_state` from `session_output.diagnostic_info.messages[].chunks[].updated_variables` on `turn_completed=True`, deduplicated by `(sessionId, Math.trunc(Number(seq)))` in both proxy and browser (resetting on `ready` and `PERSONA_SWITCH`).

## Proxy Security

`cloudbank/proxy` is unauthenticated and localhost-only. It holds local Application Default Credentials (`ADC`), so never bind it to `0.0.0.0` or deploy it remotely without adding authentication. It enforces strict `Origin` matching (honoring `PROXY_ALLOWED_ORIGINS` without wildcard suffix fallthrough), an explicit 5-key `CLIENT_SEEDABLE_VARIABLES` allowlist validated against `cloudbank/shared/customer_snapshot.schema.json`, a 10-second `16 kHz` `LINEAR16` silence keepalive, and a configurable `PROXY_MAX_IDLE_SECONDS` (default `900` seconds, emitting `ServerSessionExpired` on idle close).

## Deploying & Syncing Evaluations (`cloudbank/push.sh`)

Never hardcode a GCP project ID anywhere in code, scripts, or docs; derive it dynamically from `cloudbank/gecx-config.json` (`locations/eu`).

Use `./cloudbank/push.sh`, which runs the local lint/audit/test gates, performs an overwrite import via `cloudbank/scripts/manage_ces_app.py` (failing on any `ImportAppResponse.warnings` and verifying expected tool declarations so renamed or deleted tools never linger as orphans), and syncs multi-segment NAIVE golden evaluations via `cloudbank/scripts/run_golden_evals.py sync` (never `cxas push-eval`, which mis-orders `agentResponse` before `agentTransfer` on multi-agent turns):

```bash
cd cloudbank
./push.sh
```

When adding or removing tools or sub-agents:
- Declare every tool in the owning agent's `agents/<agent>/<agent>.json` `"tools"` array, set a non-empty `description` in `tools/<tool>/<tool>.json` (`T012`), and reference `{@TOOL: <tool>}` in `instruction.txt` (`I012`; hidden tools such as `end_session` and wrapped `search_help` are referenced inside a negative `"Never call {@TOOL: ...} directly"` constraint).
- Keep `childAgents` in `root_agent.json` strictly acyclic (`S007`), copy any callback edits across all four agents (`test_bundle_integrity.py` fails on drift), and follow every `--overwrite` push with `run_golden_evals.py sync` because `OVERWRITE` clears server-side evaluations on the target app.
