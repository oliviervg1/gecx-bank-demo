"""Controller state × empty-arguments & stray-confirmation matrix tests."""

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


def test_pending_anomaly_empty_args_idempotence_and_stray_confirmation_safety(
    struct_fixtures: dict[str, dict[str, Any]],
) -> None:
    """Verify empty args re-ask pending_anomaly_vendor and stray confirmations do nothing."""
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

    # 2. While pending_anomaly_vendor == "Netflix", empty args idempotently re-ask
    state = make_seeded_state("chloe", struct_fixtures)
    ns = load_controller_namespace("assist_everyday_banking", state)
    ns["assist_everyday_banking"](query_type="overview")
    seq_after_overview = state["ui_view_state"]["seq"]

    reask = ns["assist_everyday_banking"]()
    assert "Netflix" in reask["agent_action"]
    assert "recognise" in reask["agent_action"]
    assert state["everyday_state"]["pending_anomaly_vendor"] == "Netflix"
    assert state.get("unclear_count", "0") == "0"
    assert state["ui_view_state"]["seq"] == seq_after_overview


def test_pending_redirect_offer_empty_args_and_bare_yes_no(
    struct_fixtures: dict[str, dict[str, Any]],
) -> None:
    """Verify pending_redirect_offer re-asks on empty args and handles bare yes/no in anomaly_confirmed."""
    state = make_seeded_state("chloe", struct_fixtures)
    ns = load_controller_namespace("assist_everyday_banking", state)
    ns["assist_everyday_banking"](
        query_type="cancel_subscription", vendor_name="Netflix", anomaly_confirmed="yes"
    )
    assert state["everyday_state"]["pending_redirect_offer"] is True
    seq_after_cancel = state["ui_view_state"]["seq"]

    # Empty args re-asks the £45.00 redirect offer without dropping pending_redirect_offer
    reask = ns["assist_everyday_banking"]()
    assert "£45.00 a month" in reask["agent_action"]
    assert state["everyday_state"]["pending_redirect_offer"] is True
    assert state["ui_view_state"]["seq"] == seq_after_cancel

    # Declining via anomaly_confirmed="no" clears pending_redirect_offer and keeps anomaly_status
    decline_state = make_seeded_state("chloe", struct_fixtures)
    dec_ns = load_controller_namespace("assist_everyday_banking", decline_state)
    dec_ns["assist_everyday_banking"](
        query_type="cancel_subscription", vendor_name="Netflix", anomaly_confirmed="yes"
    )
    declined = dec_ns["assist_everyday_banking"](anomaly_confirmed="no")
    assert "leave your savings pot as it is" in declined["agent_action"]
    assert decline_state["everyday_state"]["pending_redirect_offer"] is False
    assert decline_state["everyday_state"]["anomaly_status"] == "confirmed"
    assert decline_state.get("target_agent", "") == ""

    # Accepting via anomaly_confirmed="yes" pivots to savings_agent with freed_monthly_pence
    accepted = ns["assist_everyday_banking"](anomaly_confirmed="yes")
    assert "£45.00 a month freed from Netflix" in accepted["agent_action"]
    assert state["target_agent"] == "savings_agent"
    assert state["handoff_context"]["freed_monthly_pence"] == 4500


def test_renter_pending_savings_pivot_empty_args_and_pivot(
    struct_fixtures: dict[str, dict[str, Any]],
) -> None:
    """Verify Tom's renter pending_savings_pivot re-asks on empty args without bumping seq."""
    state = make_seeded_state("tom", struct_fixtures)
    ns = load_controller_namespace("assist_mortgages", state)

    first = ns["assist_mortgages"](query_type="summary")
    assert "£189,000.00" in first["agent_action"]
    assert state["mortgage_state"]["pending_savings_pivot"] is True
    seq_first = state["ui_view_state"]["seq"]

    reask = ns["assist_mortgages"]()
    assert "savings deposit pot projection" in reask["agent_action"]
    assert state["mortgage_state"]["pending_savings_pivot"] is True
    assert state["ui_view_state"]["seq"] == seq_first
    assert state.get("unclear_count", "0") == "0"

    piv = ns["assist_mortgages"](switch_intent="SAVINGS")
    assert "savings projections" in piv["agent_action"]
    assert state["target_agent"] == "savings_agent"
    assert state["mortgage_state"] == {}
