"""Cross-language parity assertions exercising real controller math against parity_vectors.json."""

from __future__ import annotations

import math
from typing import Any

from conftest import (
    CONTROLLER_NAMES,
    load_controller_namespace,
    make_seeded_state,
)


def test_half_up_parity_vectors(
    parity_vectors: dict[str, Any],
    struct_fixtures: dict[str, dict[str, Any]],
) -> None:
    """Assert _half_up in both savings and mortgages matches every half_up_cases row."""
    state = make_seeded_state("chloe", struct_fixtures)
    sav_ns = load_controller_namespace("assist_savings", state)
    mg_ns = load_controller_namespace("assist_mortgages", state)

    cases = parity_vectors["half_up_cases"]
    assert len(cases) >= 7
    for row in cases:
        assert sav_ns["_half_up"](row["n"], row["d"]) == row["expected"], row["id"]
        assert mg_ns["_half_up"](row["n"], row["d"]) == row["expected"], row["id"]


def test_to_pence_clamping_and_non_finite_guards(
    parity_vectors: dict[str, Any],
    struct_fixtures: dict[str, dict[str, Any]],
) -> None:
    """Assert _to_pence matches input_clamping_to_pence and rejects NaN/+Inf/-Inf."""
    state = make_seeded_state("chloe", struct_fixtures)
    sav_ns = load_controller_namespace("assist_savings", state)
    mg_ns = load_controller_namespace("assist_mortgages", state)

    for row in parity_vectors["input_clamping_to_pence"]:
        assert sav_ns["_to_pence"](row["raw"]) == row["expected_pence"], row["id"]
        assert mg_ns["_to_pence"](row["raw"]) == row["expected_pence"], row["id"]

    for non_finite in (math.nan, math.inf, -math.inf):
        assert sav_ns["_to_pence"](non_finite) == 0
        assert mg_ns["_to_pence"](non_finite) == 0


def test_persona_spending_vectors_and_spoken_totals(
    parity_vectors: dict[str, Any],
    struct_fixtures: dict[str, dict[str, Any]],
) -> None:
    """Assert normalized Struct-coerced spending totals, categories, and spoken figures."""
    for persona, expected in parity_vectors["persona_spending"].items():
        state = make_seeded_state(persona, struct_fixtures)
        ns = load_controller_namespace("assist_everyday_banking", state)
        snap = ns["_normalize_snapshot"](state["customer_snapshot"])
        txns = snap["transactions"]
        fmt_gbp = ns["_format_gbp"]

        monthly_totals = [
            sum(t["amount_pence"] for t in txns if t["month_offset"] == m and t["amount_pence"] > 0)
            for m in (0, 1, 2)
        ]
        assert monthly_totals == expected["monthly_totals_pence"], persona
        assert monthly_totals[0] - monthly_totals[1] == expected["delta_this_vs_last_pence"]

        recurring_totals = [
            sum(
                t["amount_pence"]
                for t in txns
                if t["month_offset"] == m and t["is_subscription"] and t["amount_pence"] > 0
            )
            for m in (0, 1, 2)
        ]
        assert recurring_totals == expected["recurring_totals_pence"], persona

        anoms = [t for t in txns if t["month_offset"] == 0 and t["is_anomaly"]]
        assert len(anoms) == 1
        anom = anoms[0]
        exp_anom = expected["anomaly"]
        assert anom["id"] == exp_anom["id"]
        assert anom["vendor"] == exp_anom["vendor"]
        assert anom["day"] == exp_anom["day"]
        assert anom["amount_pence"] == exp_anom["amount_pence"]

        for cat, cat_pence in expected["by_category_this_month_pence"].items():
            resp = ns["assist_everyday_banking"](query_type="category", category=cat)
            assert fmt_gbp(cat_pence) in resp["agent_action"], (persona, cat, resp)

        ov = ns["assist_everyday_banking"](query_type="overview", period="this_month")
        assert fmt_gbp(monthly_totals[0]) in ov["agent_action"]
        assert fmt_gbp(exp_anom["amount_pence"]) in ov["agent_action"]
        assert fmt_gbp(exp_anom["prior_month_amount_pence"]) in ov["agent_action"]


