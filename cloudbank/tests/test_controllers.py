"""Behavioural and regression tests for all four Cloudbank Python controllers."""

from __future__ import annotations

import types
from typing import Any

import jsonschema

from conftest import (
    PERSONA_IDS,
    load_controller_namespace,
    make_seeded_state,
)

ILLUSTRATION_SENTENCE = (
    "These figures are an indicative illustration only and not personalised mortgage advice."
)


def _assert_envelope_and_ui(
    result: dict[str, Any],
    state: dict[str, Any],
    ui_schema: dict[str, Any],
) -> str:
    assert list(result.keys()) == ["agent_action"]
    text = result["agent_action"]
    assert isinstance(text, str) and text.strip()
    for banned in ("transfer", "transferring", "connecting", "handoff"):
        assert banned not in text.lower()
    if "ui_view_state" in state:
        jsonschema.validate(instance=state["ui_view_state"], schema=ui_schema)
    return text


def test_frozen_hero_journey_turns_1_to_6_and_alt_2b(
    struct_fixtures: dict[str, dict[str, Any]],
    ui_view_state_schema: dict[str, Any],
) -> None:
    """Verify the complete frozen Chloe hero journey (Turns 1..6) and Alt Turn 2b."""
    state = make_seeded_state("chloe", struct_fixtures)
    r_ns = load_controller_namespace("route_banking_intent", state)
    e_ns = load_controller_namespace("assist_everyday_banking", state)
    s_ns = load_controller_namespace("assist_savings", state)
    m_ns = load_controller_namespace("assist_mortgages", state)

    # Turn 1: root -> everyday overview
    t1_route = r_ns["route_banking_intent"](
        intent="EVERYDAY_BANKING", topic_hint="spending overview"
    )
    _assert_envelope_and_ui(t1_route, state, ui_view_state_schema)
    assert state["target_agent"] == "everyday_banking_agent"
    state["target_agent"] = ""

    t1_ov = e_ns["assist_everyday_banking"](query_type="overview", period="this_month")
    ov_text = _assert_envelope_and_ui(t1_ov, state, ui_view_state_schema)
    assert "£2,018.64" in ov_text and "£77.15" in ov_text and "£45 at Netflix" in ov_text
    assert state["ui_view_state"] == {
        "seq": 1,
        "page": "spending",
        "view": "overview",
        "period": "this_month",
        "highlight_vendor": "Netflix",
    }

    # Branch check for Turn 2b (unrecognised) on an isolated state clone
    alt_state = make_seeded_state("chloe", struct_fixtures)
    alt_e = load_controller_namespace("assist_everyday_banking", alt_state)
    alt_e["assist_everyday_banking"](query_type="overview", period="this_month")
    t2b = alt_e["assist_everyday_banking"](
        query_type="anomaly_followup", anomaly_confirmed="no"
    )
    t2b_text = _assert_envelope_and_ui(t2b, alt_state, ui_view_state_schema)
    assert "marked the £45 Netflix charge in November as not recognised" in t2b_text
    assert alt_state["ui_view_state"] == {
        "seq": 2,
        "page": "spending",
        "view": "overview",
        "period": "this_month",
        "highlight_vendor": "Netflix",
        "anomaly_status": "unrecognised",
    }

    # Turn 2a: confirm hike + cancel Netflix via wrapped search_help
    t2a = e_ns["assist_everyday_banking"](
        query_type="cancel_subscription",
        vendor_name="Netflix",
        anomaly_confirmed="yes",
    )
    t2a_text = _assert_envelope_and_ui(t2a, state, ui_view_state_schema)
    assert "[Diagnosis context:" in t2a_text
    assert "£45 a month" in t2a_text
    assert state["everyday_state"]["anomaly_status"] == "confirmed"
    assert state["everyday_state"]["pending_redirect_offer"] is True
    assert state["ui_view_state"] == {
        "seq": 2,
        "page": "spending",
        "view": "subscriptions",
        "period": "this_month",
        "highlight_vendor": "Netflix",
    }

    # Turn 3: pivot to savings + automatic £45/mo projection
    t3_piv = e_ns["assist_everyday_banking"](switch_intent="SAVINGS")
    _assert_envelope_and_ui(t3_piv, state, ui_view_state_schema)
    assert state["target_agent"] == "savings_agent"
    assert state["handoff_context"] == {
        "from_agent": "everyday_banking_agent",
        "vendor": "Netflix",
        "freed_monthly_pence": 4500,
    }
    state["target_agent"] = ""

    t3_proj = s_ns["assist_savings"](query_type="projection")
    t3_text = _assert_envelope_and_ui(t3_proj, state, ui_view_state_schema)
    assert state["handoff_context"] == {}
    assert "£45 a month from Netflix" in t3_text
    assert "shaving 4 months" in t3_text and "19 months (June 2028)" in t3_text
    assert state["ui_view_state"] == {
        "seq": 3,
        "page": "savings",
        "extra_monthly_pence": 4500,
    }

    # Turn 4: pivot to mortgage + £200/mo overpayment projection
    t4_piv = s_ns["assist_savings"](switch_intent="MORTGAGES")
    _assert_envelope_and_ui(t4_piv, state, ui_view_state_schema)
    assert state["target_agent"] == "mortgage_agent"
    state["target_agent"] = ""

    t4_proj = m_ns["assist_mortgages"](
        query_type="overpayment_projection", monthly_overpayment=200.0
    )
    t4_text = _assert_envelope_and_ui(t4_proj, state, ui_view_state_schema)
    assert "£2,400 in year one" in t4_text
    assert "3 years and 2 months" in t4_text and "£17,849.18" in t4_text
    assert ILLUSTRATION_SENTENCE in t4_text
    assert state["ui_view_state"] == {
        "seq": 4,
        "page": "mortgage",
        "subview": "overpay",
        "monthly_overpayment_pence": 20000,
        "lump_sum_overpayment_pence": 0,
    }

    # Turn 5: fixed-rate renewal options
    t5 = m_ns["assist_mortgages"](query_type="rate_options")
    t5_text = _assert_envelope_and_ui(t5, state, ui_view_state_schema)
    assert "£1,365.17" in t5_text and "£34.54 less a month" in t5_text
    assert "£1,348.63" in t5_text and "£51.08 less a month" in t5_text
    assert ILLUSTRATION_SENTENCE in t5_text
    assert state["ui_view_state"] == {
        "seq": 5,
        "page": "mortgage",
        "subview": "rates",
    }

    # Turn 6: farewell leaves ui_view_state at seq 5 and latches call_complete
    t6 = m_ns["assist_mortgages"](switch_intent="FAREWELL")
    t6_text = _assert_envelope_and_ui(t6, state, ui_view_state_schema)
    assert "Chloe" in t6_text and "goodbye" in t6_text.lower()
    assert state["call_complete"] == "true"
    assert state["escalation_reason"] == "CALL_COMPLETED"
    assert state["ui_view_state"]["seq"] == 5


