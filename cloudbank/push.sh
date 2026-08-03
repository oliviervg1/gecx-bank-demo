#!/usr/bin/env bash
# Push the Cloudbank GECX app to CES.
#
# Reads the GCP project, location, and deployed app id from
# `cloudbank/gecx-config.json` so callers don't need to remember the
# explicit --app-dir / --to flags `cxas push` requires.
#
# Usage:
#   ./cloudbank/push.sh                       # plain push
#   ./cloudbank/push.sh --create-version      # push and create a CES version
#
# Any extra args are forwarded to `cxas push`.
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required to parse gecx-config.json" >&2
  exit 1
fi

PROJECT=$(jq -r .gcp_project_id gecx-config.json)
LOCATION=$(jq -r .location gecx-config.json)
APP_ID=$(jq -r .deployed_app_id gecx-config.json)

if [ "$PROJECT" = "null" ] || [ "$LOCATION" = "null" ] || [ "$APP_ID" = "null" ]; then
  echo "error: gecx-config.json missing one of gcp_project_id / location / deployed_app_id" >&2
  exit 1
fi

exec cxas push \
  --app-dir cxas_app/Cloudbank \
  --to "projects/${PROJECT}/locations/${LOCATION}/apps/${APP_ID}" \
  --project-id "${PROJECT}" \
  --location "${LOCATION}" \
  "$@"
