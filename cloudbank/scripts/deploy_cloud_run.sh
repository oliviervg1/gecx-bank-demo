#!/usr/bin/env bash
# Deploy the single-origin Cloudbank web + BidiRunSession proxy container to
# Google Cloud Run behind Direct Identity-Aware Proxy (IAP).
#
# Zero project IDs, project numbers, `.run.app` URLs, OAuth client IDs, app UUIDs,
# or organization domains are hardcoded here; all target identifiers are resolved
# from gitignored `cloudbank/gecx-config.json` or environment/CLI parameters.
#
# Usage example:
#   ./cloudbank/scripts/deploy_cloud_run.sh \
#     --service-account cloudbank-proxy@my-gcp-project.iam.gserviceaccount.com \
#     --iap-domains example.com \
#     --iap-members user:alice@example.com \
#     --yes
set -euo pipefail

export CLOUDSDK_CORE_INTERACTIVE_UX_STYLE=OFF

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLOUDBANK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${CLOUDBANK_DIR}"

usage() {
  cat <<'EOF'
Usage: ./cloudbank/scripts/deploy_cloud_run.sh [options]

Required parameters (via flags or environment variables):
  --service-account <email>      Dedicated runtime service account email (`SA_EMAIL` or
                                 `CLOUDBANK_SERVICE_ACCOUNT`); default Compute Engine
                                 `*-compute@developer.gserviceaccount.com` is refused.
  --iap-members <csv>            Comma-separated IAM principals granted
                                 `roles/iap.httpsResourceAccessor` (`IAP_MEMBERS`, e.g.
                                 `user:alice@example.com,group:concierge@example.com`).
  --iap-domains <csv>            Comma-separated Workspace/Cloud Identity domains granted
                                 `roles/iap.httpsResourceAccessor` (`IAP_DOMAINS`, e.g.
                                 `example.com`). At least one of `--iap-members` or
                                 `--iap-domains` is required; `allUsers` and
                                 `allAuthenticatedUsers` are refused.

Optional parameters:
  --config <path>                Path to CXAS config JSON (default: `gecx-config.json`,
                                 falling back to `gecx-config.example.json`).
  --project <id>                 GCP project ID (`CLOUDBANK_GCP_PROJECT_ID`).
  --location <loc>               CX Agent Studio (GECX) app location (`CLOUDBANK_LOCATION`).
  --app-id <uuid>                Deployed CXAS app ID (`CLOUDBANK_APP_ID`).
  --region <region>              Cloud Run & Artifact Registry region
                                 (`CLOUDBANK_CLOUD_RUN_REGION`, default: `europe-west1`).
  --service <name>               Cloud Run service name (`CLOUDBANK_CLOUD_RUN_SERVICE`,
                                 default: `cloudbank`).
  --ar-repo <name>               Artifact Registry Docker repository (`CLOUDBANK_AR_REPO`,
                                 default: `cloudbank`).
  --image-tag <tag>              Container image tag (`CLOUDBANK_IMAGE_TAG`, default: UTC
                                 timestamp).
  --cxas-role <role>             Optional IAM role ID for CXAS BidiRunSession access
                                 (`CLOUDBANK_CXAS_ROLE`); when set, binds both this role
                                 and `roles/serviceusage.serviceUsageConsumer` to
                                 `--service-account`.
  --extra-hosts <csv>            Optional comma-separated custom domain hostnames to allow
                                 alongside `.run.app` URLs (`CLOUDBANK_EXTRA_ALLOWED_HOSTS`).
  --iap-oauth-client-id <id>     Optional custom IAP OAuth 2.0 client ID
                                 (`IAP_OAUTH_CLIENT_ID`); requires `--iap-oauth-secret-name`.
  --iap-oauth-secret-name <name> Secret Manager secret holding the custom IAP OAuth client
                                 secret (`IAP_OAUTH_SECRET_NAME`).
  --max-instances <n>            Cloud Run `--max-instances` (`CLOUDBANK_MAX_INSTANCES`,
                                 default: `1`).
  --concurrency <n>              Cloud Run `--concurrency` (`CLOUDBANK_CONCURRENCY`,
                                 default: `80`).
  --max-sessions <n>             Per-instance `PROXY_MAX_SESSIONS` (default: `4`).
  --max-sessions-per-user <n>    Per-user `PROXY_MAX_SESSIONS_PER_USER` (default: `2`).
  --max-session-seconds <n>      `PROXY_MAX_SESSION_SECONDS` (default: `3300`, must be
                                 strictly below `3600`).
  -y, --yes                      Confirm deployment without interactive TTY prompt.
  -h, --help                     Show this help message and exit.
EOF
}

