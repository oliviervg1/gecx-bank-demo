import logging
from typing import Literal

logger = logging.getLogger(__name__)

_PLATFORM_CURRENT_DATE_KEY = "current_date"
_DEFAULT_DEMO_DATE = "2026-11-24"
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
_PERIOD_OFFSETS = {
    "": 0,
    "this_month": 0,
    "last_month": 1,
    "two_months_ago": 2,
}
_OFFSET_PERIOD_KEYS = {
    0: "this_month",
    1: "last_month",
    2: "two_months_ago",
}
_CATEGORY_LABELS = {
    "groceries": "groceries",
    "coffee_shops": "coffee shops",
    "eating_out": "eating out",
    "subscriptions": "subscriptions",
    "transport": "transport",
    "shopping": "shopping",
    "bills": "bills",
    "entertainment": "entertainment",
}


def assist_everyday_banking(
    query_type: Literal[
        "",
        "balance",
        "overview",
        "category",
        "vendor",
        "trend",
        "subscriptions",
        "anomaly_followup",
        "cancel_subscription",
    ] = "",
    category: Literal[
        "",
        "groceries",
        "coffee_shops",
        "eating_out",
        "subscriptions",
        "transport",
        "shopping",
        "bills",
        "entertainment",
    ] = "",
    vendor_name: str = "",
    period: Literal["", "this_month", "last_month", "two_months_ago"] = "",
    anomaly_confirmed: Literal["", "yes", "no"] = "",
    switch_intent: Literal[
        "",
        "SAVINGS",
        "MORTGAGES",
        "NAVIGATE_HOME",
        "NAVIGATE_PROFILE",
        "CAPABILITIES",
        "FAREWELL",
    ] = "",
) -> dict:
    """Answer everyday banking, spending, anomaly, and subscription cancellation requests.

    Pass only the arguments spoken by the caller on this turn. When the caller
    accepts an offer to see what freed subscription money does in savings with a
    bare "yes", pass ``switch_intent="SAVINGS"``.

    Do not speak a conversational pacing phrase before calling this tool, except
    when ``query_type`` is ``"cancel_subscription"``, where you may speak one
    brief natural sentence (such as "Let me check how to cancel that for you.")
    before calling the tool.

    Args:
        query_type: Specific everyday banking request ("balance", "overview",
            "category", "vendor", "trend", "subscriptions", "anomaly_followup",
            or "cancel_subscription").
        category: Spending category spoken by the caller when drilling into a
            category ("groceries", "coffee_shops", "eating_out", "subscriptions",
            "transport", "shopping", "bills", or "entertainment").
        vendor_name: Merchant or subscription provider name spoken by the caller.
        period: Statement period requested ("this_month", "last_month", or
            "two_months_ago").
        anomaly_confirmed: "yes" when the caller confirms recognising a flagged
            charge, or "no" when they state they do not recognise it.
        switch_intent: Cross-product or navigation action ("SAVINGS",
            "MORTGAGES", "NAVIGATE_HOME", "NAVIGATE_PROFILE", "CAPABILITIES",
            or "FAREWELL").

    Returns:
        A single-key dict with ``agent_action`` carrying the spoken reply.
    """
    try:
        clean_switch = (switch_intent or "").strip()
        clean_query = (query_type or "").strip()
        clean_cat = (category or "").strip()
        clean_vendor = (vendor_name or "").strip()
        clean_period = (period or "").strip()
        clean_confirm = (anomaly_confirmed or "").strip()

        everyday = dict(context.state.get("everyday_state") or {})

        if clean_switch:
            return _handle_switch_intent(clean_switch, everyday)

        snapshot = _normalize_snapshot(context.state.get("customer_snapshot") or {})
        if not snapshot:
            return {
                "agent_action": "I could not load your account snapshot right now. Please try your question again in a moment."
            }

        anchor_year, anchor_month, _ = _parse_demo_date()

        # If a savings redirect offer is pending and the caller replies "yes" or "no"
        # (even if the model mapped bare "yes" into anomaly_confirmed), honour it cleanly.
        if (
            everyday.get("pending_redirect_offer")
            and clean_confirm in ("yes", "no")
            and clean_query in ("", "anomaly_followup")
            and not clean_cat
            and not clean_vendor
        ):
            return _handle_redirect_offer_reply(clean_confirm, everyday)

        if clean_query == "cancel_subscription":
            context.state["unclear_count"] = "0"
            return _handle_cancel_subscription(
                snapshot, everyday, clean_vendor, clean_period, clean_confirm, anchor_year, anchor_month
            )

        if clean_query == "anomaly_followup" or (
            not clean_query
            and clean_confirm in ("yes", "no")
            and bool(everyday.get("pending_anomaly_vendor"))
        ):
            context.state["unclear_count"] = "0"
            return _handle_anomaly_followup(
                snapshot, everyday, clean_vendor, clean_confirm, anchor_year, anchor_month
            )

        if clean_query == "balance":
            context.state["unclear_count"] = "0"
            return _handle_balance(snapshot, anchor_year, anchor_month)

        if clean_query == "overview":
            context.state["unclear_count"] = "0"
            return _handle_overview(snapshot, everyday, clean_period, anchor_year, anchor_month)

        if clean_query == "category" or (not clean_query and clean_cat):
            context.state["unclear_count"] = "0"
            return _handle_category(snapshot, clean_cat, clean_period, anchor_year, anchor_month)

        if clean_query == "vendor" or (not clean_query and clean_vendor):
            context.state["unclear_count"] = "0"
            return _handle_vendor(
                snapshot, everyday, clean_vendor, clean_period, anchor_year, anchor_month
            )

        if clean_query == "trend":
            context.state["unclear_count"] = "0"
            return _handle_trend(snapshot, anchor_year, anchor_month)

        if clean_query == "subscriptions":
            context.state["unclear_count"] = "0"
            return _handle_subscriptions(
                snapshot, everyday, clean_period, anchor_year, anchor_month
            )

        return _handle_empty_or_unclear(snapshot, everyday)
    except Exception:
        logger.exception("assist_everyday_banking failed")
        return {
            "agent_action": "I am sorry, I ran into a temporary issue checking your account details. Please ask again in a moment."
        }


