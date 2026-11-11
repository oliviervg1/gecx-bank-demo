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

# Sets up the local development environment for CX Agent Studio (GECX) agent development.
# Creates a Python virtualenv, installs cxas-scrapi (from PyPI by default, or from an
# adjacent local checkout when present), syncs project-local Python/Node environments,
# and optionally runs the interactive configuration wizard for gecx-config.json.
#
# Usage:
#   .agents/skills/cxas-agent-foundry/scripts/setup.sh                  # Full setup (install + configure)
#   .agents/skills/cxas-agent-foundry/scripts/setup.sh --configure      # Skip install, run configuration wizard only
#   .agents/skills/cxas-agent-foundry/scripts/setup.sh --skip-config    # Install only, skip configuration wizard

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PYPI_INDEX="https://pypi.org/simple"

# Optional local cxas-scrapi checkout discovery for SDK contributors
SCRAPI_DIR=""
candidate="$SKILL_ROOT"
for _ in 1 2 3 4 5; do
  candidate="$(cd "$candidate/.." && pwd)"
  if [ -f "$candidate/pyproject.toml" ] && grep -q 'name *= *"cxas-scrapi"' "$candidate/pyproject.toml" 2>/dev/null; then
    SCRAPI_DIR="$candidate"
    break
  fi
  if [ -d "$candidate/cxas-scrapi" ] && [ -f "$candidate/cxas-scrapi/pyproject.toml" ]; then
    SCRAPI_DIR="$candidate/cxas-scrapi"
    break
  fi
done

if [ -n "$SCRAPI_DIR" ] && [[ "$SKILL_ROOT" == "$SCRAPI_DIR"* ]]; then
  WORKSPACE_ROOT="$(cd "$SCRAPI_DIR/.." && pwd)"
else
  _candidate="$SKILL_ROOT"
  WORKSPACE_ROOT=""
  for _ in 1 2 3 4 5; do
    _candidate="$(cd "$_candidate/.." && pwd)"
    if [ -d "$_candidate/.agents" ] || [ -d "$_candidate/.claude" ] || [ -d "$_candidate/.gemini" ]; then
      WORKSPACE_ROOT="$_candidate"
      break
    fi
  done
  if [ -z "$WORKSPACE_ROOT" ]; then
    WORKSPACE_ROOT="$(cd "$SKILL_ROOT/../../.." && pwd)"
  fi
fi
cd "$WORKSPACE_ROOT"

SKIP_CONFIG=false
CONFIGURE_ONLY=false
VENV_DIR=".venv"

for arg in "$@"; do
  case $arg in
    --skip-config)
      SKIP_CONFIG=true
      ;;
    --configure)
      CONFIGURE_ONLY=true
      ;;
  esac
done

echo "========================================="
echo " GECX Development Environment Setup"
echo "========================================="
echo ""

if [ "$CONFIGURE_ONLY" = false ]; then
  NEEDS_INSTALL=true

  if [ -d "$VENV_DIR" ] && [ -f "${VENV_DIR}/bin/activate" ]; then
    # shellcheck disable=SC1090
    source "${VENV_DIR}/bin/activate"
    if python -c "import cxas_scrapi" 2>/dev/null; then
      installed_ver=$(python -c "import importlib.metadata; print(importlib.metadata.version('cxas-scrapi'))" 2>/dev/null || echo "unknown")
      echo "  cxas-scrapi v${installed_ver} is already installed."
      echo ""
      if [ -t 0 ]; then
        read -r -p "  Reinstall cxas-scrapi? [y/N] " reinstall
        if [[ ! "$reinstall" =~ ^[Yy] ]]; then
          NEEDS_INSTALL=false
        fi
      else
        NEEDS_INSTALL=false
      fi
    fi
  fi

  if [ "$NEEDS_INSTALL" = true ]; then
    if [ ! -d "$VENV_DIR" ]; then
      echo "[1/3] Creating virtualenv in ${VENV_DIR}..."
      if command -v uv >/dev/null 2>&1; then
        uv venv "$VENV_DIR" --quiet
      else
        echo "      Warning: uv not found. Falling back to python3 -m venv."
        python3 -m venv "$VENV_DIR"
      fi
    else
      echo "[1/3] Virtualenv already exists at ${VENV_DIR}"
    fi

    # shellcheck disable=SC1090
    source "${VENV_DIR}/bin/activate"

    if [ -n "$SCRAPI_DIR" ] && [ -f "$SCRAPI_DIR/pyproject.toml" ]; then
      echo "[2/3] Installing cxas-scrapi (editable) from $SCRAPI_DIR..."
      if command -v uv >/dev/null 2>&1; then
        uv pip install --default-index "$PYPI_INDEX" -e "$SCRAPI_DIR" rich InquirerPy --quiet
      else
        pip install --index-url "$PYPI_INDEX" -e "$SCRAPI_DIR" rich InquirerPy --quiet
      fi
    else
      echo "[2/3] Installing cxas-scrapi from PyPI..."
      if command -v uv >/dev/null 2>&1; then
        uv pip install --default-index "$PYPI_INDEX" cxas-scrapi rich InquirerPy --quiet
      else
        pip install --index-url "$PYPI_INDEX" cxas-scrapi rich InquirerPy --quiet
      fi
    fi

    echo ""
    installed_ver=$(python -c "import importlib.metadata; print(importlib.metadata.version('cxas-scrapi'))" 2>/dev/null || echo "unknown")
    echo "      cxas-scrapi v${installed_ver} installed."
    echo ""
  else
    if command -v uv >/dev/null 2>&1; then
      uv pip install --default-index "$PYPI_INDEX" rich InquirerPy --quiet 2>/dev/null
    else
      pip install --index-url "$PYPI_INDEX" rich InquirerPy --quiet 2>/dev/null
    fi
    echo ""
  fi
