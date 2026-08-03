# Cloudbank "Gemini Live" demo

A voice-first conversational banking agent embedded in a simulated mobile
banking app. Cloudbank is a fictional bank; every customer, account and
transaction in this repository is invented.

Three components:

1. **Mobile-shaped React web app** — Vite + React + TypeScript + Tailwind, with a
   header concierge pill and agent-driven UI. Lives at `cloudbank/web/`.
2. **FastAPI BidiRunSession proxy** — authenticates with Google Cloud (ADC) and
   relays WebSocket frames between the browser and Conversational Agents. Lives
   at `cloudbank/proxy/`.
3. **GECX agent** — a Google Conversational Agents (CES) app, deployed with
   `cxas push`. Lives at `cloudbank/cxas_app/Cloudbank/`.

Interaction is voice-first through the header concierge pill, and the UI
integration is bi-directional: the agent drives the UI (navigation, view
switching, chart selection) and reads the UI's state.

## What the demo does

The Spend Analysis journey works end to end for any of four personas
(`chloe`, `david`, `tom`, `sarah`).

- Voice in → agent reply out, through the header concierge pill.
- **Push-to-talk** — hold the pill or the spacebar; `?ptt=0` selects
  always-listening instead.
- **Client functions** — `navigate_to`, five `get_*` spending tools, and
  `search_help`.
- **Agent-driven UI** — the `show` flag navigates and switches view in the same
  tool call that fetches the data.
- **Two-agent topology** — `root_agent` plus `spending_agent`, with silent
  transfer between them.
- **CI on every PR** — `.github/workflows/ci.yml`.

The Mortgage tab is a static screen: it renders each persona's mortgage (or an
empty state, for the persona who rents) but the agent does not drive it. Savings
and Servicing have no screens.

## Repository layout

```
gecx-bank-demo/
├── README.md                      ← this file
├── AGENTS.md                      ← workspace guide for AI agents
├── GEMINI.md                      ← Gemini CLI mandates
├── .agents/
│   └── skills/                    ← reusable agent skills
│       ├── cxas-agent-foundry/    ← end-to-end GECX agent lifecycle
│       └── cxas-sim-eval/         ← golden → simulation eval converter
├── examples/
│   └── cxaslint.yaml              ← CXAS linter config template
├── cloudbank/                     ← the demo project
│   ├── gecx-config.json           ← GCP project, location, deployed app id
│   ├── push.sh                    ← wraps `cxas push` with the right flags
│   ├── cxaslint.yaml              ← lint policy
│   ├── cxas_app/Cloudbank/        ← GECX agent (deployed via cxas push)
│   ├── evals/                     ← golden evals
│   ├── proxy/                     ← FastAPI BidiRunSession proxy
│   └── web/                       ← Vite React mobile app
├── .claude/, .gemini/             ← editor/CLI settings + hooks
└── .venv/                         ← shared Python venv (gitignored)
```

## Setup

```bash
.agents/skills/cxas-agent-foundry/scripts/setup.sh
source .venv/bin/activate
```

