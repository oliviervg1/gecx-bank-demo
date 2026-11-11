"""Static bundle, AST, schema, helper-parity, and golden-contract integrity tests."""

from __future__ import annotations

import ast
import inspect
import json
import re
import sys
import types
from pathlib import Path
from typing import Any

import jsonschema
import pytest
import yaml
from cxas_scrapi.utils.eval_utils import EvalUtils

from conftest import (
    AGENT_NAMES,
    BUNDLE_DIR,
    CLOUDBANK_DIR,
    CONTROLLER_NAMES,
    GOLDENS_DIR,
    PERSONA_IDS,
    SIMULATIONS_DIR,
    load_controller_namespace,
    make_seeded_state,
)

sys.path.insert(0, str(CLOUDBANK_DIR / "scripts"))
import run_golden_evals  # noqa: E402


BANNED_ROUTING_WORDS = ("transfer", "transferring", "connecting", "handoff")
SHARED_STATE_KEYS = frozenset(
    {
        "persona_id",
        "first_name",
        "demo_date",
        "time_of_day",
        "customer_snapshot",
        "target_agent",
        "handoff_context",
        "ui_view_state",
        "ui_emitted_seq",
        "unclear_count",
        "pass_turn_id",
        "pass_count",
        "last_user_utterance",
        "call_complete",
        "escalation_reason",
    }
)
CONTROLLER_PRIVATE_STATE = {
    "route_banking_intent": "router_state",
    "assist_everyday_banking": "everyday_state",
    "assist_savings": "savings_state",
    "assist_mortgages": "mortgage_state",
}


def test_acyclic_single_parent_agent_topology() -> None:
    """Verify root_agent -> 3 spokes forms a single-parent acyclic tree (S007)."""
    app_cfg = json.loads((BUNDLE_DIR / "app.json").read_text(encoding="utf-8"))
    assert app_cfg["rootAgent"] == "root_agent"

    agent_cfgs = {
        name: json.loads(
            (BUNDLE_DIR / "agents" / name / f"{name}.json").read_text(encoding="utf-8")
        )
        for name in AGENT_NAMES
    }
    assert set(agent_cfgs["root_agent"]["childAgents"]) == {
        "everyday_banking_agent",
        "savings_agent",
        "mortgage_agent",
    }
    assert len(agent_cfgs["root_agent"]["childAgents"]) == 3

    parent_counts: dict[str, int] = {name: 0 for name in AGENT_NAMES}
    for name, cfg in agent_cfgs.items():
        for child in cfg.get("childAgents", []):
            assert child in AGENT_NAMES, f"Unknown childAgent {child} on {name}"
            parent_counts[child] += 1
        if name != "root_agent":
            assert cfg.get("childAgents") == []
            assert "modelSettings" not in cfg, f"{name} must inherit modelSettings from app.json"

    assert parent_counts["root_agent"] == 0
    for spoke in ("everyday_banking_agent", "savings_agent", "mortgage_agent"):
        assert parent_counts[spoke] == 1


def test_app_json_schema_and_variable_invariants() -> None:
    """Verify app.json settings, V001 OBJECT schemas, and absence of legacy fields."""
    app_cfg = json.loads((BUNDLE_DIR / "app.json").read_text(encoding="utf-8"))
    assert "tools" not in app_cfg
    assert "inactivityTimeout" not in app_cfg
    assert "evaluationAudioRecordingConfig" not in app_cfg
    assert not (BUNDLE_DIR / "environment.json").exists()
    assert app_cfg["modelSettings"]["model"] == "gemini-composite-v2"
    assert app_cfg["languageSettings"]["defaultLanguageCode"] == "en-GB"
    assert app_cfg["audioProcessingConfig"]["bargeInConfig"]["bargeInAwareness"] is True
    tts_cfg = app_cfg["audioProcessingConfig"]["synthesizeSpeechConfigs"]["en-GB"]
    assert tts_cfg["voice"] == "en-GB-Chirp3-HD-Aoede"
    assert app_cfg["loggingSettings"]["redactionConfig"]["enableRedaction"] is True
    assert app_cfg["loggingSettings"]["cloudLoggingSettings"]["enableCloudLogging"] is True

    thresholds = app_cfg["evaluationMetricsThresholds"]["goldenEvaluationMetricsThresholds"]
    assert thresholds["turnLevelMetricsThresholds"]["semanticSimilaritySuccessThreshold"] >= 3
    assert thresholds["toolMatchingSettings"]["extraToolCallBehavior"] == "FAIL"

    declared_names = set()
    for var in app_cfg["variableDeclarations"]:
        vname = var["name"]
        assert vname not in declared_names, f"Duplicate variable {vname}"
        declared_names.add(vname)
        assert vname != "current_date", "Never declare platform reserved current_date"
        schema = var["schema"]
        assert schema.get("required") == [], f"{vname} must declare required: [] (V001)"
        if schema["type"] == "OBJECT":
            assert "properties" not in schema, f"{vname} must omit properties to avoid V102/V103"