CONFIG_FILE=""
CLI_PROJECT=""
CLI_LOCATION=""
CLI_APP_ID=""
REGION="${CLOUDBANK_CLOUD_RUN_REGION:-europe-west1}"
SERVICE_NAME="${CLOUDBANK_CLOUD_RUN_SERVICE:-cloudbank}"
AR_REPO="${CLOUDBANK_AR_REPO:-cloudbank}"
IMAGE_TAG="${CLOUDBANK_IMAGE_TAG:-}"
SA_EMAIL_VAL="${SA_EMAIL:-${CLOUDBANK_SERVICE_ACCOUNT:-}}"
CXAS_ROLE="${CLOUDBANK_CXAS_ROLE:-}"
IAP_MEMBERS_RAW="${IAP_MEMBERS:-}"
IAP_DOMAINS_RAW="${IAP_DOMAINS:-}"
EXTRA_HOSTS_RAW="${CLOUDBANK_EXTRA_ALLOWED_HOSTS:-}"
OAUTH_CLIENT_ID="${IAP_OAUTH_CLIENT_ID:-}"
OAUTH_SECRET_NAME="${IAP_OAUTH_SECRET_NAME:-}"
MAX_INSTANCES="${CLOUDBANK_MAX_INSTANCES:-1}"
CONCURRENCY="${CLOUDBANK_CONCURRENCY:-80}"
MAX_SESSIONS="${PROXY_MAX_SESSIONS:-4}"
MAX_SESSIONS_PER_USER="${PROXY_MAX_SESSIONS_PER_USER:-2}"
MAX_SESSION_SECONDS="${PROXY_MAX_SESSION_SECONDS:-3300}"
ASSUME_YES="false"

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    -y|--yes)
      ASSUME_YES="true"
      shift
      ;;
    --config)
      [ $# -ge 2 ] || { echo "error: --config requires a path" >&2; exit 1; }
      CONFIG_FILE="$2"
      shift 2
      ;;
    --config=*)
      CONFIG_FILE="${1#*=}"
      shift
      ;;
    --project)
      [ $# -ge 2 ] || { echo "error: --project requires a value" >&2; exit 1; }
      CLI_PROJECT="$2"
      shift 2
      ;;
    --project=*)
      CLI_PROJECT="${1#*=}"
      shift
      ;;
    --location)
      [ $# -ge 2 ] || { echo "error: --location requires a value" >&2; exit 1; }
      CLI_LOCATION="$2"
      shift 2
      ;;
    --location=*)
      CLI_LOCATION="${1#*=}"
      shift
      ;;
    --app-id)
      [ $# -ge 2 ] || { echo "error: --app-id requires a value" >&2; exit 1; }
      CLI_APP_ID="$2"
      shift 2
      ;;
    --app-id=*)
      CLI_APP_ID="${1#*=}"
      shift
      ;;
    --region)
      [ $# -ge 2 ] || { echo "error: --region requires a value" >&2; exit 1; }
      REGION="$2"
      shift 2
      ;;
    --region=*)
      REGION="${1#*=}"
      shift
      ;;
    --service)
      [ $# -ge 2 ] || { echo "error: --service requires a value" >&2; exit 1; }
      SERVICE_NAME="$2"
      shift 2
      ;;
    --service=*)
      SERVICE_NAME="${1#*=}"
      shift
      ;;
    --ar-repo)
      [ $# -ge 2 ] || { echo "error: --ar-repo requires a value" >&2; exit 1; }
      AR_REPO="$2"
      shift 2
      ;;
    --ar-repo=*)
      AR_REPO="${1#*=}"
      shift
      ;;
    --image-tag)
      [ $# -ge 2 ] || { echo "error: --image-tag requires a value" >&2; exit 1; }
      IMAGE_TAG="$2"
      shift 2
      ;;
    --image-tag=*)
      IMAGE_TAG="${1#*=}"
      shift
      ;;
    --service-account)
      [ $# -ge 2 ] || { echo "error: --service-account requires an email" >&2; exit 1; }
      SA_EMAIL_VAL="$2"
      shift 2
      ;;
    --service-account=*)
      SA_EMAIL_VAL="${1#*=}"
      shift
      ;;
    --cxas-role)
      [ $# -ge 2 ] || { echo "error: --cxas-role requires a role ID" >&2; exit 1; }
      CXAS_ROLE="$2"
      shift 2
      ;;
    --cxas-role=*)
      CXAS_ROLE="${1#*=}"
      shift
      ;;
    --iap-members)
      [ $# -ge 2 ] || { echo "error: --iap-members requires a comma-separated value" >&2; exit 1; }
      IAP_MEMBERS_RAW="$2"
      shift 2
      ;;
    --iap-members=*)
      IAP_MEMBERS_RAW="${1#*=}"
      shift
      ;;
    --iap-domains)
      [ $# -ge 2 ] || { echo "error: --iap-domains requires a comma-separated value" >&2; exit 1; }
      IAP_DOMAINS_RAW="$2"
      shift 2
      ;;
    --iap-domains=*)
      IAP_DOMAINS_RAW="${1#*=}"
      shift
      ;;
    --extra-hosts)
      [ $# -ge 2 ] || { echo "error: --extra-hosts requires a comma-separated value" >&2; exit 1; }
      EXTRA_HOSTS_RAW="$2"
      shift 2
      ;;
    --extra-hosts=*)
      EXTRA_HOSTS_RAW="${1#*=}"
      shift
      ;;
    --iap-oauth-client-id)
      [ $# -ge 2 ] || { echo "error: --iap-oauth-client-id requires a value" >&2; exit 1; }
      OAUTH_CLIENT_ID="$2"
      shift 2
      ;;
    --iap-oauth-client-id=*)
      OAUTH_CLIENT_ID="${1#*=}"
      shift
      ;;
    --iap-oauth-secret-name)
      [ $# -ge 2 ] || { echo "error: --iap-oauth-secret-name requires a value" >&2; exit 1; }
      OAUTH_SECRET_NAME="$2"
      shift 2
      ;;
    --iap-oauth-secret-name=*)
      OAUTH_SECRET_NAME="${1#*=}"
      shift
      ;;
    --max-instances)
      [ $# -ge 2 ] || { echo "error: --max-instances requires an integer" >&2; exit 1; }
      MAX_INSTANCES="$2"
      shift 2
      ;;
    --max-instances=*)
      MAX_INSTANCES="${1#*=}"
      shift
      ;;
    --concurrency)
      [ $# -ge 2 ] || { echo "error: --concurrency requires an integer" >&2; exit 1; }
      CONCURRENCY="$2"
      shift 2
      ;;
    --concurrency=*)
      CONCURRENCY="${1#*=}"
      shift
      ;;
    --max-sessions)
      [ $# -ge 2 ] || { echo "error: --max-sessions requires an integer" >&2; exit 1; }
      MAX_SESSIONS="$2"
      shift 2
      ;;
    --max-sessions=*)
      MAX_SESSIONS="${1#*=}"
      shift
      ;;
    --max-sessions-per-user)
      [ $# -ge 2 ] || { echo "error: --max-sessions-per-user requires an integer" >&2; exit 1; }
      MAX_SESSIONS_PER_USER="$2"
      shift 2
      ;;
    --max-sessions-per-user=*)
      MAX_SESSIONS_PER_USER="${1#*=}"
      shift
      ;;
    --max-session-seconds)
      [ $# -ge 2 ] || { echo "error: --max-session-seconds requires an integer" >&2; exit 1; }
      MAX_SESSION_SECONDS="$2"
      shift 2
      ;;
    --max-session-seconds=*)
      MAX_SESSION_SECONDS="${1#*=}"
      shift
      ;;
    --auth-token|--auth-token=*|--allow-unauthenticated)
      echo "error: option '$1' is forbidden for Cloud Run Direct IAP deployments" >&2
      exit 1
      ;;
    *)
      echo "error: unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [ -n "${PROXY_AUTH_TOKEN:-}" ]; then
  echo "error: PROXY_AUTH_TOKEN must not be set for Cloud Run Direct IAP deployments (browser WebSockets authenticate via Direct IAP)" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required to parse gecx-config.json and Cloud Run service metadata" >&2
  exit 1