def test_s2_1_vendor_matching_exact_and_whole_token_across_all_personas(
    struct_fixtures: dict[str, dict[str, Any]],
    ui_view_state_schema: dict[str, Any],
) -> None:
    """Regression S2-1: exact normalised match + whole-token containment, never norm_tx in needle."""
    # Every exact vendor across all 4 personas returns strictly its own rows (except Tesco -> Tesco + Tesco Express)
    for pid in PERSONA_IDS:
        state = make_seeded_state(pid, struct_fixtures)
        ns = load_controller_namespace("assist_everyday_banking", state)
        txns = ns["_normalize_snapshot"](state["customer_snapshot"])["transactions"]
        vendors = sorted({t["vendor"] for t in txns if t["amount_pence"] > 0})
        for vname in vendors:
            resp = ns["assist_everyday_banking"](query_type="vendor", vendor_name=vname)
            txt = _assert_envelope_and_ui(resp, state, ui_view_state_schema)
            if pid == "chloe" and vname == "Tesco":
                expected_pence = sum(
                    t["amount_pence"]
                    for t in txns
                    if t["month_offset"] == 0 and t["vendor"] in ("Tesco", "Tesco Express")
                )
            else:
                expected_pence = sum(
                    t["amount_pence"]
                    for t in txns
                    if t["month_offset"] == 0 and t["vendor"] == vname
                )
            assert ns["_format_gbp"](expected_pence) in txt, (pid, vname, txt)

    # Specific S2-1 regressions: Costa Coffee on Chloe, EE on David, possessives, non-matches
    chloe_st = make_seeded_state("chloe", struct_fixtures)
    chloe_e = load_controller_namespace("assist_everyday_banking", chloe_st)
    assert "£3.85 across 1 payment" in chloe_e["assist_everyday_banking"](
        query_type="vendor", vendor_name="Costa Coffee"
    )["agent_action"]
    assert "£80.75 across 3 payments" in chloe_e["assist_everyday_banking"](
        query_type="vendor", vendor_name="Tesco's"
    )["agent_action"]
    assert "£12.40 across 1 payment" in chloe_e["assist_everyday_banking"](
        query_type="vendor", vendor_name="Tesco Express"
    )["agent_action"]
    assert "could not find any charges" in chloe_e["assist_everyday_banking"](
        query_type="vendor", vendor_name="coffee shop near me"
    )["agent_action"]
    assert "could not find any charges" in chloe_e["assist_everyday_banking"](
        query_type="vendor", vendor_name="a"
    )["agent_action"]

    david_st = make_seeded_state("david", struct_fixtures)
    david_e = load_controller_namespace("assist_everyday_banking", david_st)
    assert "£45 across 1 payment" in david_e["assist_everyday_banking"](
        query_type="vendor", vendor_name="EE"
    )["agent_action"]
    assert "£365.75 across 3 payments" in david_e["assist_everyday_banking"](
        query_type="vendor", vendor_name="Sainsburys"
    )["agent_action"]
    assert "could not find any charges" in david_e["assist_everyday_banking"](
        query_type="vendor", vendor_name="ee e"
    )["agent_action"]