def test_guardrails_active_and_safeguarding_numbers() -> None:
    """Verify all 3 guardrails are enabled and use Ofcom drama number + Samaritans."""
    app_cfg = json.loads((BUNDLE_DIR / "app.json").read_text(encoding="utf-8"))
    expected = [
        "prompt_security_guardrail",
        "model_safety_guardrail",
        "fca_vulnerability_guardrail",
    ]
    assert app_cfg["guardrails"] == expected

    for gname in expected:
        gpath = BUNDLE_DIR / "guardrails" / gname / f"{gname}.json"
        gcfg = json.loads(gpath.read_text(encoding="utf-8"))
        assert gcfg["enabled"] is True
        responses = gcfg["action"]["respondImmediately"]["responses"]
        assert responses and responses[0]["text"].strip()

    fca = json.loads(
        (
            BUNDLE_DIR
            / "guardrails"
            / "fca_vulnerability_guardrail"
            / "fca_vulnerability_guardrail.json"
        ).read_text(encoding="utf-8")
    )
    assert fca["llmPolicy"]["policyScope"] == "USER_QUERY"
    assert fca["llmPolicy"]["failOpen"] is True
    fca_text = fca["action"]["respondImmediately"]["responses"][0]["text"]
    assert "0808 157 0100" in fca_text
    assert "116 123" in fca_text


def test_zero_prompt_leaks_and_banned_routing_words() -> None:
    """Verify zero customer_snapshot/ui_view_state prompt tokens and zero transfer wording."""
    global_txt = (BUNDLE_DIR / "global_instruction.txt").read_text(encoding="utf-8")
    assert "{current_date}" in global_txt
    assert "{demo_date}" in global_txt
    assert "{customer_snapshot}" not in global_txt
    assert "{ui_view_state}" not in global_txt
    assert "{@AGENT:" not in global_txt

    for name in AGENT_NAMES:
        inst = (BUNDLE_DIR / "agents" / name / "instruction.txt").read_text(encoding="utf-8")
        assert "{customer_snapshot}" not in inst
        assert "{ui_view_state}" not in inst
        assert "{@AGENT:" not in inst
        lowered = inst.lower()
        for word in BANNED_ROUTING_WORDS:
            assert word not in lowered, f"Banned word {word!r} in {name}/instruction.txt"

    for tpath in sorted((BUNDLE_DIR / "tools").glob("*/*.json")):
        tcfg = json.loads(tpath.read_text(encoding="utf-8"))
        desc = (
            (tcfg.get("pythonFunction") or {}).get("description")
            or (tcfg.get("googleSearchTool") or {}).get("description")
            or ""
        ).lower()
        for word in BANNED_ROUTING_WORDS:
            assert word not in desc, f"Banned word {word!r} in {tpath.name}"


def test_callbacks_byte_for_byte_identical_across_four_agents() -> None:
    """Enforce byte-for-byte parity across all 4 agents for all 3 callbacks."""
    rel_paths = (
        "before_model_callbacks/capture_utterance/python_code.py",
        "after_model_callbacks/agent_transfer/python_code.py",
        "after_model_callbacks/release_line/python_code.py",
    )
    for rel in rel_paths:
        blobs = {
            agent: (BUNDLE_DIR / "agents" / agent / rel).read_bytes()
            for agent in AGENT_NAMES
        }
        unique = set(blobs.values())
        assert len(unique) == 1, f"Callback drift detected across agents in {rel}"


