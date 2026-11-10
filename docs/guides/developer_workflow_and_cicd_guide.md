# Developer Workflow & CI/CD Guide

This guide covers local environment setup, the four zero-warning verification gates, isolated CX Agent Studio branch/sandbox apps, deployment via `./cloudbank/push.sh`, and GitHub Actions CI.

## 1. Local Setup

Prerequisites:
- Python `3.11+` and [uv](https://docs.astral.sh/uv/getting-started/installation/)
- Node.js `22+` (see `cloudbank/web/.nvmrc`)
- `jq` (used by `push.sh` and CI hygiene checks)

Bootstrap all Python and Node dependencies from committed PyPI and npm lockfiles:

```bash
# Offline bootstrap (no GCP credentials required)
.agents/skills/cxas-agent-foundry/scripts/setup.sh --skip-config
source .venv/bin/activate
```

Both `cloudbank/pyproject.toml` and `cloudbank/proxy/pyproject.toml` pin `[[tool.uv.index]]` to `https://pypi.org/simple` so `uv.lock` never records private mirror URLs.

---

## 2. The Four Local Verification Gates

Run all four gates before committing or deploying. Every gate runs completely offline with zero GCP credentials, and `.github/workflows/ci.yml` executes the exact same commands on every pull request:

```bash
# Gate 1 — CXAS structural & evaluation lint (run from cloudbank/ WITHOUT --app-dir so E001-E011 run) + Composite v2 audit
cd cloudbank && uv run --locked cxas lint
cd cloudbank && uv run --locked python scripts/audit_agent.py --workspace=cxas_app/Cloudbank --report

# Gate 2 — Offline Python agent suite (bundle AST/schema checks, controllers, state matrix, callback chains, parity, push checks)
cd cloudbank && uv run --locked pytest -v

# Gate 3 — Bidi WebSocket proxy suite & Ruff lint
cd cloudbank/proxy && uv run --locked --all-extras pytest -v && uv run --locked --all-extras ruff check .

# Gate 4 — Web unit/parity/state-machine tests, TypeScript check, zero-warning ESLint, and production build
cd cloudbank/web && npm test && npm run typecheck && npm run lint && npm run build
```

> **Zero-Warning Policy:** `cxas lint`, Ruff, TypeScript, and ESLint (`--max-warnings 0`) treat warnings as blockers. Any callback modification must be copied identically across all four agents (`test_bundle_integrity.py` fails on byte drift).

---

## 3. Configuration Hygiene (`cloudbank/gecx-config.json`)

Never hardcode a GCP project ID, region, or app UUID in code, tests, scripts, or Markdown documentation. Every tool and script resolves workspace configuration dynamically from `cloudbank/gecx-config.json`:

```json
{
  "gcp_project_id": "<your-gcp-project-id>",
  "location": "eu",
  "app_name": "Cloudbank",
  "deployed_app_id": "<your-ces-app-uuid>",
  "app_dir": "cxas_app",
  "goldens_dir": "evals/goldens",
  "simulations_dir": "evals/simulations",
  "default_language_code": "en-GB"
}
```

The `no-hardcoded-project` job in `.github/workflows/ci.yml` scans the entire repository to guarantee `gcp_project_id` appears nowhere outside `cloudbank/gecx-config.json`.

---

## 4. Isolated Branch & Sandbox Apps (`manage_ces_app.py`)

When iterating on prompts, guardrails, or live voice behaviour against Google Cloud, provision an isolated branch/sandbox app rather than overwriting the shared target app directly:

```bash
cd cloudbank

# Provision an isolated CXAS sandbox cloned from the base app and sync golden evals
uv run --locked python scripts/manage_ces_app.py --config gecx-config.json provision-sandbox my-feature

# Push local bundle edits + sync & run FAKE-mode NAIVE golden evaluations on a feature branch
uv run --locked python scripts/manage_ces_app.py --config gecx-config.json pr-eval feat/my-feature

# Clean up branch apps whose remote Git branches have been merged/deleted (fails closed if remote is unreachable)
uv run --locked python scripts/manage_ces_app.py --config gecx-config.json cleanup-stale
```

---

## 5. Deploying & Syncing Golden Evaluations (`cloudbank/push.sh`)

Always deploy through `./cloudbank/push.sh` rather than calling `cxas push` or `cxas push-eval` directly:

```bash
cd cloudbank
./push.sh                                   # Deploy to prod target in gecx-config.json
./push.sh dev                               # Deploy to dev or named branch target
./push.sh --create-version v-release-1      # Deploy + snapshot an immutable CES version
```

What `./push.sh` enforces in sequence:
1. Runs `uv run --locked cxas lint`, `audit_agent.py`, and `pytest -v`.
2. Runs `scripts/manage_ces_app.py push`, which zips `cxas_app/Cloudbank`, imports with `conflict_strategy="OVERWRITE"`, **fails closed on any `ImportAppResponse.warnings`**, and calls `verify_expected_tools` via the SDK `Tools` client so neither missing tools nor orphaned legacy tools can survive on the server.
3. Runs `scripts/run_golden_evals.py sync`, which compiles multi-agent turns in chronological execution order (`toolCall → agentResponse → agentTransfer`) and re-populates server-side evaluations cleared by `OVERWRITE`.

To execute live platform NAIVE golden evaluations after syncing:

```bash
cd cloudbank
uv run --locked python scripts/run_golden_evals.py --config gecx-config.json run prod FAKE
```

---

## 6. GitHub Actions CI Pipeline (`.github/workflows/ci.yml`)

Every pull request and `main` push runs five parallel, credential-free jobs:

| CI Job | Working Directory | Checks Executed |
| :--- | :--- | :--- |
| **`agent`** | `cloudbank` | `uv sync --locked`, PyPI-only `uv.lock` check, `cxas lint` (including `E001`–`E011`), `audit_agent.py`, `pytest -v`. |
| **`proxy`** | `cloudbank/proxy` | `uv sync --locked --all-extras`, PyPI-only `uv.lock` check, `pytest -v`, `ruff check .`. |
| **`web`** | `cloudbank/web` | `npm ci`, `npm test` (Vitest), `npm run typecheck`, `npm run lint` (`--max-warnings 0`), `npm run build`. |
| **`web-audit`** | `cloudbank/web` | `npm audit --audit-level=high` (isolated so upstream advisories report clearly). |
| **`no-hardcoded-project`** | Repository root | Verifies `gcp_project_id` from `cloudbank/gecx-config.json` is never hardcoded elsewhere. |
