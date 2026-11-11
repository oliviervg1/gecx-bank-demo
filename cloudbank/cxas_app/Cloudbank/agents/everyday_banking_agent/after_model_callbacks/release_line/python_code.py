import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

_DIAGNOSIS_MARKER = "[diagnosis context:"
_CLOSED_SNIPPET_RE = re.compile(
    r"<untrusted_web_snippet\b[^>]*>.*?</\s*untrusted_web_snippet\s*>",
    re.DOTALL | re.IGNORECASE,
)
_UNCLOSED_SNIPPET_RE = re.compile(
    r"<untrusted_web_snippet\b[^>]*>.*\Z",
    re.DOTALL | re.IGNORECASE,
)
_ORPHAN_CLOSE_SNIPPET_RE = re.compile(
    r"</\s*untrusted_web_snippet\s*>",
    re.IGNORECASE,
)
_FORBIDDEN_TOOL_CALLS = frozenset(
    {
        "transfer_to_agent",
        "end_session",
        "search_help",
    }
)
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


def _strip_diagnosis_notes(text: str) -> str:
    """Strip closed/unclosed <untrusted_web_snippet> blocks and [diagnosis context: ...] notes."""
    cleaned = _CLOSED_SNIPPET_RE.sub(" ", text)
    cleaned = _UNCLOSED_SNIPPET_RE.sub(" ", cleaned)
    cleaned = _ORPHAN_CLOSE_SNIPPET_RE.sub(" ", cleaned)
    while True:
        start = cleaned.lower().find(_DIAGNOSIS_MARKER)
        if start == -1:
            break
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
    """Unified after_model_callback: defense-in-depth agent_transfer routing, snippet/diagnosis stripping, Tier 2 UI sync, and session release."""
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

        cleaned: list[Part] = []
        changed = False
        has_controller_call = False
        for p in raw:
            if p.function_call is not None:
                if p.function_call.name in _FORBIDDEN_TOOL_CALLS:
                    changed = True
                    continue
                has_controller_call = True
                cleaned.append(p)
                continue
            if p.text is not None:
                low_text = p.text.lower()
                if _DIAGNOSIS_MARKER in low_text or "untrusted_web_snippet" in low_text:
                    stripped = _strip_diagnosis_notes(p.text)
                    changed = True
                    if stripped:
                        cleaned.append(Part.from_text(text=stripped))
                    continue
            cleaned.append(p)

        # When a valid controller tool call remains, strip any forbidden sibling calls
        # without running end-of-turn transfer, Tier 2 UI, or end_session logic yet.
        if has_controller_call:
            return LlmResponse.from_parts(parts=cleaned) if changed else None

        session_id = callback_context.session_id or ""
        if not _is_call_ended(state):
            raw_target = state.get("target_agent")
            target = str(raw_target or "").strip()
            if raw_target:
                state["target_agent"] = ""
            if target:
                current = (callback_context.agent_name or "").split("/")[-1]
                if target not in _ALLOWED_AGENTS:
                    logger.warning("Blocked transfer to unknown target_agent: %r", target)
                elif target != current:
                    if not session_id.startswith("evaluation"):
                        return LlmResponse.from_parts(
                            parts=[Part.from_agent_transfer(agent=target)]
                        )
                    return LlmResponse.from_parts(
                        parts=cleaned + [Part.from_agent_transfer(agent=target)]
                    )

        tier2_json = ""
        if not session_id.startswith("evaluation"):
            view = dict(state.get("ui_view_state") or {})
            seq = int(view.get("seq") or 0)
            prev_seq = int(state.get("ui_emitted_seq") or "0")
            if seq >= 1:
                if seq > prev_seq:
                    tier2_json = json.dumps(view)
                state["ui_emitted_seq"] = str(seq)

        will_end_session = _is_call_ended(state)
        has_spoken_text = any(
            p.text is not None and bool(p.text.strip()) for p in cleaned
        )
        if not has_spoken_text and (changed or bool(tier2_json) or will_end_session):
            if will_end_session:
                staged_reason = str(state.get("escalation_reason") or "").strip()
                closing_text = (
                    "Thank you for banking with Cloudbank. Goodbye."
                    if staged_reason in ("", "CALL_COMPLETED")
                    else "I am sorry, I ran into an unexpected issue. Goodbye."
                )
                cleaned.insert(0, Part.from_text(text=closing_text))
            else:
                cleaned.insert(0, Part.from_text(text=_SAFE_FALLBACK_TEXT))
            changed = True

        if tier2_json:
            cleaned.append(Part.from_json(data=tier2_json))
            changed = True

        if will_end_session:
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
        return LlmResponse.from_parts(parts=cleaned)
    except Exception:
        logger.exception("release_line failed")
        return _safe_fallback_response()
