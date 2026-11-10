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
# before allowing cxas push, push.sh, or manage_ces_app.py pr-eval.
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

python3 - "$payload_file" "$config_file" <<'PY'
import json
import pathlib
import re
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

B = r"(?:^|[^A-Za-z0-9_.-])"
E = r"(?:[^A-Za-z0-9_.-]|$)"
patterns = (
    B + r"cxas(?:-eval)?\s+push" + E,
    B + r"push\.sh" + E,
    B + r"manage_ces_app\.py" + E + r".*" + B + r"pr-eval" + E,
)
if not any(re.search(p, cmd, flags=re.DOTALL) for p in patterns):
    sys.exit(0)

if not config_path:
    sys.exit(0)

cfg = json.loads(pathlib.Path(config_path).read_text(encoding="utf-8"))
expected_prefix = f"projects/{cfg['gcp_project_id']}/locations/{cfg['location']}/apps/"

for m in re.finditer(r"--to(?:=|\s+)['\"]?([^\s'\";|&)]+)", cmd):
    target = m.group(1)
    if target.startswith("projects/") and not target.startswith(expected_prefix):
        sys.stderr.write(
            f"PUSH BLOCKED: Target '{target}' does not match configured prefix "
            f"'{expected_prefix}' from gecx-config.json.\n"
        )
        sys.exit(2)

sys.exit(0)
PY
