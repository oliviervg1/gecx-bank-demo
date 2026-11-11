#!/usr/bin/env bash
# Deploy the Cloudbank CXAS bundle and sync multi-segment NAIVE golden evaluations.
#
# Resolves GCP project, location, and target app id dynamically from
# CLOUDBANK_GCP_PROJECT_ID / CLOUDBANK_LOCATION / CLOUDBANK_APP_ID environment
# variables or local `cloudbank/gecx-config.json` (never hardcoded).
#
# Pipeline:
#   1. Shared callback & persona evaluation sync check (`sync_shared.py --check`)
#   2. CXAS structural & evaluation lint (`cxas lint`, zero warnings)
#   3. Composite v2 voice & guardrail readiness audit (`audit_agent.py`)
#   4. Offline Python controller, callback, and parity suite (`pytest`)
#   5. Overwrite import via `scripts/manage_app.py push` (fails on any
#      `ImportAppResponse.warnings` and verifies expected tool declarations so
#      renamed or deleted tools never linger as orphans)
#   6. Multi-segment NAIVE golden evaluation sync via
#      `scripts/run_golden_evals.py sync` (never `cxas push-eval`, which
#      mis-orders `agentResponse` before `agentTransfer` on multi-agent turns)
#   7. Optional immutable CXAS version snapshot (`--create-version [v-name]`)
#      created AFTER golden evaluations are synced.
#
# Usage:
#   ./cloudbank/push.sh --yes                          # deploy to prod app (non-interactive)
#   ./cloudbank/push.sh dev                            # deploy to dev target
#   ./cloudbank/push.sh --yes --create-version [name]  # deploy + sync goldens + snapshot version
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required to parse gecx-config.json" >&2
  exit 1
fi

CONFIG_FILE="gecx-config.json"
if [ ! -f "$CONFIG_FILE" ]; then
  if [ -f "gecx-config.example.json" ]; then
    CONFIG_FILE="gecx-config.example.json"
  else
    echo "error: neither gecx-config.json nor gecx-config.example.json found in $(pwd)" >&2
    exit 1
  fi
fi

CFG_PROJECT=$(jq -r '.gcp_project_id // empty' "$CONFIG_FILE")
CFG_LOCATION=$(jq -r '.location // empty' "$CONFIG_FILE")
CFG_APP_ID=$(jq -r '.deployed_app_id // empty' "$CONFIG_FILE")

PROJECT="${CLOUDBANK_GCP_PROJECT_ID:-$CFG_PROJECT}"
LOCATION="${CLOUDBANK_LOCATION:-$CFG_LOCATION}"
APP_ID="${CLOUDBANK_APP_ID:-$CFG_APP_ID}"

if [ -z "$PROJECT" ] || [ "$PROJECT" = "null" ] || [[ "$PROJECT" == \<*\> ]] || \
   [ -z "$LOCATION" ] || [ "$LOCATION" = "null" ] || [[ "$LOCATION" == \<*\> ]] || \
   [ -z "$APP_ID" ] || [ "$APP_ID" = "null" ] || [[ "$APP_ID" == \<*\> ]]; then
  echo "error: set real gcp_project_id, location, and deployed_app_id in gecx-config.json or CLOUDBANK_GCP_PROJECT_ID / CLOUDBANK_LOCATION / CLOUDBANK_APP_ID" >&2
  exit 1
fi

export GOOGLE_CLOUD_QUOTA_PROJECT="${GOOGLE_CLOUD_QUOTA_PROJECT:-$PROJECT}"

TARGET="prod"
ASSUME_YES="false"
CREATE_VERSION="false"
VERSION_NAME=""

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes)
      ASSUME_YES="true"
      shift
      ;;
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

if [ "$TARGET" = "prod" ] || [ "$TARGET" = "production" ]; then
  if [ "$ASSUME_YES" != "true" ]; then
    if [ -t 0 ]; then
      printf "Confirm OVERWRITE import to prod app '%s' in project '%s'? [y/N]: " "$APP_ID" "$PROJECT" >&2
      read -r REPLY
      case "$REPLY" in
        y|Y|yes|YES)
          ;;
        *)
          echo "Aborted prod OVERWRITE deployment." >&2
          exit 1
          ;;
      esac
    else
      echo "error: prod OVERWRITE deployment requires --yes in non-interactive mode" >&2
      exit 1
    fi
  fi
fi

echo "==> [1/6] Verifying canonical callbacks and persona evaluation sync..."
uv run --locked python scripts/sync_shared.py --check

echo "==> [2/6] Running CXAS structural & evaluation lint..."
uv run --locked cxas lint

echo "==> [3/6] Running Composite v2 readiness audit..."
uv run --locked python scripts/audit_agent.py --workspace=cxas_app/Cloudbank --report

echo "==> [4/6] Running offline Python agent test suite..."
uv run --locked pytest -v

echo "==> [5/6] Performing OVERWRITE import & tool declaration check (projects/${PROJECT}/locations/${LOCATION})..."
uv run --locked python scripts/manage_app.py --config "${CONFIG_FILE}" push "${TARGET}"

echo "==> [6/6] Syncing multi-segment NAIVE golden evaluations to target '${TARGET}'..."
uv run --locked python scripts/run_golden_evals.py --config "${CONFIG_FILE}" sync "${TARGET}"

if [ "$CREATE_VERSION" = "true" ]; then
  if [ -z "$VERSION_NAME" ]; then
    VERSION_NAME="v-$(date -u +%Y%m%d-%H%M%S)"
  fi
  echo "==> [7/7] Creating immutable CXAS version '${VERSION_NAME}' on '${TARGET}'..."
  uv run --locked python scripts/manage_app.py --config "${CONFIG_FILE}" create-version "${VERSION_NAME}" "" "${TARGET}"
fi

echo "==> Deployment and golden evaluation sync complete."
