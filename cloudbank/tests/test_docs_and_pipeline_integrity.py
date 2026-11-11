"""Documentation accuracy, hook enforcement, and push.sh pipeline integrity tests."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess

CLOUDBANK_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = CLOUDBANK_ROOT.parent
FIXTURES_DIR = CLOUDBANK_ROOT / "web" / "src" / "fixtures"
DOCS_DIR = REPO_ROOT / "docs"
HOOKS_DIR = REPO_ROOT / ".agents" / "skills" / "cxas-agent-foundry" / "scripts" / "hooks"

# External platform / CXAS lint / Web-API symbols legitimately named in docs.
ALLOWED_EXTERNAL_IDENTIFIERS = frozenset(
    {
        "E001",
        "E011",
        "I012",
        "I014",
        "InputAudioConfig",
        "NotSupportedError",
        "S005",
        "S007",
        "T008",
        "T012",
        "V001",
        "V101",
        "V102",
        "V103",
        "clientFunction",
    }
)


def _fmt_gbp_exact(pence: int) -> str:
    pounds, rem = divmod(pence, 100)
    return f"£{pounds:,}.{rem:02d}"


def _fmt_gbp_whole(pence: int) -> str:
    return f"£{pence // 100:,}"


def _fmt_bps(bps: int) -> str:
    whole, rem = divmod(bps, 100)
    return f"{whole}.{rem:02d}%"


def test_docs_persona_tables_match_fixtures_verbatim() -> None:
    """Every persona balance, pot name, AER, mortgage rate, and anomaly in docs matches fixtures."""
    flows_md = (DOCS_DIR / "architecture" / "banking_flows.md").read_text(encoding="utf-8")
    qa_md = (DOCS_DIR / "guides" / "qa_tester_guide.md").read_text(encoding="utf-8")
    beginners_md = (DOCS_DIR / "guides" / "gecx_for_beginners.md").read_text(encoding="utf-8")
    walkthrough_md = (DOCS_DIR / "architecture" / "end_to_end_walkthrough.md").read_text(
        encoding="utf-8"
    )

    for persona in ("chloe", "david", "tom", "sarah"):
        fx = json.loads((FIXTURES_DIR / f"{persona}.json").read_text(encoding="utf-8"))
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
            line for line in qa_md.splitlines() if line.startswith(f"| **{first_name} ·")
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

    # Pin walkthrough & beginners prose figures for Sarah and Tom specifically.
    sarah_fx = json.loads((FIXTURES_DIR / "sarah.json").read_text(encoding="utf-8"))
    sarah_rate = _fmt_bps(sarah_fx["accounts"]["mortgage"]["interest_rate_bps"])
    assert f"`{sarah_rate}` (`90` months remaining)" in walkthrough_md
    assert f"at `{sarah_rate}`" in beginners_md

    tom_fx = json.loads((FIXTURES_DIR / "tom.json").read_text(encoding="utf-8"))
    tom_aer = f"{_fmt_bps(tom_fx['accounts']['savings']['aer_bps'])} AER"
    assert tom_aer in walkthrough_md
    assert tom_aer in beginners_md
    assert '`{page: "mortgage", subview: "overview"}`' in walkthrough_md


def test_docs_backticked_identifiers_and_links_exist_in_codebase() -> None:
    """Every backticked state key / function name and #L anchor in docs resolves against code."""
    code_chunks: list[str] = []
    for ext in ("*.py", "*.ts", "*.tsx", "*.js", "*.json", "*.yaml", "*.yml", "*.sh", "*.txt"):
        for path in REPO_ROOT.rglob(ext):
            if any(
                part in path.parts
                for part in (".git", "node_modules", ".venv", "dist", "__pycache__", ".pytest_cache")
            ):
                continue
            code_chunks.append(path.read_text(encoding="utf-8", errors="ignore"))
    code_corpus = "\n".join(code_chunks)

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
                assert m is not None, f"Invalid line anchor {raw!r} in {md}"
                start, end = int(m.group(1)), int(m.group(2) or m.group(1))
                lines = target.read_text(encoding="utf-8").splitlines()
                assert 1 <= start <= end <= len(lines), (
                    f"Out-of-range anchor {raw!r} (file has {len(lines)} lines) in {md}"
                )

    assert not unknown_identifiers, (
        f"Docs reference identifiers that do not exist in codebase: {unknown_identifiers}"
    )

    # QA tester guide must never leak internal agent, tool, callback, or state identifiers.
    qa_text = (DOCS_DIR / "guides" / "qa_tester_guide.md").read_text(encoding="utf-8")
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
        assert internal_tok not in qa_text, f"Internal token {internal_tok!r} leaked in QA guide"


