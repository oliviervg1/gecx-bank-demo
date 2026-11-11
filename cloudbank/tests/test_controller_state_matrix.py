"""Controller state, multi-turn pending unclear ladder, and stray-confirmation matrix tests."""

from __future__ import annotations

from typing import Any

import pytest
from conftest import (
    CONTROLLER_NAMES,
    load_controller_namespace,
    make_seeded_state,
)


@pytest.mark.parametrize("ctrl_name", CONTROLLER_NAMES)
def test_two_strike_non_terminating_unclear_ladder_across_all_controllers(
    ctrl_name: str,
    struct_fixtures: dict[str, dict[str, Any]],
) -> None:
    """Verify Strike 1 clarifies and Strike 2 resets to Home without ever ending the call."""
    state = make_seeded_state("chloe", struct_fixtures)
    ns = load_controller_namespace(ctrl_name, state)
    fn = ns[ctrl_name]

    # Strike 1
    s1 = fn()
    assert state["unclear_count"] == "1"
    assert state.get("call_complete", "") == ""
    assert "everyday banking" in s1["agent_action"].lower()
    assert "savings" in s1["agent_action"].lower()
    assert "mortgage" in s1["agent_action"].lower()

    # Strike 2
    s2 = fn()
    assert state["unclear_count"] == "0"
    assert state.get("call_complete", "") == ""
    assert state["ui_view_state"]["page"] == "home"
    assert "home" in s2["agent_action"].lower()


def test_pending_anomaly_two_strike_ladder_and_stray_confirmation_safety(
    struct_fixtures: dict[str, dict[str, Any]],
) -> None:
    """Verify pending_anomaly_vendor re-asks on Strike 1, clears on Strike 2, and ignores stray confirmations."""
    # 1. Stray confirmation in initial state must NOT confirm or dispute Netflix
    initial_state = make_seeded_state("chloe", struct_fixtures)
    init_ns = load_controller_namespace("assist_everyday_banking", initial_state)
    stray = init_ns["assist_everyday_banking"](anomaly_confirmed="yes")
    assert "Netflix" not in stray["agent_action"]
    assert initial_state["unclear_count"] == "1"
    assert initial_state.get("everyday_state") is None

    stray_no = init_ns["assist_everyday_banking"](anomaly_confirmed="no")
    assert "not recognised" not in stray_no["agent_action"]
    assert initial_state["unclear_count"] == "0"
    assert initial_state["ui_view_state"]["page"] == "home"

    # 2. While pending_anomaly_vendor == "Netflix", Strike 1 re-asks and increments unclear_count;
    #    Strike 2 clears pending_anomaly_vendor and resets to Home instead of looping forever.
    state = make_seeded_state("chloe", struct_fixtures)
    ns = load_controller_namespace("assist_everyday_banking", state)
    ns["assist_everyday_banking"](query_type="overview")
    seq_after_overview = state["ui_view_state"]["seq"]

    reask = ns["assist_everyday_banking"]()
    assert "Netflix" in reask["agent_action"]
    assert "recognise" in reask["agent_action"]
    assert state["everyday_state"]["pending_anomaly_vendor"] == "Netflix"
    assert state["unclear_count"] == "1"
    assert state["ui_view_state"]["seq"] == seq_after_overview

    strike2 = ns["assist_everyday_banking"]()
    assert state["unclear_count"] == "0"
    assert state["everyday_state"]["pending_anomaly_vendor"] == ""
    assert state["ui_view_state"]["page"] == "home"
    assert "home" in strike2["agent_action"].lower()

    # 3. "Just to check" re-ask (anomaly_followup with empty confirmed) arms pending_anomaly_vendor (L-14)
    reask_state = make_seeded_state("chloe", struct_fixtures)
    reask_ns = load_controller_namespace("assist_everyday_banking", reask_state)
    just_check = reask_ns["assist_everyday_banking"](query_type="anomaly_followup")
    assert "Just to check" in just_check["agent_action"]
    assert reask_state["everyday_state"]["pending_anomaly_vendor"] == "Netflix"
    bare_no = reask_ns["assist_everyday_banking"](anomaly_confirmed="no")
    assert "not recognised" in bare_no["agent_action"]
    assert reask_state["everyday_state"]["anomaly_by_vendor"] == {
        "Netflix": "unrecognised"
    }

    # 4. cancel_subscription + anomaly_confirmed="no" marks unrecognised + freeze-card guidance (P1-7),
    #    whereas anomaly_confirmed="" leaves anomaly_by_vendor untouched!
    cancel_no_state = make_seeded_state("chloe", struct_fixtures)
    cancel_no_ns = load_controller_namespace("assist_everyday_banking", cancel_no_state)
    cancel_no_ns["assist_everyday_banking"](query_type="overview")
    cancel_no = cancel_no_ns["assist_everyday_banking"](
        query_type="cancel_subscription", vendor_name="Netflix", anomaly_confirmed="no"
    )
    assert "not recognised" in cancel_no["agent_action"]
    assert "freeze" in cancel_no["agent_action"]
    assert cancel_no_state["everyday_state"]["anomaly_by_vendor"] == {
        "Netflix": "unrecognised"
    }
    assert cancel_no_state["everyday_state"]["pending_anomaly_vendor"] == ""
    assert cancel_no_state["everyday_state"]["pending_redirect_offer"] is False
    assert cancel_no_state["everyday_state"]["last_discussed_subscription"] == {}

    cancel_empty_state = make_seeded_state("chloe", struct_fixtures)
    cancel_empty_ns = load_controller_namespace(
        "assist_everyday_banking", cancel_empty_state
    )
    cancel_empty_ns["assist_everyday_banking"](query_type="overview")
    cancel_empty_ns["assist_everyday_banking"](
        query_type="cancel_subscription", vendor_name="Netflix"
    )
    assert cancel_empty_state["everyday_state"].get("anomaly_by_vendor", {}) == {}