def _normalize_snapshot(raw: dict) -> dict:
    """Coerce protobuf Struct floats into exact Python ints once at entry."""
    if not isinstance(raw, dict) or "accounts" not in raw or "transactions" not in raw:
        return {}
    accounts_raw = dict(raw.get("accounts") or {})
    cur_raw = dict(accounts_raw.get("current") or {})
    sav_raw = dict(accounts_raw.get("savings") or {})

    txns = []
    for item in raw.get("transactions") or []:
        txns.append(
            {
                "id": str(item.get("id") or ""),
                "month_offset": int(item.get("month_offset") or 0),
                "day": int(item.get("day") or 1),
                "vendor": str(item.get("vendor") or ""),
                "category": str(item.get("category") or ""),
                "amount_pence": int(item.get("amount_pence") or 0),
                "is_subscription": bool(item.get("is_subscription")),
                "is_anomaly": bool(item.get("is_anomaly")),
            }
        )

    return {
        "current": {
            "name": str(cur_raw.get("name") or "Cloudbank Everyday Account"),
            "sort_code": str(cur_raw.get("sort_code") or ""),
            "account_number_last4": str(cur_raw.get("account_number_last4") or ""),
            "balance_pence": int(cur_raw.get("balance_pence") or 0),
        },
        "savings": {
            "name": str(sav_raw.get("name") or "Cloudbank Saver"),
            "balance_pence": int(sav_raw.get("balance_pence") or 0),
            "aer_bps": int(sav_raw.get("aer_bps") or 0),
            "goal_name": str(sav_raw.get("goal_name") or "savings pot"),
        },
        "transactions": txns,
    }


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


def _month_name_for_offset(anchor_year: int, anchor_month: int, offset: int) -> str:
    """Resolve the English calendar month name for month_offset 0, 1, or 2."""
    total_m = anchor_year * 12 + (anchor_month - 1) - offset
    return _MONTH_NAMES[total_m % 12]


def _format_gbp(amount_pence: int) -> str:
    """Format integer pence as £X,XXX.XX without float division."""
    sign = "-" if amount_pence < 0 else ""
    pounds, pence = divmod(abs(amount_pence), 100)
    return f"{sign}£{pounds:,}.{pence:02d}"


def _format_bps(rate_bps: int) -> str:
    """Format integer basis points as X.XX%."""
    whole, frac = divmod(abs(rate_bps), 100)
    return f"{whole}.{frac:02d}%"


def _emit_ui_view(payload: dict) -> None:
    """Increment ui_view_state.seq monotonically and store payload."""
    current = dict(context.state.get("ui_view_state") or {})
    next_seq = int(current.get("seq") or 0) + 1
    updated = dict(payload)
    updated["seq"] = next_seq
    context.state["ui_view_state"] = updated


