# Workspace guide

This repository is a workspace for building and managing GECX (Google Customer
Engagement Suite) conversational agents. It hosts the **Cloudbank "Gemini Live"
demo** — a voice-first banking agent for a fictional bank. See `README.md` for
the project overview and design.

## Repository structure

```
.agents/skills/                 # Reusable agent skills
├── cxas-agent-foundry/         # Composite skill for end-to-end agent lifecycle
├── cxas-sim-eval/              # Skill for converting evals
└── ...
cloudbank/                      # The demo project
├── cxas_app/Cloudbank/         # GECX agent (deployed via cxas push)
├── evals/                      # Golden evals
├── proxy/                      # FastAPI BidiRunSession proxy
├── web/                        # Vite React mobile app
├── gecx-config.json            # GCP project, location, deployed app id
├── cxaslint.yaml               # Lint policy
└── push.sh                     # Wraps cxas push
examples/                       # Config templates
.venv/                          # Shared virtual environment (gitignored)
AGENTS.md                       # Workspace guide (this file)
README.md                       # Project overview and design
.active-project                 # Points to the active project folder
```

## Setup

Run the setup script to create a virtual environment and install the
`cxas-scrapi` SDK:

```bash
.agents/skills/cxas-agent-foundry/scripts/setup.sh          # Full setup (install + configure)
.agents/skills/cxas-agent-foundry/scripts/setup.sh --configure  # Reconfigure only
source .venv/bin/activate
```