def test_shared_controller_helpers_source_identical() -> None:
    """Ensure duplicated helpers stay byte-identical across controllers."""
    helper_names = (
        "_half_up",
        "_to_pence",
        "_emit_ui_view",
        "_format_gbp",
        "_format_bps",
        "_parse_demo_date",
    )
    for helper in helper_names:
        definitions: dict[str, str] = {}
        for ctrl in CONTROLLER_NAMES:
            src = (
                BUNDLE_DIR / "tools" / ctrl / "python_function" / "python_code.py"
            ).read_text(encoding="utf-8")
            tree = ast.parse(src)
            for node in tree.body:
                if isinstance(node, ast.FunctionDef) and node.name == helper:
                    seg = ast.get_source_segment(src, node)
                    assert seg is not None
                    definitions[ctrl] = seg
        assert definitions, f"Helper {helper} not found in any controller"
        assert len(set(definitions.values())) == 1, (
            f"Helper {helper} drifted across controllers: {list(definitions)}"
        )


def test_ast_safety_math_and_private_state_isolation() -> None:
    """Enforce AST bans on float division, pop/del/None state writes, __future__, and regex."""
    declared_vars = {
        v["name"]
        for v in json.loads((BUNDLE_DIR / "app.json").read_text(encoding="utf-8"))[
            "variableDeclarations"
        ]
    }

    py_files = list((BUNDLE_DIR / "tools").rglob("*.py")) + list(
        (BUNDLE_DIR / "agents").rglob("*.py")
    )
    assert len(py_files) == 17  # 4 controllers + 1 fake + 12 callbacks

    for py_path in py_files:
        src = py_path.read_text(encoding="utf-8")
        tree = ast.parse(src, filename=str(py_path))
        is_controller = "python_function" in py_path.parts
        tool_name = py_path.parts[-3] if is_controller else ""

        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == "__future__":
                pytest.fail(f"Banned __future__ import in {py_path}")
            if is_controller and isinstance(node, ast.Import):
                for alias in node.names:
                    assert alias.name != "re", f"Controllers must not import re: {py_path}"
            if isinstance(node, ast.Attribute):
                assert node.attr != "thought", f"Banned .thought access in {py_path}"
                assert node.attr != "pop", f"Banned .pop() mutation in {py_path}"
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                assert node.func.id not in ("getattr", "hasattr"), (
                    f"Banned dynamic reflection {node.func.id} in {py_path}"
                )
            if isinstance(node, ast.Delete):
                for target in node.targets:
                    assert not isinstance(target, ast.Subscript), (
                        f"Banned del subscript on state in {py_path}"
                    )
            if isinstance(node, ast.Assign):
                if isinstance(node.value, ast.Constant) and node.value.value is None:
                    for target in node.targets:
                        assert not isinstance(target, ast.Subscript), (
                            f"Banned subscript = None assignment in {py_path}"
                        )
                if is_controller:
                    for target in node.targets:
                        if (
                            isinstance(target, ast.Subscript)
                            and isinstance(target.value, ast.Attribute)
                            and target.value.attr == "state"
                            and isinstance(target.slice, ast.Constant)
                            and isinstance(target.slice.value, str)
                        ):
                            key = target.slice.value
                            allowed = SHARED_STATE_KEYS | {
                                CONTROLLER_PRIVATE_STATE[tool_name]
                            }
                            assert key in declared_vars, f"Undeclared state key {key} in {tool_name}"
                            assert key in allowed, (
                                f"{tool_name} mutated foreign private state {key!r}"
                            )

        if tool_name in ("assist_savings", "assist_mortgages"):
            for node in ast.walk(tree):
                assert not isinstance(node, ast.Div), f"Banned float '/' in {tool_name}"
                assert not isinstance(node, ast.Pow), f"Banned '**' in {tool_name}"
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                    assert node.func.id != "round", f"Banned round() in {tool_name}"


def test_controller_docstrings_match_signatures(
    struct_fixtures: dict[str, dict[str, Any]],
) -> None:
    """Verify every controller's Google-style Args: docstring matches inspect.signature."""
    state = make_seeded_state("chloe", struct_fixtures)
    for ctrl in CONTROLLER_NAMES:
        ns = load_controller_namespace(ctrl, state)
        fn = ns[ctrl]
        params = set(inspect.signature(fn).parameters)
        doc = inspect.getdoc(fn) or ""
        assert "Args:" in doc and "\nReturns:" in doc, f"Malformed docstring in {ctrl}"
        for word in BANNED_ROUTING_WORDS:
            assert word not in doc.lower(), f"Banned word {word!r} in {ctrl} docstring"
        args_block = doc.split("Args:", 1)[1].split("\nReturns:", 1)[0]
        documented = set(re.findall(r"^ {4}(\w+):", args_block, flags=re.MULTILINE))
        assert documented == params, f"Docstring Args mismatch in {ctrl}: {documented} != {params}"