def test_s2_2_and_c1_resolved_anomaly_persists_and_disputed_charge_never_hands_off(
    struct_fixtures: dict[str, dict[str, Any]],
    ui_view_state_schema: dict[str, Any],
) -> None:
    """Regression S2-2 + C-1: resolved anomaly never re-asks; 'no' clears last_discussed_subscription."""
    state = make_seeded_state("chloe", struct_fixtures)
    e_ns = load_controller_namespace("assist_everyday_banking", state)

    e_ns["assist_everyday_banking"](query_type="overview")
    assert state["everyday_state"]["last_discussed_subscription"] == {
        "vendor": "Netflix",
        "monthly_pence": 4500,
    }

    # Caller marks Netflix as unrecognised ("no")
    e_ns["assist_everyday_banking"](anomaly_confirmed="no")
    assert state["everyday_state"]["anomaly_status"] == "unrecognised"
    assert state["everyday_state"]["last_discussed_subscription"] == {}

    # Subsequent overview keeps highlight + anomaly_status and does NOT re-ask
    ov_after = e_ns["assist_everyday_banking"](query_type="overview")
    ov_txt = _assert_envelope_and_ui(ov_after, state, ui_view_state_schema)
    assert "Do you recognise that charge?" not in ov_txt
    assert "already marked as not recognised" in ov_txt
    assert state["ui_view_state"]["highlight_vendor"] == "Netflix"
    assert state["ui_view_state"]["anomaly_status"] == "unrecognised"

    # Pivot to savings: C-1 ensures disputed Netflix £45 is NOT handed off as freed money
    piv = e_ns["assist_everyday_banking"](switch_intent="SAVINGS")
    piv_txt = _assert_envelope_and_ui(piv, state, ui_view_state_schema)
    assert "Netflix" not in piv_txt
    assert state["handoff_context"] == {}

    # Returning to overview after pivot STILL remembers anomaly_status="unrecognised"
    ov_return = e_ns["assist_everyday_banking"](query_type="overview")
    assert "Do you recognise that charge?" not in ov_return["agent_action"]
    assert state["ui_view_state"]["anomaly_status"] == "unrecognised"


def test_s2_3_cancelling_other_subscription_keeps_anomaly_pending(
    struct_fixtures: dict[str, dict[str, Any]],
) -> None:
    """Regression S2-3: cancelling Spotify while Netflix is pending leaves Netflix pending."""
    state = make_seeded_state("chloe", struct_fixtures)
    e_ns = load_controller_namespace("assist_everyday_banking", state)

    e_ns["assist_everyday_banking"](query_type="overview")
    assert state["everyday_state"]["pending_anomaly_vendor"] == "Netflix"

    e_ns["assist_everyday_banking"](
        query_type="cancel_subscription", vendor_name="Spotify"
    )
    assert state["everyday_state"]["pending_anomaly_vendor"] == "Netflix"
    assert state["everyday_state"].get("anomaly_status", "") == ""
    assert state["everyday_state"]["last_discussed_subscription"] == {
        "vendor": "Spotify",
        "monthly_pence": 1199,
    }


