# Cloudbank Documentation Hub

Welcome to the documentation for the **Cloudbank Multi-Product Retail Banking Reference Application** built on [CX Agent Studio](https://docs.cloud.google.com/gemini-enterprise-cx/cx-agent-studio) (`GECX`).

## Documentation Tree

```text
docs/
├── README.md                                        # Documentation index, reading paths, and domain glossary
├── architecture/
│   ├── banking_flows.md                             # Multi-product journey requirements and colour-coded flowcharts
│   ├── end_to_end_walkthrough.md                    # Turn-by-turn tables across Chloe, Sarah, and Tom journeys
│   ├── tool_first_architecture_guide.md             # Why Python controllers own state, integer math, and silent routing
│   └── bidi_ui_sync_and_session_runtime.md          # 3-Tier ui_view_state sync, AudioWorklet, sessionMachine, ConciergePanel, eu verification
├── tools/
│   ├── README.md                                    # Controller progression diagram and line-linked specification index
│   ├── route_banking_intent.md                      # Root concierge classifier, navigation, and 2-strike unclear spec
│   ├── assist_everyday_banking.md                   # Spending, anomaly check, wrapped search_help, and pivot spec
│   ├── assist_savings.md                            # Savings pot AER summary and monthly compound projection spec
│   └── assist_mortgages.md                          # Mortgage overpayments, integer-bisection renewals, and renter spec
└── guides/
    ├── gecx_for_beginners.md                        # 5-minute everyday-analogy introduction (zero unexplained jargon)
    ├── developer_workflow_and_cicd_guide.md         # Local setup, 4 verification gates, branch apps, push.sh, and CI
    └── qa_tester_guide.md                           # Business-language QA test script across all 4 customer profiles
```

## Navigation by Role

### 1. New to GECX / Product & Executive Stakeholders
1. [GECX for Beginners](guides/gecx_for_beginners.md) — Understand how the concierge desk, specialist desks, and calculator work together in five minutes.
2. [Retail Banking Flows](architecture/banking_flows.md) — Visualise the customer journeys across Everyday Banking, Savings, Mortgages, and Customer Safeguarding.
3. [End-to-End Walkthrough](architecture/end_to_end_walkthrough.md) — Follow Chloe's 6-turn hero conversation turn by turn.

### 2. Software & Agent Engineers
1. [Cloudbank Engineering Blueprint](../cloudbank/README.md) — Topology, callback execution order, `context.state` table, and cross-runtime schemas.
2. [Tool-First Architecture Guide](architecture/tool_first_architecture_guide.md) — Silent `target_agent` transfers, zero-prompt-token `customer_snapshot`, integer `half_up` math, and `search_help` wrapping.
3. [Bidi UI Sync & Session Runtime](architecture/bidi_ui_sync_and_session_runtime.md) — Three-tier `ui_view_state` delivery, cross-rate `16 kHz` `AudioWorklet`, 11-row `sessionMachine.ts`, executive `ConciergePanel`, and the `locations/eu` live verification results.
4. [Python Controller Specifications](tools/README.md) — Deep-dive flowcharts, parameter schemas, and `#L<start>-L<end>` code links for every tool.
5. [Developer Workflow & CI/CD Guide](guides/developer_workflow_and_cicd_guide.md) — Running the four local gates, sandbox/branch apps, `./push.sh`, and GitHub Actions.

### 3. Conversation Designers
1. [Retail Banking Flows](architecture/banking_flows.md) — Review the conversational steps, confirmation prompts, and safeguarding signposts.
2. [End-to-End Walkthrough](architecture/end_to_end_walkthrough.md) — Inspect spoken phrasing, modality formatting, and cross-product pivots.
3. [Developer Workflow & CI/CD Guide](guides/developer_workflow_and_cicd_guide.md) — Provision an isolated CX Agent Studio sandbox (`manage_ces_app.py provision-sandbox`) and sync golden evaluations.

### 4. QA Testers
1. [QA Tester Guide](guides/qa_tester_guide.md) — Step-by-step voice and text test scripts for `Chloe`, `David`, `Tom`, and `Sarah` written strictly in customer-facing business terms.

---

## Domain & Platform Glossary

| Term | Meaning |
| :--- | :--- |
| **ADC** | **Application Default Credentials** — Local `gcloud` credentials used by the localhost FastAPI proxy to authenticate upstream gRPC streams to Google Cloud. |
| **AER** | **Annual Equivalent Rate** — The UK headline savings interest rate illustrating what a saver would earn over a full year including compounding, spoken aloud and shown on the Savings screen (`aer_bps`). |
| **BidiRunSession** | The bi-directional streaming RPC in the [CX Agent Studio v1 API](https://docs.cloud.google.com/gemini-enterprise-cx/cx-agent-studio/reference/rpc/google.cloud.ces.v1) that exchanges live microphone audio, text, session variables, and synthesised speech over a single stream. |
| **BPS (Basis Points)** | One hundredth of a percentage point (`100 bps = 1.00%`, `465 bps = 4.65%`). Cloudbank stores all interest rates as integers in basis points to avoid floating-point rounding errors. |
| **CSWSH** | **Cross-Site WebSocket Hijacking** — A browser attack where an untrusted website opens a WebSocket to `localhost`; blocked by strict `Origin` header validation in `cloudbank/proxy`. |
| **ERC** | **Early Repayment Charge** — A fee charged by UK mortgage lenders when a borrower overpays more than their annual fee-free overpayment allowance (typically 10% of the opening balance per year during a fixed-rate period). |
| **Gross Rate** | The contractual nominal annual interest rate (`gross_rate_bps`) divided by 12 (`rate_bps / 120,000`) in Cloudbank's month-by-month compound savings simulator before tax. |
| **Half-Up Rounding** | Standard financial integer rounding (`(n * 2 + d) // (2 * d)`) where exact `.5` pence fractions round up to the nearest penny identically in Python and TypeScript. |
| **LTV** | **Loan-to-Value** — The ratio of a mortgage loan to the property price (for example, an `85%` LTV mortgage requires a `15%` deposit). |
| **NAIVE Golden Evaluation** | A deterministic turn-by-turn CX Agent Studio evaluation mode where each turn's tool calls, spoken expectations, and silent agent handoffs are asserted in chronological order without simulated persona improvisation. |
| **PTT** | **Push-to-Talk** — Default Cloudbank microphone mode where audio is captured only while holding **Hold to talk** or **Spacebar**, preventing room-speaker echo in live demonstrations. |
| **SVR** | **Standard Variable Rate** — The lender's default revert interest rate that applies once an introductory 2-year or 5-year fixed-rate mortgage deal expires. |
| **VAD / Endpointer** | **Voice Activity Detection** — The server-side speech detector on `BidiRunSession` that decides when a caller has finished speaking; assisted on PTT release by up to `2.5 s` of trailing `16 kHz` silence frames. |
