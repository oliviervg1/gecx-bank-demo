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

# Validates CXAS push target resource names against cloudbank/gecx-config.json
# before allowing cxas push, push.sh, or manage_ces_app.py push|pr-eval.
# Exits 2 with a stderr message when blocked (harness-neutral for Claude Code and Gemini CLI).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../resolve-project.sh"

payload_file="$(mktemp)"
trap 'rm -f "$payload_file"' EXIT
cat >"$payload_file"

project_dir="$(resolve_project_dir || true)"
config_file=""
if [ -n "$project_dir" ] && [ -f "${project_dir}/gecx-config.json" ]; then
  config_file="${project_dir}/gecx-config.json"
fi

set +e
python3 - "$payload_file" "$config_file" <<'PY'
import json
import os
import pathlib
import re
import shlex
import sys

raw = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace").strip()
config_path = sys.argv[2]

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


if not _command_invokes_push(cmd):
    sys.exit(0)

if not config_path:
    sys.exit(0)

cfg = json.loads(pathlib.Path(config_path).read_text(encoding="utf-8"))
expected_prefix = f"projects/{cfg['gcp_project_id']}/locations/{cfg['location']}/apps/"

candidate_targets = [
    m.group(1) for m in re.finditer(r"--to(?:=|\s+)['\"]?([^\s'\";|&)]+)", cmd)
] + re.findall(
    r"projects/[^\s'\";|&)/]+/locations/[^\s'\";|&)/]+/apps/[^\s'\";|&)]+", cmd
)

for target in candidate_targets:
    if target.startswith("projects/") and not target.startswith(expected_prefix):
        sys.stderr.write(
            f"PUSH BLOCKED: Target '{target}' does not match configured prefix "
            f"'{expected_prefix}' from gecx-config.json.\n"
        )
        sys.exit(2)

sys.exit(0)
PY
hook_rc=$?
set -e
if [ "$hook_rc" -ne 0 ]; then
  exit 2
fi
