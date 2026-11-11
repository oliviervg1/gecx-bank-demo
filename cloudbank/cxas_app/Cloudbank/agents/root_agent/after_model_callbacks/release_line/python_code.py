import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

_DIAGNOSIS_PREFIX = "[Diagnosis context:"
_UNTRUSTED_SNIPPET_RE = re.compile(
    r"<untrusted_web_snippet>.*?</untrusted_web_snippet>",
    re.DOTALL | re.IGNORECASE,
)
_SAFE_FALLBACK_TEXT = (
    "Sorry, something went wrong on my side. Could you try asking that again?"
)


def _is_call_ended(state: Any) -> bool:
    """Return True when the session completion latch has been staged or released."""
    return state.get("call_complete") in ("true", "released")


def _strip_diagnosis_notes(text: str) -> str:
    """Strip bracket-balanced [Diagnosis context: ...] blocks and untrusted snippet tags."""
    cleaned = _UNTRUSTED_SNIPPET_RE.sub(" ", text)
    while _DIAGNOSIS_PREFIX in cleaned:
        start = cleaned.find(_DIAGNOSIS_PREFIX)
        depth = 0
        end = len(cleaned)
        for idx in range(start, len(cleaned)):
            ch = cleaned[idx]
            if ch == "[":
                depth += 1
            elif ch == "]":
                depth -= 1
                if depth == 0:
                    end = idx + 1
                    break
        cleaned = f"{cleaned[:start]} {cleaned[end:]}"
    return " ".join(cleaned.split())


def _safe_fallback_response() -> LlmResponse:
    """Return a fail-closed spoken apology response when callback execution fails."""
    return LlmResponse.from_parts(parts=[Part.from_text(text=_SAFE_FALLBACK_TEXT)])


def after_model_callback(
    callback_context: CallbackContext, llm_response: LlmResponse
) -> LlmResponse | None:
    """Strip diagnosis notes, stamp Tier 2 UI state, and append end_session when complete."""
    try:
        if llm_response.partial:
            return None

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
            if p.text is not None and (
                _DIAGNOSIS_PREFIX in p.text or "<untrusted_web_snippet>" in p.text.lower()
            ):
                stripped = _strip_diagnosis_notes(p.text)
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
            reason = str(state.get("escalation_reason") or "").strip() or "CALL_COMPLETED"
            state["call_complete"] = "released"
            state["escalation_reason"] = reason
            cleaned.append(
                Part.from_end_session(
                    reason=reason,
                    escalated=(reason != "CALL_COMPLETED"),
                )
            )
            changed = True

        if not changed:
            return None
        if not cleaned:
            return _safe_fallback_response()
        return LlmResponse.from_parts(parts=cleaned)
    except Exception:
        logger.exception("release_line failed")
        return _safe_fallback_response()
