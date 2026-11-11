import json
import logging

logger = logging.getLogger(__name__)

_MAX_PASSES = 8
_ENABLE_TIER1_PARTIAL_UI = True
_RESTRICTED_TOOLS = ("end_session", "transfer_to_agent", "search_help")
_ALLOWED_AGENTS = frozenset(
    {
        "root_agent",
        "everyday_banking_agent",
        "savings_agent",
        "mortgage_agent",
    }
)
_SAFE_FALLBACK_TEXT = (
    "Sorry, something went wrong on my side. Could you try asking that again?"
)


def _safe_fallback_response() -> LlmResponse:
    """Return a fail-closed spoken apology response when callback state is invalid."""
    return LlmResponse.from_parts(parts=[Part.from_text(text=_SAFE_FALLBACK_TEXT)])


def _hide_restricted_tools(llm_request: LlmRequest) -> bool:
    """Hide restricted tools in an isolated guard so later errors never expose them."""
    all_hidden = True
    for tool_name in _RESTRICTED_TOOLS:
        try:
            llm_request.config.hide_tool(tool_name)
        except Exception:
            logger.exception("capture_utterance failed to hide tool %s", tool_name)
            all_hidden = False
    return all_hidden


def _is_tool_response(llm_request: LlmRequest) -> bool:
    """Return True when the latest content entry is a tool function_response."""
    contents = llm_request.contents or []
    if not contents or not contents[-1].parts:
        return False
    return any(p.function_response is not None for p in contents[-1].parts)


def _last_returned_tool_name(llm_request: LlmRequest) -> str:
    """Return the name of the last tool that returned on this pass, or ''."""
    contents = llm_request.contents or []
    if not contents or not contents[-1].parts:
        return ""
    names = [
        p.function_response.name
        for p in contents[-1].parts
        if p.function_response is not None and p.function_response.name
    ]
    return names[-1] if names else ""


def before_model_callback(
    callback_context: CallbackContext, llm_request: LlmRequest
) -> LlmResponse | None:
    """Guard pass limits, hide internal tools, route silently, and emit Tier 1 UI state."""
    if not _hide_restricted_tools(llm_request):
        return _safe_fallback_response()

    try:
        state = callback_context.state
        if state.get("call_complete") == "released":
            return LlmResponse.from_parts(parts=[Part.from_text(text="")])

        # Track per-invocation pass count as a declared string variable (V101).
        inv_id = callback_context.invocation_id or ""
        if state.get("pass_turn_id") != inv_id:
            state["pass_turn_id"] = inv_id
            count = 1
        else:
            count = int(state.get("pass_count") or "0") + 1
        state["pass_count"] = str(count)

        is_tool_resp = _is_tool_response(llm_request)
        returned_tool = ""
        if is_tool_resp:
            returned_tool = _last_returned_tool_name(llm_request)
            if returned_tool:
                try:
                    llm_request.config.hide_tool(returned_tool)
                except Exception:
                    logger.exception(
                        "capture_utterance failed to hide returned tool %s", returned_tool
                    )

            target = str(state.get("target_agent") or "").strip()
            if target:
                state["target_agent"] = ""
                current = (callback_context.agent_name or "").split("/")[-1]
                if target not in _ALLOWED_AGENTS:
                    logger.warning("Blocked transfer to unknown target_agent: %r", target)
                elif target != current:
                    return LlmResponse.from_parts(
                        parts=[Part.from_agent_transfer(agent=target)]
                    )

        # Loop-cap guard runs BEFORE Tier 1 partial UI return so runaway passes always stop.
        if count > _MAX_PASSES:
            target = str(state.get("target_agent") or "").strip()
            if target:
                state["target_agent"] = ""
                current = (callback_context.agent_name or "").split("/")[-1]
                if target in _ALLOWED_AGENTS and target != current:
                    return LlmResponse.from_parts(
                        parts=[Part.from_agent_transfer(agent=target)]
                    )
            reason = str(state.get("escalation_reason") or "").strip() or (
                "CALL_COMPLETED"
                if state.get("call_complete") == "true"
                else "MAX_PASSES_EXCEEDED"
            )
            state["call_complete"] = "released"
            state["escalation_reason"] = reason
            return LlmResponse.from_parts(
                parts=[
                    Part.from_text(
                        text="I am sorry, I ran into an unexpected snag processing that request. "
                    ),
                    Part.from_end_session(
                        reason=reason,
                        escalated=(reason != "CALL_COMPLETED"),
                    ),
                ]
            )

        # Post-tool Tier 1 partial UI emission (BidiRunSession streams JSON without suppressing LLM speech).
        session_id = callback_context.session_id or ""
        if (
            is_tool_resp
            and _ENABLE_TIER1_PARTIAL_UI
            and returned_tool != "transfer_to_agent"
            and not session_id.startswith("evaluation")
        ):
            view = dict(state.get("ui_view_state") or {})
            seq = int(view.get("seq") or 0)
            prev_seq = int(state.get("ui_emitted_seq") or "0")
            if seq >= 1 and seq > prev_seq:
                payload_json = json.dumps(view)
                state["ui_emitted_seq"] = str(seq)
                resp = LlmResponse.from_parts(
                    parts=[Part.from_json(data=payload_json)]
                )
                resp.partial = True
                return resp

        return None
    except Exception:
        logger.exception("capture_utterance failed")
        return _safe_fallback_response()
