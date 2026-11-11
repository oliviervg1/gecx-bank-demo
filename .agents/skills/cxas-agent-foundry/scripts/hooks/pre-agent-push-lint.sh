#!/bin/bash
# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Runs cxas lint from the project workspace (containing cxaslint.yaml) before
# pushing to CXAS. Enforces 0 errors AND 0 warnings, and fails closed (exit 2 +
# stderr message, honored by both Claude Code and Gemini CLI) if any finding is
# reported or if the linter fails to execute.

set -euo pipefail

export PATH="${HOME}/.local/bin:${PATH}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../resolve-project.sh"

payload_file="$(mktemp)"
lint_file="$(mktemp)"
stderr_file="$(mktemp)"
trap 'rm -f "$payload_file" "$lint_file" "$stderr_file"' EXIT

cat >"$payload_file"

should_check="$(
  python3 - "$payload_file" <<'PY'
import json
import os
import pathlib
import re
import shlex
import sys

raw = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace").strip()
try:
    data = json.loads(raw) if raw else {}
except Exception:
    data = {}

cmd = ""
if isinstance(data, dict):
    ti = data.get("tool_input")
    args = data.get("arguments")
    if isinstance(ti, dict) and isinstance(ti.get("command"), str):
        cmd = ti["command"]
    elif isinstance(args, dict) and isinstance(args.get("command"), str):
        cmd = args["command"]


_B = r"(?<![A-Za-z0-9_.-])"
_E = r"(?![A-Za-z0-9_.-])"
_PUSH_PATTERNS = (
    re.compile(_B + r"cxas(?:-eval)?\s+push(?:-eval)?" + _E, re.DOTALL),
    re.compile(_B + r"push\.sh" + _E, re.DOTALL),
    re.compile(
        _B + r"manage_ces_app\.py" + _E + r".*?" + _B + r"(?:push|pr-eval|provision-sandbox)" + _E,
        re.DOTALL,
    ),
)
_SAFE_READONLY_CMDS = frozenset(
    {
        "cat",
        "less",
        "head",
        "tail",
        "grep",
        "rg",
        "ls",
        "wc",
        "diff",
        "stat",
        "file",
        "chmod",
        "shellcheck",
    }
)
_SAFE_GIT_SUBCMDS = frozenset(
    {
        "add",
        "blame",
        "check-ignore",
        "checkout",
        "commit",
        "diff",
        "grep",
        "log",
        "ls-files",
        "mv",
        "reset",
        "restore",
        "rm",
        "show",
        "status",
    }
)


def _has_push_pattern(text: str) -> bool:
    return any(p.search(text) for p in _PUSH_PATTERNS)


def _is_env_assignment(tok: str) -> bool:
    return bool(re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tok))


def _is_exempt_readonly_segment(seg: str) -> bool:
    if "$" in seg:
        return False
    try:
        tokens = shlex.split(seg, comments=True, posix=True)
    except ValueError:
        return False
    while tokens and _is_env_assignment(tokens[0]):
        tokens = tokens[1:]
    if not tokens:
        return True
    head = os.path.basename(tokens[0])
    if head in _SAFE_READONLY_CMDS:
        return True
    if head == "git" and len(tokens) >= 2 and tokens[1] in _SAFE_GIT_SUBCMDS:
        return True
    if head in ("bash", "sh") and len(tokens) == 3 and tokens[1] == "-n":
        return True
    return False


def _command_invokes_push(command: str) -> bool:
    if not _has_push_pattern(command):
        return False
    segments = re.split(r"[\r\n;&|()`]+", command)
    saw_matching_segment = False
    for seg in segments:
        if not _has_push_pattern(seg):
            continue
        saw_matching_segment = True
        if not _is_exempt_readonly_segment(seg):
            return True
    return not saw_matching_segment


print("yes" if _command_invokes_push(cmd) else "no")
PY
)" || exit 2

if [ "$should_check" != "yes" ]; then
  exit 0
fi

project_dir="$(resolve_project_dir || true)"
if [ -z "$project_dir" ] || [ ! -f "${project_dir}/cxaslint.yaml" ]; then
  echo "LINT BLOCKED: Could not locate active project directory with cxaslint.yaml." >&2
  exit 2
fi

workspace_root="$(cd "${project_dir}/.." && pwd)"

# Run from $project_dir WITHOUT --app-dir so cxaslint.yaml and evals_dirs (E001-E011) apply.
set +e
if [ -f "${project_dir}/pyproject.toml" ] && [ -f "${project_dir}/uv.lock" ] && command -v uv >/dev/null 2>&1; then
  (cd "$project_dir" && uv run --locked cxas lint --json) >"$lint_file" 2>"$stderr_file"
  lint_rc=$?
elif [ -x "${workspace_root}/.venv/bin/cxas" ]; then
  (cd "$project_dir" && "${workspace_root}/.venv/bin/cxas" lint --json) >"$lint_file" 2>"$stderr_file"
  lint_rc=$?
elif command -v cxas >/dev/null 2>&1; then
  (cd "$project_dir" && cxas lint --json) >"$lint_file" 2>"$stderr_file"
  lint_rc=$?
else
  set -e
  echo "LINT BLOCKED: cxas CLI is not installed on PATH or in .venv." >&2
  exit 2
fi
set -e

set +e
python3 - "$lint_file" "$stderr_file" "$lint_rc" "$project_dir" <<'PY'
import json
import os
import pathlib
import sys

raw = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace").strip()
stderr = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8", errors="replace").strip()
rc = int(sys.argv[3])
project_name = os.path.basename(os.path.normpath(sys.argv[4]))

try:
    data = json.loads(raw) if raw else None
except Exception:
    data = None

if not isinstance(data, list):
    detail = stderr or raw or f"cxas lint exited with status {rc}"
    sys.stderr.write(f"LINT BLOCKED: cxas lint failed to produce JSON output.\n{detail}\n")
    sys.exit(2)

issues = [r for r in data if isinstance(r, dict) and r.get("severity") in ("error", "warning")]
if not issues and rc != 0:
    detail = stderr or f"cxas lint exited with non-zero status {rc}"
    sys.stderr.write(f"LINT BLOCKED: {detail}\n")
    sys.exit(2)

if issues:
    err_n = sum(1 for r in issues if r.get("severity") == "error")
    warn_n = sum(1 for r in issues if r.get("severity") == "warning")
    lines = []
    for item in issues[:12]:
        sev = "E" if item.get("severity") == "error" else "W"
        loc = str(item.get("file", ""))
        if item.get("line"):
            loc += f":{item['line']}"
        lines.append(f"  [{sev}] {loc} [{item.get('rule_id', '')}] {item.get('message', '')}")
    if len(issues) > 12:
        lines.append(f"  ... and {len(issues) - 12} more finding(s)")
    msg = (
        f"LINT BLOCKED: {err_n} error(s) and {warn_n} warning(s) found (Zero Warnings Policy).\n"
        + "\n".join(lines)
        + f"\nRun 'cd {project_name} && cxas lint' and fix every finding before pushing.\n"
    )
    sys.stderr.write(msg)
    sys.exit(2)

sys.exit(0)
PY
analysis_rc=$?
set -e
if [ "$analysis_rc" -ne 0 ]; then
  exit 2
fi
