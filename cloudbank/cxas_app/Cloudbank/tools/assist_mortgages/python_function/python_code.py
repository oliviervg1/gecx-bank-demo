import logging
import math
from typing import Literal

logger = logging.getLogger(__name__)

_PLATFORM_CURRENT_DATE_KEY = "current_date"
_DEFAULT_DEMO_DATE = "2026-11-24"
_MAX_MORTGAGE_MONTHS = 600
_ILLUSTRATION_NOTE = (
    "These figures are an indicative illustration only and not personalised mortgage advice."
)
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
    are passed in pounds (for example ``monthly_overpayment=200.0``).

    Do not speak a conversational pacing phrase before calling this tool; call
    it immediately so the caller hears only the post-tool response.

    Args:
        query_type: Specific mortgage request ("summary", "next_payment",
            "overpayment_allowance", "overpayment_projection", or "rate_options").
        monthly_overpayment: Proposed extra monthly overpayment in pounds spoken
            by the caller, or 0.0 when not specified.
        lump_sum_overpayment: Proposed one-off lump-sum overpayment in pounds
            spoken by the caller, or 0.0 when not specified.
        switch_intent: Cross-product or navigation action ("EVERYDAY_BANKING",
            "SAVINGS", "NAVIGATE_HOME", "NAVIGATE_PROFILE", "CAPABILITIES",
            or "FAREWELL").

    Returns:
        A single-key dict with ``agent_action`` carrying the spoken reply.
    """
    try:
        clean_switch = (switch_intent or "").strip()
        clean_query = (query_type or "").strip()
        monthly_pence = _to_pence(monthly_overpayment)
        lump_pence = _to_pence(lump_sum_overpayment)

        handoff = dict(context.state.get("handoff_context") or {})
        context.state["handoff_context"] = {}

        if clean_switch:
            return _handle_switch_intent(clean_switch)

        snapshot = _normalize_snapshot(context.state.get("customer_snapshot") or {})
        if not snapshot:
            return {
                "agent_action": "I could not load your mortgage details right now. Please try your question again in a moment."
            }

        anchor_year, anchor_month, anchor_day = _parse_demo_date()
        statement_month = _MONTH_NAMES[anchor_month - 1]

        mortgage = snapshot.get("mortgage")
        mortgage_st = dict(context.state.get("mortgage_state") or {})
        if (
            mortgage is None
            and not clean_query
            and monthly_pence <= 0
            and lump_pence <= 0
            and mortgage_st.get("pending_savings_pivot")
        ):
            return _handle_unclear()
        if mortgage is None:
            context.state["unclear_count"] = "0"
            return _handle_renter_guidance(snapshot, statement_month)

        handoff_freed = int(handoff.get("freed_monthly_pence") or 0)
        if (
            clean_query in ("", "overpayment_projection")
            and monthly_pence <= 0
            and lump_pence <= 0
            and handoff_freed > 0
        ):
            monthly_pence = handoff_freed
            clean_query = "overpayment_projection"
        elif not clean_query and (monthly_pence > 0 or lump_pence > 0):
            clean_query = "overpayment_projection"

        if clean_query == "summary":
            context.state["unclear_count"] = "0"
            return _handle_summary(mortgage, anchor_year, anchor_month, anchor_day)

        if clean_query == "next_payment":
            context.state["unclear_count"] = "0"
            return _handle_next_payment(mortgage, anchor_year, anchor_month, anchor_day)

        if clean_query == "overpayment_allowance":
            context.state["unclear_count"] = "0"
            return _handle_allowance(mortgage, statement_month)

        if clean_query == "overpayment_projection":
            context.state["unclear_count"] = "0"
            return _handle_overpayment_projection(
                mortgage, monthly_pence, lump_pence, statement_month
            )

        if clean_query == "rate_options":
            context.state["unclear_count"] = "0"
            return _handle_rate_options(mortgage, statement_month)

        return _handle_unclear()
    except Exception:
        logger.exception("assist_mortgages failed")
        return {
            "agent_action": "I am sorry, I ran into a temporary issue checking your mortgage details. Please ask again in a moment."
        }


def _half_up(n: int, d: int) -> int:
    """Exact integer half-up division for n >= 0 and d > 0."""
    return (n * 2 + d) // (2 * d)


def _to_pence(raw: float | int) -> int:
    """Convert model-supplied pound float to clamped integer pence without float division."""
    fx = float(raw or 0.0)
    if not math.isfinite(fx):
        return 0
    clamped = max(0.0, min(fx, 10_000_000.0))
    return int(math.floor(clamped * 100.0 + 0.5))


def _simulate_mortgage(
    opening_balance_pence: int,
    interest_rate_bps: int,
    monthly_payment_pence: int,
    max_months: int = _MAX_MORTGAGE_MONTHS,
) -> dict:
    """Run month-by-month integer amortisation capped at max_months."""
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
    low = _half_up(balance_pence * rate_bps, 120_000) + 1
    high = balance_pence + low
    while low < high:
        mid = (low + high) // 2
        if _simulate_mortgage(balance_pence, rate_bps, mid, term_remaining_months)["paid_off"]:
            high = mid
        else:
            low = mid + 1
    return low


def _project_overpayment(
    mortgage: dict, monthly_overpayment_pence: int, lump_sum_overpayment_pence: int
) -> dict:
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
        mortgage["annual_overpayment_allowance_pence"] - mortgage["overpaid_this_year_pence"],
    )
    first_year_overpay = min(
        balance_pence,
        effective_lump + min(12, proj["months"]) * monthly_overpayment_pence,
    )
    exceeds = first_year_overpay > remaining_allowance
    excess = max(0, first_year_overpay - remaining_allowance)

    return {
        "baseline_months": base["months"],
        "projected_months": proj["months"],
        "months_saved": max(0, base["months"] - proj["months"]),
        "baseline_interest_pence": base["total_interest_pence"],
        "projected_interest_pence": proj["total_interest_pence"],
        "interest_saved_pence": max(0, base["total_interest_pence"] - proj["total_interest_pence"]),
        "remaining_allowance_pence": remaining_allowance,
        "first_year_overpayment_pence": first_year_overpay,
        "exceeds_allowance": exceeds,
        "excess_over_allowance_pence": excess,
        "paid_off": proj["paid_off"],
    }


def _normalize_snapshot(raw: dict) -> dict:
    """Coerce protobuf Struct floats on user, savings, and mortgage into exact ints."""
    if not isinstance(raw, dict) or "accounts" not in raw:
        return {}
    user_raw = dict(raw.get("user") or {})
    accounts_raw = dict(raw.get("accounts") or {})
    sav_raw = dict(accounts_raw.get("savings") or {})
    mg_raw = accounts_raw.get("mortgage")

    result: dict = {
        "annual_income_pence": int(user_raw.get("annual_income_pence") or 0),
        "savings": {
            "goal_name": str(sav_raw.get("goal_name") or "First Home Deposit"),
            "balance_pence": int(sav_raw.get("balance_pence") or 0),
            "goal_target_pence": int(sav_raw.get("goal_target_pence") or 0),
        },
        "mortgage": None,
    }

    if isinstance(mg_raw, dict) and mg_raw:
        np_raw = dict(mg_raw.get("next_payment") or {})
        options = []
        for opt in mg_raw.get("renewal_options") or []:
            options.append(
                {
                    "id": str(opt.get("id") or ""),
                    "label": str(opt.get("label") or ""),
                    "term_years": int(opt.get("term_years") or 2),
                    "rate_bps": int(opt.get("rate_bps") or 0),
                }
            )
        result["mortgage"] = {
            "balance_pence": int(mg_raw.get("balance_pence") or 0),
            "address": str(mg_raw.get("address") or ""),
            "interest_rate_bps": int(mg_raw.get("interest_rate_bps") or 0),
            "rate_type": str(mg_raw.get("rate_type") or "Fixed"),
            "fixed_until": str(mg_raw.get("fixed_until") or ""),
            "term_remaining_months": int(mg_raw.get("term_remaining_months") or 0),
            "next_payment": {
                "amount_pence": int(np_raw.get("amount_pence") or 0),
                "day_of_month": int(np_raw.get("day_of_month") or 1),
            },
            "annual_overpayment_allowance_pence": int(
                mg_raw.get("annual_overpayment_allowance_pence") or 0
            ),
            "overpaid_this_year_pence": int(mg_raw.get("overpaid_this_year_pence") or 0),
            "renewal_options": options,
        }
    return result


def _parse_demo_date() -> tuple[int, int, int]:
    """Parse YYYY-MM-DD by integer components without timezone shifts."""
    raw = (
        str(context.state.get("demo_date") or "").strip()
        or str(context.state.get(_PLATFORM_CURRENT_DATE_KEY) or "").strip()
        or _DEFAULT_DEMO_DATE
    )
    parts = raw.split("-")
    if len(parts) == 3 and all(p.isdigit() for p in parts):
        year = int(parts[0])
        month = int(parts[1])
        day = int(parts[2])
        if 1 <= month <= 12 and 1 <= day <= 31:
            return year, month, day
    return 2026, 11, 24


def _format_gbp(amount_pence: int) -> str:
    """Format integer pence as £X,XXX.XX without float division."""
    sign = "-" if amount_pence < 0 else ""
    pounds, pence = divmod(abs(amount_pence), 100)
    return f"{sign}£{pounds:,}.{pence:02d}"


def _format_bps(rate_bps: int) -> str:
    """Format integer basis points as X.XX%."""
    whole, frac = divmod(abs(rate_bps), 100)
    return f"{whole}.{frac:02d}%"


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
    """Resolve the upcoming recurring payment date label from demo_date."""
    if day_of_month >= anchor_day:
        target_year = anchor_year
        target_month = anchor_month
    else:
        total_m = anchor_year * 12 + anchor_month
        target_year = total_m // 12
        target_month = (total_m % 12) + 1
    return f"{day_of_month} {_MONTH_NAMES[target_month - 1]} {target_year}"


def _format_iso_month_year(iso_date: str) -> str:
    """Format YYYY-MM-DD as 'D Month YYYY' without timezone conversion."""
    elems = [x for x in iso_date.split("-") if x.isdigit()]
    if len(elems) == 3:
        year = int(elems[0])
        month = int(elems[1])
        day = int(elems[2])
        if 1 <= month <= 12:
            return f"{day} {_MONTH_NAMES[month - 1]} {year}"
    return iso_date


def _emit_ui_view(payload: dict) -> None:
    """Increment ui_view_state.seq monotonically and store payload."""
    current = dict(context.state.get("ui_view_state") or {})
    next_seq = int(current.get("seq") or 0) + 1
    updated = dict(payload)
    updated["seq"] = next_seq
    context.state["ui_view_state"] = updated


def _handle_summary(
    mg: dict, anchor_year: int, anchor_month: int, anchor_day: int
) -> dict:
    """Report mortgage balance, fixed rate & expiry, remaining term, and next payment."""
    statement_month = _MONTH_NAMES[anchor_month - 1]
    next_due = _next_payment_label(
        mg["next_payment"]["day_of_month"], anchor_year, anchor_month, anchor_day
    )
    rem_allow = max(
        0, mg["annual_overpayment_allowance_pence"] - mg["overpaid_this_year_pence"]
    )
    context.state["mortgage_state"] = {"last_subview": "overview"}
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
    mg: dict, anchor_year: int, anchor_month: int, anchor_day: int
) -> dict:
    """Report the next scheduled mortgage payment date and amount."""
    statement_month = _MONTH_NAMES[anchor_month - 1]
    next_due = _next_payment_label(
        mg["next_payment"]["day_of_month"], anchor_year, anchor_month, anchor_day
    )
    context.state["mortgage_state"] = {"last_subview": "overview"}
    _emit_ui_view({"page": "mortgage", "subview": "overview"})
    return {
        "agent_action": (
            f"Following your {statement_month} statement, your next mortgage payment is "
            f"{_format_gbp(mg['next_payment']['amount_pence'])} on {next_due}."
        )
    }


def _handle_allowance(mg: dict, statement_month: str) -> dict:
    """Report annual 10% ERC-free overpayment allowance and amount used so far."""
    rem_allow = max(
        0, mg["annual_overpayment_allowance_pence"] - mg["overpaid_this_year_pence"]
    )
    context.state["mortgage_state"] = {"last_subview": "overview"}
    _emit_ui_view({"page": "mortgage", "subview": "overview"})
    return {
        "agent_action": (
            f"As of {statement_month}, your annual 10% fee-free overpayment allowance is "
            f"{_format_gbp(mg['annual_overpayment_allowance_pence'])}; you have overpaid "
            f"{_format_gbp(mg['overpaid_this_year_pence'])} so far this year, leaving "
            f"{_format_gbp(rem_allow)} before any early repayment charge applies."
        )
    }


def _handle_overpayment_projection(
    mg: dict, monthly_pence: int, lump_pence: int, statement_month: str
) -> dict:
    """Project term reduction, interest saved, and ERC-free cap check."""
    context.state["mortgage_state"] = {
        "last_subview": "overpay",
        "monthly_overpayment_pence": monthly_pence,
        "lump_sum_overpayment_pence": lump_pence,
    }
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
                f"{_format_gbp(rem_allow)} remaining in your 10% fee-free allowance this year — "
                "what monthly or lump-sum overpayment amount would you like to test?"
            )
        }

    res = _project_overpayment(mg, monthly_pence, lump_pence)
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

    if res["projected_months"] == 0:
        outcome_clause = (
            f"It would clear the entire balance immediately and save {_format_gbp(res['interest_saved_pence'])} in future interest."
        )
    else:
        outcome_clause = (
            f"It would shave {_format_months_duration(res['months_saved'])} off your remaining term "
            f"(down to {_format_months_duration(res['projected_months'])}) and save {_format_gbp(res['interest_saved_pence'])} in total interest."
        )

    return {
        "agent_action": (
            f"Starting from {statement_month}, overpaying {proposal_text} {cap_clause}. "
            f"{outcome_clause} {_ILLUSTRATION_NOTE}"
        )
    }


def _handle_rate_options(mg: dict, statement_month: str) -> dict:
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

    context.state["mortgage_state"] = {"last_subview": "rates"}
    _emit_ui_view({"page": "mortgage", "subview": "rates"})
    joined = ", while ".join(comparisons)
    return {
        "agent_action": (
            f"Compared with your {statement_month} payment of {_format_gbp(current_pmt)} a month at "
            f"{_format_bps(mg['interest_rate_bps'])}, {joined}. {_ILLUSTRATION_NOTE}"
        )
    }


def _handle_renter_guidance(snapshot: dict, statement_month: str) -> dict:
    """Provide indicative first-home borrowing readiness for renters and offer Savings pivot."""
    income_pence = snapshot["annual_income_pence"]
    sav = snapshot["savings"]
    max_borrow_pence = _half_up(income_pence * 45, 10)
    budget_with_goal_pence = max_borrow_pence + sav["goal_target_pence"]
    remaining_deposit_pence = max(0, sav["goal_target_pence"] - sav["balance_pence"])

    context.state["mortgage_state"] = {
        "last_subview": "overview",
        "pending_savings_pivot": True,
    }
    _emit_ui_view({"page": "mortgage", "subview": "overview"})
    return {
        "agent_action": (
            f"You do not hold a Cloudbank mortgage right now, though as of {statement_month} an "
            f"indicative 4.5 times income multiple on {_format_gbp(income_pence)} suggests borrowing "
            f"up to {_format_gbp(max_borrow_pence)} — or a property budget around "
            f"{_format_gbp(budget_with_goal_pence)} once your {_format_gbp(sav['goal_target_pence'])} "
            f"{sav['goal_name']} is complete ({_format_gbp(remaining_deposit_pence)} left to go). "
            f"{_ILLUSTRATION_NOTE} Would you like to look at your {sav['goal_name']} projection?"
        )
    }


def _handle_switch_intent(switch_intent: str) -> dict:
    """Handle local navigation, capabilities, farewell, or cross-spoke pivots."""
    if switch_intent == "FAREWELL":
        first_name = (context.state.get("first_name") or "").strip()
        context.state["unclear_count"] = "0"
        context.state["mortgage_state"] = {}
        context.state["escalation_reason"] = "CALL_COMPLETED"
        context.state["call_complete"] = "true"
        if first_name:
            return {
                "agent_action": f"You are very welcome, {first_name}. Have a great rest of your day, and goodbye."
            }
        return {
            "agent_action": "You are very welcome. Have a great rest of your day, and goodbye."
        }

    if switch_intent == "NAVIGATE_HOME":
        context.state["unclear_count"] = "0"
        _emit_ui_view({"page": "home"})
        return {
            "agent_action": "I have opened your Home summary on screen. What would you like to check next?"
        }

    if switch_intent == "NAVIGATE_PROFILE":
        context.state["unclear_count"] = "0"
        _emit_ui_view({"page": "profile"})
        return {
            "agent_action": "I have opened your Profile page on screen. What else can I help you with?"
        }

    if switch_intent == "CAPABILITIES":
        context.state["unclear_count"] = "0"
        return {
            "agent_action": "I can help with everyday banking and spending, your savings pot and goal projections, or your mortgage payments, overpayments, and fixed-rate renewal options. Which area would you like to explore?"
        }

    if switch_intent in ("EVERYDAY_BANKING", "SAVINGS"):
        pass_count = int(context.state.get("pass_count") or "0")
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
        if pass_count > 4:
            return {
                "agent_action": f"Sure, tell me what you would like to check on your {label}."
            }
        context.state["unclear_count"] = "0"
        context.state["mortgage_state"] = {}
        context.state["target_agent"] = target
        return {"agent_action": f"Customer wants to explore {label}."}

    return _handle_unclear()


def _handle_unclear() -> dict:
    """Two-strike non-terminating unclear input ladder."""
    mortgage_st = dict(context.state.get("mortgage_state") or {})
    if mortgage_st.get("pending_savings_pivot"):
        return {
            "agent_action": "Would you like to look at your savings deposit pot projection, or check something else on your accounts?"
        }

    strikes = int(context.state.get("unclear_count") or "0")
    if strikes == 0:
        context.state["unclear_count"] = "1"
        return {
            "agent_action": "Sorry, I did not quite catch that. Would you like help with your mortgage, your savings pot, or everyday banking?"
        }
    context.state["unclear_count"] = "0"
    _emit_ui_view({"page": "home"})
    return {
        "agent_action": (
            "I have opened your Home summary on screen. I can help with everyday banking and "
            "spending, savings pots and goal projections, or mortgage payments, overpayments, "
            "and fixed-rate renewal options. Which would you like to look at?"
        )
    }
