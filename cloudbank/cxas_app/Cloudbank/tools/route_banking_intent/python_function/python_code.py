import logging
from typing import Literal

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
    in topic_hint when available.

    Do not speak a conversational pacing phrase before calling this tool; call
    it immediately so the caller hears only the post-tool response.

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
        clean_hint = (topic_hint or "").strip()

        if clean_intent == "FAREWELL":
            return _handle_farewell()

        if clean_intent in _DOMAIN_TARGETS:
            return _stage_domain_route(clean_intent, clean_hint)

        if clean_intent == "GREETING":
            context.state["unclear_count"] = "0"
            _emit_ui_view({"page": "home"})
            return {"agent_action": _build_greeting()}

        if clean_intent == "NAVIGATE_HOME":
            context.state["unclear_count"] = "0"
            _emit_ui_view({"page": "home"})
            return {
                "agent_action": "I have opened your Home summary. Would you like to look into your spending, your savings pot, or your mortgage?"
            }

        if clean_intent == "NAVIGATE_PROFILE":
            context.state["unclear_count"] = "0"
            _emit_ui_view({"page": "profile"})
            return {
                "agent_action": "I have opened your Profile page, where you can review your personal details and card controls. What else can I help you with?"
            }

        if clean_intent == "CAPABILITIES":
            context.state["unclear_count"] = "0"
            return {"agent_action": _capabilities_message()}

        return _handle_unclear()
    except Exception:
        logger.exception("route_banking_intent failed")
        return {
            "agent_action": "I am sorry, I ran into a temporary issue checking that. Could you tell me again whether you would like help with everyday banking, savings, or mortgages?"
        }


def _emit_ui_view(payload: dict) -> None:
    """Increment ui_view_state.seq monotonically and store payload."""
    current = dict(context.state.get("ui_view_state") or {})
    next_seq = int(current.get("seq") or 0) + 1
    updated = dict(payload)
    updated["seq"] = next_seq
    context.state["ui_view_state"] = updated


def _stage_domain_route(intent: str, hint: str) -> dict:
    """Stage silent specialist routing in target_agent and record router_state."""
    target_agent, label = _DOMAIN_TARGETS[intent]
    context.state["unclear_count"] = "0"
    context.state["router_state"] = {
        "last_intent": intent,
        "topic_hint": hint,
    }
    context.state["target_agent"] = target_agent
    suffix = f": {hint}" if hint else "."
    return {"agent_action": f"Customer asked about {label}{suffix}"}


def _build_greeting() -> str:
    """Compose a time-aware British English greeting."""
    first_name = (context.state.get("first_name") or "").strip()
    tod = (context.state.get("time_of_day") or "").strip().lower()
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


def _capabilities_message() -> str:
    """Return the shared three-product capabilities summary."""
    return (
        "I can help across three areas: everyday banking for your current account balance, "
        "monthly spending breakdowns, merchant history, and recurring subscriptions; "
        "savings for your pot balance, AER interest rate, and goal projections; "
        "and mortgages for your next payment, fee-free overpayment allowance, overpayment "
        "savings, and fixed-rate renewal options. Which of those would you like to explore?"
    )


def _handle_unclear() -> dict:
    """Two-strike non-terminating unclear input ladder."""
    strikes = int(context.state.get("unclear_count") or "0")
    if strikes == 0:
        context.state["unclear_count"] = "1"
        return {
            "agent_action": "Sorry, I did not quite catch that. Would you like help with everyday banking, savings, or mortgages?"
        }
    context.state["unclear_count"] = "0"
    _emit_ui_view({"page": "home"})
    return {
        "agent_action": "I have brought up your Home overview on screen. "
        + _capabilities_message()
    }


def _handle_farewell() -> dict:
    """Latch session completion and return a warm closing line."""
    first_name = (context.state.get("first_name") or "").strip()
    context.state["unclear_count"] = "0"
    context.state["router_state"] = {}
    context.state["escalation_reason"] = "CALL_COMPLETED"
    context.state["call_complete"] = "true"
    if first_name:
        return {
            "agent_action": f"You are very welcome, {first_name}. Have a lovely rest of your day, and goodbye."
        }
    return {
        "agent_action": "You are very welcome. Have a lovely rest of your day, and goodbye."
    }
