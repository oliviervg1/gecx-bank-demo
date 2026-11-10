import json
import logging
import re
from typing import Any, Optional

logger = logging.getLogger(__name__)

_DIAGNOSIS_NOTE_RE = re.compile(r"\s*\[Diagnosis context:.*?\]\s*", re.DOTALL)


def _is_call_ended(state: Any) -> bool:
    return state.get("call_complete") in ("true", "released")


def after_model_callback(
    callback_context: CallbackContext, llm_response: LlmResponse
) -> Optional[LlmResponse]:
    """Strip diagnosis notes, stamp Tier 2 UI state, and append end_session when complete."""
    try:
        state = callback_context.state
        if state.get("call_complete") == "released":
            return None

        raw = (
            list(llm_response.content.parts)
            if llm_response.content and llm_response.content.parts
            else []
        )
        if any(
            p.function_call is not None and p.function_call.name != "end_session"
            for p in raw
        ):
            return None

        cleaned = []
        changed = False
        for p in raw:
            if p.function_call is not None and p.function_call.name == "end_session":
                changed = True
                continue
            if p.text is not None and "[Diagnosis context:" in p.text:
                stripped = _DIAGNOSIS_NOTE_RE.sub(" ", p.text).strip()
                changed = True
                if stripped:
                    cleaned.append(Part.from_text(text=stripped))
            else:
                cleaned.append(p)

        session_id = callback_context.session_id or ""
        if not session_id.startswith("evaluation"):
            view = dict(state.get("ui_view_state") or {})
            seq = int(view.get("seq") or 0)
            prev_seq = int(state.get("ui_emitted_seq") or "0")
            if seq >= 1:
                state["ui_emitted_seq"] = str(seq)
                if seq > prev_seq:
                    cleaned.append(Part.from_json(data=json.dumps(view)))
                    changed = True

        if _is_call_ended(state):
            reason = (state.get("escalation_reason") or "").strip() or "CALL_COMPLETED"
            state["call_complete"] = "released"
            state["escalation_reason"] = reason
            cleaned.append(
                Part.from_end_session(
                    reason=reason,
                    escalated=(reason != "CALL_COMPLETED"),
                )
            )
            changed = True

        return LlmResponse.from_parts(parts=cleaned) if changed else None
    except Exception:
        logger.exception("release_line failed")
        return None
