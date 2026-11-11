# Vendored Lifecycle & Audit Scripts (`cloudbank/scripts/`)

All scripts in `cloudbank/scripts/` are licensed under the Apache License, Version 2.0 (`LICENSE` at repository root) and run purely inside the locked `cloudbank/` Python environment (`uv run --locked`) with zero external path dependencies.

| Script | Provenance | Local Hardening & Scope |
| :--- | :--- | :--- |
| `audit_agent.py` | Adapted from the Google Cloud CX Agent Studio (`CXAS`) Gemini Composite v2 Voice Optimizer audit tool (`Apache-2.0`). | Standardised terminology to `CX Agent Studio (GECX)` / `CXAS`; enforces `gemini-composite-v2`, `en-GB-Chirp3-HD-Aoede`, concise prebuilt speaking style (`<= 25` words), English angle-bracket audio tags, and `I015` / `V104` / `T014` rules. |
| `gecx_workspace.py` | Adapted from CX Agent Studio (`CXAS`) workspace configuration utilities (`Apache-2.0`). | Added `CLOUDBANK_GCP_PROJECT_ID`, `CLOUDBANK_LOCATION`, and `CLOUDBANK_APP_ID` environment variable overrides, plus automatic fallback from untracked `gecx-config.json` to `gecx-config.example.json` for offline tests and CI. |
| `manage_app.py` | Adapted and trimmed from CX Agent Studio (`CXAS`) `cxas_scrapi` deployment helpers (`Apache-2.0`, renamed from `manage_ces_app.py`). | Removed unused branch-app, sandbox, and prefix-based `cleanup_stale_apps` deletion commands; fails closed on any `ImportAppResponse.warnings`; verifies remote `ListTools` declarations match `cxas_app/Cloudbank` with zero orphan tools. |
| `run_golden_evals.py` | Adapted from CX Agent Studio (`CXAS`) golden evaluation sync and runner (`Apache-2.0`). | Compiles multi-segment NAIVE golden turns in chronological runtime execution order (`toolCall` -> `agentResponse` -> `agentTransfer`) and runs server-side evaluations with `FAKE` or `REAL` tool behaviour. |
| `sync_shared.py` | Authored directly in this repository (`Apache-2.0`). | Deterministically syncs `cloudbank/cxas_shared/callbacks/*.py` into all four agents under `cxas_app/Cloudbank/agents/` (preserving 100% `cxas pull` compatibility) and syncs `customer_snapshot` + `first_name` in `evals/{goldens,simulations}/*.yaml` from `shared/personas/*.json`. |
