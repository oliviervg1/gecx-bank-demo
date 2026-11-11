# Workspace Guide

This repository hosts the Cloudbank Multi-Product Retail Banking Reference Application built on CX Agent Studio (GECX) (`CXAS`). It pairs a 4-agent, tool-first `gemini-composite-v2` voice and chat application with a hardened FastAPI `BidiRunSession` WebSocket proxy and a React 19 + Tailwind CSS v4 5-tab Split-Screen Workbench.

## Repository Structure

```text
Makefile                        # Root install, lint, test, build, e2e, hygiene, and check targets
LICENSE                         # Apache License 2.0
SECURITY.md                     # Trust boundaries and vulnerability reporting policy
cloudbank/                      # Cloudbank application workspace
├── cxas_app/Cloudbank/         # CXAS bundle (app.json, global_instruction.txt, guardrails, 4 agents, tools)
├── cxas_shared/callbacks/      # Canonical model callbacks synced across all 4 agents
├── evals/                      # Multi-segment NAIVE golden evaluations and SimulationEvals
├── proxy/                      # Hardened localhost FastAPI BidiRunSession WebSocket proxy
├── scripts/                    # Lifecycle (manage_app.py), sync_shared.py, audit_agent.py, run_golden_evals.py
├── shared/                     # personas/*.json, customer_snapshot / ui_view_state / ws_protocol schemas, parity_vectors.json
├── tests/                      # Offline pytest suite (bundle integrity, controllers, state matrix, callbacks, parity)
├── web/                        # Vite + React 19 + Tailwind v4 banking app, Concierge UI, and Playwright E2E suite
├── cxaslint.yaml               # Zero-warning CXAS structural and evaluation lint policy
├── gecx-config.example.json    # Committed config template (copy to gitignored gecx-config.json for live cloud use)
├── pyproject.toml              # Python environment for agent tests and CXAS tooling (PEP 735 dev group, PyPI pinned)
└── push.sh                     # Lint + Composite v2 audit + pytest + confirmed OVERWRITE import + golden sync
docs/                           # Architecture guides, per-tool specs, and role-based runbooks
AGENTS.md                       # Workspace engineering rules (this file)
GEMINI.md                       # Agent delegation, deterministic sync, and zero-warning mandates
README.md                       # Root onboarding and offline quickstart
CHANGELOG.md                    # Release history (Why / Fix / Test / Docs)
```

## Setup

Install all locked Python and Node environments using the root `Makefile`:

```bash
make install
```

For live cloud deployment or live `BidiRunSession` streaming, copy the tracked template to your gitignored local configuration file (or export `CLOUDBANK_GCP_PROJECT_ID`, `CLOUDBANK_LOCATION`, and `CLOUDBANK_APP_ID`):

```bash
cp cloudbank/gecx-config.example.json cloudbank/gecx-config.json
```