def test_instruction_examples_match_real_controller_outputs(
    struct_fixtures: dict[str, dict[str, Any]],
) -> None:
    """Verify every tool_outputs JSON in instruction.txt matches real Chloe output."""
    state = make_seeded_state("chloe", struct_fixtures)
    r_ns = load_controller_namespace("route_banking_intent", state)
    e_ns = load_controller_namespace("assist_everyday_banking", state)
    s_ns = load_controller_namespace("assist_savings", state)
    m_ns = load_controller_namespace("assist_mortgages", state)

    e_ns["assist_everyday_banking"](query_type="overview", period="this_month")
    expected_by_agent = {
        "root_agent": [
            r_ns["route_banking_intent"](
                intent="EVERYDAY_BANKING", topic_hint="spending overview this month"
            ),
            r_ns["route_banking_intent"](intent="GREETING", topic_hint="greeting"),
        ],
        "everyday_banking_agent": [
            e_ns["assist_everyday_banking"](
                query_type="cancel_subscription",
                vendor_name="Netflix",
                anomaly_confirmed="yes",
            ),
            e_ns["assist_everyday_banking"](switch_intent="SAVINGS"),
        ],
        "savings_agent": [
            s_ns["assist_savings"](switch_intent="MORTGAGES"),
        ],
        "mortgage_agent": [
            m_ns["assist_mortgages"](
                query_type="overpayment_projection", monthly_overpayment=200.0
            ),
        ],
    }

    block_re = re.compile(r"```tool_outputs\n(.*?)\n```", re.DOTALL)
    for agent, expected_list in expected_by_agent.items():
        inst = (BUNDLE_DIR / "agents" / agent / "instruction.txt").read_text(encoding="utf-8")
        blocks = [json.loads(m.strip()) for m in block_re.findall(inst)]
        assert blocks == expected_list, f"Example output drift in {agent}/instruction.txt"


def test_fixtures_schema_unique_ids_single_anomaly_and_struct_floats(
    raw_fixtures: dict[str, dict[str, Any]],
    struct_fixtures: dict[str, dict[str, Any]],
    snapshot_schema: dict[str, Any],
) -> None:
    """Validate all 4 persona fixtures against schema, uniqueness, and Struct float coercion."""
    for pid in PERSONA_IDS:
        raw = raw_fixtures[pid]
        jsonschema.validate(instance=raw, schema=snapshot_schema)

        txns = raw["transactions"]
        ids = [t["id"] for t in txns]
        assert len(ids) == len(set(ids)), f"Duplicate transaction IDs in {pid}.json"

        m0_anomalies = [t for t in txns if t["month_offset"] == 0 and t.get("is_anomaly")]
        other_anomalies = [t for t in txns if t["month_offset"] != 0 and t.get("is_anomaly")]
        assert len(m0_anomalies) == 1, f"{pid}.json must have exactly 1 month_offset=0 anomaly"
        assert other_anomalies == [], f"{pid}.json must have 0 historical anomalies"

        # Confirm protobuf.Struct round-trip turns JSON numbers into Python floats
        coerced = struct_fixtures[pid]
        assert isinstance(coerced["accounts"]["current"]["balance_pence"], float)
        assert isinstance(coerced["transactions"][0]["amount_pence"], float)


