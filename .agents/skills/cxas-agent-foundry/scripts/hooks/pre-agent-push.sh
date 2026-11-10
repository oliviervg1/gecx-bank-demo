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
# before allowing cxas push, push.sh, or manage_ces_app.py push/pr-eval.
# Works with both Claude Code and Gemini CLI.

set -euo pipefail

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
if [ -z "$project_dir" ] || [ ! -f "${project_dir}/gecx-config.json" ]; then
  allow_hook
  exit 0
fi

config_file="${project_dir}/gecx-config.json"
project="$(jq -r '.gcp_project_id' "$config_file")"
location="$(jq -r '.location' "$config_file")"
expected_prefix="projects/${project}/locations/${location}/apps/"

if echo "$cmd" | grep -q -- "--to"; then
  push_target="$(echo "$cmd" | sed -nE 's/.*--to(=|[[:space:]]+)["'\'']?([^"'\''[:space:]]+).*/\2/p')"
  if [ -n "$push_target" ] && [[ "$push_target" == projects/* ]] && [[ "$push_target" != "${expected_prefix}"* ]]; then
    block_hook "PUSH BLOCKED: Target '${push_target}' does not match configured prefix '${expected_prefix}' from gecx-config.json."
    exit 0
  fi
fi

allow_hook