def test_push_sh_pipeline_order_and_no_push_eval() -> None:
    """Pins the 5 ordered steps of cloudbank/push.sh and bans cxas push / cxas push-eval."""
    push_sh = CLOUDBANK_ROOT / "push.sh"
    syntax = subprocess.run(["bash", "-n", str(push_sh)], capture_output=True, text=True)
    assert syntax.returncode == 0, syntax.stderr

    active_lines = [
        line.strip()
        for line in push_sh.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    active_script = "\n".join(active_lines)

    assert "set -euo pipefail" in active_lines
    assert "jq -r .gcp_project_id gecx-config.json" in active_script
    assert "jq -r .location gecx-config.json" in active_script
    assert "jq -r .deployed_app_id gecx-config.json" in active_script
    assert "push-eval" not in active_script
    assert not re.search(r"\bcxas\s+push\b", active_script)

    cfg = json.loads((CLOUDBANK_ROOT / "gecx-config.json").read_text(encoding="utf-8"))
    assert cfg["gcp_project_id"] not in active_script

    required_steps = [
        "uv run --locked cxas lint",
        "uv run --locked python scripts/audit_agent.py --workspace=cxas_app/Cloudbank --report",
        "uv run --locked pytest -v",
        "uv run --locked python scripts/manage_ces_app.py --config gecx-config.json push",
        "uv run --locked python scripts/run_golden_evals.py --config gecx-config.json sync",
        "uv run --locked python scripts/manage_ces_app.py --config gecx-config.json create-version",
    ]
    positions = []
    for step in required_steps:
        pos = active_script.find(step)
        assert pos != -1, f"Missing required step in cloudbank/push.sh: {step!r}"
        positions.append(pos)
    assert positions == sorted(positions), (
        f"Steps in cloudbank/push.sh are out of chronological order: {positions}"
    )


def test_push_sh_argument_order_and_target_parsing(tmp_path: Path) -> None:
    """F7-3: push.sh parses TARGET and --create-version cleanly in any argument order."""
    work = tmp_path / "cb"
    work.mkdir()
    (work / "push.sh").write_text((CLOUDBANK_ROOT / "push.sh").read_text(encoding="utf-8"), encoding="utf-8")
    (work / "gecx-config.json").write_text(
        json.dumps({"gcp_project_id": "test-p", "location": "eu", "deployed_app_id": "app-1"}),
        encoding="utf-8",
    )
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    uv_log = tmp_path / "uv_calls.log"
    fake_uv = bin_dir / "uv"
    fake_uv.write_text(
        f"#!/usr/bin/env bash\necho \"$*\" >> {uv_log}\n",
        encoding="utf-8",
    )
    fake_uv.chmod(0o755)
    env = {**os.environ, "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}"}

    # Case 1: ./push.sh dev --create-version v1 -> target='dev', version='v1'
    uv_log.write_text("", encoding="utf-8")
    r1 = subprocess.run(["bash", str(work / "push.sh"), "dev", "--create-version", "v1"], env=env, capture_output=True, text=True)
    assert r1.returncode == 0, r1.stderr
    calls1 = uv_log.read_text(encoding="utf-8").splitlines()
    assert any("manage_ces_app.py --config gecx-config.json push dev" in c for c in calls1)
    assert any("run_golden_evals.py --config gecx-config.json sync dev" in c for c in calls1)
    assert any("manage_ces_app.py --config gecx-config.json create-version v1  dev" in c for c in calls1)

    # Case 2: ./push.sh --create-version dev -> target='dev', auto-timestamped version (never version='dev'!)
    uv_log.write_text("", encoding="utf-8")
    r2 = subprocess.run(["bash", str(work / "push.sh"), "--create-version", "dev"], env=env, capture_output=True, text=True)
    assert r2.returncode == 0, r2.stderr
    calls2 = uv_log.read_text(encoding="utf-8").splitlines()
    assert any("manage_ces_app.py --config gecx-config.json push dev" in c for c in calls2)
    assert any("create-version v-" in c and c.endswith(" dev") for c in calls2)


def test_push_hooks_gate_manage_ces_app_push_subcommand(tmp_path: Path) -> None:
    """Both pre-agent-push.sh and pre-agent-push-lint.sh intercept manage_ces_app.py push."""
    push_hook = HOOKS_DIR / "pre-agent-push.sh"
    lint_hook = HOOKS_DIR / "pre-agent-push-lint.sh"

    # 1. pre-agent-push.sh blocks a mismatched project target on `manage_ces_app.py push`.
    bad_payload = json.dumps(
        {
            "tool_input": {
                "command": (
                    "uv run python scripts/manage_ces_app.py --config gecx-config.json "
                    "push projects/wrong-project/locations/eu/apps/00000000-0000-0000-0000-000000000000"
                )
            }
        }
    )
    blocked = subprocess.run(
        ["bash", str(push_hook)],
        input=bad_payload,
        capture_output=True,
        text=True,
        cwd=CLOUDBANK_ROOT,
    )
    assert blocked.returncode == 2
    assert "PUSH BLOCKED" in blocked.stderr

    # Matching `prod` target passes pre-agent-push.sh.
    ok_payload = json.dumps(
        {
            "tool_input": {
                "command": "uv run python scripts/manage_ces_app.py --config gecx-config.json push prod"
            }
        }
    )
    allowed = subprocess.run(
        ["bash", str(push_hook)],
        input=ok_payload,
        capture_output=True,
        text=True,
        cwd=CLOUDBANK_ROOT,
    )
    assert allowed.returncode == 0, allowed.stderr

    # 2. pre-agent-push-lint.sh intercepts `manage_ces_app.py push` (proved by setting
    # GECX_PROJECT to a missing project -> exits 2 with LINT BLOCKED, whereas non-push
    # `list-versions` exits 0 before project resolution).
    env = {**os.environ, "GECX_PROJECT": "__nonexistent_project__"}
    lint_triggered = subprocess.run(
        ["bash", str(lint_hook)],
        input=ok_payload,
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        env=env,
    )
    assert lint_triggered.returncode == 2
    assert "LINT BLOCKED" in lint_triggered.stderr

    readonly_payload = json.dumps(
        {"tool_input": {"command": "uv run python scripts/manage_ces_app.py list-versions"}}
    )
    readonly_res = subprocess.run(
        ["bash", str(lint_hook)],
        input=readonly_payload,
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        env=env,
    )
    assert readonly_res.returncode == 0

    # 3. Non-executing commands mentioning push.sh as a file argument never false-trigger!
    for safe_cmd in (
        "git add cloudbank/push.sh",
        "git diff cloudbank/push.sh",
        "cat cloudbank/push.sh",
        "bash -n cloudbank/push.sh",
    ):
        payload = json.dumps({"tool_input": {"command": safe_cmd}})
        for hook in (push_hook, lint_hook):
            res = subprocess.run(
                ["bash", str(hook)],
                input=payload,
                capture_output=True,
                text=True,
                cwd=REPO_ROOT,
                env=env,
            )
            assert res.returncode == 0, f"{hook.name} false-triggered on {safe_cmd!r}: {res.stderr}"

    # Whereas actually invoking push in any shell wrapper, multi-line, subshell, or timeout form IS intercepted!
    for exec_cmd in (
        "cd cloudbank && ./push.sh",
        "cd cloudbank\n./push.sh",
        "timeout 900 ./cloudbank/push.sh",
        "sudo ./cloudbank/push.sh",
        "exec ./cloudbank/push.sh",
        "source ./cloudbank/push.sh",
        "if true; then ./cloudbank/push.sh; fi",
        "echo ./cloudbank/push.sh | xargs bash",
        "`./cloudbank/push.sh`",
        'echo "$(cd cloudbank && ./push.sh)"',
        "npx cxas push",
    ):
        exec_push_payload = json.dumps({"tool_input": {"command": exec_cmd}})
        exec_res = subprocess.run(
            ["bash", str(lint_hook)],
            input=exec_push_payload,
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
            env=env,
        )
        assert exec_res.returncode == 2, f"lint_hook missed {exec_cmd!r}"
        assert "LINT BLOCKED" in exec_res.stderr

        # Also verify wrong-project guard in pre-agent-push.sh catches multi-line & timeout forms!
        wrong_target_cmd = (
            f"{exec_cmd} --to projects/wrong-proj/locations/eu/apps/00000000-0000-0000-0000-000000000000"
        )
        wrong_res = subprocess.run(
            ["bash", str(push_hook)],
            input=json.dumps({"tool_input": {"command": wrong_target_cmd}}),
            capture_output=True,
            text=True,
            cwd=CLOUDBANK_ROOT,
        )
        assert wrong_res.returncode == 2, f"push_hook missed {wrong_target_cmd!r}"
