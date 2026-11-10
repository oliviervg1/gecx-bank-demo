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
# pushing to CXAS. Enforces 0 errors AND 0 warnings, and fails closed if the
# linter binary fails or cannot locate the project.
# Works with both Claude Code and Gemini CLI.

set -euo pipefail

export PATH="${HOME}/.local/bin:${PATH}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../resolve-project.sh"

input=$(cat)

agent=$(echo "$input" | jq -r 'if .tool_input then "claude" else "gemini" end')
cmd=$(echo "$input" | jq -r '.tool_input.command // .arguments.command // ""')

allow_hook() {
  if [ "$agent" = "claude" ]; then
    echo '{}'
  else
    echo '{"decision":"allow"}'
  fi
}

block_hook() {
  local message="$1"
  if [ "$agent" = "claude" ]; then
    jq -cn --arg msg "$message" \
      '{hookSpecificOutput:{hookEventName:"PreToolUse",blockToolExecution:true,additionalContext:$msg}}'
  else
    jq -cn --arg msg "$message" \
      '{decision:"block",context_update:$msg}'
  fi
}

is_push_cmd=false
if echo "$cmd" | grep -qE '(^|[[:space:]/])(cxas(-eval)?[[:space:]]+push|push\.sh)([[:space:]]|$)'; then
  is_push_cmd=true
elif echo "$cmd" | grep -qE 'manage_ces_app\.py' && echo "$cmd" | grep -qE '(^|[[:space:]])(push|pr-eval)([[:space:]]|$)'; then
  is_push_cmd=true
fi

if [ "$is_push_cmd" = false ]; then
  allow_hook
  exit 0
fi

project_dir="$(resolve_project_dir || true)"
if [ -z "$project_dir" ] || [ ! -f "${project_dir}/cxaslint.yaml" ]; then
  block_hook "LINT BLOCKED: Could not locate active project directory with cxaslint.yaml."
  exit 0
fi

workspace_root="$(cd "${project_dir}/.." && pwd)"
stderr_file="$(mktemp)"
trap 'rm -f "$stderr_file"' EXIT

# Run from $project_dir WITHOUT --app-dir so cxaslint.yaml and evals_dirs (E001-E011) apply.
set +e
if [ -f "${project_dir}/pyproject.toml" ] && [ -f "${project_dir}/uv.lock" ] && command -v uv >/dev/null 2>&1; then
  lint_output="$(cd "$project_dir" && uv run --locked cxas lint --json 2>"$stderr_file")"
  lint_rc=$?
elif [ -x "${workspace_root}/.venv/bin/cxas" ]; then
  lint_output="$(cd "$project_dir" && "${workspace_root}/.venv/bin/cxas" lint --json 2>"$stderr_file")"
  lint_rc=$?
elif command -v cxas >/dev/null 2>&1; then
  lint_output="$(cd "$project_dir" && cxas lint --json 2>"$stderr_file")"
  lint_rc=$?
else
  set -e
  block_hook "LINT BLOCKED: cxas CLI is not installed on PATH or in .venv."
  exit 0
fi
set -e

summary_json="$(
  LINT_RC="$lint_rc" LINT_STDERR="$(cat "$stderr_file")" python3 -c '
import json, os, sys
raw = sys.stdin.read().strip()
rc = int(os.environ.get("LINT_RC", "0"))
stderr = os.environ.get("LINT_STDERR", "").strip()
try:
    data = json.loads(raw) if raw else None
except Exception:
    data = None

if not isinstance(data, list):
    detail = stderr or raw or f"cxas lint exited with status {rc}"
    print(json.dumps({"blocked": True, "msg": f"LINT BLOCKED: cxas lint failed to produce JSON output.\n{detail}"}))
    sys.exit(0)

issues = [r for r in data if r.get("severity") in ("error", "warning")]
if not issues and rc != 0:
    detail = stderr or f"cxas lint exited with non-zero status {rc}"
    print(json.dumps({"blocked": True, "msg": f"LINT BLOCKED: {detail}"}))
    sys.exit(0)

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
        + f"\nRun \x27cd {os.path.basename(os.getcwd())} && cxas lint\x27 and fix every finding before pushing."
    )
    print(json.dumps({"blocked": True, "msg": msg}))
else:
    print(json.dumps({"blocked": False, "msg": ""}))
' <<<"$lint_output"
)"

if [ "$(echo "$summary_json" | jq -r '.blocked')" = "true" ]; then
  block_hook "$(echo "$summary_json" | jq -r '.msg')"
else
  allow_hook
fi
