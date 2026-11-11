"""Documentation accuracy and cloudbank/push.sh pipeline integrity tests."""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

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
        "ClientText",
        "Draft7Validator",
        "E001",
        "E011",
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
        "TrustedHostMiddleware",
        "TurnComplete",
        "V001",
        "V101",
        "V102",
        "V103",
        "V104",
        "agentResponse",
        "agentTransfer",
        "axe",
        "clientFunction",
        "gcloud",
        "snake_case",
        "toolCall",
    }
)

# Pre-Stage-2 identifiers present in docs/ only before feat/remediate-ci-docs merges.
_PRE_DOCS_MERGE_IDENTIFIERS = frozenset(
    {
        "C018",
        "SearchToolResponse",
        "googleSearchTool",
        "manage_ces_app",
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
        ) or path.name == "Makefile":
            code_chunks.append(path.read_text(encoding="utf-8", errors="ignore"))
    code_corpus = "\n".join(code_chunks)

    docs_merged = (REPO_ROOT / "Makefile").is_file()
    allowed = (
        ALLOWED_EXTERNAL_IDENTIFIERS
        if docs_merged
        else (ALLOWED_EXTERNAL_IDENTIFIERS | _PRE_DOCS_MERGE_IDENTIFIERS)
    )

    md_files = [
        REPO_ROOT / "README.md",
        CLOUDBANK_ROOT / "README.md",
        CLOUDBANK_ROOT / "proxy" / "README.md",
        *sorted(DOCS_DIR.rglob("*.md")),
    ]

    ident_re = re.compile(r"`([A-Za-z_][A-Za-z0-9_]{2,})`")
    link_re = re.compile(r"\[[^\]]+\]\(([^)]+)\)")

    unknown_identifiers: list[tuple[str, str]] = []
    for md in md_files:
        text = md.read_text(encoding="utf-8")
        for match in ident_re.finditer(text):
            ident = match.group(1)
            if ident in allowed:
                continue
            if ident not in code_corpus:
                unknown_identifiers.append((str(md.relative_to(REPO_ROOT)), ident))

        if docs_merged:
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