def _normalize_vendor_forms(name: str) -> tuple[str, str]:
    """Return (apostrophe-stripped, possessive-stripped) lowercase alphanumeric vendor forms."""
    lowered = name.strip().lower()
    raw_clean = "".join(ch for ch in lowered if ch.isalnum() or ch == " ")
    raw_norm = " ".join(raw_clean.split())
    stem_src = lowered
    if stem_src.endswith("'s") or stem_src.endswith("’s"):
        stem_src = stem_src[:-2]
    stem_clean = "".join(ch for ch in stem_src if ch.isalnum() or ch == " ")
    stem_norm = " ".join(stem_clean.split())
    return raw_norm, stem_norm


def _contains_token_sequence(tx_tokens: list[str], needle_tokens: list[str]) -> bool:
    """Return True when needle_tokens appears as a contiguous whole-token slice of tx_tokens."""
    if not needle_tokens or len(needle_tokens) > len(tx_tokens):
        return False
    span = len(needle_tokens)
    return any(
        tx_tokens[idx : idx + span] == needle_tokens
        for idx in range(len(tx_tokens) - span + 1)
    )


def _vendors_equal(left: str, right: str) -> bool:
    """Return True when two vendor names normalise to the same merchant."""
    l_raw, l_stem = _normalize_vendor_forms(left)
    r_raw, r_stem = _normalize_vendor_forms(right)
    if not l_raw or not r_raw:
        return False
    return l_raw == r_raw or (bool(l_stem) and l_stem == r_stem)


def _match_vendor_rows(txns: list[dict], query_vendor: str) -> tuple[str, list[dict]]:
    """Return canonical vendor display name and matching non-income rows using whole tokens."""
    needle_raw, needle_stem = _normalize_vendor_forms(query_vendor)
    if not needle_raw:
        return "", []
    raw_tokens = needle_raw.split()
    stem_tokens = needle_stem.split() if needle_stem else raw_tokens

    matched = []
    canonical = ""
    has_exact = False
    for tx in txns:
        if tx["amount_pence"] <= 0:
            continue
        tx_raw, tx_stem = _normalize_vendor_forms(tx["vendor"])
        is_exact = tx_raw == needle_raw or (bool(needle_stem) and tx_stem == needle_stem)
        is_token_match = _contains_token_sequence(
            tx_raw.split(), raw_tokens
        ) or _contains_token_sequence(tx_stem.split(), stem_tokens)
        if is_exact or is_token_match:
            matched.append(tx)
            if is_exact and not has_exact:
                canonical = tx["vendor"]
                has_exact = True
            elif not canonical:
                canonical = tx["vendor"]
    return canonical, matched


def _handle_switch_intent(switch_intent: str, everyday: dict) -> dict:
    """Handle local navigation, capabilities, farewell, or cross-spoke pivots."""
    if switch_intent == "FAREWELL":
        first_name = (context.state.get("first_name") or "").strip()
        context.state["unclear_count"] = "0"
        context.state["everyday_state"] = {}
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
            "agent_action": "I have opened your Profile page, where your personal details and card controls live. Let me know what else you would like to look at."
        }

    if switch_intent == "CAPABILITIES":
        context.state["unclear_count"] = "0"
        return {
            "agent_action": "I can help with everyday banking and spending, your savings pot and goal projections, or your mortgage payments, overpayments, and fixed-rate renewal options. Which area would you like to explore?"
        }

    if switch_intent in ("SAVINGS", "MORTGAGES"):
        pass_count = int(context.state.get("pass_count") or "0")
        target = "savings_agent" if switch_intent == "SAVINGS" else "mortgage_agent"
        label = "savings projections" if switch_intent == "SAVINGS" else "mortgage options"
        if pass_count > 4:
            return {
                "agent_action": f"Sure, tell me what you would like to check on your {label}."
            }
        return _stage_spoke_pivot(target, label, everyday)

    return _handle_empty_or_unclear({}, everyday)


def _stage_spoke_pivot(target_agent: str, label: str, everyday: dict) -> dict:
    """Carry freed_monthly_pence in handoff_context and stage silent target_agent."""
    context.state["unclear_count"] = "0"
    last_sub = dict(everyday.get("last_discussed_subscription") or {})
    sub_vendor = str(last_sub.get("vendor") or "")
    freed_pence = int(last_sub.get("monthly_pence") or 0)

    if freed_pence > 0:
        context.state["handoff_context"] = {
            "from_agent": "everyday_banking_agent",
            "vendor": sub_vendor,
            "freed_monthly_pence": freed_pence,
        }
    else:
        context.state["handoff_context"] = {}

    everyday["pending_anomaly_vendor"] = ""
    everyday["pending_redirect_offer"] = False
    context.state["everyday_state"] = everyday
    context.state["target_agent"] = target_agent

    if freed_pence > 0 and sub_vendor:
        return {
            "agent_action": f"Customer wants to explore {label} with {_format_gbp(freed_pence)} a month freed from {sub_vendor}."
        }
    return {"agent_action": f"Customer wants to explore {label}."}