Requires Python 3.10+ and [astral-uv](https://docs.astral.sh/uv/getting-started/installation/).

## Testing the Cloudbank app

```bash
cd cloudbank/web   && npm test && npm run typecheck && npm run lint && npm audit
cd cloudbank/proxy && python -m pytest && uvx ruff check .
cd cloudbank       && cxas lint         # must be 0 errors, 0 warnings
```

Run all of these before merging. CI enforces the same gates
(`.github/workflows/ci.yml`).

### The agent/UI parity suite

`cloudbank/web/src/__tests__/agentUiParity.test.ts` asserts that, for the real
`chloe.json` and across several `today` values (including the 1st of a month),
each `get_*` ClientFunction returns the same number the corresponding screen
renders. It exists because the handler tests use small synthetic fixtures while
the view tests render the real one — neither side can see a disagreement with
the other, so without this suite a divergence ships behind a green test run.

**When you add a spending view or a `get_*` tool, add it to that file.** View
aggregations live in `cloudbank/web/src/util/spendingViews.ts` as pure functions
precisely so the test can call them without rendering; keep them there rather
than inlining a `useMemo` in the component.

Two invariants the suite depends on:

- `computeSpendingSummary().monthly_history` is **always exactly 3 calendar
  months** (this, last, two-ago), zero-padded. That is what makes
  `monthly_history[n]` mean "n months ago" in the handlers.
- "Subscription" means `is_subscription === true`, **not**
  `category === 'subscriptions'` — British Gas, EE and the rent are flagged
  recurring but categorised as `bills`.

### Golden evals cannot mock ClientFunction results

`common_session_parameters` holds session *variables* (merged into each
conversation's `session_parameters`); there is no tool-response mock mechanism,
and the eval harness has no browser to execute a ClientFunction. So goldens can
assert the **shape of the tool call** but not how the agent narrates the data
that comes back. Manual transcript review remains the safety net for narration.

## Proxy security

`cloudbank/proxy` is **unauthenticated and localhost-only**. It holds ADC
credentials and lends them to whoever connects, so never run it with
`--host 0.0.0.0` and never deploy it without adding authentication first. There
is no Dockerfile or deploy config in this repo, on purpose. See
`cloudbank/proxy/README.md` for the controls that are in place (Origin
allowlist, session cap, frame caps, session-variable allowlist) and the env vars
that tune them.

### If the concierge pill sits on "Retry"

Check the proxy log before anything else. A rejected WebSocket origin looks
identical to the proxy being down — the browser burns its three auto-retries
against a 403 and gives up, while `/health` still returns 200:

```
WARNING:proxy:rejecting websocket from disallowed origin 'https://…'
```

Hosted dev environments (Cloud Shell, Cloud Workstations, Codespaces, Gitpod)
are accepted out of the box. Anywhere else needs `PROXY_ALLOWED_ORIGINS`.

## Deploying the agent (cxas push)

`cxas push` defaults to looking for `app.json` directly under `--app-dir`. This
agent lives one level deeper (`cloudbank/cxas_app/Cloudbank/app.json`), so the
bare `cxas push` invocation fails with
`400 ImportApp must contain an app resource`. Always pass both flags:

```bash
cd cloudbank
cxas push \
  --app-dir cxas_app/Cloudbank \
  --to "projects/$(jq -r .gcp_project_id gecx-config.json)/locations/$(jq -r .location gecx-config.json)/apps/$(jq -r .deployed_app_id gecx-config.json)"
```

Prefer `./cloudbank/push.sh`, which builds exactly this from `gecx-config.json`.

**Never hardcode the project id** — read it from `gecx-config.json`. A project in
`lifecycleState: DELETE_REQUESTED` fails every CES call with
`403 CONSUMER_INVALID`, which reads like a permissions problem; check
`gcloud projects describe <id>` before debugging IAM.

`gecx-config.json`'s `app_dir: "cxas_app/"` is misleading on this point — the
SDK does not auto-descend into the nested app directory.

### Adding a new tool to the agent (DO NOT SKIP)

When adding any new tool (ClientFunction, search tool, etc.) to
`cloudbank/cxas_app/Cloudbank/`, **two files must change**:

1. The tool schema: `cloudbank/cxas_app/Cloudbank/tools/<name>/<name>.json`.
2. The declaring agent's tool list, e.g.
   `cloudbank/cxas_app/Cloudbank/agents/root_agent/root_agent.json` — add
   `"<name>"` to the `tools` array. **Forgetting step 2 is a silent failure.**

**Failure mode:** `cxas push` reports `Successfully pushed`, the tool JSON
deploys, but the agent has no way to call it. The model falls back to
*"mmmm, I'm having trouble with that"* with **zero** signals in the proxy logs,
browser console, or push output. It is diagnosed only by `cxas pull <app>` and
diffing the deployed agent JSON against your local one.

**Always verify post-push:**

```bash
cxas pull projects/<project>/locations/us/apps/<app-id> --target-dir /tmp/check
diff <(jq -r '.tools | sort | .[]' cloudbank/cxas_app/Cloudbank/agents/root_agent/root_agent.json) \
     <(jq -r '.tools | sort | .[]' /tmp/check/*/agents/root_agent/root_agent.json)
```

If the diff has output, the deployed agent's tool list disagrees with your local
one — the push didn't take, or you forgot step 2.

Any change that creates a new tool must include both files in its diff and a
post-push `cxas pull` verification.

### Removing a tool from the agent (DO NOT SKIP)

**First decide which of two things you are doing** — they are different layers,
and `cxas push` treats them differently:

| Layer | Where | Push behaviour |
|---|---|---|
| Tool **schema** (the app-level `Tool` resource, shared by all agents) | `tools/<name>/<name>.json` | **Additive** — uploads local schemas, never deletes deployed-but-locally-absent ones |
| Agent **declaration** (which tools *that* agent may call) | `agents/<agent>/<agent>.json` → `tools` | **Replaced** — removing a name takes effect on push |

**Case A — revoking a tool from one agent while another still uses it.** Only
remove the name from that agent's `tools` array and push. Do NOT delete the tool
directory, and there is no orphan to clean up.

**Case B — deleting a tool from the app entirely**, i.e. *no* agent declares it
any more. Four things must happen:

1. Remove the tool name from the `tools` array of **every** agent that declares
   it (`agents/*/*.json` — not just root; the app is multi-agent).
2. Delete the tool directory: `rm -rf cloudbank/cxas_app/Cloudbank/tools/<name>/`.
3. `./cloudbank/push.sh` (drops the reference from the agents — the model can no
   longer call it).
4. **Delete the orphan tool from CES via the REST API** — the schema still lives
   on CES until you explicitly DELETE it.

```bash
# Find the orphan's resource id
TOKEN=$(gcloud auth print-access-token)
APP="projects/$(jq -r .gcp_project_id cloudbank/gecx-config.json)/locations/$(jq -r .location cloudbank/gecx-config.json)/apps/$(jq -r .deployed_app_id cloudbank/gecx-config.json)"
curl -s -H "Authorization: Bearer $TOKEN" "https://ces.googleapis.com/v1/$APP/tools" \
  | jq '.tools[] | select(.displayName=="<name-to-delete>") | .name'

# Then DELETE it
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://ces.googleapis.com/v1/<resource-name-from-above>"
```

Verify no orphans remain:

```bash
cxas pull "$APP" --target-dir /tmp/check
comm -23 <(ls /tmp/check/*/tools/ | sort) <(jq -r '.tools[]' /tmp/check/*/agents/*/*.json | sort -u)
# Empty output = no orphans (end_session is built-in so won't appear as a tool dir)
```

The `agents/*/*.json` glob matters. Reading only `root_agent.json` reports all
five `get_*` tools plus `search_help` as orphans — every one a false positive,
and deleting them would break the spending journey. A tool is an orphan only if
**no** agent declares it.

### Adding a sub-agent (DO NOT SKIP)

When extracting a journey into its own sub-agent under
`cloudbank/cxas_app/Cloudbank/agents/`, **three artifacts must change**:

1. New directory `agents/<sub_agent>/<sub_agent>.json` + `instruction.txt`. The
   JSON's `tools` array lists every tool the sub-agent calls, including tools
   also declared on root — they are per-agent declarations, not global.
2. Parent agent's JSON gains `"childAgents": ["<sub_agent>"]`. The string MUST
   exactly match the JSON `name` field (underscores, no spaces); `cxas push`
   returns `400 Reference not found` for a spaced display name here. See the
   "Configuring childAgents (platform quirk)" section of
   `.agents/skills/cxas-agent-foundry/references/gecx-design-guide.md`.
3. Parent agent's `instruction.txt` gains a `<routing>` block describing when to
   silently delegate. The `<action>` block references the sub-agent via the
   **instruction-author syntax** `{@AGENT: <displayName>}` (same family as
   `{@TOOL: <tool_name>}`). The sub-agent's `instruction.txt` has a matching
   `<scope>` block describing when to silently transfer BACK using
   `{@AGENT: root_agent}`. See
   https://docs.cloud.google.com/customer-engagement-ai/conversational-agents/ps/instruction
   for the syntax reference.

**Two layers, easy to confuse:**

- **Instruction-author syntax** (what you write in prompts):
  `{@AGENT: <displayName>}`.
- **Runtime action** (what the platform fires and transcripts show):
  `actions.transfer_to_agent`. Never something you write literally in the
  prompt.

**Silent transfer:** the customer should perceive a single continuous assistant.
Neither agent speaks about the handoff. Both agents need an explicit
`CRITICAL — SILENT TRANSFER` (root) / `CRITICAL — SILENT TRANSFER BACK`
(sub-agent) constraint banning "transfer" / "specialist" / "colleague" /
"let me hand" / "one moment" filler.

**Verify post-push:**

```bash
cxas pull "$APP" --target-dir /tmp/check
ls /tmp/check/Cloudbank/agents/          # must contain parent + every child
jq -r '.childAgents' /tmp/check/Cloudbank/agents/<parent>/<parent>.json
# must list every child agent created
```

Any change that introduces a sub-agent must include the parent's `childAgents`
update and the `cxas pull` verification — the same class of gotcha as the tool
registration gap.

## Available skills

This workspace provides several specialized AI skills to assist with
development.

- **`cxas-agent-foundry`**: The primary skill for the end-to-end GECX agent
  lifecycle. Use this for building agents from requirements, generating and
  running evals, debugging failures, and syncing code.
- **`cxas-sim-eval`**: A utility skill for converting CXAS golden evaluations to
  SCRAPI SimulationEvals test cases.
- **`cxas-cuj-report-generator`**: Ingests existing agent implementations (ADK,
  DFCX, Cyara, draw.io, …) and produces a CUJ coverage report.
- **`cxas-dfcx-migration`**: Staged migration of a Dialogflow CX agent into a
  CXAS app.
- **`cxas-loss-analysis`**: Pulls non-contained conversations from CCAI
  Insights, clusters them into failure patterns, and writes a markdown report.

These are vendored copies of the skills shipped by the `cxas-scrapi` package
(`.venv/share/cxas-scrapi/skills/.agents/skills/`). Re-sync after an SDK upgrade
by copying that tree over `.agents/skills/`; the only local delta to preserve is
the "Step 2.7" block in `cxas-agent-foundry/scripts/setup.sh`, which installs
each project's `proxy/` and `web/` dependencies.

*For detailed development workflows, linter policies, and GECX-specific
conventions, refer to the documentation within the respective skills, e.g.
`.agents/skills/cxas-agent-foundry/SKILL.md`.*
