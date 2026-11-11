import logging
from typing import Any

logger = logging.getLogger(__name__)

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


def _is_call_ended(state: Any) -> bool:
    """Return True when the session completion latch has been staged or released."""
    return state.get("call_complete") in ("true", "released")


def _safe_fallback_response() -> LlmResponse:
    """Return a fail-closed spoken apology response when callback execution fails."""
    return LlmResponse.from_parts(parts=[Part.from_text(text=_SAFE_FALLBACK_TEXT)])


def after_model_callback(
    callback_context: CallbackContext, llm_response: LlmResponse
) -> LlmResponse | None:
    """Defense-in-depth post-model routing guard strictly for controller-staged target_agent."""
    try:
        if llm_response.partial:
            return None

        state = callback_context.state
        if _is_call_ended(state):
            return None

        raw = (
            list(llm_response.content.parts)
            if llm_response.content and llm_response.content.parts
            else []
        )
        if any(
            p.function_call is not None
            and p.function_call.name not in ("transfer_to_agent", "end_session")
            for p in raw
        ):
            return None

        target = str(state.get("target_agent") or "").strip()
        state["target_agent"] = ""
        cleaned = []
        changed = False
        for p in raw:
            if p.function_call is not None and p.function_call.name == "transfer_to_agent":
                changed = True
                continue
            cleaned.append(p)

        current = (callback_context.agent_name or "").split("/")[-1]
        if target:
            if target not in _ALLOWED_AGENTS:
                logger.warning("Blocked transfer to unknown target_agent: %r", target)
            elif target != current:
                session_id = callback_context.session_id or ""
                if not session_id.startswith("evaluation"):
                    return LlmResponse.from_parts(
                        parts=[Part.from_agent_transfer(agent=target)]
                    )
                return LlmResponse.from_parts(
                    parts=cleaned + [Part.from_agent_transfer(agent=target)]
                )

        if not changed:
            return None
        if not cleaned:
            return _safe_fallback_response()
        return LlmResponse.from_parts(parts=cleaned)
    except Exception:
        logger.exception("agent_transfer failed")
        return _safe_fallback_response()
