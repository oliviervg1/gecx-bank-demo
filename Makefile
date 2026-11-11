# Cloudbank developer workflow targets.
# Requires Python 3.11+, uv, and Node.js 22+.

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

.PHONY: help install lint test build e2e hygiene check

help: ## Show available workflow targets
	@awk 'BEGIN {FS = ":.*## "; printf "\nCloudbank Make Targets:\n\n"} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2} END {printf "\n"}' $(MAKEFILE_LIST)

install: ## Sync locked Python environments (cloudbank, proxy) and npm packages (web)
	cd cloudbank && uv sync --locked
	cd cloudbank/proxy && uv sync --locked
	cd cloudbank/web && npm ci

lint: ## Run CXAS lint, Composite v2 audit, sync_shared check, Ruff, Pyright, tsc, and ESLint
	cd cloudbank && uv run --locked cxas lint
	cd cloudbank && uv run --locked python scripts/audit_agent.py --workspace=cxas_app/Cloudbank --report
	cd cloudbank && uv run --locked python scripts/sync_shared.py --check
	cd cloudbank && uv run --locked ruff check .
	cd cloudbank && uv run --locked pyright
	cd cloudbank/proxy && uv run --locked ruff check .
	cd cloudbank/proxy && uv run --locked pyright
	cd cloudbank/web && npm run typecheck
	cd cloudbank/web && npm run lint

test: ## Run offline pytest suites (agent + proxy) and Vitest unit/parity tests (web)
	cd cloudbank && uv run --locked pytest -v
	cd cloudbank/proxy && uv run --locked pytest -v
	cd cloudbank/web && npm test

build: ## Build the production React web bundle
	cd cloudbank/web && npm run build

e2e: build ## Run Playwright + axe-core WCAG 2.1 AA end-to-end browser tests
	cd cloudbank/web && npm run test:e2e

define HYGIENE_PY
import hashlib, json, pathlib, re, subprocess, sys

cfg = json.loads(pathlib.Path("cloudbank/gecx-config.example.json").read_text(encoding="utf-8"))
assert cfg.get("gcp_project_id") == "<your-gcp-project-id>", (
    "gecx-config.example.json missing <your-gcp-project-id> placeholder"
)

allowed_py = ("https://pypi.org/simple", "https://files.pythonhosted.org/")
for lock in ("cloudbank/uv.lock", "cloudbank/proxy/uv.lock"):
    txt = pathlib.Path(lock).read_text(encoding="utf-8")
    vals = re.findall(r'\b(?:registry|url)\s*=\s*"([^"]+)"', txt)
    assert vals, f"{lock}: expected non-empty registry/url entries"
    bad = [v for v in vals if not v.startswith(allowed_py)]
    assert not bad, f"{lock}: disallowed package URLs: {bad[:5]}"

pkg_txt = pathlib.Path("cloudbank/web/package-lock.json").read_text(encoding="utf-8")
resolved = re.findall(r'"resolved"\s*:\s*"([^"]+)"', pkg_txt)
assert resolved, "package-lock.json: expected non-empty resolved entries"
bad_npm = [u for u in resolved if not u.startswith("https://registry.npmjs.org/") or "/-/@" in u]
assert not bad_npm, f"package-lock.json: disallowed resolved URLs: {bad_npm[:5]}"

digests = {
    "e17ff958e1a3487c",
    "c14d0c33b77c3007",
    "ff052a720d8ff5fa",
    "55351e18dee8f73f",
    "47a6705d7c6017c3",
    "fabeb8202bf28964",
    "8a55e63ef0788f76",
}
rxs = [
    re.compile(r"@[g]oogle\.com\b", re.I),
    re.compile(r"\b[g]ooglers\.com\b", re.I),
    re.compile(r"\b[c]orp\.google\b", re.I),
    re.compile(r"\b[c]loudshell\.dev\b", re.I),
    re.compile(r"\b(?:b|cl|yaqs|xid)/[0-9]{5,}\b"),
    re.compile(r"\b(?:sponge2?|fusion2)/[A-Za-z0-9_-]+\b"),
]

def sha16(val: str) -> str:
    return hashlib.sha256(val.lower().encode("utf-8")).hexdigest()[:16]

hits = []
for f in subprocess.check_output(["git", "ls-files"], text=True).splitlines():
    p = pathlib.Path(f)
    if not p.is_file():
        continue
    for idx, line in enumerate(p.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
        if any(rx.search(line) for rx in rxs):
            hits.append(f"{f}:{idx}: disallowed internal pattern")
        for m in re.finditer(r"[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*", line):
            tok = m.group(0)
            parts = tok.split("-")
            cands = {tok, *parts, *(f"{parts[i]}-{parts[i+1]}" for i in range(len(parts) - 1))}
            if any(sha16(c) in digests for c in cands):
                hits.append(f"{f}:{idx}: disallowed identifier")

if hits:
    print("\n".join(hits), file=sys.stderr)
    sys.exit(1)
print("Hygiene OK: lockfiles verified and zero internal patterns detected across tracked files.")
endef
export HYGIENE_PY

hygiene: ## Verify git config hygiene, public lockfile origins, and zero internal leaks
	@if git ls-files --error-unmatch cloudbank/gecx-config.json >/dev/null 2>&1; then \
		echo "error: cloudbank/gecx-config.json must not be tracked in Git" >&2; exit 1; \
	fi
	@git ls-files --error-unmatch cloudbank/gecx-config.example.json >/dev/null
	@python3 -c "$$HYGIENE_PY"

check: lint test build hygiene ## Run all local lint, test, build, and hygiene verification gates