Requires Python 3.11+, [uv](https://docs.astral.sh/uv/getting-started/installation/), and Node.js 22+. Both `cloudbank/pyproject.toml` and `cloudbank/proxy/pyproject.toml` use PEP 735 `[dependency-groups]` and pin `[[tool.uv.index]]` to `https://pypi.org/simple` so `uv.lock` resolves exclusively to public PyPI hosts.

## Local Verification Gates

Run `make check` (plus `make e2e` when changing web or proxy flows) before committing or deploying. CI (`.github/workflows/ci.yml`) enforces the same checks:

```bash
# Run all lint, test, production build, and privacy/lockfile hygiene gates
make check

# Or run individual gates in isolated subshells:
# 1. CXAS lint (from cloudbank/ WITHOUT --app-dir so E001-E011 run), Composite v2 audit, shared sync, Ruff, Pyright, pytest
(cd cloudbank && uv run --locked cxas lint && uv run --locked python scripts/audit_agent.py --workspace=cxas_app/Cloudbank --report)
(cd cloudbank && uv run --locked python scripts/sync_shared.py --check && uv run --locked ruff check . && uv run --locked pyright && uv run --locked pytest -v)

# 2. Bidi WebSocket proxy Ruff, Pyright, and pytest suite
(cd cloudbank/proxy && uv run --locked ruff check . && uv run --locked pyright && uv run --locked pytest -v)

# 3. Web unit/parity/state-machine tests, TypeScript check, zero-warning ESLint, and production build
(cd cloudbank/web && npm test && npm run typecheck && npm run lint && npm run build)

# 4. Live-browser Playwright + axe-core WCAG 2.1 AA end-to-end suite
make e2e
```

## Core Architecture Invariants

### 1. Tool-First Hub-and-Spoke Topology (`4` Agents, Silent Callback Transfers)

- `root_agent` declares `"childAgents": ["everyday_banking_agent", "savings_agent", "mortgage_agent"]` (`S007` single-parent acyclic tree). Sub-agents declare `"childAgents": []` and omit `modelSettings` so they inherit `gemini-composite-v2` from `app.json`.
- State-driven silent routing only: never place `{@AGENT: ...}` tokens in `instruction.txt`, never expose `transfer_to_agent`, `end_session`, or `search_help` to the model (`capture_utterance` hides all three inside an isolated top-level guard on every pass and fails closed with a safe canned `LlmResponse` on unexpected errors), and never use the words `"transfer"`, `"transferring"`, or `"connecting"` in `instruction.txt` or `agent_action`.
- Python controllers (`route_banking_intent`, `assist_everyday_banking`, `assist_savings`, `assist_mortgages`) stage `context.state["target_agent"] = "<agent>"` (validated against the four known agent names) and return a single-key `{"agent_action": "..."}` dictionary. On the post-tool pass (`_is_tool_response`), `before_model_callback` (`capture_utterance`) clears `state["target_agent"] = ""` and returns `LlmResponse.from_parts(parts=[Part.from_agent_transfer(agent=target)])`, skipping the source agent's post-tool LLM pass (`after_model_callback` `agent_transfer` serves as state-only defense-in-depth with zero text regex scanning).
- Spokes handle `switch_intent="NAVIGATE_HOME" | "NAVIGATE_PROFILE" | "CAPABILITIES"` locally without hopping back to `root_agent`, preserve cross-spoke pivot values in `context.state["handoff_context"]` across `switch_intent` hops, support `confirm_pivot` on `assist_mortgages`, key anomaly status per merchant via `anomaly_by_vendor`, and use a non-terminating 2-strike `unclear_count` that clears stale pending flags on Strike 2 without hanging up.
- Wrapped `search_help` (`googleSearchTool`) runs only for canonical subscription rows in the customer's transactions, enforces an exact registrable-domain allowlist of official vendor help domains (falling back to deterministic steps otherwise), strips phone numbers, emails, and URLs, and wraps text in `<untrusted_web_snippet>` delimiters.
- Canonical callbacks live in `cloudbank/cxas_shared/callbacks/{capture_utterance,agent_transfer,release_line}.py` and are synced into `cxas pull`-compatible agent paths via `cloudbank/scripts/sync_shared.py` (`--check` verified by `test_bundle_integrity.py` and CI).

See the official CX Agent Studio (GECX) documentation for [instructions](https://docs.cloud.google.com/gemini-enterprise-cx/cx-agent-studio/instruction) and [callbacks](https://docs.cloud.google.com/gemini-enterprise-cx/cx-agent-studio/callback).

### 2. Server-Owned `customer_snapshot` & Exact Cross-Language Integer Arithmetic

- Canonical persona fixtures live in `cloudbank/shared/personas/{chloe,david,tom,sarah}.json`, validated against `cloudbank/shared/customer_snapshot.schema.json` in `pytest`, `vitest`, and `cloudbank/proxy` (and synced into `cloudbank/evals/**` by `sync_shared.py`).
- All monetary fields use integer pence (`*_pence`) and all interest rates use integer basis points (`*_bps`, with both `gross_rate_bps` for monthly compounding and `aer_bps` for display and speech on savings accounts).
- On `ClientStart` (validated against `cloudbank/shared/ws_protocol.schema.json`), the browser sends only `{type: "start", persona, timeOfDay, demoDate, sessionId?, lastUiSeq?}`. `cloudbank/proxy` loads the trusted snapshot server-side, derives `first_name` from `snapshot.user.first_name`, binds `sessionId` to `persona`, skips variable re-seeding on session resume, and seeds `{persona_id, first_name, demo_date, time_of_day, customer_snapshot}` via `BidiRunSession` `realtimeInput.variables`.
- All `OBJECT` variables in `app.json` are declared as `{"type": "OBJECT", "required": []}` with no `properties` (`V001`, avoiding `V102`/`V103`), and neither `{customer_snapshot}` nor `{ui_view_state}` is ever referenced in any prompt (`0` prompt tokens).
- Because `realtimeInput.variables` is a `google.protobuf.Struct`, JSON numbers arrive in Python as floats (`4500.0`). `cloudbank/tests/conftest.py` round-trips fixtures through `Struct`, and controllers coerce snapshot integers once at entry via `_normalize_snapshot`.
- Python controllers and TypeScript selectors (`spendingViews.ts`, `savingsMath.ts`, `mortgageMath.ts`) share exact integer `half_up(n, d)` rounding, month-by-month simulation loops, and integer bisection for fixed-rate renewal payments, verified against `cloudbank/shared/parity_vectors.json` in both `pytest` and `vitest`.

### 3. Three-Tier `ui_view_state` Dynamic Screen Synchronisation

Controllers increment `ui_view_state.seq` monotonically and never rely on browser `clientFunction` round-trips, updating `BankingViewStateProvider` across three tiers:

1. Tier 1 (`capture_utterance` on `_is_tool_response`): hides `returned_tool` first; when not transferring and not in an `evaluation*` session, stamps `ui_emitted_seq = str(seq)` and returns a `partial = True` `LlmResponse.from_parts(parts=[Part.from_json(data=json.dumps(view))])` so the browser updates tabs and calculators before speech synthesis starts.
2. Tier 2 (`release_line` in `after_model_callback`, guarded against `llm_response.partial`): re-stamps `ui_emitted_seq` on the persisted final pass and appends `Part.from_json` whenever `seq > prev_emitted_seq`.
3. Tier 3 (`relay.py` fallback): extracts `ui_view_state` from `session_output.diagnostic_info.messages[].chunks[].updated_variables` on `turn_completed=True`, deduplicated by `(sessionId, Math.trunc(Number(seq)))` in both proxy and browser (preserving `lastUiSeq` across same-`sessionId` `ServerGoAway` resumes and resetting on new sessions or `PERSONA_SWITCH`).

## Proxy Security

`cloudbank/proxy` holds local Application Default Credentials (`ADC`) and is designed strictly for localhost development (`127.0.0.1`). Never bind it to `0.0.0.0` on an untrusted network or deploy it remotely without end-user authentication:

- Launch via `uv run --locked python -m proxy` (or `uvicorn` with `--host 127.0.0.1 --ws-max-size 1048576`).
- Enforces loopback client peer addresses (`127.0.0.1`, `::1`) unless `PROXY_ALLOW_REMOTE=1` is explicitly set, `TrustedHostMiddleware`, strict `Origin` allowlisting (`PROXY_ALLOWED_ORIGINS` with zero wildcard suffix fallthrough), disabled OpenAPI routes, an `asyncio.Semaphore` concurrent session cap (`PROXY_MAX_SESSIONS`), WebSocket close code `1003` on unexpected binary frames, optional `PROXY_AUTH_TOKEN`, a 10-second `16 kHz` `LINEAR16` silence keepalive, and `PROXY_MAX_IDLE_SECONDS` (`900` seconds, emitting `ServerSessionExpired`).
- In Cloud Shell (`WEB_HOST`) or GitHub Codespaces (`CODESPACE_NAME`), keep the proxy port private and connect through Vite's local `/ws/agent` loopback proxy.

## Deploying & Syncing Evaluations (`cloudbank/push.sh`)

Never hardcode a GCP project ID or app UUID in tracked code, scripts, or docs; keep local cloud identifiers in gitignored `cloudbank/gecx-config.json` (copied from `cloudbank/gecx-config.example.json`) or pass `CLOUDBANK_GCP_PROJECT_ID`, `CLOUDBANK_LOCATION`, and `CLOUDBANK_APP_ID`.

Use `./cloudbank/push.sh`, which runs the local lint/audit/test gates, requires `--yes` (or interactive TTY confirmation) before overwriting `prod`, performs an overwrite import via `cloudbank/scripts/manage_app.py` (failing on any `ImportAppResponse.warnings` and verifying expected tool declarations so renamed or deleted tools never linger as orphans), and syncs multi-segment NAIVE golden evaluations via `cloudbank/scripts/run_golden_evals.py sync` (never `cxas push-eval`, which mis-orders `agentResponse` before `agentTransfer` on multi-agent turns):

```bash
(cd cloudbank && ./push.sh --yes)
```

When adding or removing tools or sub-agents:
- Declare every tool in the owning agent's `agents/<agent>/<agent>.json` `"tools"` array, set a non-empty `description` in `tools/<tool>/<tool>.json` (`T012`), and reference `{@TOOL: <tool>}` in `instruction.txt` (`I012`; hidden tools such as `end_session` and wrapped `search_help` are referenced inside a negative `"Never call {@TOOL: ...} directly"` constraint).
- Keep `childAgents` in `root_agent.json` strictly acyclic (`S007`), edit shared callbacks in `cloudbank/cxas_shared/callbacks/` and run `uv run --locked python scripts/sync_shared.py --write` (`test_bundle_integrity.py` fails on drift), and follow every `--overwrite` push with `run_golden_evals.py sync` because `OVERWRITE` clears server-side evaluations on the target app.