def test_savings_projection_parity_vectors(
    parity_vectors: dict[str, Any],
    struct_fixtures: dict[str, dict[str, Any]],
) -> None:
    """Assert every persona and synthetic edge row in savings_projections."""
    demo_year, demo_month = 2026, 11
    state = make_seeded_state("chloe", struct_fixtures)
    ns = load_controller_namespace("assist_savings", state)
    proj_fn = ns["_project_savings_goal"]
    ann_fn = ns["_annual_interest_on_balance"]
    month_names = list(ns["_MONTH_NAMES"])
    target_label_fn = ns["_target_month_label"]

    rows = parity_vectors["savings_projections"]
    assert len(rows) >= 14

    for row in rows:
        exp = row["expected"]
        if "synthetic" in row:
            syn = row["synthetic"]
            res = proj_fn(
                syn["balance_pence"],
                syn["gross_rate_bps"],
                syn["monthly_contribution_pence"],
                syn["extra_monthly_pence"],
                syn["goal_target_pence"],
            )
            assert res == exp, row["id"]
            continue

        p_state = make_seeded_state(row["persona"], struct_fixtures)
        p_ns = load_controller_namespace("assist_savings", p_state)
        sav = p_ns["_normalize_snapshot"](p_state["customer_snapshot"])["savings"]
        target_pence = (
            row["custom_target_pence"]
            if row["custom_target_pence"] > 0
            else sav["goal_target_pence"]
        )
        base = proj_fn(
            sav["balance_pence"],
            sav["gross_rate_bps"],
            sav["monthly_contribution_pence"],
            0,
            target_pence,
        )
        proj = proj_fn(
            sav["balance_pence"],
            sav["gross_rate_bps"],
            sav["monthly_contribution_pence"],
            row["extra_monthly_pence"],
            target_pence,
        )
        assert base["months_to_goal"] == exp["baseline_months"], row["id"]
        assert proj["months_to_goal"] == exp["projected_months"], row["id"]
        assert (base["months_to_goal"] - proj["months_to_goal"]) == exp["months_saved"]
        assert proj["unreachable"] is exp["unreachable"]
        assert proj["projected_balance_pence"] == exp["projected_balance_pence"]
        assert proj["total_interest_earned_pence"] == exp["total_interest_earned_pence"]
        assert (
            ann_fn(sav["balance_pence"], sav["gross_rate_bps"])
            == exp["annual_interest_on_balance_pence"]
        )

        expected_label = f"{month_names[exp['target_month'] - 1]} {exp['target_year']}"
        assert (
            target_label_fn(demo_year, demo_month, proj["months_to_goal"]) == expected_label
        ), row["id"]