def _handle_redirect_offer_reply(confirmed: str, everyday: dict) -> dict:
    """Handle 'yes' or 'no' to the post-cancellation savings redirect offer."""
    context.state["unclear_count"] = "0"
    if confirmed == "yes":
        return _stage_spoke_pivot("savings_agent", "savings projections", everyday)
    everyday["pending_redirect_offer"] = False
    context.state["everyday_state"] = everyday
    return {
        "agent_action": "No problem at all, we will leave your savings pot as it is. Would you like to check anything else on your spending or accounts?"
    }


def _handle_balance(snapshot: dict, anchor_year: int, anchor_month: int) -> dict:
    """Report current account balance, recurring monthly commitments, and savings balance."""
    cur = snapshot["current"]
    sav = snapshot["savings"]
    this_month_name = _month_name_for_offset(anchor_year, anchor_month, 0)
    recurring_pence = sum(
        t["amount_pence"]
        for t in snapshot["transactions"]
        if t["month_offset"] == 0 and t["is_subscription"] and t["amount_pence"] > 0
    )
    _emit_ui_view({"page": "home"})
    return {
        "agent_action": (
            f"Your {cur['name']} ending {cur['account_number_last4']} has a balance of "
            f"{_format_gbp(cur['balance_pence'])}, with {_format_gbp(recurring_pence)} in "
            f"scheduled recurring bills and subscriptions for {this_month_name}. Your "
            f"{sav['name']} holds {_format_gbp(sav['balance_pence'])} at {_format_bps(sav['aer_bps'])} AER."
        )
    }


def _handle_overview(
    snapshot: dict,
    everyday: dict,
    period: str,
    anchor_year: int,
    anchor_month: int,
) -> dict:
    """Summarise monthly spending, delta vs prior month, and any flagged anomaly."""
    offset = _PERIOD_OFFSETS.get(period, 0)
    period_key = _OFFSET_PERIOD_KEYS[offset]
    month_name = _month_name_for_offset(anchor_year, anchor_month, offset)
    txns = snapshot["transactions"]

    month_txns = [t for t in txns if t["month_offset"] == offset and t["amount_pence"] > 0]
    total_pence = sum(t["amount_pence"] for t in month_txns)

    delta_clause = ""
    if offset < 2:
        prev_name = _month_name_for_offset(anchor_year, anchor_month, offset + 1)
        prev_total = sum(
            t["amount_pence"]
            for t in txns
            if t["month_offset"] == offset + 1 and t["amount_pence"] > 0
        )
        diff = total_pence - prev_total
        if diff > 0:
            delta_clause = f", which is {_format_gbp(diff)} higher than {prev_name}"
        elif diff < 0:
            delta_clause = f", which is {_format_gbp(abs(diff))} lower than {prev_name}"
        else:
            delta_clause = f", matching {prev_name} to the penny"

    anomalies = [t for t in month_txns if t["is_anomaly"]]
    if offset == 0 and anomalies:
        anom = anomalies[0]
        vendor = anom["vendor"]
        existing_status = str(everyday.get("anomaly_status") or "")
        if existing_status in ("confirmed", "unrecognised"):
            everyday["pending_anomaly_vendor"] = ""
            context.state["everyday_state"] = everyday
            _emit_ui_view(
                {
                    "page": "spending",
                    "view": "overview",
                    "period": period_key,
                    "highlight_vendor": vendor,
                    "anomaly_status": existing_status,
                }
            )
            status_label = (
                "marked as not recognised"
                if existing_status == "unrecognised"
                else "confirmed"
            )
            return {
                "agent_action": (
                    f"In {month_name} you have spent {_format_gbp(total_pence)} so far{delta_clause}, "
                    f"including the {_format_gbp(anom['amount_pence'])} {vendor} charge on "
                    f"{anom['day']} {month_name} that you already {status_label}."
                )
            }

        prior_matches = [
            t["amount_pence"]
            for t in txns
            if t["month_offset"] == 1 and t["vendor"].lower() == vendor.lower()
        ]
        prior_clause = (
            f" (up from {_format_gbp(prior_matches[0])} in {_month_name_for_offset(anchor_year, anchor_month, 1)})"
            if prior_matches
            else ""
        )
        everyday["pending_anomaly_vendor"] = vendor
        everyday["pending_redirect_offer"] = False
        everyday["anomaly_status"] = ""
        if anom["category"] == "subscriptions":
            everyday["last_discussed_subscription"] = {
                "vendor": vendor,
                "monthly_pence": anom["amount_pence"],
            }
        context.state["everyday_state"] = everyday
        _emit_ui_view(
            {
                "page": "spending",
                "view": "overview",
                "period": period_key,
                "highlight_vendor": vendor,
            }
        )
        return {
            "agent_action": (
                f"In {month_name} you have spent {_format_gbp(total_pence)} so far{delta_clause}. "
                f"One charge is flagged on your screen: {_format_gbp(anom['amount_pence'])} at "
                f"{vendor} on {anom['day']} {month_name}{prior_clause}. Do you recognise that charge? "
                f"[Diagnosis context: {month_name} total {_format_gbp(total_pence)}; flagged subscription {vendor} {_format_gbp(anom['amount_pence'])} on {anom['day']} {month_name}.]"
            )
        }

    by_cat: dict[str, int] = {}
    for t in month_txns:
        by_cat[t["category"]] = by_cat.get(t["category"], 0) + t["amount_pence"]
    top_cat_clause = ""
    if by_cat:
        top_cat, top_val = max(by_cat.items(), key=lambda kv: kv[1])
        top_cat_clause = f" Your largest category in {month_name} was {_CATEGORY_LABELS.get(top_cat, top_cat)} at {_format_gbp(top_val)}."

    context.state["everyday_state"] = everyday
    _emit_ui_view({"page": "spending", "view": "overview", "period": period_key})
    return {
        "agent_action": f"In {month_name} your total spending was {_format_gbp(total_pence)}{delta_clause}.{top_cat_clause}"
    }