fi

if [ -z "${CONFIG_FILE}" ]; then
  if [ -f "gecx-config.json" ]; then
    CONFIG_FILE="gecx-config.json"
  elif [ -f "gecx-config.example.json" ]; then
    CONFIG_FILE="gecx-config.example.json"
  else
    echo "error: neither gecx-config.json nor gecx-config.example.json found in $(pwd)" >&2
    exit 1
  fi
elif [ ! -f "${CONFIG_FILE}" ]; then
  echo "error: config file not found: ${CONFIG_FILE}" >&2
  exit 1
fi

CFG_PROJECT=$(jq -r '.gcp_project_id // empty' "${CONFIG_FILE}")
CFG_LOCATION=$(jq -r '.location // empty' "${CONFIG_FILE}")
CFG_APP_ID=$(jq -r '.deployed_app_id // empty' "${CONFIG_FILE}")

PROJECT="${CLI_PROJECT:-${CLOUDBANK_GCP_PROJECT_ID:-$CFG_PROJECT}}"
LOCATION="${CLI_LOCATION:-${CLOUDBANK_LOCATION:-$CFG_LOCATION}}"
APP_ID="${CLI_APP_ID:-${CLOUDBANK_APP_ID:-$CFG_APP_ID}}"

if [ -z "${PROJECT}" ] || [ "${PROJECT}" = "null" ] || [[ "${PROJECT}" == \<*\> ]] || \
   [ -z "${LOCATION}" ] || [ "${LOCATION}" = "null" ] || [[ "${LOCATION}" == \<*\> ]] || \
   [ -z "${APP_ID}" ] || [ "${APP_ID}" = "null" ] || [[ "${APP_ID}" == \<*\> ]]; then
  echo "error: set real gcp_project_id, location, and deployed_app_id in gecx-config.json or CLOUDBANK_GCP_PROJECT_ID / CLOUDBANK_LOCATION / CLOUDBANK_APP_ID" >&2
  exit 1
