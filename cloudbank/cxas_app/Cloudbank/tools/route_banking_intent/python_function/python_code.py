import logging
import math
from datetime import date
from typing import Any, Literal

logger = logging.getLogger(__name__)

_DOMAIN_TARGETS = {
    "EVERYDAY_BANKING": ("everyday_banking_agent", "everyday banking and spending"),
    "SAVINGS": ("savings_agent", "savings pots and goal projections"),
    "MORTGAGES": ("mortgage_agent", "mortgages, overpayments, and fixed-rate options"),
}


def route_banking_intent(
    intent: Literal[
        "",
        "GREETING",
        "EVERYDAY_BANKING",
        "SAVINGS",
        "MORTGAGES",
        "NAVIGATE_HOME",
        "NAVIGATE_PROFILE",
        "CAPABILITIES",
        "UNCLEAR",
        "FAREWELL",
    ] = "",
    topic_hint: str = "",
) -> dict:
    """Classify the caller's opening request and stage the appropriate banking action.

    Pass the intent matching what the caller just asked for and a short summary
    in topic_hint when available. Do not speak a conversational pacing phrase
    before calling this tool; call it immediately.

    Args:
        intent: High-level banking intent spoken by the caller ("GREETING",
            "EVERYDAY_BANKING", "SAVINGS", "MORTGAGES", "NAVIGATE_HOME",
            "NAVIGATE_PROFILE", "CAPABILITIES", "UNCLEAR", or "FAREWELL").
        topic_hint: Short summary of the caller's specific question or request,
            or "" when none was given.

    Returns:
        A single-key dict with ``agent_action`` carrying the spoken reply or
        routing context.
    """
    try:
        clean_intent = (intent or "").strip()
        clean_hint = (topic_hint or "").strip()[:160]
        return _dispatch_route(clean_intent, clean_hint)
    except Exception:
        logger.exception("route_banking_intent failed")
        return {
            "agent_action": "I am sorry, I ran into a temporary issue checking that. Could you tell me again whether you would like help with everyday banking, savings, or mortgages?"
        }


# BEGIN SYNCED_CONTROLLER_COMMON
_PLATFORM_CURRENT_DATE_KEY = "current_date"
_DEFAULT_DEMO_DATE = "2026-11-24"
_DEFAULT_DEMO_YMD = (2026, 11, 24)
_MONTH_NAMES = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)


def _parse_demo_date() -> tuple[int, int, int]:
    """Parse and validate YYYY-MM-DD as a real calendar date in 2000..2100."""
    raw = (
        str(context.state.get("demo_date") or "").strip()
        or str(context.state.get(_PLATFORM_CURRENT_DATE_KEY) or "").strip()
        or _DEFAULT_DEMO_DATE
    )
    parts = raw.split("-")
    if (
        len(parts) == 3
        and len(parts[0]) == 4
        and len(parts[1]) == 2
        and len(parts[2]) == 2
        and all(p.isdigit() for p in parts)
    ):
        year = int(parts[0])
        month = int(parts[1])
        day = int(parts[2])
        if 2000 <= year <= 2100:
            try:
                date(year, month, day)
                return year, month, day
            except ValueError:
                pass
    return _DEFAULT_DEMO_YMD


def _emit_ui_view(payload: dict[str, Any]) -> None:
    """Increment ui_view_state.seq monotonically and attach per-vendor anomaly state on spending views."""
    current = dict(context.state.get("ui_view_state") or {})
    next_seq = int(current.get("seq") or 0) + 1
    updated = dict(payload)
    if updated.get("page") == "spending" and "anomaly_by_vendor" not in updated:
        raw_everyday = context.state.get("everyday_state")
        by_vendor = (
            raw_everyday.get("anomaly_by_vendor")
            if isinstance(raw_everyday, dict)
            else None
        )
        if isinstance(by_vendor, dict) and by_vendor:
            updated["anomaly_by_vendor"] = {
                str(k): str(v)
                for k, v in by_vendor.items()
                if v in ("confirmed", "unrecognised")
            }
    updated["seq"] = next_seq
    context.state["ui_view_state"] = updated


def _format_gbp(amount_pence: int) -> str:
    """Format integer pence as £X,XXX when whole pounds else £X,XXX.XX."""
    sign = "-" if amount_pence < 0 else ""
    pounds, pence = divmod(abs(amount_pence), 100)
    if pence == 0:
        return f"{sign}£{pounds:,}"
    return f"{sign}£{pounds:,}.{pence:02d}"


def _format_bps(rate_bps: int) -> str:
    """Format integer basis points as X.XX%."""
    whole, frac = divmod(abs(rate_bps), 100)
    return f"{whole}.{frac:02d}%"


