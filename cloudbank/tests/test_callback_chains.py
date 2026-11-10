"""Callback chain order, platform None-mutation asymmetry, Tier 1/2 UI sync, and loop-cap tests."""

from __future__ import annotations

import copy
import json
from typing import Any

import cxas_scrapi.utils.callback_libs as cbl

from conftest import AGENT_NAMES, BUNDLE_DIR, load_callback_namespace


def _make_cb_ctx(
    agent_name: str,
    session_id: str,
    invocation_id: str,
    state: dict[str, Any],
) -> cbl.CallbackContext:
    """Create a CallbackContext bound directly to state without Pydantic dict copy."""
    ctx = cbl.CallbackContext(
        agent_name=agent_name,
        session_id=session_id,
        invocation_id=invocation_id,
    )
    ctx.state = state
    return ctx


def _run_after_model_chain(
    agent_name: str,
    cb_ctx: cbl.CallbackContext,
    initial_response: cbl.LlmResponse,
) -> cbl.LlmResponse:
    """Execute afterModelCallbacks in exact <agent>.json order with deep-copy per callback."""
    agent_cfg = json.loads(
        (BUNDLE_DIR / "agents" / agent_name / f"{agent_name}.json").read_text(
            encoding="utf-8"
        )
    )
    active = initial_response
    for entry in agent_cfg["afterModelCallbacks"]:
        cb_name = entry["pythonCode"].split("/")[-2]
        ns = load_callback_namespace(agent_name, "after_model_callbacks", cb_name)
        # Deep-copy models CXAS's None-mutation asymmetry: in-place edits returning None are dropped.
        candidate = copy.deepcopy(active)
        returned = ns["after_model_callback"](cb_ctx, candidate)
        if returned is not None:
            active = returned
    return active


def test_callback_chain_order_pinned_across_all_agents() -> None:
    """Pin exact callback order in every <agent>.json and prove why agent_transfer precedes release_line."""
    for name in AGENT_NAMES:
        cfg = json.loads(
            (BUNDLE_DIR / "agents" / name / f"{name}.json").read_text(encoding="utf-8")
        )
        before_paths = [c["pythonCode"] for c in cfg["beforeModelCallbacks"]]
        after_paths = [c["pythonCode"] for c in cfg["afterModelCallbacks"]]
        assert before_paths == [
            f"agents/{name}/before_model_callbacks/capture_utterance/python_code.py"
        ]
        assert after_paths == [
            f"agents/{name}/after_model_callbacks/agent_transfer/python_code.py",
            f"agents/{name}/after_model_callbacks/release_line/python_code.py",
        ]

    # Reason proof: when agent_transfer fires first on defense-in-depth target_agent,
    # release_line sees function_call="transfer_to_agent" and skips stamping ui_emitted_seq,
    # preserving the pending UI sequence for the destination agent.
    state: dict[str, Any] = {
        "target_agent": "savings_agent",
        "ui_view_state": {"seq": 2, "page": "spending", "view": "overview"},
        "ui_emitted_seq": "1",
    }
    ctx = _make_cb_ctx("everyday_banking_agent", "live-1", "inv-1", state)
    resp = _run_after_model_chain(
        "everyday_banking_agent",
        ctx,
        cbl.LlmResponse.from_parts(parts=[cbl.Part.from_text(text="Routing summary")]),
    )
    assert len(resp.content.parts) == 1
    assert resp.content.parts[0].function_call.name == "transfer_to_agent"
    assert resp.content.parts[0].function_call.args == {"agent_name": "savings_agent"}
    assert state["ui_emitted_seq"] == "1"


