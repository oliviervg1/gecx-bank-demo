"""Documentation accuracy and Cloudbank deployment pipeline integrity tests."""

from __future__ import annotations

import fnmatch
import json
import os
import re
import subprocess
from pathlib import Path

import yaml

CLOUDBANK_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = CLOUDBANK_ROOT.parent
PERSONAS_DIR = CLOUDBANK_ROOT / "shared" / "personas"
DOCS_DIR = REPO_ROOT / "docs"

# External platform / CXAS lint / Web-API symbols legitimately named in docs.
ALLOWED_EXTERNAL_IDENTIFIERS = frozenset(
    {
        "AudioContext",
        "AudioWorklet",
        "BidiRunSession",
        "BigInt",
        "ClientText",
        "Draft7Validator",
        "E001",
        "E011",
        "EvaluationToolCallBehaviour",
        "HIGHER",
        "I012",
        "I014",
        "I015",
        "InputAudioConfig",
        "InvalidStatus",
        "KeyError",
        "NotAllowedError",
        "NotSupportedError",
        "RunSession",
        "S005",
        "S007",
        "ServerUiState",
        "SimulationEvals",
        "T004",
        "T008",
        "T012",
        "T014",
        "ToolFakeConfig",
        "TrustedHostMiddleware",
        "TurnComplete",
        "V001",
        "V101",
        "V102",
        "V103",
        "V104",
        "agentResponse",
        "agentTransfer",
        "ajv",
        "axe",
        "clientFunction",
        "gcloud",
        "snake_case",
        "toolCall",
    }
)

_EXCLUDED_CORPUS_DIRS = frozenset(
    {
        ".git",
        "node_modules",
        ".venv",
        "dist",
        "__pycache__",
        ".pytest_cache",
        "coverage",
        "playwright-report",
        "test-results",
    }
)
_LOCKFILE_NAMES = frozenset({"uv.lock", "package-lock.json"})


def _fmt_gbp_exact(pence: int) -> str:
    pounds, rem = divmod(pence, 100)
    return f"£{pounds:,}.{rem:02d}"


def _fmt_gbp_whole(pence: int) -> str:
    return f"£{pence // 100:,}"


def _fmt_bps(bps: int) -> str:
    whole, rem = divmod(bps, 100)
    return f"{whole}.{rem:02d}%"


def test_docs_persona_tables_match_fixtures_verbatim() -> None:
    """Every persona balance, pot name, AER, mortgage rate, and anomaly in docs matches personas/*.json."""
    flows_md = (DOCS_DIR / "architecture" / "banking_flows.md").read_text(encoding="utf-8")
    qa_md = (DOCS_DIR / "guides" / "qa_tester_guide.md").read_text(encoding="utf-8")
    beginners_md = (DOCS_DIR / "guides" / "gecx_for_beginners.md").read_text(encoding="utf-8")
    walkthrough_md = (DOCS_DIR / "architecture" / "end_to_end_walkthrough.md").read_text(
        encoding="utf-8"
    )

    for persona in ("chloe", "david", "tom", "sarah"):
        fx = json.loads((PERSONAS_DIR / f"{persona}.json").read_text(encoding="utf-8"))
        first_name = fx["user"]["first_name"]
        cur_str = _fmt_gbp_exact(fx["accounts"]["current"]["balance_pence"])
        sav = fx["accounts"]["savings"]
        goal_name = sav["goal_name"]
        aer_str = f"{_fmt_bps(sav['aer_bps'])} AER"
        sav_bal_whole = _fmt_gbp_whole(sav["balance_pence"])
        sav_bal_exact = _fmt_gbp_exact(sav["balance_pence"])
        sav_target_whole = _fmt_gbp_whole(sav["goal_target_pence"])
        sav_target_exact = _fmt_gbp_exact(sav["goal_target_pence"])
        sav_contrib_whole = f"{_fmt_gbp_whole(sav['monthly_contribution_pence'])}/mo"
        sav_contrib_exact = f"{_fmt_gbp_exact(sav['monthly_contribution_pence'])}/mo"

        anom = next(t for t in fx["transactions"] if t.get("is_anomaly"))
        anom_str = _fmt_gbp_exact(anom["amount_pence"])

        flows_row = next(
            line for line in flows_md.splitlines() if line.startswith(f"| **{first_name}**")
        )
        qa_row = next(
            line for line in qa_md.splitlines() if line.startswith(f"| **{first_name}")
        )

        for expected_tok in (
            cur_str,
            goal_name,
            sav_bal_whole,
            sav_target_whole,
            aer_str,
            sav_contrib_whole,
            anom["vendor"],
            anom_str,
        ):
            assert expected_tok in flows_row, (
                f"banking_flows.md row for {first_name} missing {expected_tok!r}: {flows_row}"
            )

        for expected_tok in (
            cur_str,
            goal_name,
            sav_bal_exact,
            sav_target_exact,
            aer_str,
            sav_contrib_exact,
            anom["vendor"],
            anom_str,
        ):
            assert expected_tok in qa_row, (
                f"qa_tester_guide.md row for {first_name} missing {expected_tok!r}: {qa_row}"
            )

        mtg = fx["accounts"].get("mortgage")
        if mtg is not None:
            mtg_bal_whole = _fmt_gbp_whole(mtg["balance_pence"])
            mtg_bal_exact = _fmt_gbp_exact(mtg["balance_pence"])
            mtg_rate = _fmt_bps(mtg["interest_rate_bps"])
            rem_allow_whole = _fmt_gbp_whole(
                mtg["annual_overpayment_allowance_pence"] - mtg["overpaid_this_year_pence"]
            )
            rem_allow_exact = _fmt_gbp_exact(
                mtg["annual_overpayment_allowance_pence"] - mtg["overpaid_this_year_pence"]
            )
            assert mtg_bal_whole in flows_row and mtg_rate in flows_row and rem_allow_whole in flows_row
            assert mtg_bal_exact in qa_row and mtg_rate in qa_row and rem_allow_exact in qa_row

    sarah_fx = json.loads((PERSONAS_DIR / "sarah.json").read_text(encoding="utf-8"))
    sarah_rate = _fmt_bps(sarah_fx["accounts"]["mortgage"]["interest_rate_bps"])
    assert f"`{sarah_rate}` (`90` months remaining)" in walkthrough_md
    assert f"at `{sarah_rate}`" in beginners_md

    tom_fx = json.loads((PERSONAS_DIR / "tom.json").read_text(encoding="utf-8"))
    tom_aer = f"{_fmt_bps(tom_fx['accounts']['savings']['aer_bps'])} AER"
    assert tom_aer in walkthrough_md
    assert tom_aer in beginners_md
    assert '`{page: "mortgage", subview: "overview"}`' in walkthrough_md