def test_s2_4_bills_never_treated_as_freed_subscription_money(
    struct_fixtures: dict[str, dict[str, Any]],
) -> None:
    """Regression S2-4: mortgage, rent, energy, and council tax never populate handoff_context."""
    for pid, bill_vendor in (
        ("david", "Cloudbank Mortgage"),
        ("david", "Leeds City Council"),
        ("chloe", "British Gas"),
        ("tom", "Hamilton Lettings"),
    ):
        state = make_seeded_state(pid, struct_fixtures)
        e_ns = load_controller_namespace("assist_everyday_banking", state)
        e_ns["assist_everyday_banking"](query_type="vendor", vendor_name=bill_vendor)
        assert "last_discussed_subscription" not in state.get("everyday_state", {})
        e_ns["assist_everyday_banking"](
            query_type="cancel_subscription", vendor_name=bill_vendor
        )
        assert "last_discussed_subscription" not in state.get("everyday_state", {})
        assert state["everyday_state"]["pending_redirect_offer"] is False
        e_ns["assist_everyday_banking"](switch_intent="SAVINGS")
        assert state["handoff_context"] == {}


def test_s2_5_spoke_pivot_guard_allows_corrective_hop_and_blocks_ping_pong(
    struct_fixtures: dict[str, dict[str, Any]],
) -> None:
    """Regression S2-5: pass_count == 3 allows corrective hop; pass_count == 5 stops loop."""
    for ctrl, switch_val, expected_target in (
        ("assist_everyday_banking", "SAVINGS", "savings_agent"),
        ("assist_savings", "MORTGAGES", "mortgage_agent"),
        ("assist_mortgages", "EVERYDAY_BANKING", "everyday_banking_agent"),
    ):
        state = make_seeded_state("chloe", struct_fixtures)
        ns = load_controller_namespace(ctrl, state)
        state["pass_count"] = "3"
        ns[ctrl](switch_intent=switch_val)
        assert state["target_agent"] == expected_target

        state["target_agent"] = ""
        state["pass_count"] = "5"
        blocked = ns[ctrl](switch_intent=switch_val)
        assert state.get("target_agent", "") == ""
        assert "Sure, tell me what you would like to check" in blocked["agent_action"]


def test_savings_handoff_vendor_attribution_and_all_branches(
    struct_fixtures: dict[str, dict[str, Any]],
    ui_view_state_schema: dict[str, Any],
) -> None:
    """Verify handoff vendor attribution only when amount matches handoff_freed, plus all branches."""
    state = make_seeded_state("chloe", struct_fixtures)
    s_ns = load_controller_namespace("assist_savings", state)

    state["handoff_context"] = {
        "from_agent": "everyday_banking_agent",
        "vendor": "Netflix",
        "freed_monthly_pence": 4500,
    }
    diff_amt = s_ns["assist_savings"](query_type="projection", extra_monthly_amount=100.0)
    assert "from Netflix" not in diff_amt["agent_action"]
    assert "£100 a month" in diff_amt["agent_action"]

    state["handoff_context"] = {
        "from_agent": "everyday_banking_agent",
        "vendor": "Netflix",
        "freed_monthly_pence": 4500,
    }
    same_amt = s_ns["assist_savings"](query_type="projection", extra_monthly_amount=45.0)
    assert "£45 a month from Netflix" in same_amt["agent_action"]

    # Summary, interest_rate, custom_target, local navigation
    for call_kwargs in (
        {"query_type": "summary"},
        {"query_type": "interest_rate"},
        {"query_type": "projection", "extra_monthly_amount": 100.0, "custom_target_amount": 15000.0},
        {"switch_intent": "NAVIGATE_HOME"},
        {"switch_intent": "NAVIGATE_PROFILE"},
        {"switch_intent": "CAPABILITIES"},
    ):
        resp = s_ns["assist_savings"](**call_kwargs)
        _assert_envelope_and_ui(resp, state, ui_view_state_schema)
        assert state.get("target_agent", "") == ""