def _half_up(n: int, d: int) -> int:
    """Exact integer half-up division for n >= 0 and d > 0."""
    return (n * 2 + d) // (2 * d)


def _to_pence(raw: float | int) -> int:
    """Clamp model-supplied pound float to [0, £10M] and convert to integer pence."""
    fx = float(raw or 0.0)
    if not math.isfinite(fx):
        return 0
    clamped = max(0.0, min(fx, 10_000_000.0))
    return int(math.floor(clamped * 100.0 + 0.5))


def _capabilities_message() -> str:
    """Return the shared three-product capabilities summary."""
    return (
        "I can help with everyday banking and spending, your savings pot and goal "
        "projections, or your mortgage payments, overpayments, and fixed-rate renewal "
        "options. Which area would you like to explore?"
    )


def _farewell_response() -> dict[str, str]:
    """Latch session completion, clear handoff state, and return the closing line."""
    first_name = str(context.state.get("first_name") or "").strip()
    context.state["unclear_count"] = "0"
    context.state["handoff_context"] = {}
    context.state["escalation_reason"] = "CALL_COMPLETED"
    context.state["call_complete"] = "true"
    suffix = f", {first_name}" if first_name else ""
    return {
        "agent_action": f"You are very welcome{suffix}. Have a great rest of your day, and goodbye."
    }


def _shared_navigation_response(intent: str) -> dict[str, str]:
    """Handle NAVIGATE_HOME, NAVIGATE_PROFILE, or CAPABILITIES consistently across hub and spokes."""
    context.state["unclear_count"] = "0"
    if intent == "NAVIGATE_HOME":
        context.state["handoff_context"] = {}
        _emit_ui_view({"page": "home"})
        return {
            "agent_action": "I have opened your Home summary on screen. What would you like to check next?"
        }
    if intent == "NAVIGATE_PROFILE":
        context.state["handoff_context"] = {}
        _emit_ui_view({"page": "profile"})
        return {
            "agent_action": "I have opened your Profile page, where your personal details and card controls live. Let me know what else you would like to look at."
        }
    return {"agent_action": _capabilities_message()}


def _increment_unclear(strike_one_prompt: str) -> dict[str, str] | None:
    """Advance two-strike unclear counter; return Strike 1 prompt or None on Strike 2."""
    strikes = int(context.state.get("unclear_count") or "0")
    if strikes == 0:
        context.state["unclear_count"] = "1"
        return {"agent_action": strike_one_prompt}
    context.state["unclear_count"] = "0"
    context.state["handoff_context"] = {}
    return None


def _unclear_reset_home_response() -> dict[str, str]:
    """Navigate to Home and restate capabilities on Strike 2 without ending the session."""
    _emit_ui_view({"page": "home"})
    return {
        "agent_action": f"I have opened your Home summary on screen. {_capabilities_message()}"
    }
# END SYNCED_CONTROLLER_COMMON


def _dispatch_route(intent: str, hint: str) -> dict:
    """Route a normalised top-level intent to its handler."""
    if intent == "FAREWELL":
        return _farewell_response()
    if intent in _DOMAIN_TARGETS:
        return _stage_domain_route(intent, hint)
    if intent == "GREETING":
        context.state["unclear_count"] = "0"
        _emit_ui_view({"page": "home"})
        return {"agent_action": _build_greeting()}
    if intent in ("NAVIGATE_HOME", "NAVIGATE_PROFILE", "CAPABILITIES"):
        return _shared_navigation_response(intent)
    return _handle_unclear()


def _stage_domain_route(intent: str, hint: str) -> dict:
    """Stage silent specialist routing in target_agent."""
    target_agent, label = _DOMAIN_TARGETS[intent]
    context.state["unclear_count"] = "0"
    context.state["target_agent"] = target_agent
    suffix = f": {hint}" if hint else "."
    return {"agent_action": f"Customer asked about {label}{suffix}"}


def _build_greeting() -> str:
    """Compose a time-aware British English greeting."""
    first_name = str(context.state.get("first_name") or "").strip()
    tod = str(context.state.get("time_of_day") or "").strip().lower()
    salutation_map = {
        "morning": "Good morning",
        "afternoon": "Good afternoon",
        "evening": "Good evening",
    }
    salutation = salutation_map.get(tod, "Hello")
    greeting = f"{salutation}, {first_name}." if first_name else f"{salutation}."
    return (
        f"{greeting} I can help with your everyday account and spending, "
        "your savings goals, or your mortgage. What would you like to look at today?"
    )


def _handle_unclear() -> dict:
    """Two-strike non-terminating unclear input ladder."""
    strike_one = _increment_unclear(
        "Sorry, I did not quite catch that. Would you like help with everyday banking, savings, or mortgages?"
    )
    if strike_one is not None:
        return strike_one
    return _unclear_reset_home_response()