def test_docs_backticked_identifiers_and_links_exist_in_non_test_codebase() -> None:
    """Verify backticked identifiers and links resolve against production code (excluding tests and lockfiles)."""
    agent_tests_dir = CLOUDBANK_ROOT / "tests"
    proxy_tests_dir = CLOUDBANK_ROOT / "proxy" / "tests"
    web_tests_dir = CLOUDBANK_ROOT / "web" / "src" / "__tests__"
    web_e2e_dir = CLOUDBANK_ROOT / "web" / "e2e"

    code_chunks: list[str] = []
    for path in REPO_ROOT.rglob("*"):
        if not path.is_file():
            continue
        if path.name in _LOCKFILE_NAMES:
            continue
        if any(part in path.parts for part in _EXCLUDED_CORPUS_DIRS):
            continue
        if (
            path.is_relative_to(agent_tests_dir)
            or path.is_relative_to(proxy_tests_dir)
            or path.is_relative_to(web_tests_dir)
            or path.is_relative_to(web_e2e_dir)
            or path.is_relative_to(DOCS_DIR)
            or path.suffix == ".md"
        ):
            continue
        if path.suffix in (
            ".py",
            ".ts",
            ".tsx",
            ".js",
            ".json",
            ".yaml",
            ".yml",
            ".sh",
            ".txt",
            ".css",
            ".html",
            ".toml",
        ) or path.name in ("Makefile", "Dockerfile"):
            code_chunks.append(path.read_text(encoding="utf-8", errors="ignore"))
    code_corpus = "\n".join(code_chunks)

    md_files = [
        REPO_ROOT / "README.md",
        CLOUDBANK_ROOT / "README.md",
        CLOUDBANK_ROOT / "proxy" / "README.md",
        *sorted(DOCS_DIR.rglob("*.md")),
    ]

    ident_re = re.compile(r"`([A-Za-z_][A-Za-z0-9_]{2,})(?:\(\))?`")
    link_re = re.compile(r"\[[^\]]+\]\(([^)]+)\)")

    unknown_identifiers: list[tuple[str, str]] = []
    for md in md_files:
        text = md.read_text(encoding="utf-8")
        for match in ident_re.finditer(text):
            ident = match.group(1)
            if ident in ALLOWED_EXTERNAL_IDENTIFIERS:
                continue
            if ident not in code_corpus:
                unknown_identifiers.append((str(md.relative_to(REPO_ROOT)), ident))

        for match in link_re.finditer(text):
            raw = match.group(1).strip()
            if raw.startswith(("http://", "https://", "#")):
                continue
            path_part, _, anchor = raw.partition("#")
            target = (md.parent / path_part).resolve()
            assert target.exists(), f"Broken relative link {raw!r} in {md}"
            if anchor:
                m = re.fullmatch(r"L(\d+)(?:-L(\d+))?", anchor)
                if m is not None:
                    start, end = int(m.group(1)), int(m.group(2) or m.group(1))
                    lines = target.read_text(encoding="utf-8").splitlines()
                    assert 1 <= start <= end <= len(lines), (
                        f"Out-of-range anchor {raw!r} (file has {len(lines)} lines) in {md}"
                    )

    assert not unknown_identifiers, (
        f"Docs reference identifiers absent from non-test codebase: {unknown_identifiers}"
    )

    qa_text = (DOCS_DIR / "guides" / "qa_tester_guide.md").read_text(encoding="utf-8")
    for line in qa_text.splitlines():
        if "**Expected reply:**" in line:
            assert ".00" not in line, (
                f"QA Expected reply quotes '.00' instead of whole pounds: {line}"
            )
    for internal_tok in (
        "root_agent",
        "everyday_banking_agent",
        "savings_agent",
        "mortgage_agent",
        "route_banking_intent",
        "assist_everyday_banking",
        "assist_savings",
        "assist_mortgages",
        "search_help",
        "capture_utterance",
        "agent_transfer",
        "release_line",
        "ui_view_state",
        "customer_snapshot",
        "handoff_context",
        "target_agent",
        "BidiRunSession",
        "gemini-composite-v2",
    ):
        assert internal_tok not in qa_text, (
            f"Internal token {internal_tok!r} leaked in QA guide"
        )


