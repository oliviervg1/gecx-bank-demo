# Cloudbank Multi-Product GECX Rewrite Checklist

## Stage 1: Workspace Rules, Vendored Scripts & Frozen Shared Contracts
- [x] Rewrite `AGENTS.md` and `GEMINI.md`; add `.gitattributes`
- [x] Fix `.agents/skills/cxas-agent-foundry/scripts/setup.sh`, `pre-agent-push-lint.sh`, `pre-agent-push.sh`, `.claude/settings.json`, and `.gemini/settings.json`
- [x] Prune unused vendored skills and leftover `examples/` scaffolding
- [x] Vendor Apache-2.0 `audit_agent.py`, `run_golden_evals.py`, `manage_ces_app.py`, and `gecx_workspace.py` into `cloudbank/scripts/`
- [x] Author `cloudbank/shared/customer_snapshot.schema.json` and `cloudbank/web/src/data/fixture.ts`
- [x] Author month-anchored integer `*_pence` / `*_bps` fixtures `cloudbank/web/src/fixtures/{chloe,david,tom,sarah}.json`
- [x] Author cross-runtime `cloudbank/shared/parity_vectors.json` (4 personas + edge vectors)

## Stage 2: Multi-Product CXAS Bundle (`cloudbank/cxas_app/Cloudbank/`)
- [x] Update `cloudbank/gecx-config.json` (`locations/eu`, `gemini-composite-v2`) and `cloudbank/cxaslint.yaml` (`T012` active)
- [x] Author `app.json`, `global_instruction.txt`, and 3 active `respondImmediately` guardrails (`0808 157 0100` + `116 123`)
- [x] Author 4 agents (`root_agent`, `everyday_banking_agent`, `savings_agent`, `mortgage_agent`) + 3 identical callbacks per agent (`capture_utterance`, `agent_transfer`, `release_line`)
- [x] Author 4 Python controllers (`route_banking_intent`, `assist_everyday_banking` wrapping `tools.search_help`, `assist_savings`, `assist_mortgages`) + `search_help` `toolFakeConfig`
- [x] Delete legacy `spending_agent` and 6 `clientFunction` directories; pass `cxas lint` (`0/0`) and `audit_agent.py` (`0` P0/P1)

## Stage 3: Python Agent Test Suite, NAIVE Goldens & Simulations
- [x] Author `cloudbank/pyproject.toml` + `cloudbank/uv.lock` (PyPI index pinned, zero internal URLs)
- [x] Author `conftest.py` (`protobuf.Struct` round-trip), `test_bundle_integrity.py`, `test_controllers.py`, `test_controller_state_matrix.py`, `test_callback_chains.py`, and `test_parity_vectors.py`
- [x] Author multi-segment NAIVE goldens (`common_session_parameters` deep-equal to fixtures) and `SimulationEvals`; pass `cxas lint` (`E001`–`E011`) and `pytest`

## Stage 4: Bidi WebSocket Proxy Hardening (`cloudbank/proxy/`)
- [ ] Pin PyPI index in `cloudbank/proxy/pyproject.toml`, move tests to `cloudbank/proxy/tests/`, and remove legacy client-tool protocol types
- [ ] Enforce strict CSWSH origin validation, 5-key `CLIENT_SEEDABLE_VARIABLES` + `customer_snapshot.schema.json` validation, 10s silence keepalive + `PROXY_MAX_IDLE_SECONDS=900` (`ServerSessionExpired`), 3-tier `ui_state`, `ServerTurnDiagnostics`, and `ServerSearchSuggestions`
- [ ] Pass `uv run --locked --all-extras pytest` and `ruff check .`

## Stage 5: Audio Worklet, `sessionMachine.ts`, 5-Tab App & Split-Screen Workbench (`cloudbank/web/`)
- [ ] Author `demoClock.ts`, `savingsMath.ts`, `mortgageMath.ts`, updated `spendingSummary.ts` & `spendingViews.ts`, and `parityVectors.test.ts`
- [ ] Author cross-rate `16/44.1/48 kHz -> 16 kHz` `100ms` `audio-worklet.js`, post-release trailing silence (`<= 2.5s`), and 11-row `sessionMachine.ts`
- [ ] Build 5-tab Cloudbank app (`Home`, `Spending`, `SavingsPage.tsx`, `MortgagePage.tsx`, `ProfilePage.tsx`) + Flat Editorial Split-Screen Workbench (`WorkbenchLayout.tsx`, `GecxInspectorPane.tsx`)
- [ ] Pass `npm test`, `npm run typecheck`, `npm run lint` (`--max-warnings 0`), `npm run build`, and capture `1440x900` + `390x844` headless Chrome screenshots

## Stage 6: CI/CD, `push.sh` & Full Documentation Suite
- [ ] Update `.github/workflows/ci.yml` and `cloudbank/push.sh`
- [ ] Author `README.md`, `CHANGELOG.md`, `cloudbank/README.md`, `docs/README.md`, `docs/architecture/*`, `docs/tools/*` (exact `#L<start>-L<end>` anchors), and `docs/guides/*` (zero internal leaks, verified `200 OK` Cloud Docs URLs)
- [ ] Optional live `locations/eu` verification spike (requires explicit user approval before any GCP write)
