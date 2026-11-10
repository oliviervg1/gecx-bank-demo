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
            # `bash -n push.sh` is a syntax check, not an execution.
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
