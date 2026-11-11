# Cloudbank: Multi-Product Retail Banking Reference on CX Agent Studio

Cloudbank is a voice-and-chat multi-product retail banking reference application built on [CX Agent Studio](https://docs.cloud.google.com/gemini-enterprise-cx/cx-agent-studio) (`GECX`). It pairs a 4-agent, tool-first `gemini-composite-v2` application (`CXAS`) with a hardened localhost FastAPI `BidiRunSession` WebSocket proxy and a React 19 + Tailwind CSS v4 Split-Screen banking and concierge workbench. Cloudbank is a fictional bank; all four customer personas, sort codes, accounts, and transactions are synthetic.

```text
Customer (Voice / Text)
  -> Root Concierge (greet, home/profile navigation, silent intent classification)
       |-> Everyday Banking Specialist (balances, 3-month spending, anomaly check, cancel help)
       |-> Savings Specialist (AER summary, monthly compound goal projections)
       `-> Mortgage Specialist (10% ERC-free overpayments, fixed-rate renewals, renter readiness)
```

## Start Here

- New to CX Agent Studio (GECX)? Read [GECX for Beginners](docs/guides/gecx_for_beginners.md) for a 5-minute mental model with zero unexplained jargon.
- Want to trace a real conversation? Read the [End-to-End Multi-Turn Walkthrough](docs/architecture/end_to_end_walkthrough.md).
- Testing the app as a customer? Follow the [QA Tester Guide](docs/guides/qa_tester_guide.md).

## 2-Minute Offline Quickstart (Zero GCP Credentials)

Requires Python 3.11+, [uv](https://docs.astral.sh/uv/getting-started/installation/), and Node.js 22+. Every structural lint, Composite v2 readiness audit, shared-bundle sync check, Ruff and Pyright check, Python controller/callback/parity test, proxy security test, React Vitest suite, and Playwright E2E test runs locally without cloud credentials:

```bash
# 1. Install locked Python environments (cloudbank, proxy) and npm packages (web)
make install

# 2. Run all lint, typecheck, unit/parity test, build, and privacy/lockfile gates
make check

# 3. Optional: run individual component gates in isolated subshells
(cd cloudbank && uv run --locked cxas lint && uv run --locked python scripts/audit_agent.py --workspace=cxas_app/Cloudbank --report)
(cd cloudbank && uv run --locked python scripts/sync_shared.py --check && uv run --locked ruff check . && uv run --locked pyright && uv run --locked pytest -v)
(cd cloudbank/proxy && uv run --locked ruff check . && uv run --locked pyright && uv run --locked pytest -v)
(cd cloudbank/web && npm test && npm run typecheck && npm run lint && npm run build)
```

To run the live-browser Playwright + `@axe-core/playwright` WCAG 2.1 AA suite against `cloudbank/proxy` and a production preview build:

```bash
(cd cloudbank/web && npx playwright install --with-deps chromium)
make build
make e2e
```

## Running the Live Local Demo

1. Copy the tracked configuration template to your local gitignored config file and fill in your GCP project ID and deployed CXAS app UUID (or export `CLOUDBANK_GCP_PROJECT_ID` and `CLOUDBANK_APP_ID`):

```bash
cp cloudbank/gecx-config.example.json cloudbank/gecx-config.json
gcloud auth application-default login
```

2. Start both local processes in separate terminals:

```bash
# Terminal 1: localhost BidiRunSession WebSocket proxy (never bind to 0.0.0.0)
(cd cloudbank/proxy && uv run --locked uvicorn proxy.main:app --reload --host 127.0.0.1 --port 8080 --ws-max-size 1048576)

# Terminal 2: Split-Screen Cloudbank app and Cloudbank Concierge workbench
(cd cloudbank/web && npm run dev)
```

> Note: `cloudbank/proxy` also provides a standalone `uv run --locked python -m proxy` entrypoint that binds `127.0.0.1:8765` with `ws_max_size=1048576` enforced (`VITE_PROXY_URL=ws://127.0.0.1:8765/ws/agent`). In Google Cloud Shell or GitHub Codespaces, keep the proxy port private; Vite's dev server on `:5173` proxies `/ws/agent` over loopback automatically.

Open `http://localhost:5173/` in Chrome. Use the top bar to switch across the four customer profiles (`Chloe · Homeowner`, `David · Remortgager`, `Tom · First-Time Buyer`, `Sarah · Pre-Retirement`). Hold **Hold to talk** (or hold **Spacebar**), click or press **Enter** on the voice pill to toggle speech capture (`aria-pressed`), or type directly into the **Cloudbank Concierge** panel (`?ptt=0` enables continuous listening mode with a live Mute/Stop control).

## The 3 Agent Building Blocks

| Building Block | Location | Role |
| :--- | :--- | :--- |
| Sub-Agents (`instruction.txt`) | `cloudbank/cxas_app/Cloudbank/agents/*/` | Concise persona, safety rules, and slot-extraction guidance; delegates all math, routing, and state to Python. |
| Python Controllers (`python_code.py`) | `cloudbank/cxas_app/Cloudbank/tools/*/python_function/` | Deterministic integer-pence and basis-point calculators, state owners, `ui_view_state` emitters, and silent route stagers. |
| Model Callbacks (`python_code.py`) | `cloudbank/cxas_shared/callbacks/` (synced to `agents/*/`) | Fail-closed hooks that hide internal tools, execute validated `Part.from_agent_transfer` handoffs, stream `ui_view_state` JSON parts, strip `[Diagnosis context: ...]` notes, and close sessions cleanly. |

## Repository Map

```text
Makefile                            # Unified install, lint, test, build, e2e, and hygiene gates
LICENSE                             # Apache License 2.0
SECURITY.md                         # Localhost ADC, snapshot trust boundary, and disclosure policy
cloudbank/                          # Cloudbank application workspace
├── cxas_app/Cloudbank/             # 4-agent CXAS bundle, guardrails, synced callbacks, and Python tools
├── cxas_shared/callbacks/          # Canonical before/after model callbacks synced across all 4 agents
├── evals/                          # Multi-segment NAIVE golden YAML suites and SimulationEvals
├── proxy/                          # Hardened localhost FastAPI BidiRunSession WebSocket proxy
├── scripts/                        # Apache-2.0 lifecycle (manage_app.py), sync_shared.py, audit, and golden scripts
├── shared/                         # Server-owned personas/*.json + JSON Schemas + parity_vectors.json
├── tests/                          # Offline pytest suite (bundle AST, controllers, callbacks, parity)
├── web/                            # React 19 + Tailwind v4 5-tab banking app, Concierge UI, and Playwright E2E
├── cxaslint.yaml                   # Zero-warning CXAS structural and evaluation lint configuration
├── gecx-config.example.json        # Committed configuration template (local gecx-config.json is gitignored)
└── push.sh                         # Gates + confirmed OVERWRITE import + tool check + golden sync
docs/                               # Architecture guides, per-tool symbol specs, and role runbooks
```

## Documentation by Role

- All Readers: [Documentation Hub & Domain Glossary](docs/README.md) · [Security Policy](SECURITY.md) · [Release Changelog](CHANGELOG.md) · [License](LICENSE)
- Beginners & Stakeholders: [GECX for Beginners](docs/guides/gecx_for_beginners.md) · [Retail Banking Flows](docs/architecture/banking_flows.md)
- Software Engineers: [Cloudbank Engineering Blueprint](cloudbank/README.md) · [Tool-First Architecture](docs/architecture/tool_first_architecture_guide.md) · [Bidi UI Sync & Session Runtime](docs/architecture/bidi_ui_sync_and_session_runtime.md) · [Python Controller Specs](docs/tools/README.md) · [Developer & CI/CD Guide](docs/guides/developer_workflow_and_cicd_guide.md)
- QA Testers: [External QA Tester Script](docs/guides/qa_tester_guide.md)
