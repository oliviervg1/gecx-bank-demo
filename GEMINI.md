# Agent Engineering Mandates

## Sub-Agent Delegation & Reasoning
1. Ban on Generalist Agent: You MUST NEVER delegate ANY task to the `generalist` sub-agent. The `generalist` agent is explicitly forbidden in this workspace due to its tendency to take shortcuts and produce low-quality work.
2. Architectural Planning Before Multi-File Changes: For complex tasks, cross-cutting architectural changes, or generating multiple files from a technical design document, formulate and align on an explicit architectural plan first before editing repository files.

## Code Generation & Deterministic Synchronisation
When translating specifications, requirements, or a technical design document into code (especially `instruction.txt` files, Python controllers, or callbacks):
1. Ban on Ad-Hoc Generation Scripts: You MUST NOT write or execute ad-hoc Python, bash, or throwaway scripts (for example, `fix_linter.py`) to auto-generate prompts, bulk-regex source files, or stub out implementations. Author `instruction.txt` files, Python controllers, canonical callbacks in `cloudbank/cxas_shared/callbacks/`, and React components directly using built-in file editing tools (`write_file` or `edit_file`) with complete persona rules, safety constraints, and typed helpers.
2. Deterministic Shared Bundle & Evaluation Sync: Running the committed `cloudbank/scripts/sync_shared.py` utility (`--write` to propagate canonical edits from `cloudbank/cxas_shared/callbacks/` across the four CXAS agents and sync persona snapshots from `cloudbank/shared/personas/*.json` into `cloudbank/evals/**`, and `--check` in `pytest` and CI) is explicitly authorized so `cxas pull`-compatible files remain byte-for-byte identical without hand-copy drift.

## Linter & Verification Enforcement
1. Zero Warnings Policy: CX Agent Studio (GECX) linting and repository static analysis treat warnings as fatal errors. You MUST achieve `0` errors AND `0` warnings across `cxas lint`, `scripts/audit_agent.py`, `scripts/sync_shared.py --check`, Ruff (`ruff check .`), Pyright (`pyright`), TypeScript (`npm run typecheck`), ESLint (`npm run lint`, `--max-warnings 0`), and Playwright + `@axe-core/playwright` (`npm run test:e2e`). Missing tool docstrings, unreferenced tools, and schema issues are blockers; do not deploy until `make check` passes completely.
