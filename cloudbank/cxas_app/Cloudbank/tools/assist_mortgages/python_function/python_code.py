import calendar
import logging
import math
from datetime import date
from typing import Any, Literal

logger = logging.getLogger(__name__)

_MAX_MORTGAGE_MONTHS = 600
_ILLUSTRATION_NOTE = (
    "These figures are an indicative illustration only and not personalised mortgage advice."
)


def assist_mortgages(
    query_type: Literal[
        "",
        "summary",
        "next_payment",
        "overpayment_allowance",
        "overpayment_projection",
        "rate_options",
    ] = "",
    monthly_overpayment: float = 0.0,
    lump_sum_overpayment: float = 0.0,
    confirm_pivot: Literal["", "yes", "no"] = "",
    switch_intent: Literal[
        "",
        "EVERYDAY_BANKING",
        "SAVINGS",
        "NAVIGATE_HOME",
        "NAVIGATE_PROFILE",
        "CAPABILITIES",
        "FAREWELL",
    ] = "",
) -> dict:
    """Answer mortgage summary, overpayment allowance, overpayment projection, renewal deal, and renter readiness requests.

    Pass only the arguments spoken by the caller on this turn. Monetary amounts
    are passed in pounds (for example ``monthly_overpayment=200.0``). When a
    renter responds to the savings deposit pot offer with "yes" or "no", pass
    ``confirm_pivot="yes"`` or ``confirm_pivot="no"``. Do not speak a pacing
    phrase before calling this tool; call it immediately.

    Args:
        query_type: Specific mortgage request ("summary", "next_payment",
            "overpayment_allowance", "overpayment_projection", or "rate_options").
        monthly_overpayment: Proposed extra monthly overpayment in pounds spoken
            by the caller, or 0.0 when not specified.
        lump_sum_overpayment: Proposed one-off lump-sum overpayment in pounds
            spoken by the caller, or 0.0 when not specified.
        confirm_pivot: "yes" when the caller accepts the offer to view their
            savings deposit pot projection, or "no" when they decline it.
        switch_intent: Cross-product or navigation action ("EVERYDAY_BANKING",
            "SAVINGS", "NAVIGATE_HOME", "NAVIGATE_PROFILE", "CAPABILITIES",
            or "FAREWELL").

    Returns:
        A single-key dict with ``agent_action`` carrying the spoken reply.
    """
    try:
        # Handle spoke pivots and local navigation before consuming handoff_context.
        clean_switch = (switch_intent or "").strip()
        if clean_switch:
            return _handle_switch_intent(clean_switch)

        clean_confirm = (confirm_pivot or "").strip()
        pending_pivot = bool(
            (context.state.get("mortgage_state") or {}).get("pending_savings_pivot")
        )
        if clean_confirm in ("yes", "no") and pending_pivot and not (query_type or "").strip():
            return _handle_pivot_confirmation(clean_confirm)

        handoff = dict(context.state.get("handoff_context") or {})
        context.state["handoff_context"] = {}
        snapshot = _normalize_snapshot(context.state.get("customer_snapshot") or {})
        if not snapshot:
            return {
                "agent_action": "I could not load your mortgage details right now. Please try your question again in a moment."
            }
        return _dispatch_mortgage(
            snapshot,
            (query_type or "").strip(),
            _to_pence(monthly_overpayment),
            _to_pence(lump_sum_overpayment),
            handoff,
        )
    except Exception:
        logger.exception("assist_mortgages failed")
        return {
            "agent_action": "I am sorry, I ran into a temporary issue checking your mortgage details. Please ask again in a moment."
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


def _handle_pivot_confirmation(confirm_pivot: str) -> dict:
    """Handle affirmative or negative reply to the renter savings-pot offer."""
    if confirm_pivot == "yes":
        return _handle_switch_intent("SAVINGS")
    context.state["unclear_count"] = "0"
    context.state["mortgage_state"] = {"pending_savings_pivot": False}
    return {
        "agent_action": "No problem at all. Would you like to check anything on your everyday banking and spending, or your savings pot?"
    }


def _dispatch_mortgage(
    snapshot: dict[str, Any],
    query: str,
    monthly_pence: int,
    lump_pence: int,
    handoff: dict[str, Any],
) -> dict:
    """Resolve renter/handoff defaults and dispatch a mortgage query."""
    anchor_year, anchor_month, anchor_day = _parse_demo_date()
    statement_month = _MONTH_NAMES[anchor_month - 1]
    mortgage = snapshot["mortgage"]
    # ui_view_state.subview replaces legacy mortgage_state.last_subview; only pending_savings_pivot is stored.
    mortgage_st = dict(context.state.get("mortgage_state") or {})

    if mortgage is None:
        if (
            not query
            and monthly_pence <= 0
            and lump_pence <= 0
            and mortgage_st.get("pending_savings_pivot")
        ):
            return _handle_unclear()
        context.state["unclear_count"] = "0"
        return _handle_renter_guidance(snapshot, statement_month)

    handoff_freed = int(handoff.get("freed_monthly_pence") or 0)
    if (
        query in ("", "overpayment_projection")
        and monthly_pence <= 0
        and lump_pence <= 0
        and handoff_freed > 0
    ):
        monthly_pence = handoff_freed
        query = "overpayment_projection"
    elif not query and (monthly_pence > 0 or lump_pence > 0):
        query = "overpayment_projection"

    handlers = {
        "summary": lambda: _handle_summary(
            mortgage, anchor_year, anchor_month, anchor_day
        ),
        "next_payment": lambda: _handle_next_payment(
            mortgage, anchor_year, anchor_month, anchor_day
        ),
        "overpayment_allowance": lambda: _handle_allowance(mortgage, statement_month),
        "overpayment_projection": lambda: _handle_overpayment_projection(
            mortgage, monthly_pence, lump_pence, statement_month
        ),
        "rate_options": lambda: _handle_rate_options(mortgage, statement_month),
    }
    handler = handlers.get(query)
    if handler is None:
        return _handle_unclear()
    context.state["unclear_count"] = "0"
    return handler()


def _simulate_mortgage(
    opening_balance_pence: int,
    interest_rate_bps: int,
    monthly_payment_pence: int,
    max_months: int = _MAX_MORTGAGE_MONTHS,
) -> dict[str, Any]:
    """Run month-by-month integer amortisation capped at max_months with non-amortising early exit."""
    if opening_balance_pence <= 0:
        return {
            "months": 0,
            "total_interest_pence": 0,
            "ending_balance_pence": 0,
            "paid_off": True,
        }

    bal = opening_balance_pence
    total_interest = 0
    for month_idx in range(1, max_months + 1):
        interest = _half_up(bal * interest_rate_bps, 120_000)
        if bal + interest <= monthly_payment_pence:
            return {
                "months": month_idx,
                "total_interest_pence": total_interest + interest,
                "ending_balance_pence": 0,
                "paid_off": True,
            }
        if interest >= monthly_payment_pence:
            return {
                "months": max_months,
                "total_interest_pence": total_interest + interest,
                "ending_balance_pence": bal + interest - monthly_payment_pence,
                "paid_off": False,
            }
        bal = bal + interest - monthly_payment_pence
        total_interest = total_interest + interest

    return {
        "months": max_months,
        "total_interest_pence": total_interest,
        "ending_balance_pence": bal,
        "paid_off": False,
    }


def _renewal_payment_pence(
    balance_pence: int, rate_bps: int, term_remaining_months: int
) -> int:
    """Find smallest integer monthly payment paying off balance within term via bisection."""
    if balance_pence <= 0:
        return 0
    if term_remaining_months <= 0:
        return balance_pence + _half_up(balance_pence * rate_bps, 120_000)
    low = _half_up(balance_pence * rate_bps, 120_000) + 1
    high = balance_pence + low
    while low < high:
        mid = (low + high) // 2
        if _simulate_mortgage(balance_pence, rate_bps, mid, term_remaining_months)[
            "paid_off"
        ]:
            high = mid
        else:
            low = mid + 1
    return low


def _project_overpayment(
    mortgage: dict[str, Any],
    monthly_overpayment_pence: int,
    lump_sum_overpayment_pence: int,
) -> dict[str, Any]:
    """Compute exact baseline vs overpayment amortisation and ERC-free cap status."""
    balance_pence = mortgage["balance_pence"]
    rate_bps = mortgage["interest_rate_bps"]
    scheduled_pence = mortgage["next_payment"]["amount_pence"]
    effective_lump = min(max(0, lump_sum_overpayment_pence), balance_pence)

    base = _simulate_mortgage(balance_pence, rate_bps, scheduled_pence)
    proj = _simulate_mortgage(
        balance_pence - effective_lump,
        rate_bps,
        scheduled_pence + monthly_overpayment_pence,
    )

    remaining_allowance = max(
        0,
        mortgage["annual_overpayment_allowance_pence"]
        - mortgage["overpaid_this_year_pence"],
    )
    first_year_overpay = min(
        balance_pence,
        effective_lump + min(12, proj["months"]) * monthly_overpayment_pence,
    )
    exceeds = first_year_overpay > remaining_allowance
    excess = max(0, first_year_overpay - remaining_allowance)
    both_amortize = bool(base["paid_off"] and proj["paid_off"])

    return {
        "baseline_months": base["months"],
        "projected_months": proj["months"],
        "months_saved": max(0, base["months"] - proj["months"]) if both_amortize else 0,
        "baseline_interest_pence": base["total_interest_pence"],
        "projected_interest_pence": proj["total_interest_pence"],
        "interest_saved_pence": (
            max(0, base["total_interest_pence"] - proj["total_interest_pence"])
            if both_amortize
            else 0
        ),
        "remaining_allowance_pence": remaining_allowance,
        "first_year_overpayment_pence": first_year_overpay,
        "exceeds_allowance": exceeds,
        "excess_over_allowance_pence": excess,
        "baseline_paid_off": base["paid_off"],
        "paid_off": proj["paid_off"],
    }


def _normalize_snapshot(raw: dict[str, Any]) -> dict[str, Any]:
    """Coerce protobuf Struct floats on user, savings, and mortgage into exact ints."""
    if not isinstance(raw, dict) or "accounts" not in raw or "user" not in raw:
        return {}
    user_raw = raw["user"]
    accounts_raw = raw["accounts"]
    sav_raw = accounts_raw["savings"]
    mg_raw = accounts_raw.get("mortgage")

    result: dict[str, Any] = {
        "annual_income_pence": int(user_raw["annual_income_pence"]),
        "savings": {
            "goal_name": str(sav_raw["goal_name"]),
            "balance_pence": int(sav_raw["balance_pence"]),
            "goal_target_pence": int(sav_raw["goal_target_pence"]),
        },
        "mortgage": None,
    }

    if isinstance(mg_raw, dict) and mg_raw:
        np_raw = mg_raw["next_payment"]
        result["mortgage"] = {
            "balance_pence": int(mg_raw["balance_pence"]),
            "address": str(mg_raw["address"]),
            "interest_rate_bps": int(mg_raw["interest_rate_bps"]),
            "rate_type": str(mg_raw["rate_type"]),
            "fixed_until": str(mg_raw["fixed_until"]),
            "term_remaining_months": int(mg_raw["term_remaining_months"]),
            "next_payment": {
                "amount_pence": int(np_raw["amount_pence"]),
                "day_of_month": int(np_raw["day_of_month"]),
            },
            "annual_overpayment_allowance_pence": int(
                mg_raw["annual_overpayment_allowance_pence"]
            ),
            "overpaid_this_year_pence": int(mg_raw["overpaid_this_year_pence"]),
            "renewal_options": [
                {
                    "id": str(opt["id"]),
                    "label": str(opt["label"]),
                    "term_years": int(opt["term_years"]),
                    "rate_bps": int(opt["rate_bps"]),
                }
                for opt in mg_raw["renewal_options"]
            ],
        }
    return result


def _format_months_duration(total_months: int) -> str:
    """Format integer months as 'X years and Y months'."""
    years, months = divmod(max(0, total_months), 12)
    if years and months:
        y_word = "year" if years == 1 else "years"
        m_word = "month" if months == 1 else "months"
        return f"{years} {y_word} and {months} {m_word}"
    if years:
        return f"{years} {'year' if years == 1 else 'years'}"
    return f"{months} {'month' if months == 1 else 'months'}"


def _next_payment_label(
    day_of_month: int, anchor_year: int, anchor_month: int, anchor_day: int
) -> str:
    """Resolve upcoming recurring payment date label, clamping day to month length."""
    if day_of_month >= anchor_day:
        target_year = anchor_year
        target_month = anchor_month
    else:
        total_m = anchor_year * 12 + anchor_month
        target_year = total_m // 12
        target_month = (total_m % 12) + 1
    last_day = calendar.monthrange(target_year, target_month)[1]
    clamped_day = min(max(1, day_of_month), last_day)
    return f"{clamped_day} {_MONTH_NAMES[target_month - 1]} {target_year}"


def _format_iso_month_year(iso_date: str) -> str:
    """Format valid YYYY-MM-DD as 'D Month YYYY' without timezone conversion."""
    parts = iso_date.strip().split("-")
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
                return f"{day} {_MONTH_NAMES[month - 1]} {year}"
            except ValueError:
                pass
    return iso_date


def _handle_summary(
    mg: dict[str, Any], anchor_year: int, anchor_month: int, anchor_day: int
) -> dict:
    """Report mortgage balance, fixed rate & expiry, remaining term, and next payment."""
    statement_month = _MONTH_NAMES[anchor_month - 1]
    next_due = _next_payment_label(
        mg["next_payment"]["day_of_month"], anchor_year, anchor_month, anchor_day
    )
    rem_allow = max(
        0, mg["annual_overpayment_allowance_pence"] - mg["overpaid_this_year_pence"]
    )
    context.state["mortgage_state"] = {}
    _emit_ui_view({"page": "mortgage", "subview": "overview"})
    return {
        "agent_action": (
            f"As of {statement_month}, your Cloudbank mortgage on {mg['address']} has a remaining "
            f"balance of {_format_gbp(mg['balance_pence'])} at {_format_bps(mg['interest_rate_bps'])} "
            f"fixed until {_format_iso_month_year(mg['fixed_until'])}, with "
            f"{_format_months_duration(mg['term_remaining_months'])} remaining. Your next payment of "
            f"{_format_gbp(mg['next_payment']['amount_pence'])} is due on {next_due}, and you have "
            f"{_format_gbp(rem_allow)} left in your 10% fee-free overpayment allowance this year."
        )
    }


def _handle_next_payment(
    mg: dict[str, Any], anchor_year: int, anchor_month: int, anchor_day: int
) -> dict:
    """Report the next scheduled mortgage payment date and amount."""
    statement_month = _MONTH_NAMES[anchor_month - 1]
    next_due = _next_payment_label(
        mg["next_payment"]["day_of_month"], anchor_year, anchor_month, anchor_day
    )
    context.state["mortgage_state"] = {}
    _emit_ui_view({"page": "mortgage", "subview": "overview"})
    return {
        "agent_action": (
            f"Following your {statement_month} statement, your next mortgage payment is "
            f"{_format_gbp(mg['next_payment']['amount_pence'])} on {next_due}."
        )
    }


def _handle_allowance(mg: dict[str, Any], statement_month: str) -> dict:
    """Report annual 10% ERC-free overpayment allowance and amount used so far."""
    rem_allow = max(
        0, mg["annual_overpayment_allowance_pence"] - mg["overpaid_this_year_pence"]
    )
    context.state["mortgage_state"] = {}
    _emit_ui_view({"page": "mortgage", "subview": "overview"})
    return {
        "agent_action": (
            f"As of {statement_month}, your annual 10% fee-free overpayment allowance is "
            f"{_format_gbp(mg['annual_overpayment_allowance_pence'])}; you have overpaid "
            f"{_format_gbp(mg['overpaid_this_year_pence'])} so far this year, leaving "
            f"{_format_gbp(rem_allow)} before any early repayment charge applies."
        )
    }


def _format_overpayment_reply(
    res: dict[str, Any], monthly_pence: int, lump_pence: int, statement_month: str
) -> str:
    """Format spoken amortisation & ERC allowance summary from _project_overpayment."""
    parts_desc = []
    if monthly_pence > 0:
        parts_desc.append(f"{_format_gbp(monthly_pence)} a month")
    if lump_pence > 0:
        parts_desc.append(f"a {_format_gbp(lump_pence)} lump sum")
    proposal_text = " plus ".join(parts_desc)

    if res["exceeds_allowance"]:
        cap_clause = (
            f"adds {_format_gbp(res['first_year_overpayment_pence'])} in year one, which exceeds "
            f"your remaining {_format_gbp(res['remaining_allowance_pence'])} fee-free allowance by "
            f"{_format_gbp(res['excess_over_allowance_pence'])} and could incur an early repayment charge"
        )
    else:
        cap_clause = (
            f"totals {_format_gbp(res['first_year_overpayment_pence'])} in year one, fitting within "
            f"your remaining {_format_gbp(res['remaining_allowance_pence'])} 10% fee-free allowance"
        )

    if not res["paid_off"]:
        outcome_clause = (
            "However, the combined monthly payment still does not cover enough principal to clear the balance within 50 years."
        )
    elif not res.get("baseline_paid_off", True):
        outcome_clause = (
            f"Because your scheduled payment alone does not amortise the balance within 50 years, "
            f"this overpayment brings payoff down to {_format_months_duration(res['projected_months'])}."
        )
    elif res["projected_months"] == 0:
        outcome_clause = (
            f"It would clear the entire balance immediately and save {_format_gbp(res['interest_saved_pence'])} in future interest."
        )
    else:
        outcome_clause = (
            f"It would shave {_format_months_duration(res['months_saved'])} off your remaining term "
            f"(down to {_format_months_duration(res['projected_months'])}) and save {_format_gbp(res['interest_saved_pence'])} in total interest."
        )
    return (
        f"Starting from {statement_month}, overpaying {proposal_text} {cap_clause}. "
        f"{outcome_clause} {_ILLUSTRATION_NOTE}"
    )


def _handle_overpayment_projection(
    mg: dict[str, Any], monthly_pence: int, lump_pence: int, statement_month: str
) -> dict:
    """Project term reduction, interest saved, and ERC-free cap check."""
    context.state["mortgage_state"] = {}
    _emit_ui_view(
        {
            "page": "mortgage",
            "subview": "overpay",
            "monthly_overpayment_pence": monthly_pence,
            "lump_sum_overpayment_pence": lump_pence,
        }
    )

    if monthly_pence <= 0 and lump_pence <= 0:
        rem_allow = max(
            0, mg["annual_overpayment_allowance_pence"] - mg["overpaid_this_year_pence"]
        )
        return {
            "agent_action": (
                f"I have opened the overpayment calculator for {statement_month}. You have "
                f"{_format_gbp(rem_allow)} remaining in your 10% fee-free allowance this year; "
                "what monthly or lump-sum overpayment amount would you like to test?"
            )
        }

    res = _project_overpayment(mg, monthly_pence, lump_pence)
    return {
        "agent_action": _format_overpayment_reply(
            res, monthly_pence, lump_pence, statement_month
        )
    }


def _handle_rate_options(mg: dict[str, Any], statement_month: str) -> dict:
    """Compare current scheduled payment against 2-year and 5-year Fixed renewal deals."""
    current_pmt = mg["next_payment"]["amount_pence"]
    comparisons = []
    for opt in mg["renewal_options"]:
        new_pmt = _renewal_payment_pence(
            mg["balance_pence"], opt["rate_bps"], mg["term_remaining_months"]
        )
        delta = new_pmt - current_pmt
        if delta < 0:
            delta_str = f"{_format_gbp(abs(delta))} less a month"
        elif delta > 0:
            delta_str = f"{_format_gbp(delta)} more a month"
        else:
            delta_str = "unchanged"
        comparisons.append(
            f"the {opt['label']} at {_format_bps(opt['rate_bps'])} would be {_format_gbp(new_pmt)} a month ({delta_str})"
        )

    context.state["mortgage_state"] = {}
    _emit_ui_view({"page": "mortgage", "subview": "rates"})
    joined = ", while ".join(comparisons)
    return {
        "agent_action": (
            f"Compared with your {statement_month} payment of {_format_gbp(current_pmt)} a month at "
            f"{_format_bps(mg['interest_rate_bps'])}, {joined}. {_ILLUSTRATION_NOTE}"
        )
    }


def _handle_renter_guidance(snapshot: dict[str, Any], statement_month: str) -> dict:
    """Provide indicative first-home borrowing readiness for renters and offer Savings pivot."""
    income_pence = snapshot["annual_income_pence"]
    sav = snapshot["savings"]
    max_borrow_pence = _half_up(income_pence * 45, 10)
    budget_with_goal_pence = max_borrow_pence + sav["goal_target_pence"]
    remaining_deposit_pence = max(0, sav["goal_target_pence"] - sav["balance_pence"])

    context.state["mortgage_state"] = {"pending_savings_pivot": True}
    _emit_ui_view({"page": "mortgage", "subview": "overview"})
    return {
        "agent_action": (
            f"You do not hold a Cloudbank mortgage right now, though as of {statement_month} an "
            f"indicative 4.5 times income multiple on {_format_gbp(income_pence)} suggests borrowing "
            f"up to {_format_gbp(max_borrow_pence)}, or a property budget around "
            f"{_format_gbp(budget_with_goal_pence)} once your {_format_gbp(sav['goal_target_pence'])} "
            f"{sav['goal_name']} is complete ({_format_gbp(remaining_deposit_pence)} left to go). "
            f"{_ILLUSTRATION_NOTE} Would you like to look at your {sav['goal_name']} projection?"
        )
    }


def _handle_switch_intent(switch_intent: str) -> dict:
    """Handle local navigation, capabilities, farewell, or cross-spoke pivots."""
    if switch_intent == "FAREWELL":
        context.state["mortgage_state"] = {}
        return _farewell_response()

    if switch_intent in ("NAVIGATE_HOME", "NAVIGATE_PROFILE", "CAPABILITIES"):
        if switch_intent in ("NAVIGATE_HOME", "NAVIGATE_PROFILE"):
            mortgage_st = dict(context.state.get("mortgage_state") or {})
            mortgage_st["pending_savings_pivot"] = False
            context.state["mortgage_state"] = mortgage_st
        return _shared_navigation_response(switch_intent)

    if switch_intent in ("EVERYDAY_BANKING", "SAVINGS"):
        target = (
            "everyday_banking_agent"
            if switch_intent == "EVERYDAY_BANKING"
            else "savings_agent"
        )
        label = (
            "everyday banking and spending"
            if switch_intent == "EVERYDAY_BANKING"
            else "savings projections"
        )
        if int(context.state.get("pass_count") or "0") > 4:
            return {
                "agent_action": f"Sure, tell me what you would like to check on your {label}."
            }
        context.state["unclear_count"] = "0"
        context.state["mortgage_state"] = {}
        context.state["target_agent"] = target
        return {"agent_action": f"Customer wants to explore {label}."}

    return _handle_unclear()


def _handle_unclear() -> dict:
    """Two-strike non-terminating unclear input ladder, clearing pending pivot on strike 2."""
    mortgage_st = dict(context.state.get("mortgage_state") or {})
    prompt = (
        "Would you like to look at your savings deposit pot projection, or check something else on your accounts?"
        if mortgage_st.get("pending_savings_pivot")
        else "Sorry, I did not quite catch that. Would you like help with your mortgage, your savings pot, or everyday banking?"
    )
    strike_one = _increment_unclear(prompt)
    if strike_one is not None:
        return strike_one
    mortgage_st["pending_savings_pivot"] = False
    context.state["mortgage_state"] = mortgage_st
    return _unclear_reset_home_response()