def _handle_anomaly_followup(
    snapshot: dict,
    everyday: dict,
    vendor_name: str,
    confirmed: str,
    anchor_year: int,
    anchor_month: int,
) -> dict:
    """Process 'yes' or 'no' recognition for the flagged anomaly charge."""
    txns = snapshot["transactions"]
    anomalies = [t for t in txns if t["month_offset"] == 0 and t["is_anomaly"]]
    default_anom = anomalies[0] if anomalies else None

    vendor = (
        vendor_name
        or str(everyday.get("pending_anomaly_vendor") or "")
        or (default_anom["vendor"] if default_anom else "")
    )
    if not vendor:
        return {
            "agent_action": "Which charge on your statement would you like me to check?"
        }

    canonical, matched = _match_vendor_rows(txns, vendor)
    resolved_vendor = canonical or vendor
    current_rows = [t for t in matched if t["month_offset"] == 0]
    monthly_pence = current_rows[0]["amount_pence"] if current_rows else 0
    month_name = _month_name_for_offset(anchor_year, anchor_month, 0)

    if confirmed == "no":
        everyday["anomaly_status"] = "unrecognised"
        everyday["pending_anomaly_vendor"] = ""
        everyday["pending_redirect_offer"] = False
        last_sub = dict(everyday.get("last_discussed_subscription") or {})
        if _vendors_equal(resolved_vendor, str(last_sub.get("vendor") or "")):
            everyday["last_discussed_subscription"] = {}
        context.state["everyday_state"] = everyday
        _emit_ui_view(
            {
                "page": "spending",
                "view": "overview",
                "period": "this_month",
                "highlight_vendor": resolved_vendor,
                "anomaly_status": "unrecognised",
            }
        )
        amt_str = f"{_format_gbp(monthly_pence)} " if monthly_pence > 0 else ""
        return {
            "agent_action": (
                f"I have marked the {amt_str}{resolved_vendor} charge in {month_name} as not recognised on your screen. "
                "It is worth checking whether anyone in your household upgraded the plan, and you can freeze your card in the Profile tab or contact Cloudbank support if you need to raise a formal card dispute."
            )
        }

    if confirmed == "yes":
        is_sub_cat = any(t["category"] == "subscriptions" for t in matched)
        offer_pence = monthly_pence if is_sub_cat else 0
        everyday["anomaly_status"] = "confirmed"
        everyday["pending_anomaly_vendor"] = ""
        everyday["pending_redirect_offer"] = bool(offer_pence > 0)
        if offer_pence > 0:
            everyday["last_discussed_subscription"] = {
                "vendor": resolved_vendor,
                "monthly_pence": offer_pence,
            }
        context.state["everyday_state"] = everyday
        _emit_ui_view(
            {
                "page": "spending",
                "view": "subscriptions",
                "period": "this_month",
                "highlight_vendor": resolved_vendor,
            }
        )
        goal_name = snapshot["savings"]["goal_name"]
        if offer_pence > 0:
            return {
                "agent_action": (
                    f"Thanks for confirming that {_format_gbp(monthly_pence)} {resolved_vendor} charge in {month_name}. "
                    f"Would you like me to look up how to cancel {resolved_vendor}, or show what redirecting {_format_gbp(offer_pence)} a month into your {goal_name} could do?"
                )
            }
        return {
            "agent_action": f"Thanks for confirming that {resolved_vendor} charge in {month_name}. Would you like me to look up how to cancel {resolved_vendor}?"
        }

    return {
        "agent_action": f"Just to check, do you recognise the {resolved_vendor} charge in {month_name}?"
    }