def test_capture_utterance_hides_tools_extracts_digits_and_routes_before_tier1() -> None:
    """Verify tool hiding order, unredacted 4+ digit utterance capture, and silent transfer."""
    ns = load_callback_namespace(
        "everyday_banking_agent", "before_model_callbacks", "capture_utterance"
    )
    before_fn = ns["before_model_callback"]

    state: dict[str, Any] = {}
    ctx = _make_cb_ctx(
        "projects/p/locations/eu/apps/c/agents/everyday_banking_agent",
        "live-session-1",
        "turn-1",
        state,
    )

    # Pass 1: user turn with platform tags and 5-digit pound number 15000 (must NOT be redacted)
    req1 = cbl.LlmRequest(
        contents=[
            cbl.Content(
                role="user",
                parts=[
                    cbl.Part.from_text(
                        text="<context>meta</context> What if my goal target is 15000 pounds?"
                    )
                ],
            )
        ],
        config=cbl.GenerateContentConfig(),
    )
    out1 = before_fn(ctx, req1)
    assert out1 is None
    assert state["pass_count"] == "1"
    assert state["last_user_utterance"] == "What if my goal target is 15000 pounds?"
    assert set(req1.config.excluded_tools or []) == {
        "end_session",
        "transfer_to_agent",
        "search_help",
    }

    # Pass 2: post-tool pass with staged target_agent -> hides returned controller FIRST, then transfers silently
    state["target_agent"] = "savings_agent"
    state["ui_view_state"] = {"seq": 1, "page": "savings", "extra_monthly_pence": 4500}
    req2 = cbl.LlmRequest(
        contents=[
            cbl.Content(
                role="user",
                parts=[
                    cbl.Part.from_function_response(
                        name="assist_everyday_banking",
                        response={"agent_action": "Customer wants to explore savings."},
                    )
                ],
            )
        ],
        config=cbl.GenerateContentConfig(),
    )
    out2 = before_fn(ctx, req2)
    assert out2 is not None
    assert "assist_everyday_banking" in (req2.config.excluded_tools or [])
    assert state["target_agent"] == ""
    # Source agent skips Tier 1 UI emission when transferring
    assert state.get("ui_emitted_seq") is None
    assert len(out2.content.parts) == 1
    assert out2.content.parts[0].function_call.name == "transfer_to_agent"


def test_tier1_partial_ui_cursor_tier2_fallback_and_evaluation_suppression() -> None:
    """Verify Tier 1 partial=True emits once per seq, Tier 2 avoids duplicates, and evals suppress JSON."""
    ns = load_callback_namespace(
        "savings_agent", "before_model_callbacks", "capture_utterance"
    )
    before_fn = ns["before_model_callback"]

    state: dict[str, Any] = {
        "pass_turn_id": "turn-3",
        "pass_count": "1",
        "ui_view_state": {"seq": 3, "page": "savings", "extra_monthly_pence": 4500},
        "ui_emitted_seq": "2",
    }
    ctx = _make_cb_ctx("savings_agent", "live-session-3", "turn-3", state)

    tool_resp_content = [
        cbl.Content(
            role="user",
            parts=[
                cbl.Part.from_function_response(
                    name="assist_savings",
                    response={"agent_action": "Adding £45.00 reaches £10,000 in June 2028."},
                )
            ],
        )
    ]

    # Pass 2: Tier 1 emits partial=True JSON and stamps ui_emitted_seq = "3"
    req_partial = cbl.LlmRequest(
        contents=tool_resp_content, config=cbl.GenerateContentConfig()
    )
    tier1 = before_fn(ctx, req_partial)
    assert tier1 is not None
    assert tier1.partial is True
    assert state["ui_emitted_seq"] == "3"
    assert "assist_savings" in (req_partial.config.excluded_tools or [])
    raw_json = tier1.content.parts[0].inline_data.raw_data.decode("utf-8")
    assert json.loads(raw_json) == state["ui_view_state"]

    # Pass 3 (immediate follow-up LLM pass): cursor prevents infinite partial loop while still hiding assist_savings
    req_speech = cbl.LlmRequest(
        contents=tool_resp_content, config=cbl.GenerateContentConfig()
    )
    assert before_fn(ctx, req_speech) is None
    assert "assist_savings" in (req_speech.config.excluded_tools or [])

    # Tier 2 (release_line): strips [Diagnosis context: ...] without duplicating Part.from_json
    final_resp = _run_after_model_chain(
        "savings_agent",
        ctx,
        cbl.LlmResponse.from_parts(
            parts=[
                cbl.Part.from_text(
                    text="Adding £45 reaches £10,000 in June 2028. [Diagnosis context: internal]"
                )
            ]
        ),
    )
    assert len(final_resp.content.parts) == 1
    assert final_resp.content.parts[0].text == "Adding £45 reaches £10,000 in June 2028."

    # Tier 1 off-switch fallback: when _ENABLE_TIER1_PARTIAL_UI is False, Tier 2 delivers Part.from_json
    ns["_ENABLE_TIER1_PARTIAL_UI"] = False
    state["ui_view_state"] = {"seq": 4, "page": "savings", "extra_monthly_pence": 10000}
    req_tier1_off = cbl.LlmRequest(
        contents=tool_resp_content, config=cbl.GenerateContentConfig()
    )
    assert before_fn(ctx, req_tier1_off) is None
    assert state["ui_emitted_seq"] == "3"
    tier2_fallback = _run_after_model_chain(
        "savings_agent",
        ctx,
        cbl.LlmResponse.from_parts(parts=[cbl.Part.from_text(text="Saved in 16 months.")]),
    )
    assert state["ui_emitted_seq"] == "4"
    assert len(tier2_fallback.content.parts) == 2
    assert tier2_fallback.content.parts[1].inline_data.mime_type == "application/json"

    # Evaluation sessions suppress both Tier 1 and Tier 2 Part.from_json blobs
    ns["_ENABLE_TIER1_PARTIAL_UI"] = True
    eval_state: dict[str, Any] = {
        "ui_view_state": {"seq": 1, "page": "savings", "extra_monthly_pence": 4500},
        "ui_emitted_seq": "0",
    }
    eval_ctx = _make_cb_ctx(
        "savings_agent", "evaluation-run-123", "eval-inv-1", eval_state
    )
    assert (
        before_fn(
            eval_ctx,
            cbl.LlmRequest(contents=tool_resp_content, config=cbl.GenerateContentConfig()),
        )
        is None
    )
    eval_final = _run_after_model_chain(
        "savings_agent",
        eval_ctx,
        cbl.LlmResponse.from_parts(parts=[cbl.Part.from_text(text="Clean speech only.")]),
    )
    assert len(eval_final.content.parts) == 1
    assert eval_final.content.parts[0].text == "Clean speech only."