def test_mortgage_overpayment_simulation_and_renewal_vectors(
    parity_vectors: dict[str, Any],
    struct_fixtures: dict[str, dict[str, Any]],
) -> None:
    """Assert mortgage overpayment vectors, 600-month cap edge, renewal bisection, and Tom renter."""
    base_state = make_seeded_state("chloe", struct_fixtures)
    mg_ns = load_controller_namespace("assist_mortgages", base_state)

    for edge in parity_vectors["mortgage_simulation_edges"]:
        sim = mg_ns["_simulate_mortgage"](
            edge["balance_pence"],
            edge["interest_rate_bps"],
            edge["monthly_payment_pence"],
            edge["max_months"],
        )
        assert sim == edge["expected"], edge["id"]

    for ren_edge in parity_vectors["mortgage_renewal_edges"]:
        pmt = mg_ns["_renewal_payment_pence"](
            ren_edge["balance_pence"],
            ren_edge["rate_bps"],
            ren_edge["term_remaining_months"],
        )
        assert pmt == ren_edge["expected_payment_pence"], ren_edge["id"]

    for row in parity_vectors["mortgage_overpayments"]:
        if "synthetic" in row:
            syn = row["synthetic"]
            p_ns = mg_ns
            mg = {
                "balance_pence": syn["balance_pence"],
                "interest_rate_bps": syn["interest_rate_bps"],
                "annual_overpayment_allowance_pence": syn["annual_overpayment_allowance_pence"],
                "overpaid_this_year_pence": syn["overpaid_this_year_pence"],
                "next_payment": {"amount_pence": syn["scheduled_payment_pence"]},
            }
        else:
            p_state = make_seeded_state(row["persona"], struct_fixtures)
            p_ns = load_controller_namespace("assist_mortgages", p_state)
            mg = p_ns["_normalize_snapshot"](p_state["customer_snapshot"])["mortgage"]
        res = p_ns["_project_overpayment"](
            mg,
            row["monthly_overpayment_pence"],
            row["lump_sum_overpayment_pence"],
        )
        assert res == row["expected"], row["id"]

    for persona, ren_exp in parity_vectors["mortgage_renewals"].items():
        p_state = make_seeded_state(persona, struct_fixtures)
        p_ns = load_controller_namespace("assist_mortgages", p_state)
        mg = p_ns["_normalize_snapshot"](p_state["customer_snapshot"])["mortgage"]
        assert mg["next_payment"]["amount_pence"] == ren_exp["current_payment_pence"]
        by_id = {opt["id"]: opt for opt in mg["renewal_options"]}
        for exp_opt in ren_exp["options"]:
            opt = by_id[exp_opt["id"]]
            assert opt["rate_bps"] == exp_opt["rate_bps"]
            pmt = p_ns["_renewal_payment_pence"](
                mg["balance_pence"], opt["rate_bps"], mg["term_remaining_months"]
            )
            assert pmt == exp_opt["payment_pence"], (persona, exp_opt["id"])
            assert pmt - ren_exp["current_payment_pence"] == exp_opt["delta_pence"]
            assert p_ns["_simulate_mortgage"](
                mg["balance_pence"], opt["rate_bps"], pmt, mg["term_remaining_months"]
            )["paid_off"]
            assert not p_ns["_simulate_mortgage"](
                mg["balance_pence"], opt["rate_bps"], pmt - 1, mg["term_remaining_months"]
            )["paid_off"]

    tom_exp = parity_vectors["renter_readiness"]["tom"]
    tom_state = make_seeded_state("tom", struct_fixtures)
    tom_ns = load_controller_namespace("assist_mortgages", tom_state)
    tom_snap = tom_ns["_normalize_snapshot"](tom_state["customer_snapshot"])
    assert tom_snap["mortgage"] is None
    assert tom_snap["annual_income_pence"] == tom_exp["annual_income_pence"]
    max_borrow = tom_ns["_half_up"](tom_snap["annual_income_pence"] * 45, 10)
    assert max_borrow == tom_exp["max_borrowing_pence"]
    assert max_borrow + tom_snap["savings"]["goal_target_pence"] == tom_exp[
        "indicative_budget_with_goal_pence"
    ]
    assert (
        tom_snap["savings"]["goal_target_pence"] - tom_snap["savings"]["balance_pence"]
        == tom_exp["remaining_to_goal_pence"]
    )
    progress_bps = min(
        10_000,
        tom_ns["_half_up"](
            tom_snap["savings"]["balance_pence"] * 10_000,
            tom_snap["savings"]["goal_target_pence"],
        ),
    )
    assert progress_bps == tom_exp["deposit_progress_bps"]

    tom_resp = tom_ns["assist_mortgages"](query_type="summary")
    assert "£189,000" in tom_resp["agent_action"]
    assert "£224,000" in tom_resp["agent_action"]
    assert "£20,800" in tom_resp["agent_action"]


def test_vendor_matching_and_calendar_date_parity_vectors(
    parity_vectors: dict[str, Any],
    struct_fixtures: dict[str, dict[str, Any]],
) -> None:
    """Assert vendor_matching_cases (including Unicode) and calendar_date_cases across controllers."""
    for case in parity_vectors["vendor_matching_cases"]:
        if "persona" in case:
            state = make_seeded_state(case["persona"], struct_fixtures)
            ns = load_controller_namespace("assist_everyday_banking", state)
            txns = ns["_normalize_snapshot"](state["customer_snapshot"])["transactions"]
        else:
            state = make_seeded_state("chloe", struct_fixtures)
            ns = load_controller_namespace("assist_everyday_banking", state)
            txns = [
                {
                    "id": str(item["id"]),
                    "month_offset": int(item["month_offset"]),
                    "day": int(item["day"]),
                    "vendor": str(item["vendor"]),
                    "category": str(item["category"]),
                    "amount_pence": int(item["amount_pence"]),
                    "is_subscription": bool(item.get("is_subscription")),
                    "is_anomaly": bool(item.get("is_anomaly")),
                }
                for item in case["synthetic_transactions"]
            ]
            raw_norm, stem_norm = ns["_normalize_vendor_forms"](txns[0]["vendor"])
            assert raw_norm == case["expected_normalized_raw"], case["id"]
            assert stem_norm == case["expected_normalized_stem"], case["id"]

        canonical, matched = ns["_match_vendor_rows"](txns, case["query"])
        assert canonical == case["expected_canonical"], case["id"]
        assert len(matched) == case["expected_match_count"], case["id"]

    for date_case in parity_vectors["calendar_date_cases"]:
        expected_tuple = tuple(date_case["resolved"])
        for ctrl_name in CONTROLLER_NAMES:
            d_state = make_seeded_state(
                "chloe", struct_fixtures, demo_date=date_case["raw"]
            )
            d_ns = load_controller_namespace(ctrl_name, d_state)
            assert d_ns["_parse_demo_date"]() == expected_tuple, (
                f"{ctrl_name}:{date_case['id']}"
            )