def _handle_cancel_subscription(
    snapshot: dict,
    everyday: dict,
    vendor_name: str,
    period: str,
    confirmed: str,
    anchor_year: int,
    anchor_month: int,
) -> dict:
    """Look up public cancellation guidance via tools.search_help and offer savings redirect."""
    txns = snapshot["transactions"]
    last_sub = dict(everyday.get("last_discussed_subscription") or {})
    target_vendor = (
        vendor_name
        or str(everyday.get("pending_anomaly_vendor") or "")
        or str(last_sub.get("vendor") or "")
    )
    if not target_vendor:
        return {
            "agent_action": "Which subscription would you like help cancelling?"
        }

    canonical, matched = _match_vendor_rows(txns, target_vendor)
    resolved_vendor = canonical or target_vendor
    m0_rows = [t for t in matched if t["month_offset"] == 0]
    fallback_pence = (
        int(last_sub.get("monthly_pence") or 0)
        if _vendors_equal(resolved_vendor, str(last_sub.get("vendor") or ""))
        else 0
    )
    monthly_pence = (
        m0_rows[0]["amount_pence"]
        if m0_rows
        else (matched[0]["amount_pence"] if matched else fallback_pence)
    )
    is_subscription_cat = (
        any(t["category"] == "subscriptions" for t in matched)
        if matched
        else (fallback_pence > 0)
    )
    offer_pence = monthly_pence if is_subscription_cat else 0

    offset = _PERIOD_OFFSETS.get(period, 0)
    period_key = _OFFSET_PERIOD_KEYS[offset]
    month_name = _month_name_for_offset(anchor_year, anchor_month, offset)

    pending_vendor = str(everyday.get("pending_anomaly_vendor") or "")
    anomalies = [t for t in txns if t["month_offset"] == 0 and t["is_anomaly"]]
    anom_vendor = anomalies[0]["vendor"] if anomalies else ""
    if pending_vendor and _vendors_equal(resolved_vendor, pending_vendor):
        everyday["anomaly_status"] = "confirmed"
        everyday["pending_anomaly_vendor"] = ""
    elif (
        not pending_vendor
        and confirmed == "yes"
        and anom_vendor
        and _vendors_equal(resolved_vendor, anom_vendor)
    ):
        everyday["anomaly_status"] = "confirmed"

    everyday["pending_redirect_offer"] = bool(offer_pence > 0)
    if offer_pence > 0:
        everyday["last_discussed_subscription"] = {
            "vendor": resolved_vendor,
            "monthly_pence": offer_pence,
        }
    context.state["everyday_state"] = everyday

    _emit_ui_view(
        {
            "page": "spending",
            "view": "subscriptions",
            "period": period_key,
            "highlight_vendor": resolved_vendor,
        }
    )

    search_answer = _lookup_cancellation_guidance(resolved_vendor)
    goal_name = snapshot["savings"]["goal_name"]
    redirect_prompt = (
        f" Would you like to see what putting that {_format_gbp(offer_pence)} a month from {month_name} into your {goal_name} could do?"
        if offer_pence > 0
        else ""
    )

    if search_answer:
        first_name = (context.state.get("first_name") or "the customer").strip()
        offer_directive = (
            f", then ask if {first_name} would like to see what redirecting that {_format_gbp(offer_pence)} a month from {month_name} into their {goal_name} could do."
            if offer_pence > 0
            else "."
        )
        return {
            "agent_action": (
                f"Summarise the {resolved_vendor} cancellation steps from the diagnosis context in at most two plain sentences with no web addresses or URLs read aloud{offer_directive} "
                f"[Diagnosis context: {search_answer}]"
            )
        }

    return {
        "agent_action": (
            f"To cancel {resolved_vendor}, sign in to your account settings in the {resolved_vendor} app or website and select the option to cancel or manage your plan.{redirect_prompt}"
        )
    }


