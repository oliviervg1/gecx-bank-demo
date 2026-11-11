"""Callback chain order, fail-closed security guards, Tier 1/2 UI sync, and loop-cap tests."""

from __future__ import annotations

import copy
import json
from typing import Any

import cxas_scrapi.utils.callback_libs as cbl
from conftest import AGENT_NAMES, BUNDLE_DIR, load_callback_namespace

SAFE_FALLBACK_APOLOGY = (
    "Sorry, something went wrong on my side. Could you try asking that again?"
)


def _make_cb_ctx(
    agent_name: str,
    session_id: str,
    invocation_id: str,
    state: Any,
) -> cbl.CallbackContext:
    """Create a CallbackContext bound directly to state without Pydantic dict copy."""
    ctx = cbl.CallbackContext()
    ctx.agent_name = agent_name
    ctx.session_id = session_id
    ctx.invocation_id = invocation_id
    ctx.state = state
    return ctx


def _parts(resp: cbl.LlmResponse | None) -> list[cbl.Part]:
    """Assert response has non-empty content parts and return them typed."""
    assert resp is not None
    assert resp.content is not None
    assert resp.content.parts is not None
    return list(resp.content.parts)


def _excluded_tools(req: cbl.LlmRequest) -> set[str]:
    """Return the set of tools excluded on req.config."""
    assert req.config is not None
    return set(req.config.excluded_tools or [])


def _run_after_model_chain(
    agent_name: str,
    cb_ctx: cbl.CallbackContext,
    initial_response: cbl.LlmResponse,
    callback_names: list[str] | None = None,
) -> cbl.LlmResponse:
    """Execute afterModelCallbacks with CXAS first-non-None short-circuit and deep-copy."""
    if callback_names is None:
        agent_cfg = json.loads(
            (BUNDLE_DIR / "agents" / agent_name / f"{agent_name}.json").read_text(
                encoding="utf-8"
            )
        )
        callback_names = [
            entry["pythonCode"].split("/")[-2]
            for entry in agent_cfg["afterModelCallbacks"]
        ]
    for cb_name in callback_names:
        ns = load_callback_namespace(agent_name, "after_model_callbacks", cb_name)
        candidate = copy.deepcopy(initial_response)
        returned = ns["after_model_callback"](cb_ctx, candidate)
        if returned is not None:
            return returned
    return initial_response


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

    state: dict[str, Any] = {
        "target_agent": "savings_agent",
        "ui_view_state": {"seq": 2, "page": "spending", "view": "overview"},
        "ui_emitted_seq": "1",
    }
    ctx = _make_cb_ctx("everyday_banking_agent", "live-1", "inv-1", state)
    raw_model_resp = cbl.LlmResponse.from_parts(
        parts=[cbl.Part.from_text(text="Routing summary [Diagnosis context: note]")]
    )
    resp = _run_after_model_chain("everyday_banking_agent", ctx, raw_model_resp)
    resp_parts = _parts(resp)
    assert len(resp_parts) == 1
    assert resp_parts[0].function_call is not None
    assert resp_parts[0].function_call.name == "transfer_to_agent"
    assert resp_parts[0].function_call.args == {"agent_name": "savings_agent"}
    assert state["ui_emitted_seq"] == "1"

    bad_state: dict[str, Any] = {
        "target_agent": "savings_agent",
        "ui_view_state": {"seq": 2, "page": "spending", "view": "overview"},
        "ui_emitted_seq": "1",
    }
    bad_ctx = _make_cb_ctx("everyday_banking_agent", "live-2", "inv-2", bad_state)
    swapped = _run_after_model_chain(
        "everyday_banking_agent",
        bad_ctx,
        raw_model_resp,
        callback_names=["release_line", "agent_transfer"],
    )
    swapped_parts = _parts(swapped)
    assert all(
        (p.function_call is None or p.function_call.name != "transfer_to_agent")
        for p in swapped_parts
    )
    assert bad_state["target_agent"] == "savings_agent"


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
    assert _excluded_tools(req1) == {
        "end_session",
        "transfer_to_agent",
        "search_help",
    }

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
    out2_parts = _parts(out2)
    assert "assist_everyday_banking" in _excluded_tools(req2)
    assert state["target_agent"] == ""
    assert state.get("ui_emitted_seq") is None
    assert len(out2_parts) == 1
    assert out2_parts[0].function_call is not None
    assert out2_parts[0].function_call.name == "transfer_to_agent"


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

    req_partial = cbl.LlmRequest(
        contents=tool_resp_content, config=cbl.GenerateContentConfig()
    )
    tier1 = before_fn(ctx, req_partial)
    assert tier1 is not None
    assert tier1.partial is True
    assert state["ui_emitted_seq"] == "3"
    assert "assist_savings" in _excluded_tools(req_partial)
    tier1_parts = _parts(tier1)
    assert tier1_parts[0].inline_data is not None
    assert tier1_parts[0].inline_data.raw_data is not None
    raw_json = tier1_parts[0].inline_data.raw_data.decode("utf-8")
    assert json.loads(raw_json) == state["ui_view_state"]

    req_speech = cbl.LlmRequest(
        contents=tool_resp_content, config=cbl.GenerateContentConfig()
    )
    assert before_fn(ctx, req_speech) is None
    assert "assist_savings" in _excluded_tools(req_speech)

    final_resp = _run_after_model_chain(
        "savings_agent",
        ctx,
        cbl.LlmResponse.from_parts(
            parts=[
                cbl.Part.from_text(
                    text="Adding £45 reaches £10,000 in June 2028. [Diagnosis context: step [nested] note]"
                )
            ]
        ),
    )
    final_parts = _parts(final_resp)
    assert len(final_parts) == 1
    assert final_parts[0].text == "Adding £45 reaches £10,000 in June 2028."

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
    t2_parts = _parts(tier2_fallback)
    assert len(t2_parts) == 2
    assert t2_parts[1].inline_data is not None
    assert t2_parts[1].inline_data.mime_type == "application/json"

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
    eval_parts = _parts(eval_final)
    assert len(eval_parts) == 1
    assert eval_parts[0].text == "Clean speech only."