fi

if [[ ! "${PROJECT}" =~ ^([a-z0-9.-]+:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
  echo "error: invalid GCP project ID '${PROJECT}'" >&2
  exit 1
fi
if [[ ! "${LOCATION}" =~ ^[a-z0-9-]+$ ]]; then
  echo "error: invalid CXAS location '${LOCATION}'" >&2
  exit 1
fi
if [[ ! "${APP_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ ]]; then
  echo "error: invalid CXAS deployed_app_id '${APP_ID}'" >&2
  exit 1
fi
if [[ ! "${REGION}" =~ ^[a-z0-9-]+$ ]]; then
  echo "error: invalid Cloud Run region '${REGION}'" >&2
  exit 1
fi
if [[ ! "${SERVICE_NAME}" =~ ^[a-z][a-z0-9-]{0,48}$ ]] || [[ "${SERVICE_NAME}" == *- ]]; then
  echo "error: invalid Cloud Run service name '${SERVICE_NAME}'" >&2
  exit 1
fi
if [[ ! "${AR_REPO}" =~ ^[a-z][a-z0-9-]{0,61}[a-z0-9]$ ]]; then
  echo "error: invalid Artifact Registry repository name '${AR_REPO}'" >&2
  exit 1
fi

# Require explicit dedicated service account and refuse default Compute/App Engine SAs
if [ -z "${SA_EMAIL_VAL}" ] || [[ "${SA_EMAIL_VAL}" == \<*\> ]]; then
  echo "error: --service-account (or SA_EMAIL) is required and must be a dedicated least-privilege service account" >&2
  exit 1
fi
if [[ "${SA_EMAIL_VAL}" == *-compute@developer.gserviceaccount.com ]] || \
   [[ "${SA_EMAIL_VAL}" == *@appspot.gserviceaccount.com ]]; then
  echo "error: refusing default Compute Engine or App Engine service account '${SA_EMAIL_VAL}'; create and pass a dedicated service account" >&2
  exit 1
fi
if [[ ! "${SA_EMAIL_VAL}" =~ ^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com$ ]]; then
  echo "error: invalid --service-account email '${SA_EMAIL_VAL}' (expected *@*.gserviceaccount.com)" >&2
  exit 1
fi

if [ -n "${CXAS_ROLE}" ] && [[ ! "${CXAS_ROLE}" =~ ^(roles/[A-Za-z0-9._-]+|projects/[A-Za-z0-9._:-]+/roles/[A-Za-z0-9._-]+|organizations/[0-9]+/roles/[A-Za-z0-9._-]+)$ ]]; then
  echo "error: invalid --cxas-role '${CXAS_ROLE}'" >&2
  exit 1
fi

if { [ -n "${OAUTH_CLIENT_ID}" ] && [ -z "${OAUTH_SECRET_NAME}" ]; } || \
   { [ -z "${OAUTH_CLIENT_ID}" ] && [ -n "${OAUTH_SECRET_NAME}" ]; }; then
  echo "error: --iap-oauth-client-id and --iap-oauth-secret-name must be provided together" >&2
  exit 1
fi
if [ -n "${OAUTH_CLIENT_ID}" ] && [[ ! "${OAUTH_CLIENT_ID}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "error: invalid --iap-oauth-client-id" >&2
  exit 1
fi
if [ -n "${OAUTH_SECRET_NAME}" ] && [[ ! "${OAUTH_SECRET_NAME}" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "error: invalid --iap-oauth-secret-name" >&2
  exit 1
fi

# Validate numeric tuning flags
for num_pair in \
  "max-instances:${MAX_INSTANCES}" \
  "concurrency:${CONCURRENCY}" \
  "max-sessions:${MAX_SESSIONS}" \
  "max-sessions-per-user:${MAX_SESSIONS_PER_USER}" \
  "max-session-seconds:${MAX_SESSION_SECONDS}"; do
  num_label="${num_pair%%:*}"
  num_val="${num_pair#*:}"
  if [[ ! "${num_val}" =~ ^[1-9][0-9]*$ ]]; then
    echo "error: --${num_label} must be a positive integer (got '${num_val}')" >&2
    exit 1
  fi
done

if [ "${MAX_SESSION_SECONDS}" -ge 3600 ]; then
  echo "error: --max-session-seconds (${MAX_SESSION_SECONDS}) must be strictly below Cloud Run --timeout=3600" >&2
  exit 1
fi
if [ "${CONCURRENCY}" -le "${MAX_SESSIONS}" ]; then
  echo "error: --concurrency (${CONCURRENCY}) must exceed --max-sessions (${MAX_SESSIONS}) to leave static asset headroom" >&2
  exit 1
fi

# Validate and normalize IAP principals (refusing empty, allUsers, and allAuthenticatedUsers)
PRINCIPAL_LIST=()
append_unique_principal() {
  local candidate="$1"
  local existing
  for existing in ${PRINCIPAL_LIST[@]+"${PRINCIPAL_LIST[@]}"}; do
    if [ "${existing}" = "${candidate}" ]; then
      return 0
    fi
  done
  PRINCIPAL_LIST+=("${candidate}")
}

check_not_public_principal() {
  local raw_entry="$1"
  local lowered
  lowered=$(printf '%s' "${raw_entry}" | tr '[:upper:]' '[:lower:]')
  case "${lowered}" in
    allusers|allauthenticatedusers|*:allusers|*:allauthenticatedusers|*"*"*|*\<*\>*)
      echo "error: public or placeholder IAP principal '${raw_entry}' is forbidden (allUsers and allAuthenticatedUsers are refused)" >&2
      exit 1
      ;;
  esac
}

if [ -n "${IAP_MEMBERS_RAW}" ]; then
  IFS=',' read -r -a RAW_MEMBERS <<< "${IAP_MEMBERS_RAW}"
  for entry in "${RAW_MEMBERS[@]}"; do
    trimmed="${entry#"${entry%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
    if [ -z "${trimmed}" ]; then
      echo "error: empty entry in --iap-members / IAP_MEMBERS" >&2
      exit 1
    fi
    check_not_public_principal "${trimmed}"
    if [[ ! "${trimmed}" =~ ^(user|group|domain|serviceAccount|principal|principalSet):[A-Za-z0-9._@/:+-]+$ ]]; then
      echo "error: invalid IAP member '${trimmed}' (expected user:, group:, domain:, or serviceAccount: prefix)" >&2
      exit 1
    fi
    append_unique_principal "${trimmed}"
  done
fi

if [ -n "${IAP_DOMAINS_RAW}" ]; then
  IFS=',' read -r -a RAW_DOMAINS <<< "${IAP_DOMAINS_RAW}"
  for dom in "${RAW_DOMAINS[@]}"; do
    trimmed="${dom#"${dom%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
    trimmed="${trimmed#domain:}"
    if [ -z "${trimmed}" ]; then
      echo "error: empty entry in --iap-domains / IAP_DOMAINS" >&2
      exit 1
    fi
    check_not_public_principal "${trimmed}"
    if [[ ! "${trimmed}" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]]; then
      echo "error: invalid IAP domain '${trimmed}'" >&2
      exit 1
    fi
    append_unique_principal "domain:${trimmed}"
  done
fi

if [ "${#PRINCIPAL_LIST[@]}" -eq 0 ]; then
  echo "error: at least one IAP principal is required via --iap-members / IAP_MEMBERS or --iap-domains / IAP_DOMAINS" >&2
  exit 1
fi

# Validate optional extra custom hostnames (strip https:// if supplied, refuse http://, ports, wildcards, loopback)
EXTRA_HOSTS=()
validate_bare_non_loopback_host() {
  local host="$1"
  local lower_host
  lower_host=$(printf '%s' "${host}" | tr '[:upper:]' '[:lower:]')
  case "${lower_host}" in
    localhost|*.localhost|127.*|::1|"[::1]"|testserver|testclient|*"*"*|*:*|*/*)
      echo "error: invalid or loopback hostname '${host}'" >&2
      exit 1
      ;;
  esac
  if [[ ! "${lower_host}" =~ ^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$ ]]; then
    echo "error: malformed hostname '${host}'" >&2
    exit 1
  fi
  printf '%s' "${lower_host}"
}

if [ -n "${EXTRA_HOSTS_RAW}" ]; then
  IFS=',' read -r -a RAW_EXTRA_HOSTS <<< "${EXTRA_HOSTS_RAW}"
  for raw_h in "${RAW_EXTRA_HOSTS[@]}"; do
    trimmed="${raw_h#"${raw_h%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
    if [[ "${trimmed}" == http://* ]]; then
      echo "error: non-HTTPS origin '${trimmed}' is forbidden in --extra-hosts" >&2
      exit 1
    fi
    stripped="${trimmed#https://}"
    stripped="${stripped%/}"
    norm_host=$(validate_bare_non_loopback_host "${stripped}")
    EXTRA_HOSTS+=("${norm_host}")
  done
fi

if [ ! -f "Dockerfile" ] || [ ! -f ".gcloudignore" ]; then
  echo "error: Dockerfile and .gcloudignore must exist in ${CLOUDBANK_DIR}" >&2
  exit 1
fi

if [ -z "${IMAGE_TAG}" ]; then
  IMAGE_TAG="v-$(date -u +%Y%m%d-%H%M%S)"
fi
if [[ ! "${IMAGE_TAG}" =~ ^[A-Za-z0-9._-]{1,128}$ ]]; then
  echo "error: invalid --image-tag '${IMAGE_TAG}'" >&2
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "error: gcloud CLI is required to deploy to Cloud Run" >&2
  exit 1
fi

if [ "${ASSUME_YES}" != "true" ]; then
  if [ -t 0 ]; then
    printf "Confirm Cloud Run Direct IAP deployment of '%s' in project '%s' (%s)? [y/N]: " \
      "${SERVICE_NAME}" "${PROJECT}" "${REGION}" >&2
    read -r REPLY
    case "${REPLY}" in
      y|Y|yes|YES)
        ASSUME_YES="true"
        ;;
      *)
        echo "Aborted Cloud Run deployment." >&2
        exit 1
        ;;
    esac
  else
    echo "error: Cloud Run deployment requires --yes in non-interactive mode" >&2
    exit 1
  fi
fi

ENV_FILE="$(mktemp)"
IAP_SETTINGS_FILE=""
cleanup_temp_files() {
  rm -f "${ENV_FILE}"
  if [ -n "${IAP_SETTINGS_FILE}" ]; then
    rm -f "${IAP_SETTINGS_FILE}"
  fi
}
trap cleanup_temp_files EXIT
chmod 600 "${ENV_FILE}"

write_env_vars_yaml() {
  local target_file="$1"
  local hosts_csv="$2"
  local origins_csv="$3"
  local iap_aud="$4"
  cat > "${target_file}" <<EOF
CLOUDBANK_GCP_PROJECT_ID: '${PROJECT}'
CLOUDBANK_LOCATION: '${LOCATION}'
CLOUDBANK_APP_ID: '${APP_ID}'
PROXY_HOST: '0.0.0.0'
PROXY_ALLOW_REMOTE: '1'
PROXY_STATIC_DIR: '/app/web/dist'
PROXY_MAX_SESSIONS: '${MAX_SESSIONS}'
PROXY_MAX_SESSIONS_PER_USER: '${MAX_SESSIONS_PER_USER}'
PROXY_MAX_SESSION_SECONDS: '${MAX_SESSION_SECONDS}'
PROXY_IAP_AUDIENCE: '${iap_aud}'
PROXY_ALLOWED_HOSTS: '${hosts_csv}'
PROXY_ALLOWED_ORIGINS: '${origins_csv}'
EOF
}

build_hosts_and_origins_csv() {
  local -a merged_hosts=()
  local candidate existing
  for candidate in "$@"; do
    [ -n "${candidate}" ] || continue
    local seen="false"
    for existing in ${merged_hosts[@]+"${merged_hosts[@]}"}; do
      if [ "${existing}" = "${candidate}" ]; then
        seen="true"
        break
      fi
    done
    if [ "${seen}" = "false" ]; then
      merged_hosts+=("${candidate}")
    fi
  done

  local hosts_csv=""
  local origins_csv=""
  local h
  for h in "${merged_hosts[@]}"; do
    hosts_csv="${hosts_csv:+${hosts_csv},}${h}"
    origins_csv="${origins_csv:+${origins_csv},}https://${h}"
  done
  printf '%s\n%s\n' "${hosts_csv}" "${origins_csv}"
}

echo "==> [1/6] Resolving project number for '${PROJECT}'..."
PROJECT_NUMBER="${CLOUDBANK_GCP_PROJECT_NUMBER:-}"
if [ -z "${PROJECT_NUMBER}" ]; then
  PROJECT_NUMBER=$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)' --quiet)
fi
if [[ ! "${PROJECT_NUMBER}" =~ ^[0-9]+$ ]]; then
  echo "error: failed to resolve numeric project number for '${PROJECT}'" >&2
  exit 1
fi

IAP_AUDIENCE="/projects/${PROJECT_NUMBER}/locations/${REGION}/services/${SERVICE_NAME}"
DETERMINISTIC_HOST="${SERVICE_NAME}-${PROJECT_NUMBER}.${REGION}.run.app"

if ! gcloud beta services identity create \
  --service=iap.googleapis.com \
  --project="${PROJECT}" \
  --quiet >/dev/null 2>&1; then
  echo "warning: unable to verify or create iap.googleapis.com service identity; continuing..." >&2
fi

if [ -n "${CXAS_ROLE}" ]; then
  echo "==> Binding least-privilege runtime roles on '${SA_EMAIL_VAL}'..."
  gcloud projects add-iam-policy-binding "${PROJECT}" \
    --member="serviceAccount:${SA_EMAIL_VAL}" \
    --role="${CXAS_ROLE}" \
    --condition=None \
    --quiet >/dev/null
  gcloud projects add-iam-policy-binding "${PROJECT}" \
    --member="serviceAccount:${SA_EMAIL_VAL}" \
    --role="roles/serviceusage.serviceUsageConsumer" \
    --condition=None \
    --quiet >/dev/null
fi

echo "==> [2/6] Ensuring Artifact Registry Docker repository '${AR_REPO}' exists in '${REGION}'..."
if ! gcloud artifacts repositories describe "${AR_REPO}" \
  --project="${PROJECT}" \
  --location="${REGION}" \
  --quiet >/dev/null 2>&1; then
  CLOUDSDK_CORE_INTERACTIVE_UX_STYLE=OFF gcloud artifacts repositories create "${AR_REPO}" \
    --project="${PROJECT}" \
    --location="${REGION}" \
    --repository-format=docker \
    --description="Cloudbank single-origin web and BidiRunSession proxy images" \
    --quiet
fi

AR_PROJECT_PATH="${PROJECT//://}"
IMAGE_URI="${REGION}-docker.pkg.dev/${AR_PROJECT_PATH}/${AR_REPO}/${SERVICE_NAME}:${IMAGE_TAG}"
echo "==> [3/6] Building single-origin container image via Cloud Build..."
CLOUDSDK_CORE_INTERACTIVE_UX_STYLE=OFF gcloud builds submit . \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --tag="${IMAGE_URI}" \
  --quiet

extract_service_hosts() {
  local svc_json="$1"
  [ -n "${svc_json}" ] || return 0
  local urls_nl raw_url bare_h valid_h
  urls_nl=$(
    printf '%s' "${svc_json}" | jq -r '
      if type != "object" then error("expected service JSON object") else . end
      | [
          (.status.url // empty),
          ((.metadata.annotations["run.googleapis.com/urls"] // "[]") | fromjson? // [] | .[])
        ]
      | map(select(type == "string" and length > 0))
      | .[]
    '
  ) || exit 1
  [ -n "${urls_nl}" ] || return 0
  while IFS= read -r raw_url; do
    [ -n "${raw_url}" ] || continue
    if [[ "${raw_url}" != https://* ]]; then
      echo "error: refusing non-HTTPS Cloud Run URL '${raw_url}'" >&2
      exit 1
    fi
    bare_h="${raw_url#https://}"
    bare_h="${bare_h%%/*}"
    valid_h=$(validate_bare_non_loopback_host "${bare_h}") || exit 1
    printf '%s\n' "${valid_h}"
  done <<< "${urls_nl}"
}

PREEXISTING_HOSTS=()
EXISTING_SERVICE_JSON=$(gcloud run services describe "${SERVICE_NAME}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --format=json \
  --quiet 2>/dev/null || true)
if [ -n "${EXISTING_SERVICE_JSON}" ]; then
  EXISTING_HOSTS_NL=$(extract_service_hosts "${EXISTING_SERVICE_JSON}")
  if [ -n "${EXISTING_HOSTS_NL}" ]; then
    while IFS= read -r existing_h; do
      [ -n "${existing_h}" ] && PREEXISTING_HOSTS+=("${existing_h}")
    done <<< "${EXISTING_HOSTS_NL}"
  fi
fi

INITIAL_PAIR=$(build_hosts_and_origins_csv \
  "${DETERMINISTIC_HOST}" \
  ${PREEXISTING_HOSTS[@]+"${PREEXISTING_HOSTS[@]}"} \
  ${EXTRA_HOSTS[@]+"${EXTRA_HOSTS[@]}"})
INITIAL_HOSTS_CSV=$(printf '%s\n' "${INITIAL_PAIR}" | sed -n '1p')
INITIAL_ORIGINS_CSV=$(printf '%s\n' "${INITIAL_PAIR}" | sed -n '2p')
write_env_vars_yaml "${ENV_FILE}" "${INITIAL_HOSTS_CSV}" "${INITIAL_ORIGINS_CSV}" "${IAP_AUDIENCE}"

echo "==> [4/6] Deploying Cloud Run service '${SERVICE_NAME}' with Direct IAP and session affinity..."
CLOUDSDK_CORE_INTERACTIVE_UX_STYLE=OFF gcloud run deploy "${SERVICE_NAME}" \
  --image="${IMAGE_URI}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --service-account="${SA_EMAIL_VAL}" \
  --env-vars-file="${ENV_FILE}" \
  --max-instances="${MAX_INSTANCES}" \
  --concurrency="${CONCURRENCY}" \
  --timeout=3600 \
  --no-allow-unauthenticated \
  --iap \
  --session-affinity \
  --quiet

echo "==> [5/6] Syncing deployed Cloud Run URLs into PROXY_ALLOWED_HOSTS and PROXY_ALLOWED_ORIGINS..."
SERVICE_JSON=$(gcloud run services describe "${SERVICE_NAME}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --format=json \
  --quiet)

DISCOVERED_HOSTS=()
DISCOVERED_HOSTS_NL=$(extract_service_hosts "${SERVICE_JSON}")
if [ -n "${DISCOVERED_HOSTS_NL}" ]; then
  while IFS= read -r disc_h; do
    [ -n "${disc_h}" ] && DISCOVERED_HOSTS+=("${disc_h}")
  done <<< "${DISCOVERED_HOSTS_NL}"
fi

FINAL_PAIR=$(build_hosts_and_origins_csv \
  "${DETERMINISTIC_HOST}" \
  ${DISCOVERED_HOSTS[@]+"${DISCOVERED_HOSTS[@]}"} \
  ${EXTRA_HOSTS[@]+"${EXTRA_HOSTS[@]}"})
FINAL_HOSTS_CSV=$(printf '%s\n' "${FINAL_PAIR}" | sed -n '1p')
FINAL_ORIGINS_CSV=$(printf '%s\n' "${FINAL_PAIR}" | sed -n '2p')

if [ "${FINAL_HOSTS_CSV}" != "${INITIAL_HOSTS_CSV}" ] || \
   [ "${FINAL_ORIGINS_CSV}" != "${INITIAL_ORIGINS_CSV}" ]; then
  write_env_vars_yaml "${ENV_FILE}" "${FINAL_HOSTS_CSV}" "${FINAL_ORIGINS_CSV}" "${IAP_AUDIENCE}"
  CLOUDSDK_CORE_INTERACTIVE_UX_STYLE=OFF gcloud run services update "${SERVICE_NAME}" \
    --project="${PROJECT}" \
    --region="${REGION}" \
    --env-vars-file="${ENV_FILE}" \
    --quiet
fi

echo "==> [6/6] Binding IAP Service Agent invoker role and IAP access policy..."
IAP_SERVICE_AGENT="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com"
gcloud run services add-iam-policy-binding "${SERVICE_NAME}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --member="${IAP_SERVICE_AGENT}" \
  --role="roles/run.invoker" \
  --condition=None \
  --quiet >/dev/null

if [ -n "${OAUTH_CLIENT_ID}" ] && [ -n "${OAUTH_SECRET_NAME}" ]; then
  OAUTH_SECRET_VAL=$(gcloud secrets versions access latest \
    --secret="${OAUTH_SECRET_NAME}" \
    --project="${PROJECT}" \
    --quiet)
  if [ -z "${OAUTH_SECRET_VAL}" ]; then
    echo "error: Secret Manager secret '${OAUTH_SECRET_NAME}' returned an empty value" >&2
    exit 1
  fi
  IAP_SETTINGS_FILE="$(mktemp)"
  chmod 600 "${IAP_SETTINGS_FILE}"
  printf '%s' "${OAUTH_SECRET_VAL}" | jq -Rs \
    --arg cid "${OAUTH_CLIENT_ID}" \
    '{accessSettings: {oauthSettings: {clientId: $cid, clientSecret: .}}}' \
    > "${IAP_SETTINGS_FILE}"
  unset OAUTH_SECRET_VAL
  gcloud iap settings set "${IAP_SETTINGS_FILE}" \
    --project="${PROJECT}" \
    --resource-type=cloud-run \
    --region="${REGION}" \
    --service="${SERVICE_NAME}" \
    --quiet >/dev/null
  rm -f "${IAP_SETTINGS_FILE}"
  IAP_SETTINGS_FILE=""
fi

for member in "${PRINCIPAL_LIST[@]}"; do
  gcloud iap web add-iam-policy-binding \
    --project="${PROJECT}" \
    --resource-type=cloud-run \
    --region="${REGION}" \
    --service="${SERVICE_NAME}" \
    --member="${member}" \
    --role="roles/iap.httpsResourceAccessor" \
    --condition=None \
    --quiet >/dev/null
done

PRIMARY_URL=$(printf '%s' "${SERVICE_JSON}" | jq -r '.status.url // empty')
echo "==> Cloud Run Direct IAP deployment complete: ${PRIMARY_URL:-https://${DETERMINISTIC_HOST}}"