def test_pending_redirect_offer_two_strike_ladder_and_bare_yes_no(
    struct_fixtures: dict[str, dict[str, Any]],
) -> None:
    """Verify pending_redirect_offer increments unclear_count across empty calls and handles yes/no."""
    state = make_seeded_state("chloe", struct_fixtures)
    ns = load_controller_namespace("assist_everyday_banking", state)
    ns["assist_everyday_banking"](
        query_type="cancel_subscription", vendor_name="Netflix", anomaly_confirmed="yes"
    )
    assert state["everyday_state"]["pending_redirect_offer"] is True
    seq_after_cancel = state["ui_view_state"]["seq"]

    # Strike 1 empty args re-asks the £45 redirect offer and increments unclear_count
    reask = ns["assist_everyday_banking"]()
    assert "£45 a month" in reask["agent_action"]
    assert state["everyday_state"]["pending_redirect_offer"] is True
    assert state["unclear_count"] == "1"
    assert state["ui_view_state"]["seq"] == seq_after_cancel

    # Accepting via anomaly_confirmed="yes" pivots to savings_agent and resets unclear_count
    accepted = ns["assist_everyday_banking"](anomaly_confirmed="yes")
    assert "£45 a month freed from Netflix" in accepted["agent_action"]
    assert state["unclear_count"] == "0"
    assert state["target_agent"] == "savings_agent"
    assert state["handoff_context"]["freed_monthly_pence"] == 4500

    # Declining via anomaly_confirmed="no" clears pending_redirect_offer and preserves vendor anomaly_by_vendor
    decline_state = make_seeded_state("chloe", struct_fixtures)
    dec_ns = load_controller_namespace("assist_everyday_banking", decline_state)
    dec_ns["assist_everyday_banking"](
        query_type="cancel_subscription", vendor_name="Netflix", anomaly_confirmed="yes"
    )
    declined = dec_ns["assist_everyday_banking"](anomaly_confirmed="no")
    assert "leave your savings pot as it is" in declined["agent_action"]
    assert decline_state["everyday_state"]["pending_redirect_offer"] is False
    assert decline_state["everyday_state"]["anomaly_by_vendor"] == {"Netflix": "confirmed"}
    assert decline_state.get("target_agent", "") == ""

    # Two consecutive empty turns clear stale pending_redirect_offer cleanly on Strike 2
    s2_state = make_seeded_state("chloe", struct_fixtures)
    s2_ns = load_controller_namespace("assist_everyday_banking", s2_state)
    s2_ns["assist_everyday_banking"](
        query_type="cancel_subscription", vendor_name="Netflix", anomaly_confirmed="yes"
    )
    s2_ns["assist_everyday_banking"]()
    assert s2_state["unclear_count"] == "1"
    s2_ns["assist_everyday_banking"]()
    assert s2_state["unclear_count"] == "0"
    assert s2_state["everyday_state"]["pending_redirect_offer"] is False
    assert s2_state["ui_view_state"]["page"] == "home"