def test_everyday_and_mortgage_remaining_branches_and_search_resilience(
    struct_fixtures: dict[str, dict[str, Any]],
    ui_view_state_schema: dict[str, Any],
) -> None:
    """Verify balance, trend, subscriptions, search fallbacks, and local navigation across controllers."""
    state = make_seeded_state("chloe", struct_fixtures)

    # googleSearchTool snippets shape: prefers vendor domain, skips YouTube, sanitizes brackets, and caps at 600 chars
    resp_obj_ns = load_controller_namespace(
        "assist_everyday_banking",
        state,
        search_handler=lambda inp: {
            "search_query": inp["query"],
            "snippets": [
                {
                    "url": "https://www.youtube.com/watch?v=123",
                    "title": "YouTube tutorial",
                    "text": "Watch video tutorial.",
                },
                {
                    "url": "https://subsorted.co.uk/spotify",
                    "title": "SubSorted guide",
                    "text": "General UK guide.",
                },
                {
                    "url": "https://support.spotify.com/uk/article/close-account/",
                    "title": "Spotify Support",
                    "text": "Open Account [Settings] and click Cancel.",
                },
            ],
        },
    )
    ok_res = resp_obj_ns["assist_everyday_banking"](
        query_type="cancel_subscription", vendor_name="Spotify"
    )
    assert "Watch video tutorial" not in ok_res["agent_action"]
    assert (
        "[Diagnosis context: Open Account (Settings) and click Cancel. General UK guide.]"
        in ok_res["agent_action"]
    )

    # Live CXAS SearchToolResponse wrapper (.ok / .text / .json()) is unwrapped identically to dict
    class _FakeSearchToolResponse:
        ok = True
        text = '{"snippets":[{"url":"https://help.netflix.com/en/node/407","text":"Go to Manage your membership and click Cancel."}]}'

        def json(self) -> dict[str, Any]:
            return {
                "search_query": "how to cancel Netflix subscription UK",
                "snippets": [
                    {
                        "url": "https://help.netflix.com/en/node/407",
                        "title": "How to cancel - Netflix Help Center",
                        "text": "Go to Manage your membership and click Cancel.",
                    }
                ],
            }

    ext_ns = load_controller_namespace(
        "assist_everyday_banking",
        state,
        search_handler=lambda _inp: _FakeSearchToolResponse(),
    )
    ext_res = ext_ns["assist_everyday_banking"](
        query_type="cancel_subscription", vendor_name="Netflix"
    )
    assert (
        "[Diagnosis context: Go to Manage your membership and click Cancel.]"
        in ext_res["agent_action"]
    )

    # T7-5: Long search snippet is capped at _MAX_DIAGNOSIS_CHARS (600)
    long_text = "Step " * 200  # 1,000 chars
    cap_ns = load_controller_namespace(
        "assist_everyday_banking",
        state,
        search_handler=lambda _inp: {
            "search_query": "cancel Spotify",
            "snippets": [{"url": "https://support.spotify.com/cancel", "text": long_text}],
        },
    )
    capped_res = cap_ns["assist_everyday_banking"](
        query_type="cancel_subscription", vendor_name="Spotify"
    )
    diag_body = capped_res["agent_action"].split("[Diagnosis context: ", 1)[1].rstrip("]")
    assert len(diag_body) == 600

    # Non-masking snapshot check: missing required balance_pence yields graceful apology rather than "£0"
    broken_state = make_seeded_state("chloe", struct_fixtures)
    del broken_state["customer_snapshot"]["accounts"]["current"]["balance_pence"]
    broken_ns = load_controller_namespace("assist_everyday_banking", broken_state)
    broken_res = broken_ns["assist_everyday_banking"](query_type="balance")
    assert "temporary issue checking your account details" in broken_res["agent_action"]
    assert "£0" not in broken_res["agent_action"]

    # Exception / error fallback in search_help
    def _boom(_inp: dict[str, Any]) -> None:
        raise RuntimeError("network timeout")

    err_ns = load_controller_namespace(
        "assist_everyday_banking", state, search_handler=_boom
    )
    fallback_res = err_ns["assist_everyday_banking"](
        query_type="cancel_subscription", vendor_name="Spotify"
    )
    assert "[Diagnosis context:" not in fallback_res["agent_action"]
    assert "sign in to your account settings" in fallback_res["agent_action"]

    for kwargs in (
        {"query_type": "balance"},
        {"query_type": "trend"},
        {"query_type": "subscriptions"},
        {"query_type": "overview", "period": "last_month"},
        {"switch_intent": "NAVIGATE_HOME"},
        {"switch_intent": "NAVIGATE_PROFILE"},
        {"switch_intent": "CAPABILITIES"},
    ):
        res = err_ns["assist_everyday_banking"](**kwargs)
        _assert_envelope_and_ui(res, state, ui_view_state_schema)
        assert state.get("target_agent", "") == ""

    mg_ns = load_controller_namespace("assist_mortgages", state)
    for kwargs in (
        {"query_type": "summary"},
        {"query_type": "next_payment"},
        {"query_type": "overpayment_allowance"},
        {"query_type": "overpayment_projection"},
        {"switch_intent": "NAVIGATE_HOME"},
        {"switch_intent": "NAVIGATE_PROFILE"},
        {"switch_intent": "CAPABILITIES"},
    ):
        res = mg_ns["assist_mortgages"](**kwargs)
        _assert_envelope_and_ui(res, state, ui_view_state_schema)
        assert state.get("target_agent", "") == ""

    r_ns = load_controller_namespace("route_banking_intent", state)
    for intent in ("GREETING", "NAVIGATE_HOME", "NAVIGATE_PROFILE", "CAPABILITIES", "FAREWELL"):
        res = r_ns["route_banking_intent"](intent=intent)
        _assert_envelope_and_ui(res, state, ui_view_state_schema)