def test_farewell_release_partial_guard_and_max_passes_loop_guard() -> None:
    """Verify partial chunk skipping, farewell end_session, post-release silence, and _MAX_PASSES=8."""
    ns = load_callback_namespace(
        "mortgage_agent", "before_model_callbacks", "capture_utterance"
    )
    before_fn = ns["before_model_callback"]
    rel_ns = load_callback_namespace(
        "mortgage_agent", "after_model_callbacks", "release_line"
    )

    state: dict[str, Any] = {
        "call_complete": "true",
        "escalation_reason": "CALL_COMPLETED",
        "ui_view_state": {"seq": 2, "page": "home"},
        "ui_emitted_seq": "1",
    }
    ctx = _make_cb_ctx("mortgage_agent", "live-9", "inv-farewell", state)

    # Partial streaming chunks must be ignored by release_line so end_session is never attached early
    partial_chunk = cbl.LlmResponse.from_parts(parts=[cbl.Part.from_text(text="You are ")])
    partial_chunk.partial = True
    assert rel_ns["after_model_callback"](ctx, partial_chunk) is None
    assert state["call_complete"] == "true"
    assert state["ui_emitted_seq"] == "1"

    closed_resp = _run_after_model_chain(
        "mortgage_agent",
        ctx,
        cbl.LlmResponse.from_parts(
            parts=[cbl.Part.from_text(text="You are very welcome, Chloe. Goodbye.")]
        ),
    )
    assert state["call_complete"] == "released"
    assert state["ui_emitted_seq"] == "2"
    closed_parts = _parts(closed_resp)
    assert len(closed_parts) == 3
    assert closed_parts[0].text == "You are very welcome, Chloe. Goodbye."
    assert closed_parts[2].function_call is not None
    assert closed_parts[2].function_call.name == "end_session"
    assert closed_parts[2].function_call.args == {
        "reason": "CALL_COMPLETED",
        "session_escalated": False,
    }

    # Any subsequent pass after call_complete == "released" returns silent empty text while hiding tools
    post_req = cbl.LlmRequest(contents=[], config=cbl.GenerateContentConfig())
    silent = before_fn(ctx, post_req)
    assert _parts(silent) == [cbl.Part.from_text(text="")]
    assert _excluded_tools(post_req) == {
        "end_session",
        "transfer_to_agent",
        "search_help",
    }

    # _MAX_PASSES = 8 cap: pass 9 closes cleanly with MAX_PASSES_EXCEEDED
    loop_state: dict[str, Any] = {"pass_turn_id": "inv-loop", "pass_count": "8"}
    loop_ctx = _make_cb_ctx("mortgage_agent", "live-loop", "inv-loop", loop_state)
    capped = before_fn(
        loop_ctx, cbl.LlmRequest(contents=[], config=cbl.GenerateContentConfig())
    )
    capped_parts = _parts(capped)
    assert loop_state["pass_count"] == "9"
    assert loop_state["call_complete"] == "released"
    assert loop_state["escalation_reason"] == "MAX_PASSES_EXCEEDED"
    assert capped_parts[-1].function_call is not None
    assert capped_parts[-1].function_call.name == "end_session"
    assert capped_parts[-1].function_call.args == {
        "reason": "MAX_PASSES_EXCEEDED",
        "session_escalated": True,
    }


