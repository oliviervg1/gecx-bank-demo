import logging
import math
from datetime import date
from typing import Any, Literal

logger = logging.getLogger(__name__)

_MAX_PROJECTION_MONTHS = 600


def assist_savings(
    query_type: Literal["", "summary", "projection", "interest_rate"] = "",
    extra_monthly_amount: float = 0.0,
    custom_target_amount: float = 0.0,
    switch_intent: Literal[
        "",
        "EVERYDAY_BANKING",
        "MORTGAGES",
        "NAVIGATE_HOME",
        "NAVIGATE_PROFILE",
        "CAPABILITIES",
        "FAREWELL",
    ] = "",
) -> dict:
    """Answer savings pot balance, AER interest rate, and goal completion projection requests.

    Pass only the arguments spoken by the caller on this turn. Monetary amounts
    are passed in pounds (for example ``extra_monthly_amount=45.0``). When
    reached right after discussing a freed subscription, ``query_type="projection"``
    automatically uses the freed monthly amount if ``extra_monthly_amount`` is omitted.
    Do not speak a pacing phrase before calling this tool; call it immediately.

    Args:
        query_type: Savings question type ("summary", "projection", or
            "interest_rate").
        extra_monthly_amount: Additional monthly savings contribution in pounds
            spoken by the caller, or 0.0 when not specified.
        custom_target_amount: Custom savings goal target in pounds spoken by the
            caller, or 0.0 to use their existing goal target.
        switch_intent: Cross-product or navigation action ("EVERYDAY_BANKING",
            "MORTGAGES", "NAVIGATE_HOME", "NAVIGATE_PROFILE", "CAPABILITIES",
            or "FAREWELL").

    Returns:
        A single-key dict with ``agent_action`` carrying the spoken reply.
    """
    try:
        # Handle spoke pivots and local navigation before consuming handoff_context.
        clean_switch = (switch_intent or "").strip()
        if clean_switch:
            return _handle_switch_intent(clean_switch)

        handoff = dict(context.state.get("handoff_context") or {})
        context.state["handoff_context"] = {}
        snapshot = _normalize_snapshot(context.state.get("customer_snapshot") or {})
        if not snapshot:
            return {
                "agent_action": "I could not load your savings details right now. Please try your question again in a moment."
            }
        return _dispatch_savings(
            snapshot["savings"],
            (query_type or "").strip(),
            _to_pence(extra_monthly_amount),
            _to_pence(custom_target_amount),
            handoff,
        )
    except Exception:
        logger.exception("assist_savings failed")
        return {
            "agent_action": "I am sorry, I ran into a temporary issue checking your savings pot. Please ask again in a moment."
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


def _dispatch_savings(
    sav: dict[str, Any],
    query: str,
    extra_pence: int,
    custom_target_pence: int,
    handoff: dict[str, Any],
) -> dict:
    """Resolve handoff defaults and dispatch a savings query."""
    anchor_year, anchor_month, _ = _parse_demo_date()
    statement_month = _MONTH_NAMES[anchor_month - 1]

    handoff_freed = int(handoff.get("freed_monthly_pence") or 0)
    handoff_vendor = str(handoff.get("vendor") or "")
    if query in ("", "projection") and extra_pence <= 0 and handoff_freed > 0:
        extra_pence = handoff_freed
        query = "projection"
    elif not query and (extra_pence > 0 or custom_target_pence > 0):
        query = "projection"
    attributed_vendor = (
        handoff_vendor if (handoff_freed > 0 and extra_pence == handoff_freed) else ""
    )

    if query == "interest_rate":
        context.state["unclear_count"] = "0"
        return _handle_interest_rate(sav, statement_month)
    if query == "projection":
        context.state["unclear_count"] = "0"
        return _handle_projection(
            sav,
            extra_pence,
            custom_target_pence,
            attributed_vendor,
            anchor_year,
            anchor_month,
        )
    if query == "summary":
        context.state["unclear_count"] = "0"
        return _handle_summary(sav, anchor_year, anchor_month)
    return _handle_unclear()


def _project_savings_goal(
    balance_pence: int,
    gross_rate_bps: int,
    monthly_contribution_pence: int,
    extra_monthly_pence: int,
    goal_target_pence: int,
) -> dict[str, Any]:
    """Simulate month-by-month compound savings growth capped at 600 months."""
    if balance_pence >= goal_target_pence:
        return {
            "months_to_goal": 0,
            "unreachable": False,
            "projected_balance_pence": balance_pence,
            "total_interest_earned_pence": 0,
        }

    pot = balance_pence
    total_interest = 0
    monthly_add = monthly_contribution_pence + extra_monthly_pence
    for month_idx in range(1, _MAX_PROJECTION_MONTHS + 1):
        interest = _half_up(pot * gross_rate_bps, 120_000)
        pot = pot + interest + monthly_add
        total_interest = total_interest + interest
        if pot >= goal_target_pence:
            return {
                "months_to_goal": month_idx,
                "unreachable": False,
                "projected_balance_pence": pot,
                "total_interest_earned_pence": total_interest,
            }

    return {
        "months_to_goal": None,
        "unreachable": True,
        "projected_balance_pence": pot,
        "total_interest_earned_pence": total_interest,
    }


def _annual_interest_on_balance(balance_pence: int, gross_rate_bps: int) -> int:
    """Compute 12-month compounded interest on current balance with zero contributions."""
    pot = balance_pence
    earned = 0
    for _ in range(12):
        interest = _half_up(pot * gross_rate_bps, 120_000)
        pot = pot + interest
        earned = earned + interest
    return earned


def _target_month_label(anchor_year: int, anchor_month: int, months_ahead: int) -> str:
    """Resolve 'Month YYYY' from (anchor_year, anchor_month) plus months_ahead."""
    total_m = anchor_year * 12 + (anchor_month - 1) + months_ahead
    target_year = total_m // 12
    target_month = (total_m % 12) + 1
    return f"{_MONTH_NAMES[target_month - 1]} {target_year}"


def _normalize_snapshot(raw: dict[str, Any]) -> dict[str, Any]:
    """Coerce protobuf Struct floats on accounts.savings into exact ints."""
    if not isinstance(raw, dict) or "accounts" not in raw:
        return {}
    sav_raw = raw["accounts"].get("savings")
    if not isinstance(sav_raw, dict) or not sav_raw:
        return {}
    return {
        "savings": {
            "name": str(sav_raw["name"]),
            "balance_pence": int(sav_raw["balance_pence"]),
            "gross_rate_bps": int(sav_raw["gross_rate_bps"]),
            "aer_bps": int(sav_raw["aer_bps"]),
            "monthly_contribution_pence": int(sav_raw["monthly_contribution_pence"]),
            "goal_name": str(sav_raw["goal_name"]),
            "goal_target_pence": int(sav_raw["goal_target_pence"]),
        }
    }


def _handle_summary(
    sav: dict[str, Any], anchor_year: int, anchor_month: int
) -> dict:
    """Report current savings balance, AER, monthly contribution, and baseline goal date."""
    statement_month = _MONTH_NAMES[anchor_month - 1]
    base = _project_savings_goal(
        sav["balance_pence"],
        sav["gross_rate_bps"],
        sav["monthly_contribution_pence"],
        0,
        sav["goal_target_pence"],
    )
    _emit_ui_view({"page": "savings", "extra_monthly_pence": 0})

    if base["months_to_goal"] == 0:
        return {
            "agent_action": (
                f"As of {statement_month}, your {sav['goal_name']} in {sav['name']} holds "
                f"{_format_gbp(sav['balance_pence'])} at {_format_bps(sav['aer_bps'])} AER, "
                f"which has already met your {_format_gbp(sav['goal_target_pence'])} target."
            )
        }
    if base["unreachable"]:
        return {
            "agent_action": (
                f"As of {statement_month}, your {sav['goal_name']} holds {_format_gbp(sav['balance_pence'])} "
                f"toward your {_format_gbp(sav['goal_target_pence'])} target at {_format_bps(sav['aer_bps'])} AER, "
                "and would need a higher monthly contribution to reach that goal within 50 years."
            )
        }

    months = int(base["months_to_goal"])
    target_label = _target_month_label(anchor_year, anchor_month, months)
    return {
        "agent_action": (
            f"As of {statement_month}, your {sav['goal_name']} in {sav['name']} holds "
            f"{_format_gbp(sav['balance_pence'])} toward your {_format_gbp(sav['goal_target_pence'])} target "
            f"at {_format_bps(sav['aer_bps'])} AER, with {_format_gbp(sav['monthly_contribution_pence'])} "
            f"going in each month, putting you on track to reach your goal in {months} months ({target_label})."
        )
    }


def _handle_interest_rate(sav: dict[str, Any], statement_month: str) -> dict:
    """Report AER, gross nominal rate, and 12-month compounded interest on current balance."""
    annual_int = _annual_interest_on_balance(
        sav["balance_pence"], sav["gross_rate_bps"]
    )
    _emit_ui_view({"page": "savings", "extra_monthly_pence": 0})
    return {
        "agent_action": (
            f"In {statement_month}, your {sav['name']} earns {_format_bps(sav['aer_bps'])} AER "
            f"({_format_bps(sav['gross_rate_bps'])} gross compounded monthly). On your current "
            f"{_format_gbp(sav['balance_pence'])} balance alone, that adds {_format_gbp(annual_int)} in interest over 12 months."
        )
    }


def _format_projection_reply(
    sav: dict[str, Any],
    base: dict[str, Any],
    proj: dict[str, Any],
    extra_pence: int,
    target_pence: int,
    handoff_vendor: str,
    statement_month: str,
    anchor_year: int,
    anchor_month: int,
) -> str:
    """Format spoken projection summary from baseline and projected outcomes."""
    total_monthly = sav["monthly_contribution_pence"] + extra_pence
    if proj["months_to_goal"] == 0:
        return (
            f"As of {statement_month}, your {_format_gbp(sav['balance_pence'])} balance in {sav['goal_name']} "
            f"has already reached {_format_gbp(target_pence)}."
        )
    if proj["unreachable"]:
        return (
            f"Starting from {statement_month}, at {_format_gbp(total_monthly)} a month "
            f"and {_format_bps(sav['aer_bps'])} AER, your {sav['goal_name']} would reach "
            f"{_format_gbp(proj['projected_balance_pence'])} after 50 years without hitting {_format_gbp(target_pence)}."
        )

    proj_months = int(proj["months_to_goal"])
    proj_date = _target_month_label(anchor_year, anchor_month, proj_months)
    if extra_pence > 0 and not base["unreachable"] and base["months_to_goal"] is not None:
        months_saved = int(base["months_to_goal"]) - proj_months
        source_note = f" from {handoff_vendor}" if handoff_vendor else ""
        saved_clause = (
            f"shaving {months_saved} {'month' if months_saved == 1 else 'months'} off your timeline and "
            if months_saved > 0
            else ""
        )
        return (
            f"Your {sav['goal_name']} currently holds {_format_gbp(sav['balance_pence'])} at "
            f"{_format_bps(sav['aer_bps'])} AER as of {statement_month}. Adding {_format_gbp(extra_pence)} a month{source_note} "
            f"lifts your monthly saving to {_format_gbp(total_monthly)}, {saved_clause}"
            f"reaching your {_format_gbp(target_pence)} target in {proj_months} months ({proj_date})."
        )

    return (
        f"As of {statement_month}, your {sav['goal_name']} in {sav['name']} holds "
        f"{_format_gbp(sav['balance_pence'])} at {_format_bps(sav['aer_bps'])} AER, and saving "
        f"{_format_gbp(total_monthly)} a month puts you on track to reach {_format_gbp(target_pence)} "
        f"in {proj_months} months ({proj_date})."
    )


def _handle_projection(
    sav: dict[str, Any],
    extra_pence: int,
    custom_target_pence: int,
    handoff_vendor: str,
    anchor_year: int,
    anchor_month: int,
) -> dict:
    """Compare baseline vs extra monthly contribution timeline and sync SavingsPage."""
    statement_month = _MONTH_NAMES[anchor_month - 1]
    target_pence = (
        custom_target_pence if custom_target_pence > 0 else sav["goal_target_pence"]
    )
    base = _project_savings_goal(
        sav["balance_pence"],
        sav["gross_rate_bps"],
        sav["monthly_contribution_pence"],
        0,
        target_pence,
    )
    proj = _project_savings_goal(
        sav["balance_pence"],
        sav["gross_rate_bps"],
        sav["monthly_contribution_pence"],
        extra_pence,
        target_pence,
    )

    view_payload: dict[str, Any] = {
        "page": "savings",
        "extra_monthly_pence": extra_pence,
    }
    if custom_target_pence > 0:
        view_payload["custom_target_pence"] = custom_target_pence
    _emit_ui_view(view_payload)

    return {
        "agent_action": _format_projection_reply(
            sav,
            base,
            proj,
            extra_pence,
            target_pence,
            handoff_vendor,
            statement_month,
            anchor_year,
            anchor_month,
        )
    }


def _handle_switch_intent(switch_intent: str) -> dict:
    """Handle local navigation, capabilities, farewell, or cross-spoke pivots."""
    if switch_intent == "FAREWELL":
        return _farewell_response()

    if switch_intent in ("NAVIGATE_HOME", "NAVIGATE_PROFILE", "CAPABILITIES"):
        return _shared_navigation_response(switch_intent)

    if switch_intent in ("EVERYDAY_BANKING", "MORTGAGES"):
        target = (
            "everyday_banking_agent"
            if switch_intent == "EVERYDAY_BANKING"
            else "mortgage_agent"
        )
        label = (
            "everyday banking and spending"
            if switch_intent == "EVERYDAY_BANKING"
            else "mortgage options"
        )
        if int(context.state.get("pass_count") or "0") > 4:
            return {
                "agent_action": f"Sure, tell me what you would like to check on your {label}."
            }
        context.state["unclear_count"] = "0"
        context.state["target_agent"] = target
        return {"agent_action": f"Customer wants to explore {label}."}

    return _handle_unclear()


def _handle_unclear() -> dict:
    """Two-strike non-terminating unclear input ladder."""
    strike_one = _increment_unclear(
        "Sorry, I did not quite catch that. Would you like help with your savings pot, everyday banking, or your mortgage?"
    )
    if strike_one is not None:
        return strike_one
    return _unclear_reset_home_response()