def test_farewell_release_and_max_passes_loop_guard() -> None:
    """Verify farewell appends end_session(CALL_COMPLETED), silences post-release, and caps _MAX_PASSES=8."""
    ns = load_callback_namespace(
        "mortgage_agent", "before_model_callbacks", "capture_utterance"
    )
    before_fn = ns["before_model_callback"]

    state: dict[str, Any] = {
        "call_complete": "true",
        "escalation_reason": "CALL_COMPLETED",
    }
    ctx = _make_cb_ctx("mortgage_agent", "live-9", "inv-farewell", state)
    closed_resp = _run_after_model_chain(
        "mortgage_agent",
        ctx,
        cbl.LlmResponse.from_parts(
            parts=[cbl.Part.from_text(text="You are very welcome, Chloe. Goodbye.")]
        ),
    )
    assert state["call_complete"] == "released"
    assert len(closed_resp.content.parts) == 2
    assert closed_resp.content.parts[0].text == "You are very welcome, Chloe. Goodbye."
    assert closed_resp.content.parts[1].function_call.name == "end_session"
    assert closed_resp.content.parts[1].function_call.args == {
        "reason": "CALL_COMPLETED",
        "session_escalated": False,
    }

    # Any subsequent pass after call_complete == "released" returns silent empty text (C018-safe)
    silent = before_fn(
        ctx, cbl.LlmRequest(contents=[], config=cbl.GenerateContentConfig())
    )
    assert silent is not None
    assert silent.content.parts == [cbl.Part.from_text(text="")]

    # _MAX_PASSES = 8 cap: pass 9 closes cleanly with MAX_PASSES_EXCEEDED
    loop_state: dict[str, Any] = {"pass_turn_id": "inv-loop", "pass_count": "8"}
    loop_ctx = _make_cb_ctx("mortgage_agent", "live-loop", "inv-loop", loop_state)
    capped = before_fn(
        loop_ctx, cbl.LlmRequest(contents=[], config=cbl.GenerateContentConfig())
    )
    assert capped is not None
    assert loop_state["pass_count"] == "9"
    assert loop_state["call_complete"] == "released"
    assert loop_state["escalation_reason"] == "MAX_PASSES_EXCEEDED"
    assert capped.content.parts[-1].function_call.name == "end_session"
    assert capped.content.parts[-1].function_call.args == {
        "reason": "MAX_PASSES_EXCEEDED",
        "session_escalated": True,
    }
