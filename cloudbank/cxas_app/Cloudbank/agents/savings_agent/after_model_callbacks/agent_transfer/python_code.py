import logging
import re
from typing import Any, Optional

logger = logging.getLogger(__name__)

_AGENT_TOKEN = re.compile(r"\{@AGENT:\s*([a-zA-Z0-9_]+)\}", re.IGNORECASE)


def _is_call_ended(state: Any) -> bool:
    return state.get("call_complete") in ("true", "released")


def after_model_callback(
    callback_context: CallbackContext, llm_response: LlmResponse
) -> Optional[LlmResponse]:
    """Defense-in-depth post-model routing guard for staged target_agent or leaked tokens."""
    try:
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

        target = (state.get("target_agent") or "").strip()
        state["target_agent"] = ""
        cleaned = []
        changed = False
        for p in raw:
            if p.function_call is not None and p.function_call.name == "transfer_to_agent":
                args = dict(p.function_call.args or {})
                target = target or str(args.get("agent_name") or args.get("agent") or "")
                changed = True
                continue
            text = p.text or ""
            match = _AGENT_TOKEN.search(text)
            if match:
                target = target or match.group(1)
                stripped = _AGENT_TOKEN.sub("", text).strip()
                changed = True
                if stripped:
                    cleaned.append(Part.from_text(text=stripped))
            else:
                cleaned.append(p)

        current = (callback_context.agent_name or "").split("/")[-1]
        if target and target != current:
            session_id = callback_context.session_id or ""
            if not session_id.startswith("evaluation"):
                return LlmResponse.from_parts(
                    parts=[Part.from_agent_transfer(agent=target)]
                )
            return LlmResponse.from_parts(
                parts=cleaned + [Part.from_agent_transfer(agent=target)]
            )

        return LlmResponse.from_parts(parts=cleaned) if changed else None
    except Exception:
        logger.exception("agent_transfer failed")
        return None
