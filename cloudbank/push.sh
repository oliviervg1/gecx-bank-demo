#!/usr/bin/env bash
# Deploy the Cloudbank CXAS bundle and sync multi-segment NAIVE golden evaluations.
#
# Reads GCP project, location, and target app id dynamically from
# `cloudbank/gecx-config.json` (never hardcoded).
#
# Pipeline:
#   1. CXAS structural & evaluation lint (`cxas lint`, zero warnings)
#   2. Composite v2 voice & guardrail readiness audit (`audit_agent.py`)
#   3. Offline Python controller, callback, and parity suite (`pytest`)
#   4. Overwrite import via `scripts/manage_ces_app.py push` (fails on any
#      `ImportAppResponse.warnings` and verifies expected tool declarations so
#      renamed or deleted tools never linger as orphans)
#   5. Multi-segment NAIVE golden evaluation sync via
#      `scripts/run_golden_evals.py sync` (never `cxas push-eval`, which
#      mis-orders `agentResponse` before `agentTransfer` on multi-agent turns)
#   6. Optional immutable CXAS version snapshot (`--create-version [v-name]`)
#      created AFTER golden evaluations are synced.
#
# Usage:
#   ./cloudbank/push.sh                                # deploy to prod app in gecx-config.json
#   ./cloudbank/push.sh dev                            # deploy to dev/branch target
#   ./cloudbank/push.sh --create-version [v-name]      # deploy + sync goldens + snapshot CXAS version
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required to parse gecx-config.json" >&2
  exit 1
fi

PROJECT=$(jq -r .gcp_project_id gecx-config.json)
LOCATION=$(jq -r .location gecx-config.json)
APP_ID=$(jq -r .deployed_app_id gecx-config.json)

if [ -z "$PROJECT" ] || [ "$PROJECT" = "null" ] || \
   [ -z "$LOCATION" ] || [ "$LOCATION" = "null" ] || \
   [ -z "$APP_ID" ] || [ "$APP_ID" = "null" ]; then
  echo "error: gecx-config.json missing one of gcp_project_id / location / deployed_app_id" >&2
  exit 1
fi

export GOOGLE_CLOUD_QUOTA_PROJECT="${GOOGLE_CLOUD_QUOTA_PROJECT:-$PROJECT}"

TARGET="prod"
CREATE_VERSION="false"
VERSION_NAME=""

while [ $# -gt 0 ]; do
  case "$1" in
    --create-version)
      CREATE_VERSION="true"
      shift
      if [ $# -gt 0 ] && [[ "$1" != -* ]] && [ -z "$VERSION_NAME" ]; then
        case "$1" in
          prod|production|dev)
            ;;
          *)
            VERSION_NAME="$1"
            shift
            ;;
        esac
      fi
      ;;
    --create-version=*)
      CREATE_VERSION="true"
      VERSION_NAME="${1#*=}"
      case "$VERSION_NAME" in
        ""|prod|production|dev)
          echo "error: invalid version name '$VERSION_NAME'" >&2
          exit 1
          ;;
      esac
      shift
      ;;
    -*)
      echo "error: unknown option: $1" >&2
      exit 1
      ;;
    *)
      TARGET="$1"
      shift
      ;;
  esac
done

echo "==> [1/5] Running CXAS structural & evaluation lint..."
uv run --locked cxas lint

echo "==> [2/5] Running Composite v2 readiness audit..."
uv run --locked python scripts/audit_agent.py --workspace=cxas_app/Cloudbank --report

echo "==> [3/5] Running offline Python agent test suite..."
uv run --locked pytest -v

echo "==> [4/5] Performing OVERWRITE import & tool declaration check (projects/${PROJECT}/locations/${LOCATION})..."
uv run --locked python scripts/manage_ces_app.py --config gecx-config.json push "${TARGET}"

echo "==> [5/5] Syncing multi-segment NAIVE golden evaluations to target '${TARGET}'..."
uv run --locked python scripts/run_golden_evals.py --config gecx-config.json sync "${TARGET}"

if [ "$CREATE_VERSION" = "true" ]; then
  if [ -z "$VERSION_NAME" ]; then
    VERSION_NAME="v-$(date -u +%Y%m%d-%H%M%S)"
  fi
  echo "==> [6/6] Creating immutable CXAS version '${VERSION_NAME}' on '${TARGET}'..."
  uv run --locked python scripts/manage_ces_app.py --config gecx-config.json create-version "${VERSION_NAME}" "" "${TARGET}"
fi

echo "==> Deployment and golden evaluation sync complete."