def _lookup_cancellation_guidance(vendor: str) -> str:
    """Invoke wrapped tools.search_help and extract joined answer text safely."""
    try:
        resp = tools.search_help({"query": f"how to cancel {vendor} subscription UK"})
    except Exception:
        logger.exception("search_help invocation failed")
        return ""

    if resp is None:
        return ""
    if isinstance(resp, dict):
        body = resp
    else:
        if not resp.ok or not resp.text:
            return ""
        body = resp.json()

    if not isinstance(body, dict) or body.get("status") == "error" or body.get("isError"):
        return ""

    answers = body.get("answer") or []
    if isinstance(answers, str):
        return answers.strip()
    if isinstance(answers, list):
        parts = [str(item).strip() for item in answers if str(item).strip()]
        return " ".join(parts)
    return ""


def _handle_category(
    snapshot: dict,
    category: str,
    period: str,
    anchor_year: int,
    anchor_month: int,
) -> dict:
    """Report category spend and top merchant for the requested calendar month."""
    if category not in _CATEGORY_LABELS:
        return {
            "agent_action": "Which spending category would you like to check: groceries, coffee shops, eating out, subscriptions, transport, shopping, bills, or entertainment?"
        }

    offset = _PERIOD_OFFSETS.get(period, 0)
    period_key = _OFFSET_PERIOD_KEYS[offset]
    month_name = _month_name_for_offset(anchor_year, anchor_month, offset)
    label = _CATEGORY_LABELS[category]

    rows = [
        t
        for t in snapshot["transactions"]
        if t["month_offset"] == offset and t["category"] == category and t["amount_pence"] > 0
    ]
    total_pence = sum(t["amount_pence"] for t in rows)
    _emit_ui_view(
        {
            "page": "spending",
            "view": "category",
            "period": period_key,
            "category": category,
        }
    )

    if not rows:
        return {
            "agent_action": f"You had no spending in {label} in {month_name}."
        }

    by_vendor: dict[str, int] = {}
    for t in rows:
        by_vendor[t["vendor"]] = by_vendor.get(t["vendor"], 0) + t["amount_pence"]
    top_vendor, top_vendor_pence = max(by_vendor.items(), key=lambda kv: kv[1])
    tx_word = "transaction" if len(rows) == 1 else "transactions"
    return {
        "agent_action": (
            f"In {month_name} you spent {_format_gbp(total_pence)} on {label} across "
            f"{len(rows)} {tx_word}, led by {top_vendor} at {_format_gbp(top_vendor_pence)}."
        )
    }


def _handle_vendor(
    snapshot: dict,
    everyday: dict,
    vendor_name: str,
    period: str,
    anchor_year: int,
    anchor_month: int,
) -> dict:
    """Report merchant spend in the requested month plus 3-month history."""
    if not vendor_name:
        return {"agent_action": "Which merchant would you like me to look up?"}

    txns = snapshot["transactions"]
    canonical, matched = _match_vendor_rows(txns, vendor_name)
    offset = _PERIOD_OFFSETS.get(period, 0)
    period_key = _OFFSET_PERIOD_KEYS[offset]
    month_name = _month_name_for_offset(anchor_year, anchor_month, offset)

    if not matched:
        known: dict[str, int] = {}
        for t in txns:
            if t["month_offset"] == 0 and t["amount_pence"] > 0:
                known[t["vendor"]] = known.get(t["vendor"], 0) + t["amount_pence"]
        sample = ", ".join(
            k for k, _ in sorted(known.items(), key=lambda kv: kv[1], reverse=True)[:4]
        )
        return {
            "agent_action": (
                f"I could not find any charges for {vendor_name} in your three-month statement history. "
                f"Recent merchants in {month_name} include {sample}."
            )
        }

    period_rows = [t for t in matched if t["month_offset"] == offset]
    period_total = sum(t["amount_pence"] for t in period_rows)
    three_month_total = sum(t["amount_pence"] for t in matched)

    if any(t["category"] == "subscriptions" for t in matched) and period_total > 0:
        everyday["last_discussed_subscription"] = {
            "vendor": canonical,
            "monthly_pence": period_total,
        }
        context.state["everyday_state"] = everyday

    _emit_ui_view(
        {
            "page": "spending",
            "view": "vendor",
            "period": period_key,
            "vendor": canonical,
        }
    )

    tx_word = "payment" if len(period_rows) == 1 else "payments"
    return {
        "agent_action": (
            f"At {canonical}, you spent {_format_gbp(period_total)} across {len(period_rows)} "
            f"{tx_word} in {month_name}, and {_format_gbp(three_month_total)} in total over the last three months."
        )
    }


