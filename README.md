# Cloudbank — Multi-Product Retail Banking Reference on CX Agent Studio

Cloudbank is a voice-and-chat multi-product retail banking reference application built on [CX Agent Studio](https://docs.cloud.google.com/gemini-enterprise-cx/cx-agent-studio) (`GECX`). It pairs a 4-agent, tool-first `gemini-composite-v2` application with a localhost FastAPI `BidiRunSession` WebSocket proxy and an executive Split-Screen banking and concierge web interface. Cloudbank is a fictional bank; all four customer profiles, accounts, and transactions are synthetic.

```text
Customer (Voice / Text)
  → Root Concierge (greet, home/profile navigation, silent intent classification)
      ├─→ Everyday Banking Specialist (balances, 3-month spending, anomaly check, cancel help)
      ├─→ Savings Specialist (AER summary, monthly compound goal projections)
      └─→ Mortgage Specialist (10% ERC-free overpayments, fixed-rate renewals, renter readiness)
```

## Start Here

- **New to CX Agent Studio?** Read [GECX for Beginners](docs/guides/gecx_for_beginners.md) (5-minute mental model, zero jargon).
- **Want to trace a real conversation?** Read the [End-to-End Multi-Turn Walkthrough](docs/architecture/end_to_end_walkthrough.md).
- **Testing the app as a customer?** Follow the [QA Tester Guide](docs/guides/qa_tester_guide.md).

## 2-Minute Offline Quickstart (Zero GCP Credentials)

Requires Python 3.11+, [uv](https://docs.astral.sh/uv/getting-started/installation/), and Node.js 22+. Every structural lint, Composite v2 readiness audit, Python controller/callback/parity test, proxy security test, and React test runs locally without cloud credentials:

```bash
# 1. Bootstrap Python and Node environments from committed lockfiles
.agents/skills/cxas-agent-foundry/scripts/setup.sh --skip-config

# 2. Lint the CXAS bundle & evaluations (zero warnings) + run Composite v2 audit & Python suite
cd cloudbank && uv run --locked cxas lint
cd cloudbank && uv run --locked python scripts/audit_agent.py --workspace=cxas_app/Cloudbank --report
cd cloudbank && uv run --locked pytest -v

# 3. Run the Bidi WebSocket proxy suite and Ruff linter
cd cloudbank/proxy && uv run --locked --all-extras pytest -v && uv run --locked --all-extras ruff check .

# 4. Run the web unit/parity/state-machine suite, TypeScript check, ESLint, and Vite build
cd cloudbank/web && npm test && npm run typecheck && npm run lint && npm run build
```

## Running the Live Local Demo

To run live voice and chat against a deployed CX Agent Studio app configured in `cloudbank/gecx-config.json`, authenticate local Application Default Credentials (`gcloud auth application-default login`) and start both local processes:

```bash
# Terminal 1 — localhost BidiRunSession WebSocket proxy (never bind to 0.0.0.0)
cd cloudbank/proxy && uv run --locked uvicorn proxy.main:app --reload --host 127.0.0.1 --port 8080

# Terminal 2 — Split-Screen Cloudbank app & Cloudbank Concierge panel
cd cloudbank/web && npm run dev
```

Open `http://localhost:5173/` in Chrome. Use the top bar to switch across the four customer profiles (`Chloe · Homeowner`, `David · Remortgager`, `Tom · First-Time Buyer`, `Sarah · Pre-Retirement`), hold **Hold to talk** (or press **Spacebar**) to speak, or type directly into the right-hand **Cloudbank Concierge** panel (`?ptt=0` enables always-listening mode).

## The 3 Agent Building Blocks

| Building Block | Location | Role |
| :--- | :--- | :--- |
| **Sub-Agents (`instruction.txt`)** | `cloudbank/cxas_app/Cloudbank/agents/*/` | Concise persona, hard rules, and slot-extraction rules; delegates all math, routing, and state to Python. |
| **Python Controllers (`python_code.py`)** | `cloudbank/cxas_app/Cloudbank/tools/*/python_function/` | Deterministic integer-pence/basis-point calculators, state owners, `ui_view_state` emitters, and silent route stagers. |
| **Model Callbacks (`python_code.py`)** | `cloudbank/cxas_app/Cloudbank/agents/*/{before,after}_model_callbacks/` | Hide internal tools, execute silent `Part.from_agent_transfer` handoffs, stream `ui_view_state` JSON parts, strip `[Diagnosis context: ...]` notes, and close sessions cleanly. |

## Repository Map

```text
.agents/skills/cxas-agent-foundry/  # End-to-end GECX lifecycle skill and CLI hooks
cloudbank/                          # Cloudbank application workspace
├── cxas_app/Cloudbank/             # 4-agent CXAS bundle, guardrails, callbacks, and Python tools
├── evals/                          # Multi-segment NAIVE golden YAML suites and SimulationEvals
├── proxy/                          # Hardened localhost FastAPI BidiRunSession WebSocket proxy
├── scripts/                        # Vendored Apache-2.0 lifecycle, audit, and golden sync scripts
├── shared/                         # Frozen JSON contracts (customer_snapshot, ui_view_state, parity_vectors)
├── tests/                          # Offline pytest suite (bundle AST, controllers, callbacks, parity)
├── web/                            # Vite + React 5-tab banking app & Executive Cloudbank Concierge UI
├── cxaslint.yaml                   # Zero-warning CXAS structural & evaluation lint configuration
├── gecx-config.json                # GCP project, location ("eu"), app_name, deployed_app_id
└── push.sh                         # Gates + OVERWRITE import + tool check + golden sync
docs/                               # Architecture specs, per-tool line-linked docs, and role guides
```

## Documentation by Role

- **All Readers:** [Documentation Hub & Domain Glossary](docs/README.md) · [Release Changelog](CHANGELOG.md)
- **Beginners & Stakeholders:** [GECX for Beginners](docs/guides/gecx_for_beginners.md) · [Retail Banking Flows](docs/architecture/banking_flows.md)
- **Software Engineers:** [Cloudbank Engineering Blueprint](cloudbank/README.md) · [Tool-First Architecture](docs/architecture/tool_first_architecture_guide.md) · [Bidi UI Sync & Session Runtime](docs/architecture/bidi_ui_sync_and_inspector.md) · [Python Controller Specs](docs/tools/README.md) · [Developer & CI/CD Guide](docs/guides/developer_workflow_and_cicd_guide.md)
- **QA Testers:** [External QA Tester Script](docs/guides/qa_tester_guide.md)
