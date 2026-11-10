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


def _is_env_assignment(tok: str) -> bool:
    return bool(re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tok))


def _segment_invokes_push(tokens: list[str]) -> bool:
    idx = 0
    n = len(tokens)
    while idx < n:
        tok = tokens[idx]
        if _is_env_assignment(tok):
            idx += 1
            continue
        base = os.path.basename(tok)
        if base in ("env", "time", "nohup", "command"):
            idx += 1
            while idx < n and (tokens[idx].startswith("-") or _is_env_assignment(tokens[idx])):
                idx += 1
            continue
        if base in ("bash", "sh"):
            if idx + 1 < n and tokens[idx + 1] == "-n":
                return False
            idx += 1
            while idx < n and tokens[idx].startswith("-"):
                if tokens[idx] == "-c" and idx + 1 < n:
                    return _command_invokes_push(tokens[idx + 1])
                idx += 1
            continue
        if base == "uv":
            idx += 1
            if idx < n and tokens[idx] == "run":
                idx += 1
                while idx < n and tokens[idx].startswith("-"):
                    flag = tokens[idx]
                    idx += 1
                    if flag in ("--directory", "--project", "--python", "--with") and idx < n:
                        idx += 1
                continue
            return False
        if base in ("python", "python3") or re.match(r"^python3\.\d+$", base):
            idx += 1
            while idx < n and tokens[idx].startswith("-"):
                if tokens[idx] in ("-c", "-m"):
                    return False
                idx += 1
            continue
        break

    if idx >= n:
        return False

    head_base = os.path.basename(tokens[idx])
    rest = tokens[idx + 1 :]
    if head_base == "push.sh":
        return True
    if head_base in ("cxas", "cxas-eval"):
        return any(t in ("push", "push-eval") for t in rest)
    if head_base == "manage_ces_app.py":
        return any(t in ("push", "pr-eval") for t in rest)
    return False


def _fallback_regex_match(command: str) -> bool:
    B = r"(?<![A-Za-z0-9_.-])"
    E = r"(?![A-Za-z0-9_.-])"
    patterns = (
        B + r"cxas(?:-eval)?\s+push(?:-eval)?" + E,
        B + r"push\.sh" + E,
        B + r"manage_ces_app\.py" + E + r".*?" + B + r"(?:push|pr-eval)" + E,
    )
    return any(re.search(p, command, flags=re.DOTALL) for p in patterns)


def _command_invokes_push(command: str) -> bool:
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()")
        lexer.whitespace_split = True
        raw_tokens = list(lexer)
    except ValueError:
        return _fallback_regex_match(command)

    separators = {";", "&", "&&", "|", "||", "(", ")"}
    segment: list[str] = []
    for tok in raw_tokens:
        if set(tok) <= set(";&|()"):
            if segment and _segment_invokes_push(segment):
                return True
            segment = []
        elif tok in separators:
            if segment and _segment_invokes_push(segment):
                return True
            segment = []
        else:
            segment.append(tok)
    return bool(segment and _segment_invokes_push(segment))


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