else
  if [ ! -d "$VENV_DIR" ]; then
    echo "Error: No virtualenv found at ${VENV_DIR}. Run setup.sh first (without --configure)."
    exit 1
  fi
  # shellcheck disable=SC1090
  source "${VENV_DIR}/bin/activate"
  if command -v uv >/dev/null 2>&1; then
    uv pip install --default-index "$PYPI_INDEX" rich InquirerPy --quiet 2>/dev/null
  else
    pip install --index-url "$PYPI_INDEX" rich InquirerPy --quiet 2>/dev/null
  fi
fi

# --- Step 2.5: Ensure gemini-cli can discover the skill's sub-agents ---
GEMINI_AGENTS_DIR="$WORKSPACE_ROOT/.gemini/agents"
SKILL_AGENTS_DIR="$SKILL_ROOT/agents"
if [ -d "$SKILL_AGENTS_DIR" ]; then
  mkdir -p "$WORKSPACE_ROOT/.gemini"
  if [ -L "$GEMINI_AGENTS_DIR" ]; then
    current_target="$(readlink "$GEMINI_AGENTS_DIR")"
    if [ "$(python3 -c "import os; print(os.path.abspath(os.path.join(os.path.dirname('$GEMINI_AGENTS_DIR'), '$current_target')))")" != "$SKILL_AGENTS_DIR" ]; then
      echo "  Updating $GEMINI_AGENTS_DIR symlink"
      rm "$GEMINI_AGENTS_DIR"
      rel_target=$(python3 -c "import os.path; print(os.path.relpath('$SKILL_AGENTS_DIR', os.path.dirname('$GEMINI_AGENTS_DIR')))")
      ln -s "$rel_target" "$GEMINI_AGENTS_DIR"
    fi
  elif [ -e "$GEMINI_AGENTS_DIR" ]; then
    echo "  WARN: $GEMINI_AGENTS_DIR exists and is not a symlink. Sub-agent discovery may fail."
  else
    echo "  Linking $GEMINI_AGENTS_DIR (relative symlink)"
    rel_target=$(python3 -c "import os.path; print(os.path.relpath('$SKILL_AGENTS_DIR', os.path.dirname('$GEMINI_AGENTS_DIR')))")
    ln -s "$rel_target" "$GEMINI_AGENTS_DIR"
  fi
fi

# --- Step 2.7: Install project-local agent, proxy, and web dependencies ---
NPM_CMD=""
if command -v npm >/dev/null 2>&1; then
  NPM_CMD="npm"
elif command -v corepack >/dev/null 2>&1; then
  NPM_CMD="corepack npm"
fi

for project_dir in "$WORKSPACE_ROOT"/*/; do
  if [ ! -f "${project_dir}gecx-config.json" ]; then
    continue
  fi
  project_name="$(basename "$project_dir")"

  if [ -f "${project_dir}pyproject.toml" ] && command -v uv >/dev/null 2>&1; then
    echo "  Syncing ${project_name} Python test environment..."
    if [ -f "${project_dir}uv.lock" ]; then
      ( cd "${project_dir}" && uv sync --locked --all-extras --quiet )
    else
      ( cd "${project_dir}" && uv sync --all-extras --quiet )
    fi
  fi

  if [ -f "${project_dir}proxy/pyproject.toml" ]; then
    echo "  Syncing ${project_name}/proxy..."
    if command -v uv >/dev/null 2>&1; then
      if [ -f "${project_dir}proxy/uv.lock" ]; then
        ( cd "${project_dir}proxy" && uv sync --locked --all-extras --quiet )
      else
        uv pip install --default-index "$PYPI_INDEX" -e "${project_dir}proxy" --quiet
      fi
    else
      pip install --index-url "$PYPI_INDEX" -e "${project_dir}proxy" --quiet
    fi
  fi

  if [ -f "${project_dir}web/package.json" ]; then
    if [ -n "$NPM_CMD" ]; then
      if [ ! -d "${project_dir}web/node_modules" ]; then
        echo "  Installing ${project_name}/web dependencies..."
        if [ -f "${project_dir}web/package-lock.json" ]; then
          ( cd "${project_dir}web" && $NPM_CMD ci --silent )
        else
          ( cd "${project_dir}web" && $NPM_CMD install --silent )
        fi
      fi
    else
      echo "  Skipping ${project_name}/web (npm not on PATH)."
    fi
  fi
done

if [ "$SKIP_CONFIG" = false ]; then
  echo "[3/3] Running configuration wizard..."
  echo ""
  python "$SCRIPT_DIR/configure.py"
else
  echo "[3/3] Skipping configuration wizard (--skip-config)."
fi

echo ""
echo "========================================="
echo " Setup complete!"
echo ""
echo " Activate the virtualenv with:"
echo "   source ${VENV_DIR}/bin/activate"
echo "========================================="