def test_goldens_and_simulations_integrity(
    raw_fixtures: dict[str, dict[str, Any]],
    struct_fixtures: dict[str, dict[str, Any]],
) -> None:
    """Verify verbatim fixture parity in goldens & simulations, step order, and real speech match."""
    app_cfg = json.loads((BUNDLE_DIR / "app.json").read_text(encoding="utf-8"))
    declared_vars = {v["name"] for v in app_cfg["variableDeclarations"]}
    diag_re = re.compile(r"\s*\[Diagnosis context:.*?\]\s*", re.DOTALL)

    golden_files = sorted(GOLDENS_DIR.glob("*.yaml"))
    assert len(golden_files) >= 4, "Expected at least one golden YAML per persona"

    seen_personas: set[str] = set()
    eval_utils = EvalUtils.__new__(EvalUtils)
    eval_utils.app_name = "projects/test-proj/locations/eu/apps/cloudbank"
    eval_utils.tool_map = {}
    eval_utils.agent_map = {}
    eval_utils._process_dataset_turn = types.MethodType(
        run_golden_evals.build_ordered_turn_steps, eval_utils
    )

    for gf in golden_files:
        data = yaml.safe_load(gf.read_text(encoding="utf-8"))
        common = data["common_session_parameters"]
        assert set(common.keys()) <= declared_vars
        pid = common["persona_id"]
        assert pid in PERSONA_IDS, f"Unknown persona_id {pid!r} in {gf.name}"
        seen_personas.add(pid)
        assert common["demo_date"] == "2026-11-24"
        assert common["customer_snapshot"] == raw_fixtures[pid], (
            f"customer_snapshot in {gf.name} drifted from {pid}.json"
        )

        # Replay each golden conversation against real controllers to prevent silent text drift
        for conv in data["conversations"]:
            sp = conv.get("session_parameters") or {}
            assert "persona_id" not in sp or sp["persona_id"] == pid
            assert "customer_snapshot" not in sp

            replay_state = make_seeded_state(
                pid,
                struct_fixtures,
                demo_date=common["demo_date"],
                time_of_day=common["time_of_day"],
            )
            ctrls = {
                name: load_controller_namespace(name, replay_state)[name]
                for name in CONTROLLER_NAMES
            }
            for turn_idx, turn in enumerate(conv["turns"], start=1):
                last_action_text = ""
                last_query_type = ""
                for tc in turn.get("tool_calls", []):
                    action = tc["action"]
                    if action == "transfer_to_agent":
                        replay_state["target_agent"] = ""
                        continue
                    if action == "end_session":
                        assert replay_state.get("call_complete") == "true", (
                            f"end_session declared without call_complete=true in {gf.name}"
                        )
                        replay_state["call_complete"] = "released"
                        continue
                    call_kwargs = {
                        k: ("" if isinstance(v, dict) and "$matchType" in v else v)
                        for k, v in (tc.get("args") or {}).items()
                    }
                    last_query_type = str(call_kwargs.get("query_type") or "")
                    out = ctrls[action](**call_kwargs)
                    last_action_text = diag_re.sub(" ", out["agent_action"]).strip()

                agent_field = turn["agent"]
                expected_spoken = (
                    agent_field[-1] if isinstance(agent_field, list) else agent_field
                )
                if last_query_type != "cancel_subscription":
                    assert expected_spoken == last_action_text, (
                        f"Golden text drift in {gf.name}:{conv['conversation']} turn {turn_idx}"
                    )

        # Compile through run_golden_evals.build_ordered_turn_steps offline
        compiled = eval_utils.load_golden_evals_from_yaml(str(gf))
        assert compiled, f"No evaluations compiled from {gf.name}"
        for ev in compiled:
            turns = ev["golden"]["turns"]
            assert turns
            for turn in turns:
                kinds = [
                    next(iter(step.get("expectation", {})))
                    for step in turn["steps"]
                    if "expectation" in step
                ]
                if "agentTransfer" in kinds and "agentResponse" in kinds:
                    assert kinds.index("agentTransfer") < kinds.index("agentResponse"), (
                        f"agentResponse preceded agentTransfer in {gf.name}:{ev['displayName']}"
                    )

    assert seen_personas == set(PERSONA_IDS)

    sim_files = sorted(SIMULATIONS_DIR.glob("*.yaml"))
    assert sim_files, "Expected SimulationEvals YAML under evals/simulations/"
    for sf in sim_files:
        sdata = yaml.safe_load(sf.read_text(encoding="utf-8"))
        assert sdata.get("evals"), f"Empty evals in {sf.name}"
        for item in sdata["evals"]:
            name = item.get("name")
            assert item.get("tags"), f"Missing tags in {sf.name}:{name}"
            assert item.get("steps"), f"Missing steps in {sf.name}:{name}"
            assert item.get("expectations"), f"Missing expectations in {sf.name}:{name}"
            sim_sp = item.get("session_parameters") or {}
            assert set(sim_sp.keys()) <= declared_vars, (
                f"Undeclared session_parameters in {sf.name}:{name}"
            )
            sim_pid = sim_sp.get("persona_id")
            assert sim_pid in PERSONA_IDS, f"Missing/unknown persona_id in {sf.name}:{name}"
            assert sim_sp.get("demo_date") == "2026-11-24"
            assert sim_sp.get("customer_snapshot") == raw_fixtures[sim_pid], (
                f"Simulation customer_snapshot in {sf.name}:{name} drifted from {sim_pid}.json"
            )
