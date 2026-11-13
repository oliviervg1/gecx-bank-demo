# Developer Workflow & CI/CD Guide

This guide covers local environment setup via the root `Makefile`, the zero-warning verification gates, shared callback and evaluation synchronisation, localhost and Cloud Run Direct IAP proxy hardening, CXAS bundle deployment via `./cloudbank/push.sh` and `manage_app.py`, single-origin Cloud Run Direct IAP deployment via `./cloudbank/scripts/deploy_cloud_run.sh`, and SHA-pinned GitHub Actions CI.

## 1. Local Setup

Prerequisites:
- Python `3.11+` and [uv](https://docs.astral.sh/uv/getting-started/installation/)
- Node.js `22+` (see `cloudbank/web/.nvmrc`)
- `jq` (used by `cloudbank/push.sh`)

Install all locked Python and Node dependencies from committed public PyPI and npm lockfiles:

```bash
# Offline bootstrap (zero GCP credentials required)
make install
```

Both `cloudbank/pyproject.toml` and `cloudbank/proxy/pyproject.toml` use PEP 735 `[dependency-groups]` and pin `[[tool.uv.index]]` to `https://pypi.org/simple` so `uv.lock` resolves exclusively to public PyPI registries.

---

## 2. Local Verification Gates (`make check` & `make e2e`)

Run `make check` before committing or deploying. Every gate runs offline with zero GCP credentials, and `.github/workflows/ci.yml` enforces the exact same commands on every pull request:

```bash
# Run lint, test, production build, and privacy/lockfile hygiene gates together
make check

# Or invoke individual gates in isolated subshells:
# Gate 1: CXAS structural & evaluation lint (from cloudbank/ WITHOUT --app-dir so E001-E011 run), Composite v2 audit, shared sync, Ruff, Pyright
(cd cloudbank && uv run --locked cxas lint && uv run --locked python scripts/audit_agent.py --workspace=cxas_app/Cloudbank --report)
(cd cloudbank && uv run --locked python scripts/sync_shared.py --check && uv run --locked ruff check . && uv run --locked pyright)

# Gate 2: Offline Python agent suite (bundle AST/schema checks, controllers, state matrix, callback chains, parity, push checks)
(cd cloudbank && uv run --locked pytest -v)

# Gate 3: Bidi WebSocket proxy Ruff, Pyright, and pytest suite
(cd cloudbank/proxy && uv run --locked ruff check . && uv run --locked pyright && uv run --locked pytest -v)

# Gate 4: Web unit/parity/state-machine tests, TypeScript check, zero-warning ESLint, and production build
(cd cloudbank/web && npm test && npm run typecheck && npm run lint && npm run build)

# Gate 5: Live-browser Playwright + axe-core WCAG 2.1 AA end-to-end suite
make e2e
```

> Zero-Warning Policy: `cxas lint`, Ruff, Pyright, TypeScript, and ESLint (`--max-warnings 0`) treat warnings as blockers. Edit shared callbacks (`capture_utterance`, `release_line`) in `cloudbank/cxas_shared/callbacks/`, shared controller helpers in `cloudbank/cxas_shared/controller_common.py`, official help hosts in `cloudbank/shared/official_help_hosts.json`, and persona fixtures in `cloudbank/shared/personas/*.json`, then run `(cd cloudbank && uv run --locked python scripts/sync_shared.py --write)` so all four agents, controller common regions, and evaluation snapshots stay byte-identical.

---

## 3. Configuration & Privacy Hygiene (`cloudbank/gecx-config.example.json`)

Never hardcode a GCP project ID, region, or app UUID in tracked code, tests, scripts, or Markdown documentation. Commit only placeholder values in `cloudbank/gecx-config.example.json`, and configure your local environment by copying the template to gitignored `cloudbank/gecx-config.json` (or setting `CLOUDBANK_GCP_PROJECT_ID`, `CLOUDBANK_LOCATION`, and `CLOUDBANK_APP_ID`):

```bash
cp cloudbank/gecx-config.example.json cloudbank/gecx-config.json
```

```json
{
  "gcp_project_id": "<your-gcp-project-id>",
  "location": "eu",
  "app_name": "Cloudbank",
  "deployed_app_id": "<your-deployed-app-uuid>",
  "app_dir": "cxas_app/",
  "model": "gemini-composite-v2",
  "modality": "audio",
  "default_channel": "audio",
  "default_language_code": "en-GB",
  "goldens_dir": "evals/goldens",
  "simulations_dir": "evals/simulations"
}
```

`make hygiene` (invoked directly by the `privacy-and-hygiene` job in `.github/workflows/ci.yml` with zero duplicated script logic) verifies that `cloudbank/gecx-config.json` is never tracked in Git, validates that every URL in `cloudbank/uv.lock`, `cloudbank/proxy/uv.lock`, and `cloudbank/web/package-lock.json` points to public PyPI or npmjs hosts, and scans all tracked files (`git ls-files`) for internal domains, shortlinks, legacy product names, or workstation paths.

---

## 4. Running & Hardening `cloudbank/proxy`

`cloudbank/proxy` supports two operating modes: local workstation development on `127.0.0.1:8765` using Application Default Credentials (`ADC`), and single-origin Cloud Run Direct IAP hosting (`PROXY_IAP_AUDIENCE` + `PROXY_STATIC_DIR`) under a dedicated service account. For local development, always bind to loopback (`127.0.0.1:8765`):

```bash
# Recommended package entrypoint (binds 127.0.0.1:8765 with proxy_headers=False and ws_max_size=1048576)
(cd cloudbank/proxy && uv run --locked python -m proxy)

# Or run with Uvicorn auto-reload behind Vite dev server (:5173 -> ws://127.0.0.1:8765/ws/agent)
(cd cloudbank/proxy && uv run --locked uvicorn proxy.main:app --reload --host 127.0.0.1 --port 8765 --ws-max-size 1048576)
```

Key proxy controls:
- Vite Upstream Override & Server-Side Auth Injection: `cloudbank/web/vite.config.ts` proxies `/ws/agent` to `ws://127.0.0.1:8765` by default (`VITE_PROXY_TARGET` overrides Vite's server-side upstream URL) and injects `x-proxy-token` server-side whenever `PROXY_AUTH_TOKEN` is set so bearer secrets never enter browser JavaScript. `proxy/__main__.py` honors `PORT` only when `PROXY_PORT` is unset and `K_SERVICE` is non-empty, preserving `8765` in local shells.
- Server-Owned Personas & `(persona, iap_sub)` Session Binding: loads `cloudbank/shared/personas/{persona}.json` on the server, derives `first_name` from `snapshot.user.first_name`, records `(persona, iap_sub)` bindings only after upstream connection succeeds (logging `sub` only), enforces `PROXY_MAX_SESSIONS_PER_USER` (`2` default) in IAP mode, skips variable re-seeding only on verified active resumes for the same `persona` and `iap_sub`, mints a fresh server UUID (`is_resume=False`) when a `sessionId` is unrecognized, cross-user, or post-restart, and seeds `Relay._max_ui_seq` from `lastUiSeq`.
- Loopback Peer, ASGI Host, Direct IAP, Static CSP, Frame & Lifetime Guards: runs Uvicorn with `proxy_headers=False`, fails closed at startup if `PROXY_ALLOW_REMOTE=1` or non-loopback `PROXY_HOST` lacks `PROXY_AUTH_TOKEN` or a valid `PROXY_IAP_AUDIENCE` (requiring `PROXY_IAP_AUDIENCE` whenever `PROXY_STATIC_DIR` is combined with remote/non-loopback exposure, and enforcing both checks if both are configured), validates HTTP/WebSocket `Host` headers cleanly in `_ProxyTrustedHostMiddleware` (zero `*` wildcard support) before pure ASGI `_ProxyIapMiddleware` (`ES256` `x-goog-iap-jwt-assertion` verification, exempting only exact HTTP `/health`), enforces exact `Origin` (`PROXY_ALLOWED_ORIGINS`), disables `/docs`, `/redoc`, and `/openapi.json` with `redirect_slashes=False`, serves `/` and `/assets/*` (`GET`/`HEAD`) with a startup-validated HTTP Content Security Policy (`frame-ancestors 'none'`) when `PROXY_STATIC_DIR` is set, rejects binary frames (`1003`), caps PCM16 audio frames at `64 KB` (`87,384` base64 chars) and disconnects after `5` malformed frames (`1008`), caps concurrent sessions via `asyncio.Semaphore` (`PROXY_MAX_SESSIONS`), resets `PROXY_MAX_IDLE_SECONDS` (`900 s`) strictly on `ClientText`, non-empty speech transcripts, or `sessionOutput` events, and enforces `PROXY_MAX_SESSION_SECONDS` (`3600 s` default, `3300 s` in Cloud Run).
- IAP Session-Expiry Detection in `cloudbank/web`: after a pre-`ready` WebSocket close, the browser probes same-origin `/health` with `X-Requested-With: XMLHttpRequest` and `redirect: 'manual'`, halting automatic reconnects and prompting a page reload if Direct IAP responds with `401`, `403`, or an opaque redirect.
- Cloud Shell & GitHub Codespaces: keep **both** the proxy port (`8765`) and Vite's dev-server port (`5173`) set to **Private** (authenticated to your account), because Vite proxies `/ws/agent` to `127.0.0.1:8765` over loopback while forwarding the workspace `Origin` header (`WEB_HOST` or `CODESPACE_NAME`).

---

## 5. Deploying & Syncing Golden Evaluations (`cloudbank/push.sh` & `manage_app.py`)

Always deploy through `./cloudbank/push.sh` rather than calling `cxas push` or `cxas push-eval` directly. Provenance for retained lifecycle utilities in `cloudbank/scripts/` is documented in `cloudbank/scripts/VENDORED.md`.

```bash
# Deploy to prod target in gecx-config.json (prompts on TTY, or pass --yes in non-interactive shells)
(cd cloudbank && ./push.sh --yes)

# Deploy to a configured dev target (dev_app_id in gecx-config.json) or explicit app UUID
(cd cloudbank && ./push.sh dev)

# Deploy, sync goldens, and snapshot an immutable CXAS version
(cd cloudbank && ./push.sh --yes --create-version v-release-1)
```

What `./push.sh` enforces in chronological order:
1. Confirms `OVERWRITE` intent whenever the resolved target matches `prod` (`--yes` or interactive terminal prompt, whether invoked as `prod`, app display name, UUID, or full resource path).
2. Runs `scripts/sync_shared.py --check`, `uv run --locked cxas lint`, `scripts/audit_agent.py`, and `uv run --locked pytest -v` in sequence.
3. Runs `scripts/manage_app.py --config "${CONFIG_FILE}" push "${TARGET}"`, which imports `cxas_app/Cloudbank` with `conflict_strategy="OVERWRITE"`, fails closed on any `ImportAppResponse.warnings`, and calls `verify_expected_tools` so neither missing tools nor orphaned legacy tools remain on the server.
4. Runs `scripts/run_golden_evals.py --config "${CONFIG_FILE}" sync "${TARGET}"`, compiling multi-agent turns in execution order (`toolCall -> agentResponse -> agentTransfer`) to re-populate server-side evaluations cleared by `OVERWRITE`.
5. Optionally snapshots an immutable version via `scripts/manage_app.py --config "${CONFIG_FILE}" create-version`.

To inspect versions, manage channel deployments, or execute live platform NAIVE golden evaluations:

```bash
(cd cloudbank && uv run --locked python scripts/manage_app.py --config gecx-config.json list-versions prod)
(cd cloudbank && uv run --locked python scripts/manage_app.py --config gecx-config.json list-deployments prod)
(cd cloudbank && uv run --locked python scripts/run_golden_evals.py --config gecx-config.json run prod FAKE)
```

---

## 6. Deploying a Single-Origin Demo to Cloud Run Behind Direct IAP (`cloudbank/scripts/deploy_cloud_run.sh`)

To host a shared demo without a Global External Application Load Balancer, `cloudbank/Dockerfile` packages the compiled React SPA (`cloudbank/web/dist`) and `cloudbank/proxy` into a single non-root container (`PROXY_STATIC_DIR=/app/web/dist`, listening on Cloud Run's injected `PORT` when `K_SERVICE` is set) so HTML, `AudioWorklet` modules, WebSockets (`wss://<host>/ws/agent`), and Direct IAP cookies stay strictly same-origin. Both `cloudbank/.dockerignore` and `cloudbank/.gcloudignore` exclude `gecx-config.json`, `.env*`, `.venv`, and `node_modules` from build contexts and Cloud Build staging uploads.

### Required Google Cloud APIs & Runtime Service Account Permissions

`deploy_cloud_run.sh` deploys the Cloud Run service and targets the CXAS application (`CLOUDBANK_GCP_PROJECT_ID`) in the same Google Cloud project (`--project` or `gcp_project_id` in gitignored `cloudbank/gecx-config.json`). Before running `deploy_cloud_run.sh` in that project, enable these Google Cloud APIs:
1. Cloud Run Admin API (`run.googleapis.com`)
2. Cloud Build API (`cloudbuild.googleapis.com`)
3. Artifact Registry API (`artifactregistry.googleapis.com`)
4. Cloud Identity-Aware Proxy API (`iap.googleapis.com`)
5. Service Usage API (`serviceusage.googleapis.com`)
6. CX Agent Studio API (`ces.googleapis.com`)
7. Secret Manager API (`secretmanager.googleapis.com`, required only when passing `--iap-oauth-client-id` and `--iap-oauth-secret-name` for external users outside your Google Workspace organization)

Create a dedicated least-privilege runtime service account in that project (`deploy_cloud_run.sh` refuses default Compute Engine `-compute@developer.gserviceaccount.com` and App Engine `@appspot.gserviceaccount.com` service accounts). Because `cloudbank/proxy` sends `x-goog-user-project`, the runtime service account requires both `roles/serviceusage.serviceUsageConsumer` and the CX Agent Studio session role on `--project`: passing `--cxas-role` (for example `--cxas-role roles/ces.client`) binds both roles on `--project`, whereas omitting `--cxas-role` leaves project IAM untouched so you must grant both roles by hand (and if you later point `CLOUDBANK_GCP_PROJECT_ID` at a separate CXAS project manually, grant the CXAS session role in that project by hand as well).

### Running `deploy_cloud_run.sh`

```bash
# Deploy with organization-internal Direct IAP access (prompts on TTY unless --yes is passed)
./cloudbank/scripts/deploy_cloud_run.sh \
  --service-account cloudbank-proxy@<your-gcp-project-id>.iam.gserviceaccount.com \
  --iap-domains example.com \
  --iap-members user:alice@example.com,group:banking-demo@example.com \
  --yes

# Optional: apply a custom OAuth client from Secret Manager (pass a bare secret name; the script always reads version 'latest' in --project)
./cloudbank/scripts/deploy_cloud_run.sh \
  --service-account cloudbank-proxy@<your-gcp-project-id>.iam.gserviceaccount.com \
  --iap-members user:external-reviewer@example.com \
  --iap-oauth-client-id <oauth-client-id>.apps.googleusercontent.com \
  --iap-oauth-secret-name <secret-name> \
  --yes
```

What `deploy_cloud_run.sh` enforces:
- Validates non-placeholder project/app IDs, explicit `--service-account`, non-empty `--iap-members` / `--iap-domains` (refusing `allUsers` and `allAuthenticatedUsers`), and absence of `PROXY_AUTH_TOKEN`.
- Resolves the numeric project number to compute the exact IAP audience (`/projects/<PROJECT_NUMBER>/locations/<REGION>/services/<SERVICE_NAME>`) and deterministic `.run.app` hostname (`<service>-<project_number>.<region>.run.app`) up front, writing comma-safe YAML via `--env-vars-file` with bare `PROXY_ALLOWED_HOSTS`, `https://` `PROXY_ALLOWED_ORIGINS`, and `PROXY_MAX_SESSION_SECONDS=3300` (below `--timeout=3600`).
- Builds the image via Cloud Build into Artifact Registry and deploys Cloud Run with `--no-allow-unauthenticated`, `--iap`, `--session-affinity`, `--max-instances=1`, `--concurrency=80`, and `--timeout=3600` (keeping Cloud Run's default TCP startup probe so internal probe `Host` headers never collide with `_ProxyTrustedHostMiddleware`).
- Provisions the IAP Service Agent (`gcloud beta services identity create --service=iap.googleapis.com`), binds `roles/run.invoker` (`--condition=None`), reconciles any additional `.run.app` URLs from `run.googleapis.com/urls` via a second `gcloud run services update --env-vars-file` pass when needed, optionally applies custom IAP OAuth settings, and binds each `--iap-domains` / `--iap-members` principal with `roles/iap.httpsResourceAccessor` (`--resource-type=cloud-run --condition=None`).

> Verification Status: `cloudbank/Dockerfile` and `cloudbank/scripts/deploy_cloud_run.sh` have been verified offline only (via `cloudbank/tests/test_docs_and_pipeline_integrity.py` using a fake `gcloud` harness, offline multi-stage layout simulation, and Playwright E2E serving `web/dist` directly from `proxy.main:app` with `PROXY_STATIC_DIR=dist`). The container image has not yet been built with a container runtime, and `deploy_cloud_run.sh` has not yet been executed against a live Google Cloud project; all `gcloud` flags (`gcloud run deploy --iap`, `gcloud iap web add-iam-policy-binding --resource-type=cloud-run --condition=None`, `gcloud iap settings set --resource-type=cloud-run`, and `gcloud run services add-iam-policy-binding --condition=None`) were checked against Google Cloud SDK `593.0.0`.

---

## 7. GitHub Actions CI & Dependabot (`.github/`)

Every pull request and `main` push runs seven credential-free jobs in `.github/workflows/ci.yml` (`cancel-in-progress` scoped to non-`main` refs so `main` builds never cancel mid-run), with every third-party action pinned to a 40-character commit SHA and `persist-credentials: false`:

| CI Job | Working Directory | Checks Executed |
| :--- | :--- | :--- |
| `privacy-and-hygiene` | Repository root | Runs `make hygiene` (`gecx-config.json` untracked, placeholder check, PyPI/npmjs lockfile host allowlists, and zero internal leak patterns across `git ls-files`). |
| `agent` | `cloudbank` | `uv sync --locked`, `sync_shared.py --check`, `ruff check .`, `pyright`, `cxas lint` (`E001`-`E011`), `audit_agent.py`, `pytest -v`. |
| `proxy` | `cloudbank/proxy` | `uv sync --locked`, `ruff check .`, `pyright`, `pytest -v`. |
| `web` | `cloudbank/web` | `npm ci`, `npm test` (Vitest), `npm run typecheck`, `npm run lint` (`--max-warnings 0`), `npm run build`. |
| `e2e` | `cloudbank/{proxy,web}` | Installs proxy + web + Chromium, builds `vite`, and runs Playwright + `@axe-core/playwright` (`npm run test:e2e`). |
| `python-audit` | `cloudbank`, `cloudbank/proxy` | Exports locked requirements and runs locked `uv run --locked pip-audit` against PyPA / OSV advisories. |
| `web-audit` | `cloudbank/web` | Runs `npm audit --audit-level=high` in an isolated advisory job. |

`.github/dependabot.yml` monitors `/cloudbank/web` (`npm`), `/cloudbank` (`uv`), `/cloudbank/proxy` (`uv`), and `/` (`github-actions`) weekly.