Requires Python 3.10+, [astral-uv](https://docs.astral.sh/uv/getting-started/installation/),
an authenticated `gcloud`, and Application Default Credentials
(`gcloud auth application-default login`).

## Running the demo

```bash
# Terminal 1: proxy
source .venv/bin/activate
cd cloudbank/proxy && uvicorn proxy.main:app --reload --host 127.0.0.1 --port 8080

# Terminal 2: web
cd cloudbank/web && npm run dev
```

Open the printed Vite URL in Chrome, allow microphone access, then **hold** the
"Talk to concierge" pill in the header (or the spacebar) and speak. Release to
send.

| URL | What it does |
|---|---|
| `/?persona=david` | Switch persona (`chloe`, `david`, `tom`, `sarah`) |
| `/?ptt=0` | Always-listening mode instead of push-to-talk |
| `/?persona=tom&ptt=0` | Flags combine |

Tom rents, so his Mortgage tab shows an empty state rather than a mortgage.

Hosted dev environments (Cloud Shell, Cloud Workstations, Codespaces, Gitpod)
work without extra configuration. If you serve the app from anywhere else, set
`PROXY_ALLOWED_ORIGINS` or the proxy rejects the WebSocket and the pill sits on
"Retry".

## Design

The shape of the system, grouped by concern. The reasoning usually traces back
either to a CES platform constraint or to keeping the demo legible to a
non-technical audience.

### Data flow

- **Web-owned data, tool-fetched on demand.** SpendingPage renders its
  transactions list, charts, and per-row anomaly highlights from
  `cloudbank/web/src/fixtures/<persona>.json`. The same fixture feeds the agent
  through five `get_*` ClientFunctions (`agent/handlers/spendingHandlers.ts`)
  that slice into the shared `computeSpendingSummary` kernel. Each handler is
  pure: it takes `fixture` + `today` and returns the requested slice. The agent
  fetches only what the current question needs, and the UI and the agent cannot
  disagree because they share the kernel. The only session variable is
  `{first_name}`, kept so the warm greeting fires with no tool round-trip.
- **The `show` flag fuses navigation and data fetch into one tool call.** Every
  `get_*` tool accepts an optional `show?: boolean`. When the customer asks to
  see something ("show me my spending", "how is Costa trending?"), the agent
  passes `show=true`; the browser's `SpendingDataBinder` wraps the handler with
  a side effect that navigates to the spending page and flips
  `SpendingViewProvider` to the matching view, in addition to returning the
  data. Omitting `show` gives a pure data lookup ("how much on coffee?"). This
  collapses every spending turn to one tool call plus speech. Emitting several
  tool calls in a turn is unreliable — the model drops the spoken sentence or
  falls back to "I'm having trouble".
- **One ClientFunction per turn**, enforced by `toolExecutionMode: SEQUENTIAL`
  in `app.json` as well as by the instruction wording. Prompt wording alone,
  against a `PARALLEL` configuration, is exactly the condition that makes the
  model drop speech.
- **Push-to-talk, on by default.** The mic transmits only while the presenter
  holds the concierge pill or the spacebar; `?ptt=0` restores always-listening.
  In both modes the mic is muted automatically whenever the agent is speaking
  (half-duplex). Over a room PA the mic otherwise hears the agent's own voice
  off the walls and the agent interrupts itself; browser echo cancellation
  cannot help, because its reference is the device's own output rather than the
  room's.
- **Muting sends silence rather than stopping the stream.** CES exposes no
  client-side turn control for audio: `SessionInput.will_continue` explicitly
  excludes it ("always processed automatically based on the endpointing
  signal") and `InputAudioConfig` has no VAD settings. A turn ends only when the
  endpointer hears speech stop, so `createAudioCapture().setMuted()` substitutes
  silence at the same frame cadence and size instead of pausing. CES's
  endpointer treats that silence as end-of-speech, so releasing the hold ends
  the turn. `mutedFill: 'dither'` swaps in an inaudible noise floor for mic
  setups where digital silence reads as "no signal" instead.
- **Nothing imports a fixture directly.** Screens go through `useFixture()`; the
  `get_*` handlers receive the active fixture as `ctx` from `App.tsx`'s
  `SpendingDataBinder`; the agent's session variables come from
  `getFixture(persona)`. `fixtureConformance.test.ts` keeps all four fixtures in
  the one shape that makes this work, and `personaSelection.test.tsx` asserts
  each persona reaches every consumer.
- **Not every persona owns a home.** `accounts.mortgage` is optional — Tom
  rents. `HomePage` hides the mortgage card, `MortgagePage` renders an empty
  state, and `composeHomeInsight` drops the mortgage clause rather than
  narrating a £0 payment.
- **One definition per concept, shared by app and agent.** The `get_*` handlers
  and the spending views consume the same pure functions
  (`util/spendingSummary.ts` for the kernel, `util/spendingViews.ts` for the
  per-view aggregations), and `__tests__/agentUiParity.test.ts` asserts they
  agree over the real fixture across several `today` values.
- **`monthly_history` is always exactly 3 zero-padded calendar months.**
  `computeSpendingSummary` builds `[this, last, two-ago]` rather than collecting
  only the months that contain transactions, which is what makes
  `monthly_history[n]` mean "n months ago" to the handlers.
- **"Subscription" means the `is_subscription` flag, not the `subscriptions`
  category.** British Gas, EE and the rent are flagged recurring but categorised
  as `bills`.
- **Calendar-month bucketing on every "this month" read.**
  `transactionsForMonth` and `computeSpendingSummary` both bucket on the current
  calendar month. `get_overview`, `get_category_breakdown`,
  `get_vendor_breakdown` and `get_subscriptions` accept `month?: 0|1|2` to scope
  to current / last / two-months-ago; `get_monthly_trend` always returns 3
  months with a precomputed `delta_vs_last_month`.
- **Substring vendor matching everywhere.** Vendor lookups in the data tools,
  the `MonthlyTrendView` per-vendor filter, and the agent's narration all use
  `.toLowerCase().includes(term)`, so asking about "Tesco" aggregates "Tesco"
  and "Tesco Express" consistently.
- **Auto-highlight from fixture flags.** Any transaction with `is_anomaly: true`
  is highlighted by SpendingPage at render time — no agent dispatch, and no
  timing race against the page swap.
- **Hand-authored 3-month fixtures.** Transactions span three months so that
  month-on-month comparisons are honest in every category. Dates are expressed
  as `days_ago` relative to today.

### Agent surface

- **Two-agent topology.** `root_agent` is the entry agent: greeting, closing,
  non-spending navigation, off-topic handling, and fallback. `spending_agent` is
  its child, declared through `childAgents` in root's JSON, and owns the whole
  spending journey — all five `get_*` tools plus the spend_analysis taskflow.
  Routing between the two is silent; neither agent mentions the handoff. It is
  invoked with the `{@AGENT: <name>}` instruction syntax inside the routing
  block's `<action>`.
- **Tools are registered per agent.** Root declares `navigate_to` and
  `end_session`. Spending declares `get_overview`, `get_category_breakdown`,
  `get_vendor_breakdown`, `get_monthly_trend`, `get_subscriptions` and
  `search_help`. `end_session` and `transfer_to_agent` are CES built-ins with no
  JSON schema under `tools/`; `transfer_to_agent` becomes available implicitly
  once `childAgents` is declared. Adding a tool means changing both the schema
  and the agent's `tools` array — see `AGENTS.md`, where the silent failure mode
  is documented.
- **Native CES ClientFunction transport** — `SessionOutput.tool_calls` (a oneof)
  with `Tool.client_function`, round-tripped through `tool_responses`.
- **`search_help` is a Google Search tool** for "how do I cancel X?" lookups,
  with an honest "I couldn't find clear instructions" fallback when the results
  are empty or unrelated.
- **`end_session` is called explicitly** in the closing step. Saying "have a
  good day" without the tool call leaves the session open and the mic
  listening.
- **Defence in depth against tool-call narration and silent endings.** Every
  multi-action step in `instruction.txt` uses an explicit numbered list and ends
  with the same trio: the spoken sentence is mandatory, never end after
  `tool_outputs`, never prefix with `Tool:`. A `CRITICAL — DATA FROM TOOLS`
  constraint forbids stating numbers from memory, and a
  `CRITICAL — MONEY PRONUNCIATION` constraint bans decimal currency in spoken
  text, because the TTS otherwise reads `£70.60` as "70 pounds 60 dollars".

### UI

- **Bottom tab bar with 4 tabs; the voice surface is the header pill.** The pill
  is the only voice-state indicator — the agent's response is felt as the UI
  changing: pages slide, views swap, anomaly rows highlight. Page transitions
  slide horizontally by tab order, via Framer Motion.
- **Per-view recharts components.** `OverviewView`, `CategoryDrilldownView`,
  `MonthlyTrendView`, `VendorHistoryView` and `SubscriptionsAuditView` each own
  their chart, driven by `SpendingViewProvider` context.
- **A manual back chevron** sits in `SpendingHeader` on every non-overview view,
  for users who want to go back without speaking.

### Reliability

- **The proxy sends a typed `{type:'error'}` envelope on every failure path** —
  bad config, missing ADC, malformed frame, unreachable upstream — not only on
  `ConnectionClosedError`.
- **`AgentProvider` auto-retries 3× with exponential backoff** before showing
  the Retry pill. CES occasionally closes a new BidiRunSession with
  `1007 (invalid frame payload data) … failed_precondition`; the retry usually
  absorbs it. If the Retry pill does appear, a no-op `./cloudbank/push.sh`
  generally clears it.

### Testing

- **`agentUiParity.test.ts` pins the agent against the UI.** For the real
  fixture, across several `today` values including the 1st of a month, each
  `get_*` ClientFunction must return the number the corresponding screen
  renders. Handler tests use synthetic fixtures and view tests render the real
  one, so without this suite neither side can see a disagreement.
- **Goldens use a `# silent` placeholder for the agent line** when the spoken
  content is checked by expectations rather than by text similarity. This
  bypasses the platform's LLM-judge similarity check, which otherwise flags
  every such turn as `TEXT_MISMATCH (sem_score=0)`.
- **Goldens assert tool-call shape, not narration.** `common_session_parameters`
  carries session variables, not tool mocks, and the eval harness has no browser
  to run a ClientFunction. Manual transcript review is the safety net for
  narration leaks and silent endings.

## Tests

```bash
cd cloudbank/web   && npm test && npm run typecheck && npm run lint && npm audit
cd cloudbank/proxy && python -m pytest && uvx ruff check .
cd cloudbank       && cxas lint        # must be 0 errors, 0 warnings
```

CI runs the same gates on every PR.

## Deploying the agent

```bash
./cloudbank/push.sh
```

Project, location and app id come from `cloudbank/gecx-config.json`; never
hardcode them. `AGENTS.md` covers post-push verification and the additive-push
behaviour that matters when removing a tool.