def test_push_sh_pipeline_order_and_no_push_eval() -> None:
    """Verify ordered verification/deploy steps in cloudbank/push.sh and ban cxas push / push-eval."""
    push_sh = CLOUDBANK_ROOT / "push.sh"
    syntax = subprocess.run(
        ["bash", "-n", str(push_sh)], capture_output=True, text=True
    )
    assert syntax.returncode == 0, syntax.stderr

    active_lines = [
        line.strip()
        for line in push_sh.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    active_script = "\n".join(active_lines)

    assert "set -euo pipefail" in active_lines
    assert "CLOUDBANK_GCP_PROJECT_ID" in active_script
    assert "CLOUDBANK_LOCATION" in active_script
    assert "CLOUDBANK_APP_ID" in active_script
    assert "gecx-config.example.json" in active_script
    assert "push-eval" not in active_script
    assert "manage_ces_app.py" not in active_script
    assert not re.search(r"\bcxas\s+push\b", active_script)

    required_steps = [
        "uv run --locked python scripts/sync_shared.py --check",
        "uv run --locked cxas lint",
        "uv run --locked python scripts/audit_agent.py --workspace=cxas_app/Cloudbank --report",
        "uv run --locked pytest -v",
        'uv run --locked python scripts/manage_app.py --config "${CONFIG_FILE}" push',
        'uv run --locked python scripts/run_golden_evals.py --config "${CONFIG_FILE}" sync',
        'uv run --locked python scripts/manage_app.py --config "${CONFIG_FILE}" create-version',
    ]
    positions = []
    for step in required_steps:
        pos = active_script.find(step)
        assert pos != -1, f"Missing required step in cloudbank/push.sh: {step!r}"
        positions.append(pos)
    assert positions == sorted(positions), (
        f"Steps in cloudbank/push.sh are out of chronological order: {positions}"
    )


def test_push_sh_prod_confirmation_env_overrides_and_target_parsing(
    tmp_path: Path,
) -> None:
    """Verify push.sh enforces --yes on prod, supports CLOUDBANK_* env vars, and parses targets."""
    work = tmp_path / "cb"
    work.mkdir()
    (work / "push.sh").write_text(
        (CLOUDBANK_ROOT / "push.sh").read_text(encoding="utf-8"), encoding="utf-8"
    )
    (work / "gecx-config.example.json").write_text(
        (CLOUDBANK_ROOT / "gecx-config.example.json").read_text(encoding="utf-8"),
        encoding="utf-8",
    )

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    uv_log = tmp_path / "uv_calls.log"
    fake_uv = bin_dir / "uv"
    fake_uv.write_text(
        f'#!/usr/bin/env bash\necho "$*" >> {uv_log}\n',
        encoding="utf-8",
    )
    fake_uv.chmod(0o755)
    base_env = {**os.environ, "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}"}

    # 1. Placeholder config without CLOUDBANK_* env overrides refuses to run
    r_placeholder = subprocess.run(
        ["bash", str(work / "push.sh"), "--yes"],
        env=base_env,
        input="",
        capture_output=True,
        text=True,
    )
    assert r_placeholder.returncode != 0
    assert "set real gcp_project_id" in r_placeholder.stderr

    env = {
        **base_env,
        "CLOUDBANK_GCP_PROJECT_ID": "test-bank-proj",
        "CLOUDBANK_LOCATION": "eu",
        "CLOUDBANK_APP_ID": "11111111-2222-3333-4444-555555555555",
    }

    # 2. Non-interactive prod OVERWRITE without --yes refuses to run
    uv_log.write_text("", encoding="utf-8")
    r_no_yes = subprocess.run(
        ["bash", str(work / "push.sh")],
        env=env,
        input="",
        capture_output=True,
        text=True,
    )
    assert r_no_yes.returncode != 0
    assert "requires --yes" in r_no_yes.stderr
    assert uv_log.read_text(encoding="utf-8") == ""

    # 3. Prod OVERWRITE with --yes succeeds using gecx-config.example.json + env overrides
    r_prod_yes = subprocess.run(
        ["bash", str(work / "push.sh"), "--yes"],
        env=env,
        input="",
        capture_output=True,
        text=True,
    )
    assert r_prod_yes.returncode == 0, r_prod_yes.stderr
    calls_prod = uv_log.read_text(encoding="utf-8").splitlines()
    assert any("scripts/sync_shared.py --check" in c for c in calls_prod)
    assert any(
        "scripts/manage_app.py --config gecx-config.example.json push prod" in c
        for c in calls_prod
    )
    assert any(
        "scripts/run_golden_evals.py --config gecx-config.example.json sync prod" in c
        for c in calls_prod
    )

    # 4. ./push.sh dev --create-version v1 -> target='dev', version='v1' (no --yes needed for dev)
    uv_log.write_text("", encoding="utf-8")
    r_dev = subprocess.run(
        ["bash", str(work / "push.sh"), "dev", "--create-version", "v1"],
        env=env,
        input="",
        capture_output=True,
        text=True,
    )
    assert r_dev.returncode == 0, r_dev.stderr
    calls_dev = uv_log.read_text(encoding="utf-8").splitlines()
    assert any(
        "scripts/manage_app.py --config gecx-config.example.json push dev" in c
        for c in calls_dev
    )
    assert any(
        "scripts/manage_app.py --config gecx-config.example.json create-version v1  dev" in c
        for c in calls_dev
    )

    # 5. ./push.sh --create-version dev -> target='dev', auto-timestamped version (never version='dev')
    uv_log.write_text("", encoding="utf-8")
    r_dev_auto = subprocess.run(
        ["bash", str(work / "push.sh"), "--create-version", "dev"],
        env=env,
        input="",
        capture_output=True,
        text=True,
    )
    assert r_dev_auto.returncode == 0, r_dev_auto.stderr
    calls_auto = uv_log.read_text(encoding="utf-8").splitlines()
    assert any(
        "scripts/manage_app.py --config gecx-config.example.json push dev" in c
        for c in calls_auto
    )
    assert any("create-version v-" in c and c.endswith(" dev") for c in calls_auto)


def test_documented_proxy_ports_match_vite_and_proxy_defaults() -> None:
    """Verify onboarding docs match proxy DEFAULT_PORT and vite.config.ts (8765, never 8080)."""
    proxy_main = (CLOUDBANK_ROOT / "proxy" / "src" / "proxy" / "__main__.py").read_text(
        encoding="utf-8"
    )
    port_match = re.search(r"^DEFAULT_PORT\s*=\s*(\d+)\b", proxy_main, re.MULTILINE)
    assert port_match is not None, "DEFAULT_PORT missing in proxy/__main__.py"
    default_port = port_match.group(1)
    assert default_port == "8765"

    vite_cfg = (CLOUDBANK_ROOT / "web" / "vite.config.ts").read_text(encoding="utf-8")
    assert f"ws://127.0.0.1:{default_port}" in vite_cfg
    assert "VITE_PROXY_TARGET" in vite_cfg

    doc_paths = (
        REPO_ROOT / "README.md",
        CLOUDBANK_ROOT / "proxy" / "README.md",
        DOCS_DIR / "guides" / "developer_workflow_and_cicd_guide.md",
    )
    for doc_path in doc_paths:
        text = doc_path.read_text(encoding="utf-8")
        rel = doc_path.relative_to(REPO_ROOT)
        assert f"--port {default_port}" in text, f"{rel} missing '--port {default_port}'"
        assert f"127.0.0.1:{default_port}" in text, f"{rel} missing '127.0.0.1:{default_port}'"
        assert "--port 8080" not in text, f"{rel} must not instruct '--port 8080'"
        assert ":8080" not in text, f"{rel} must not reference stale port 8080"
        assert "VITE_PROXY_URL" not in text, (
            f"{rel} must not recommend bypassing Vite's loopback proxy via VITE_PROXY_URL"
        )


def _glob_no_slash(text: str, pattern: str) -> bool:
    """Match a glob pattern where `*` and `?` do NOT cross `/` separators (Docker/Go semantics)."""
    regex_parts = [r"\A"]
    for ch in pattern:
        if ch == "*":
            regex_parts.append("[^/]*")
        elif ch == "?":
            regex_parts.append("[^/]")
        else:
            regex_parts.append(re.escape(ch))
    regex_parts.append(r"\Z")
    return re.match("".join(regex_parts), text) is not None


def _matches_ignore_rules(
    rel_posix_path: str,
    ignore_lines: list[str],
    *,
    docker_semantics: bool,
) -> bool:
    """Evaluate `.dockerignore` (root-anchored slash-less globs) or `.gcloudignore` (gitignore) rules."""
    path = rel_posix_path.strip("/")
    segments = path.split("/")
    for raw in ignore_lines:
        rule = raw.strip()
        if not rule or rule.startswith("#") or rule.startswith("!"):
            continue
        rooted = rule.startswith("/")
        dir_only = rule.endswith("/")
        pat = rule.strip("/")
        if pat.startswith("**/"):
            sub_pat = pat[3:]
            for idx in range(len(segments)):
                tail = "/".join(segments[idx:])
                if _glob_no_slash(tail, sub_pat) or tail.startswith(f"{sub_pat}/"):
                    return True
                if not dir_only and _glob_no_slash(segments[idx], sub_pat):
                    return True
            continue
        if docker_semantics or rooted or "/" in pat:
            if dir_only:
                if path == pat or path.startswith(f"{pat}/"):
                    return True
            elif _glob_no_slash(path, pat) or path.startswith(f"{pat}/"):
                return True
        else:
            for idx, seg in enumerate(segments):
                is_last = idx == len(segments) - 1
                if dir_only and (not is_last or rel_posix_path.endswith("/")):
                    if fnmatch.fnmatchcase(seg, pat):
                        return True
                elif not dir_only and fnmatch.fnmatchcase(seg, pat):
                    return True
    return False


def test_dockerfile_and_ignore_files_preserve_layout_and_exclude_secrets() -> None:
    """Verify Dockerfile runtime invariants and both .dockerignore and .gcloudignore hygiene."""
    # Sanity-check that docker_semantics=True matches slash-less globs ONLY at context root
    assert _matches_ignore_rules("private.pem", ["*.pem"], docker_semantics=True) is True
    assert _matches_ignore_rules("proxy/src/private.pem", ["*.pem"], docker_semantics=True) is False
    assert (
        _matches_ignore_rules("proxy/src/private.pem", ["**/*.pem"], docker_semantics=True)
        is True
    )

    dockerfile = (CLOUDBANK_ROOT / "Dockerfile").read_text(encoding="utf-8")
    active_docker = "\n".join(
        line.strip()
        for line in dockerfile.splitlines()
        if line.strip() and not line.strip().startswith("#")
    )

    assert "FROM node:22-slim AS web-builder" in active_docker
    assert "FROM python:3.12-slim AS runtime" in active_docker
    assert "unset VITE_PROXY_URL && npm run build" in active_docker
    assert not re.search(r"ENV\s+VITE_PROXY_URL=", active_docker)
    assert "uv sync --locked --no-dev" in active_docker
    assert "--no-editable" not in active_docker
    assert "/app/shared" in active_docker
    assert "/app/proxy/src" in active_docker
    assert "/app/proxy/.venv" in active_docker
    assert "/app/web/dist" in active_docker
    assert "PROXY_MAX_SESSION_SECONDS=3300" in active_docker
    assert "USER cloudbank:cloudbank" in active_docker
    assert 'CMD ["/app/proxy/.venv/bin/python", "-m", "proxy"]' in active_docker
    assert "uv run" not in active_docker

    for ignore_name, is_docker in ((".dockerignore", True), (".gcloudignore", False)):
        ignore_path = CLOUDBANK_ROOT / ignore_name
        assert ignore_path.is_file(), f"Missing {ignore_name} in cloudbank/"
        rules = ignore_path.read_text(encoding="utf-8").splitlines()

        for must_exclude in (
            "gecx-config.json",
            "nested/gecx-config.json",
            ".env",
            ".env.local",
            ".env.production",
            "proxy/.env",
            "service-account-key.json",
            "shared/service-account-x.json",
            "application_default_credentials.json",
            "web/src/credentials-dev.json",
            "gha-creds-prod.json",
            "proxy/gha-creds-prod.json",
            "private.pem",
            "proxy/src/private.pem",
            "proxy/tls.key",
            "shared/cert.p12",
            "shared/cert.pfx",
            "shared/keystore.jks",
            "proxy/id_rsa",
            "proxy/deploy_rsa",
            "secrets/oauth.json",
            "proxy/secrets/oauth.json",
            "app.log",
            "proxy/app.log",
            "web/npm-debug.log",
            ".venv/",
            "proxy/.venv/",
            "node_modules/",
            "web/node_modules/",
            "web/dist/",
            "cxas_app/",
            "evals/",
            "tests/",
            "proxy/tests/",
        ):
            assert _matches_ignore_rules(
                must_exclude, rules, docker_semantics=is_docker
            ), (
                f"{ignore_name} failed to exclude sensitive or build-cache path {must_exclude!r}"
            )

        for must_keep in (
            "Dockerfile",
            "gecx-config.example.json",
            "proxy/pyproject.toml",
            "proxy/uv.lock",
            "proxy/src/proxy/main.py",
            "proxy/src/proxy/iap.py",
            "shared/personas/chloe.json",
            "shared/customer_snapshot.schema.json",
            "web/package.json",
            "web/package-lock.json",
            "web/index.html",
            "web/vite.config.ts",
        ):
            assert not _matches_ignore_rules(
                must_keep, rules, docker_semantics=is_docker
            ), (
                f"{ignore_name} unexpectedly excluded required build input {must_keep!r}"
            )


def test_deploy_cloud_run_sh_static_hygiene_and_gcloud_conventions() -> None:
    """Verify deploy_cloud_run.sh syntax, executable bit, --quiet/--limit discipline, and zero leaks."""
    script_path = CLOUDBANK_ROOT / "scripts" / "deploy_cloud_run.sh"
    assert script_path.is_file()
    assert os.access(script_path, os.X_OK), "deploy_cloud_run.sh must be executable"

    syntax = subprocess.run(
        ["bash", "-n", str(script_path)], capture_output=True, text=True
    )
    assert syntax.returncode == 0, syntax.stderr

    raw_text = script_path.read_text(encoding="utf-8")
    active_lines = [
        line.strip()
        for line in raw_text.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    active_script = "\n".join(active_lines)

    assert "set -euo pipefail" in active_lines
    assert "export CLOUDSDK_CORE_INTERACTIVE_UX_STYLE=OFF" in active_lines
    assert "--no-allow-unauthenticated" in active_script
    assert not re.search(r"(?<![A-Za-z0-9_-])--allow-unauthenticated(?![)|])", active_script)
    assert "--use-http2" not in active_script
    assert "--set-env-vars" not in active_script
    assert "--env-vars-file=" in active_script
    assert "--iap" in active_script
    assert "--session-affinity" in active_script
    assert "--max-instances=" in active_script
    assert "--concurrency=" in active_script
    assert "--timeout=3600" in active_script

    # Join line continuations and check every gcloud command for --quiet (and --limit on list)
    logical_cmds: list[str] = []
    buf = ""
    for line in raw_text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.endswith("\\"):
            buf += stripped[:-1] + " "
        else:
            logical_cmds.append(buf + stripped)
            buf = ""
    if buf:
        logical_cmds.append(buf)

    gcloud_invocations = [
        cmd
        for cmd in logical_cmds
        if re.search(r"(?:^|[=(\s])gcloud\s+(?!CLI\b)", cmd)
        and not cmd.startswith(("echo ", "if ! command -v gcloud"))
    ]
    assert len(gcloud_invocations) >= 6
    for inv in gcloud_invocations:
        assert "--quiet" in inv, f"gcloud command missing --quiet: {inv}"
        if re.search(r"\bgcloud\b.*\blist\b", inv):
            assert "--limit" in inv, f"gcloud list command missing --limit: {inv}"


def test_deploy_cloud_run_sh_guards_confirmation_env_yaml_and_two_step_url_lock(
    tmp_path: Path,
) -> None:
    """Verify deploy_cloud_run.sh fail-closed guards, --yes prompt, YAML env file, and URL sync."""
    cb_dir = tmp_path / "cloudbank"
    (cb_dir / "scripts").mkdir(parents=True)
    script_copy = cb_dir / "scripts" / "deploy_cloud_run.sh"
    script_copy.write_text(
        (CLOUDBANK_ROOT / "scripts" / "deploy_cloud_run.sh").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    script_copy.chmod(0o755)
    (cb_dir / "Dockerfile").write_text("FROM scratch\n", encoding="utf-8")
    (cb_dir / ".gcloudignore").write_text("gecx-config.json\n", encoding="utf-8")
    (cb_dir / "gecx-config.example.json").write_text(
        (CLOUDBANK_ROOT / "gecx-config.example.json").read_text(encoding="utf-8"),
        encoding="utf-8",
    )

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    gcloud_log = tmp_path / "gcloud_calls.jsonl"
    captured_env_dir = tmp_path / "captured_env"
    captured_env_dir.mkdir()
    captured_iap_settings = tmp_path / "iap_settings.json"

    deployed_marker = tmp_path / "service_deployed.flag"
    fake_gcloud = bin_dir / "gcloud"
    fake_gcloud.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, pathlib, shutil, sys\n"
        "args = sys.argv[1:]\n"
        f"log_path = pathlib.Path({str(gcloud_log)!r})\n"
        f"env_dir = pathlib.Path({str(captured_env_dir)!r})\n"
        f"iap_out = pathlib.Path({str(captured_iap_settings)!r})\n"
        f"marker = pathlib.Path({str(deployed_marker)!r})\n"
        "with log_path.open('a', encoding='utf-8') as fh:\n"
        "    fh.write(json.dumps({'args': args, 'ux': os.environ.get('CLOUDSDK_CORE_INTERACTIVE_UX_STYLE')}) + '\\n')\n"
        "for a in args:\n"
        "    if a.startswith('--env-vars-file='):\n"
        "        idx = len(list(env_dir.iterdir()))\n"
        "        shutil.copyfile(a.split('=', 1)[1], env_dir / f'env_{idx}.yaml')\n"
        "if args[:2] == ['projects', 'describe']:\n"
        "    print('123456789012')\n"
        "elif args[:3] == ['artifacts', 'repositories', 'describe']:\n"
        "    sys.exit(1)\n"
        "elif args[:2] == ['run', 'deploy']:\n"
        "    marker.write_text('1', encoding='utf-8')\n"
        "elif args[:3] == ['run', 'services', 'describe']:\n"
        "    if not marker.exists():\n"
        "        sys.exit(1)\n"
        "    urls = json.loads(os.environ.get('FAKE_CLOUD_RUN_URLS', '[]'))\n"
        "    print(json.dumps({\n"
        "        'status': {'url': urls[0] if urls else 'https://cloudbank-123456789012.europe-west1.run.app'},\n"
        "        'metadata': {'annotations': {'run.googleapis.com/urls': json.dumps(urls)}},\n"
        "    }))\n"
        "elif args[:3] == ['secrets', 'versions', 'access']:\n"
        "    print('super-secret-oauth-val', end='')\n"
        "elif args[:3] == ['iap', 'settings', 'set']:\n"
        "    shutil.copyfile(args[3], iap_out)\n",
        encoding="utf-8",
    )
    fake_gcloud.chmod(0o755)

    clean_env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith(("CLOUDBANK_", "PROXY_", "IAP_", "SA_EMAIL"))
    }
    clean_env["PATH"] = f"{bin_dir}:{clean_env.get('PATH', '')}"

    valid_sa = "cloudbank-proxy@test-bank-proj.iam.gserviceaccount.com"
    valid_env = {
        **clean_env,
        "CLOUDBANK_GCP_PROJECT_ID": "test-bank-proj",
        "CLOUDBANK_LOCATION": "eu",
        "CLOUDBANK_APP_ID": "11111111-2222-4333-8444-555555555555",
    }

    def run_deploy(
        extra_args: list[str],
        *,
        env_overrides: dict[str, str] | None = None,
        stdin_text: str = "",
    ) -> subprocess.CompletedProcess[str]:
        merged = {**valid_env, **(env_overrides or {})}
        return subprocess.run(
            ["bash", str(script_copy), *extra_args],
            env=merged,
            input=stdin_text,
            capture_output=True,
            text=True,
        )

    # 1. Placeholder config without CLOUDBANK_* overrides refuses before any gcloud call
    r_placeholder = subprocess.run(
        [
            "bash",
            str(script_copy),
            "--service-account",
            valid_sa,
            "--iap-domains",
            "example.com",
            "--yes",
        ],
        env=clean_env,
        input="",
        capture_output=True,
        text=True,
    )
    assert r_placeholder.returncode != 0
    assert "set real gcp_project_id" in r_placeholder.stderr

    # 2. Refuses missing SA, default compute SA, PROXY_AUTH_TOKEN, missing IAP members, allUsers, allAuthenticatedUsers, and >=3600s session timeout
    refusal_cases: list[tuple[list[str], dict[str, str], str]] = [
        (["--iap-domains", "example.com", "--yes"], {}, "--service-account"),
        (
            [
                "--service-account",
                "123456789012-compute@developer.gserviceaccount.com",
                "--iap-domains",
                "example.com",
                "--yes",
            ],
            {},
            "default Compute Engine or App Engine service account",
        ),
        (
            [
                "--service-account",
                "test-bank-proj@appspot.gserviceaccount.com",
                "--iap-domains",
                "example.com",
                "--yes",
            ],
            {},
            "default Compute Engine or App Engine service account",
        ),
        (
            ["--service-account", valid_sa, "--iap-domains", "example.com", "--yes"],
            {"PROXY_AUTH_TOKEN": "forbidden-token"},
            "PROXY_AUTH_TOKEN",
        ),
        (["--service-account", valid_sa, "--yes"], {}, "at least one IAP principal"),
        (
            [
                "--service-account",
                valid_sa,
                "--iap-members",
                "allUsers",
                "--yes",
            ],
            {},
            "allUsers",
        ),
        (
            [
                "--service-account",
                valid_sa,
                "--iap-members",
                "user:alice@example.com,AllAuthenticatedUsers",
                "--yes",
            ],
            {},
            "allUsers and allAuthenticatedUsers are refused",
        ),
        (
            [
                "--service-account",
                valid_sa,
                "--iap-domains",
                "example.com",
                "--allow-unauthenticated",
                "--yes",
            ],
            {},
            "forbidden",
        ),
        (
            [
                "--service-account",
                valid_sa,
                "--iap-domains",
                "example.com",
                "--max-session-seconds",
                "3600",
                "--yes",
            ],
            {},
            "strictly below Cloud Run --timeout=3600",
        ),
        (
            ["--service-account", valid_sa, "--iap-domains", "example.com"],
            {},
            "requires --yes",
        ),
    ]
    for args_case, env_case, expected_err in refusal_cases:
        res = run_deploy(args_case, env_overrides=env_case)
        assert res.returncode != 0, f"Expected failure for {args_case}: {res.stdout}"
        assert expected_err in res.stderr
    assert not gcloud_log.exists(), "Refused invocations must not execute gcloud"

    # 3. Happy path WITH legacy hash URL in run.googleapis.com/urls -> runs two-step URL sync!
    dual_urls = [
        "https://cloudbank-123456789012.europe-west1.run.app",
        "https://cloudbank-legacy99-ew.a.run.app",
    ]
    r_ok = run_deploy(
        [
            "--service-account",
            valid_sa,
            "--cxas-role",
            "projects/test-bank-proj/roles/cxasSessionRunner",
            "--iap-domains",
            "example.com",
            "--iap-members",
            "user:alice@example.com",
            "--extra-hosts",
            "https://concierge.example.com/",
            "--iap-oauth-client-id",
            "12345-client.apps.example.com",
            "--iap-oauth-secret-name",
            "cloudbank-iap-oauth-secret",
            "--yes",
        ],
        env_overrides={"FAKE_CLOUD_RUN_URLS": json.dumps(dual_urls)},
    )
    assert r_ok.returncode == 0, r_ok.stderr
    assert "super-secret-oauth-val" not in r_ok.stdout
    assert "super-secret-oauth-val" not in r_ok.stderr

    calls = [
        json.loads(line)
        for line in gcloud_log.read_text(encoding="utf-8").splitlines()
    ]
    assert all(c["ux"] == "OFF" for c in calls)
    assert all("--quiet" in c["args"] for c in calls)

    env_files = sorted(captured_env_dir.glob("env_*.yaml"))
    assert len(env_files) == 2
    initial_env = yaml.safe_load(env_files[0].read_text(encoding="utf-8"))
    synced_env = yaml.safe_load(env_files[1].read_text(encoding="utf-8"))

    assert initial_env == {
        "CLOUDBANK_GCP_PROJECT_ID": "test-bank-proj",
        "CLOUDBANK_LOCATION": "eu",
        "CLOUDBANK_APP_ID": "11111111-2222-4333-8444-555555555555",
        "PROXY_HOST": "0.0.0.0",
        "PROXY_ALLOW_REMOTE": "1",
        "PROXY_STATIC_DIR": "/app/web/dist",
        "PROXY_MAX_SESSIONS": "4",
        "PROXY_MAX_SESSIONS_PER_USER": "2",
        "PROXY_MAX_SESSION_SECONDS": "3300",
        "PROXY_IAP_AUDIENCE": "/projects/123456789012/locations/europe-west1/services/cloudbank",
        "PROXY_ALLOWED_HOSTS": "cloudbank-123456789012.europe-west1.run.app,concierge.example.com",
        "PROXY_ALLOWED_ORIGINS": (
            "https://cloudbank-123456789012.europe-west1.run.app,"
            "https://concierge.example.com"
        ),
    }
    assert "PROXY_AUTH_TOKEN" not in initial_env
    assert "PROXY_AUTH_TOKEN" not in synced_env
    assert synced_env["PROXY_ALLOWED_HOSTS"] == (
        "cloudbank-123456789012.europe-west1.run.app,"
        "cloudbank-legacy99-ew.a.run.app,"
        "concierge.example.com"
    )
    assert synced_env["PROXY_ALLOWED_ORIGINS"] == (
        "https://cloudbank-123456789012.europe-west1.run.app,"
        "https://cloudbank-legacy99-ew.a.run.app,"
        "https://concierge.example.com"
    )

    deploy_call = next(c["args"] for c in calls if c["args"][:2] == ["run", "deploy"])
    for expected_flag in (
        f"--service-account={valid_sa}",
        "--max-instances=1",
        "--concurrency=80",
        "--timeout=3600",
        "--no-allow-unauthenticated",
        "--iap",
        "--session-affinity",
        "--quiet",
    ):
        assert expected_flag in deploy_call

    project_iam_roles = [
        next(a.split("=", 1)[1] for a in c["args"] if a.startswith("--role="))
        for c in calls
        if c["args"][:2] == ["projects", "add-iam-policy-binding"]
    ]
    assert project_iam_roles == [
        "projects/test-bank-proj/roles/cxasSessionRunner",
        "roles/serviceusage.serviceUsageConsumer",
    ]

    assert any(
        c["args"][:3] == ["run", "services", "update"] for c in calls
    )
    assert any(
        c["args"][:3] == ["run", "services", "add-iam-policy-binding"]
        and "--member=serviceAccount:service-123456789012@gcp-sa-iap.iam.gserviceaccount.com"
        in c["args"]
        and "--role=roles/run.invoker" in c["args"]
        and "--condition=None" in c["args"]
        for c in calls
    )
    iap_members_bound = [
        next(a.split("=", 1)[1] for a in c["args"] if a.startswith("--member="))
        for c in calls
        if c["args"][:3] == ["iap", "web", "add-iam-policy-binding"]
        and "--condition=None" in c["args"]
    ]
    assert iap_members_bound == ["user:alice@example.com", "domain:example.com"]
    assert json.loads(captured_iap_settings.read_text(encoding="utf-8")) == {
        "accessSettings": {
            "oauthSettings": {
                "clientId": "12345-client.apps.example.com",
                "clientSecret": "super-secret-oauth-val",
            }
        }
    }

    # 4. Redeploy when service already exists pre-populates legacy URL in deploy (single-step, 0 update)!
    gcloud_log.unlink()
    for f in captured_env_dir.iterdir():
        f.unlink()
    r_redeploy = run_deploy(
        [
            "--service-account",
            valid_sa,
            "--iap-domains",
            "example.com",
            "--yes",
        ],
        env_overrides={"FAKE_CLOUD_RUN_URLS": json.dumps(dual_urls)},
    )
    assert r_redeploy.returncode == 0, r_redeploy.stderr
    redeploy_calls = [
        json.loads(line)
        for line in gcloud_log.read_text(encoding="utf-8").splitlines()
    ]
    assert not any(
        c["args"][:3] == ["run", "services", "update"] for c in redeploy_calls
    )
    assert len(list(captured_env_dir.glob("env_*.yaml"))) == 1
    redeploy_env = yaml.safe_load(
        (captured_env_dir / "env_0.yaml").read_text(encoding="utf-8")
    )
    assert redeploy_env["PROXY_ALLOWED_HOSTS"] == (
        "cloudbank-123456789012.europe-west1.run.app,cloudbank-legacy99-ew.a.run.app"
    )

    # 5. Fresh initial deploy when run.googleapis.com/urls matches deterministic host alone skips update!
    deployed_marker.unlink()
    gcloud_log.unlink()
    for f in captured_env_dir.iterdir():
        f.unlink()
    r_single_url = run_deploy(
        [
            "--service-account",
            valid_sa,
            "--iap-domains",
            "example.com",
            "--yes",
        ],
        env_overrides={
            "FAKE_CLOUD_RUN_URLS": json.dumps(
                ["https://cloudbank-123456789012.europe-west1.run.app"]
            )
        },
    )
    assert r_single_url.returncode == 0, r_single_url.stderr
    single_calls = [
        json.loads(line)
        for line in gcloud_log.read_text(encoding="utf-8").splitlines()
    ]
    assert not any(
        c["args"][:3] == ["run", "services", "update"] for c in single_calls
    )
    assert len(list(captured_env_dir.glob("env_*.yaml"))) == 1

    # 6. Non-HTTPS URL in Cloud Run status/annotations aborts deploy_cloud_run.sh with non-zero exit!
    deployed_marker.unlink()
    gcloud_log.unlink()
    for f in captured_env_dir.iterdir():
        f.unlink()
    r_bad_http_url = run_deploy(
        [
            "--service-account",
            valid_sa,
            "--iap-domains",
            "example.com",
            "--yes",
        ],
        env_overrides={
            "FAKE_CLOUD_RUN_URLS": json.dumps(
                ["http://cloudbank-123456789012.europe-west1.run.app"]
            )
        },
    )
    assert r_bad_http_url.returncode != 0
    assert "refusing non-HTTPS Cloud Run URL" in r_bad_http_url.stderr

    # 7. Invalid or loopback https:// hostname inside extract_service_hosts aborts with non-zero exit!
    deployed_marker.unlink()
    gcloud_log.unlink()
    for f in captured_env_dir.iterdir():
        f.unlink()
    r_bad_https_host = run_deploy(
        [
            "--service-account",
            valid_sa,
            "--iap-domains",
            "example.com",
            "--yes",
        ],
        env_overrides={
            "FAKE_CLOUD_RUN_URLS": json.dumps(["https://bad_host!.run.app"])
        },
    )
    assert r_bad_https_host.returncode != 0
    assert "malformed hostname" in r_bad_https_host.stderr