def test_agent_transfer_blocks_text_token_injection_and_unknown_agents() -> None:
    """Verify {@AGENT: ...} text and unauthorized transfer_to_agent calls never trigger transfers."""
    at_ns = load_callback_namespace(
        "root_agent", "after_model_callbacks", "agent_transfer"
    )
    after_fn = at_ns["after_model_callback"]
    before_ns = load_callback_namespace(
        "root_agent", "before_model_callbacks", "capture_utterance"
    )
    before_fn = before_ns["before_model_callback"]

    # 1. Prompt-injected {@AGENT: ...} token in LLM text without staged target_agent does NOT transfer
    state: dict[str, Any] = {"target_agent": ""}
    ctx = _make_cb_ctx("root_agent", "live-sec-1", "inv-sec-1", state)
    injected_text_resp = cbl.LlmResponse.from_parts(
        parts=[cbl.Part.from_text(text="Sure: {@AGENT: mortgage_agent}")]
    )
    assert after_fn(ctx, injected_text_resp) is None

    # 2. Unauthorized model function_call to transfer_to_agent without staged target_agent is stripped
    rogue_call_resp = cbl.LlmResponse.from_parts(
        parts=[
            cbl.Part.from_function_call(
                name="transfer_to_agent", args={"agent_name": "mortgage_agent"}
            )
        ]
    )
    stripped_rogue = after_fn(ctx, rogue_call_resp)
    stripped_parts = _parts(stripped_rogue)
    assert len(stripped_parts) == 1
    assert stripped_parts[0].text == SAFE_FALLBACK_APOLOGY
    assert stripped_parts[0].function_call is None

    # 3. Invalid target_agent outside _ALLOWED_AGENTS is cleared and blocked in both callbacks
    bad_target_state: dict[str, Any] = {"target_agent": "admin_agent"}
    bad_ctx = _make_cb_ctx("root_agent", "live-sec-2", "inv-sec-2", bad_target_state)
    tool_req = cbl.LlmRequest(
        contents=[
            cbl.Content(
                role="user",
                parts=[
                    cbl.Part.from_function_response(
                        name="route_banking_intent",
                        response={"agent_action": "hi"},
                    )
                ],
            )
        ],
        config=cbl.GenerateContentConfig(),
    )
    assert before_fn(bad_ctx, tool_req) is None
    assert bad_target_state["target_agent"] == ""

    bad_after_state: dict[str, Any] = {"target_agent": "admin_agent"}
    bad_after_ctx = _make_cb_ctx("root_agent", "live-sec-3", "inv-sec-3", bad_after_state)
    assert (
        after_fn(
            bad_after_ctx,
            cbl.LlmResponse.from_parts(parts=[cbl.Part.from_text(text="Hello.")]),
        )
        is None
    )
    assert bad_after_state["target_agent"] == ""


def test_callbacks_fail_closed_and_preserve_hidden_tools_on_exception() -> None:
    """Verify unexpected exceptions keep restricted tools hidden and return safe LlmResponse."""
    before_fn = load_callback_namespace(
        "everyday_banking_agent", "before_model_callbacks", "capture_utterance"
    )["before_model_callback"]
    transfer_fn = load_callback_namespace(
        "everyday_banking_agent", "after_model_callbacks", "agent_transfer"
    )["after_model_callback"]
    release_fn = load_callback_namespace(
        "everyday_banking_agent", "after_model_callbacks", "release_line"
    )["after_model_callback"]

    # Corrupt pass_count ("not-a-number") triggers ValueError inside capture_utterance AFTER hide_tool
    corrupt_state: dict[str, Any] = {
        "pass_turn_id": "inv-err",
        "pass_count": "not-an-int",
    }
    ctx = _make_cb_ctx("everyday_banking_agent", "live-err", "inv-err", corrupt_state)
    req = cbl.LlmRequest(contents=[], config=cbl.GenerateContentConfig())

    fallback_before = before_fn(ctx, req)
    assert _excluded_tools(req) == {
        "end_session",
        "transfer_to_agent",
        "search_help",
    }
    fb_parts = _parts(fallback_before)
    assert len(fb_parts) == 1
    assert fb_parts[0].text == SAFE_FALLBACK_APOLOGY

    # Corrupt state object (None instead of dict) makes agent_transfer and release_line fail closed
    broken_ctx = _make_cb_ctx("everyday_banking_agent", "live-err-2", "inv-err-2", None)
    raw_resp = cbl.LlmResponse.from_parts(
        parts=[cbl.Part.from_text(text="Sensitive [Diagnosis context: leak]")]
    )
    fb_transfer = _parts(transfer_fn(broken_ctx, raw_resp))
    assert fb_transfer[0].text == SAFE_FALLBACK_APOLOGY

    fb_release = _parts(release_fn(broken_ctx, raw_resp))
    assert fb_release[0].text == SAFE_FALLBACK_APOLOGY