def test_renter_pending_savings_pivot_confirm_no_yes_and_two_strike_recovery(
    struct_fixtures: dict[str, dict[str, Any]],
) -> None:
    """Verify Tom's renter pending_savings_pivot supports confirm_pivot='no'/'yes', 2-strike recovery, and ignores stray homeowner calls."""
    # 0. Stray confirm_pivot on homeowner Chloe (pending_savings_pivot not armed) must NOT route to savings_agent or bypass unclear_count
    homeowner_state = make_seeded_state("chloe", struct_fixtures)
    homeowner_ns = load_controller_namespace("assist_mortgages", homeowner_state)
    stray_yes = homeowner_ns["assist_mortgages"](confirm_pivot="yes")
    assert homeowner_state.get("target_agent", "") == ""
    assert homeowner_state["unclear_count"] == "1"
    assert "savings projections" not in stray_yes["agent_action"].lower()

    stray_no = homeowner_ns["assist_mortgages"](confirm_pivot="no")
    assert homeowner_state.get("target_agent", "") == ""
    assert homeowner_state["unclear_count"] == "0"
    assert homeowner_state["ui_view_state"]["page"] == "home"
    assert "no problem" not in stray_no["agent_action"].lower()

    # 1. Declining with confirm_pivot="no" clears pending_savings_pivot cleanly
    decline_state = make_seeded_state("tom", struct_fixtures)
    dec_ns = load_controller_namespace("assist_mortgages", decline_state)
    first = dec_ns["assist_mortgages"](query_type="summary")
    assert "£189,000" in first["agent_action"]
    assert decline_state["mortgage_state"]["pending_savings_pivot"] is True

    declined = dec_ns["assist_mortgages"](confirm_pivot="no")
    assert "no problem" in declined["agent_action"].lower()
    assert decline_state["mortgage_state"]["pending_savings_pivot"] is False
    assert decline_state["unclear_count"] == "0"
    assert decline_state.get("target_agent", "") == ""

    # 2. Accepting with confirm_pivot="yes" stages silent pivot to savings_agent
    accept_state = make_seeded_state("tom", struct_fixtures)
    acc_ns = load_controller_namespace("assist_mortgages", accept_state)
    acc_ns["assist_mortgages"](query_type="summary")
    accepted = acc_ns["assist_mortgages"](confirm_pivot="yes")
    assert "savings projections" in accepted["agent_action"]
    assert accept_state["target_agent"] == "savings_agent"
    assert accept_state["mortgage_state"] == {}

    # 3. Empty calls increment unclear_count on Strike 1 and clear pending_savings_pivot on Strike 2
    state = make_seeded_state("tom", struct_fixtures)
    ns = load_controller_namespace("assist_mortgages", state)
    ns["assist_mortgages"](query_type="summary")
    seq_first = state["ui_view_state"]["seq"]

    reask = ns["assist_mortgages"]()
    assert "savings deposit pot projection" in reask["agent_action"]
    assert state["mortgage_state"]["pending_savings_pivot"] is True
    assert state["ui_view_state"]["seq"] == seq_first
    assert state["unclear_count"] == "1"

    strike2 = ns["assist_mortgages"]()
    assert state["unclear_count"] == "0"
    assert state["mortgage_state"]["pending_savings_pivot"] is False
    assert state["ui_view_state"]["page"] == "home"
    assert "home" in strike2["agent_action"].lower()