def test_deferred_anomaly_tesco_drilldown_trend_and_return_to_netflix(
    struct_fixtures: dict[str, dict[str, Any]],
    ui_view_state_schema: dict[str, Any],
) -> None:
    """Verify Chloe can confirm/defer Netflix, inspect Tesco month + 3-month trend, then cancel Netflix."""
    state = make_seeded_state("chloe", struct_fixtures)
    e_ns = load_controller_namespace("assist_everyday_banking", state)
    s_ns = load_controller_namespace("assist_savings", state)

    # 1. Overview flags Netflix £45
    t1 = e_ns["assist_everyday_banking"](query_type="overview", period="this_month")
    _assert_envelope_and_ui(t1, state, ui_view_state_schema)
    assert state["everyday_state"]["pending_anomaly_vendor"] == "Netflix"

    # 2. Chloe confirms/defers Netflix and asks for Tesco's spend this month
    t2 = e_ns["assist_everyday_banking"](
        query_type="vendor",
        vendor_name="Tesco's",
        period="this_month",
        anomaly_confirmed="yes",
    )
    t2_txt = _assert_envelope_and_ui(t2, state, ui_view_state_schema)
    assert "come back to Netflix" in t2_txt
    assert "£80.75 across 3 payments in November" in t2_txt
    assert "£179.65" not in t2_txt
    assert state["everyday_state"]["anomaly_status"] == "confirmed"
    assert state["everyday_state"]["pending_anomaly_vendor"] == ""
    assert state["everyday_state"]["last_discussed_subscription"] == {
        "vendor": "Netflix",
        "monthly_pence": 4500,
    }
    assert state["ui_view_state"] == {
        "seq": 2,
        "page": "spending",
        "view": "vendor",
        "period": "this_month",
        "vendor": "Tesco",
    }

    # 3. Chloe asks for 3-month view of Tesco spend
    t3 = e_ns["assist_everyday_banking"](query_type="trend", vendor_name="Tesco")
    t3_txt = _assert_envelope_and_ui(t3, state, ui_view_state_schema)
    assert "£46.40 in September" in t3_txt
    assert "£52.50 in October" in t3_txt
    assert "£80.75 in November" in t3_txt
    assert "£179.65" in t3_txt
    assert state["ui_view_state"] == {
        "seq": 3,
        "page": "spending",
        "view": "trend",
        "period": "this_month",
        "vendor": "Tesco",
    }

    # 4. Chloe returns to Netflix to cancel it, then pivots to Savings for the £45/mo impact
    t4 = e_ns["assist_everyday_banking"](query_type="cancel_subscription", vendor_name="Netflix")
    _assert_envelope_and_ui(t4, state, ui_view_state_schema)
    assert state["ui_view_state"] == {
        "seq": 4,
        "page": "spending",
        "view": "subscriptions",
        "period": "this_month",
        "highlight_vendor": "Netflix",
    }

    e_ns["assist_everyday_banking"](switch_intent="SAVINGS")
    assert state["target_agent"] == "savings_agent"
    assert state["handoff_context"]["freed_monthly_pence"] == 4500
    state["target_agent"] = ""

    t5 = s_ns["assist_savings"](query_type="projection")
    t5_txt = _assert_envelope_and_ui(t5, state, ui_view_state_schema)
    assert "£45 a month from Netflix" in t5_txt
    assert "shaving 4 months" in t5_txt