def _handle_trend(snapshot: dict, anchor_year: int, anchor_month: int) -> dict:
    """Compare total spending across the trailing three calendar months."""
    txns = snapshot["transactions"]
    totals = [
        sum(t["amount_pence"] for t in txns if t["month_offset"] == m and t["amount_pence"] > 0)
        for m in (0, 1, 2)
    ]
    names = [_month_name_for_offset(anchor_year, anchor_month, m) for m in (0, 1, 2)]
    diff = totals[0] - totals[1]
    direction = (
        f"up {_format_gbp(diff)} from {names[1]}"
        if diff > 0
        else (f"down {_format_gbp(abs(diff))} from {names[1]}" if diff < 0 else f"unchanged from {names[1]}")
    )

    _emit_ui_view({"page": "spending", "view": "trend", "period": "this_month"})
    return {
        "agent_action": (
            f"Over the past three months your spending went from {_format_gbp(totals[2])} in {names[2]} "
            f"to {_format_gbp(totals[1])} in {names[1]}, and {_format_gbp(totals[0])} in {names[0]}, {direction}."
        )
    }


def _handle_subscriptions(
    snapshot: dict,
    everyday: dict,
    period: str,
    anchor_year: int,
    anchor_month: int,
) -> dict:
    """List recurring bills and subscriptions for the requested calendar month."""
    offset = _PERIOD_OFFSETS.get(period, 0)
    period_key = _OFFSET_PERIOD_KEYS[offset]
    month_name = _month_name_for_offset(anchor_year, anchor_month, offset)

    subs = [
        t
        for t in snapshot["transactions"]
        if t["month_offset"] == offset and t["is_subscription"] and t["amount_pence"] > 0
    ]
    subs.sort(key=lambda t: t["amount_pence"], reverse=True)
    total_pence = sum(t["amount_pence"] for t in subs)

    non_bill_subs = [t for t in subs if t["category"] == "subscriptions"]
    highlight = ""
    if non_bill_subs:
        lead_sub = non_bill_subs[0]
        highlight = lead_sub["vendor"]
        everyday["last_discussed_subscription"] = {
            "vendor": lead_sub["vendor"],
            "monthly_pence": lead_sub["amount_pence"],
        }
        context.state["everyday_state"] = everyday

    view_payload = {"page": "spending", "view": "subscriptions", "period": period_key}
    if highlight:
        view_payload["highlight_vendor"] = highlight
    _emit_ui_view(view_payload)

    if not subs:
        return {
            "agent_action": f"You had no recurring bills or subscriptions recorded in {month_name}."
        }

    top_items = ", ".join(f"{t['vendor']} at {_format_gbp(t['amount_pence'])}" for t in subs[:3])
    return {
        "agent_action": (
            f"In {month_name} your recurring bills and subscriptions total {_format_gbp(total_pence)} "
            f"across {len(subs)} regular charges, led by {top_items}."
        )
    }


def _handle_empty_or_unclear(snapshot: dict, everyday: dict) -> dict:
    """Idempotently re-ask any pending question before applying the 2-strike unclear ladder."""
    pending_vendor = str(everyday.get("pending_anomaly_vendor") or "")
    if pending_vendor:
        return {
            "agent_action": f"Just checking on that flagged {pending_vendor} charge on your screen — do you recognise it?"
        }

    if everyday.get("pending_redirect_offer"):
        last_sub = dict(everyday.get("last_discussed_subscription") or {})
        freed_pence = int(last_sub.get("monthly_pence") or 0)
        goal_name = (
            snapshot.get("savings", {}).get("goal_name")
            if snapshot
            else "savings pot"
        ) or "savings pot"
        if freed_pence > 0:
            return {
                "agent_action": f"Would you like to see what putting that {_format_gbp(freed_pence)} a month into your {goal_name} could do?"
            }

    strikes = int(context.state.get("unclear_count") or "0")
    if strikes == 0:
        context.state["unclear_count"] = "1"
        return {
            "agent_action": "Sorry, I did not quite catch that. Would you like to check everyday banking and spending, your savings pot, or your mortgage?"
        }

    context.state["unclear_count"] = "0"
    _emit_ui_view({"page": "home"})
    return {
        "agent_action": (
            "I have opened your Home summary on screen. I can help with everyday banking for "
            "balances, spending categories, merchant history, and subscriptions; savings for your "
            "pot balance, AER, and goal projections; or mortgages for payments, overpayments, and "
            "fixed-rate renewal options. What would you like to look at?"
        )
    }
