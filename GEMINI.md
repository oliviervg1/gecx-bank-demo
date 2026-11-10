# Agent Engineering Mandates

## Sub-Agent Delegation & Reasoning
1. Ban on Generalist Agent: You MUST NEVER delegate ANY task to the `generalist` sub-agent. The `generalist` agent is explicitly forbidden in this workspace due to its tendency to take shortcuts and produce low-quality work.
2. Architectural Planning Before Multi-File Changes: For complex tasks, cross-cutting architectural changes, or generating multiple files from a technical design document, formulate and align on an explicit architectural plan first (using plan mode where available in the active CLI or IDE harness) before editing repository files.
3. Authorized Specialized Sub-Agents: You are explicitly authorized and encouraged to use specialized sub-agents provided by the `cxas-agent-foundry` skill (such as `lint-fixer`, `eval-writer`, `coverage-analyst`, `tdd-writer`, and `triage-failure`) for their exact designated purposes to save main-thread context and execute repetitive tasks efficiently.

## Code Generation Quality
When translating specifications, requirements, or a technical design document into code (especially `instruction.txt` files, Python scripts, or callbacks):
1. No Scripted Generation: You MUST NOT write or execute Python, bash, or other scripts (for example, `fix_linter.py`) to auto-generate, bulk-edit, or stub out files.
2. Manual File Writing & Delegation: While scripting is banned, delegating repetitive manual file generation (such as fixing numerous lint errors or writing multiple evaluation YAMLs) to the approved specialized sub-agents (`lint-fixer`, `eval-writer`) is the preferred method for bulk operations. If not delegating to a specialized sub-agent, you MUST use the built-in file editing tools (`write_file`, `edit_file`, or `replace`) to manually author the complete content of every file across turns. Every file must contain its complete persona, hard rules, and taskflow as detailed in the specifications.

## Linter Enforcement
1. Zero Warnings Policy: The CX Agent Studio (GECX) linter treats warnings as fatal errors. You MUST achieve `0` errors AND `0` warnings across `cxas lint`, ESLint (`--max-warnings 0`), and Ruff. Missing tool docstrings, unreferenced tools, and schema issues are blockers. Do not proceed to deployment until all linters pass completely.
