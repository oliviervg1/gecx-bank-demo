#!/usr/bin/env python3
# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Synchronize and execute server-side platform golden evaluations on CXAS apps.

The goldens directory and the journey prefixes come from the workspace's
``gecx-config.json`` (``goldens_dir``, ``golden_prefixes``); see
``gecx_workspace.py``.
"""

import argparse
from dataclasses import dataclass
import logging
from pathlib import Path
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gecx_workspace import (  # noqa: E402
    Workspace,
    add_config_argument,
    load_workspace,
)
from manage_ces_app import resolve_app_resource  # noqa: E402

# The golden gate asks the platform to answer tool calls with server-side
# fakes, so a red gate means the app changed rather than a backend the CI
# environment cannot reach (or whose live state should not gate a merge).
# REAL remains available for a deliberate run against the live backends, which
# is the only thing that will notice an endpoint breaking.
DEFAULT_TOOL_CALL_BEHAVIOUR = "FAKE"
TOOL_CALL_BEHAVIOURS = ("FAKE", "REAL")

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)


def golden_prefixes(ws: Workspace) -> list[str]:
    """The journey prefixes to run, or one empty prefix meaning every evaluation."""
    return list(ws.golden_prefixes) or [""]


@dataclass
class PrefixOutcome:
    """Result of running every golden under one journey prefix once."""

    prefix: str
    passed: bool
    total: int = 0
    failed: int = 0
    seconds: float = 0.0


def build_ordered_turn_steps(
    eval_utils,
    turn,
    session_params: dict,
    params_injected: bool,
) -> dict:
    """Compile a golden Turn into CXAS steps in chronological runtime execution order.

    Unlike cxas_scrapi's default ``EvalUtils._process_dataset_turn`` (which emits all
    ``agentResponse`` expectations at the top of the turn before ``toolCall`` and
    ``agentTransfer``), this helper splits the turn into per-agent segments delimited
    by ``transfer_to_agent``. Within each segment it emits:
      1. ``toolCall`` expectations (and ``toolResponse`` if present)
      2. ``agentResponse`` expectation for that agent (unless ``# silent``)
      3. ``agentTransfer`` expectation transitioning to the next agent
    """
    steps = []
    user_input_text = turn.user

    variables = {}
    if not params_injected and session_params:
        variables.update(session_params)
        params_injected = True
    variables.update(turn.variables)

    if variables:
        steps.append({"userInput": {"variables": variables}})

    if user_input_text is None:
        steps.append({"userInput": {"event": {"event": "welcome"}}})
    else:
        steps.append({"userInput": {"text": str(user_input_text)}})

    segment_tools: list[list] = [[]]
    transfers: list[str] = []
    for tool_call in turn.tool_calls:
        action = tool_call.action
        if not action:
            continue
        # The YAML spells a transfer either as ``args: {agent: ...}`` or with the
        # SDK's ``agent:`` shorthand on the tool call itself.
        target_name = tool_call.args.get("agent") or tool_call.agent
        if action == "transfer_to_agent" and target_name:
            transfers.append(target_name)
            segment_tools.append([])
        else:
            segment_tools[-1].append(tool_call)

    num_segments = len(segment_tools)
    raw_agents = (
        list(turn.agent)
        if isinstance(turn.agent, list)
        else ([turn.agent] if turn.agent else [])
    )
    if len(raw_agents) == num_segments:
        segment_agents = raw_agents
    elif num_segments > 1 and len(raw_agents) == 1:
        segment_agents = ["# silent"] * (num_segments - 1) + raw_agents
    else:
        segment_agents = raw_agents + ["# silent"] * max(
            0, num_segments - len(raw_agents)
        )

    def _append_tool_expectation(tool_call) -> None:
        action = tool_call.action
        tool_call_id = f"adk-{uuid.uuid4()}"
        tool_resource = eval_utils.tool_map.get(action, action)
        if action not in eval_utils.tool_map and not tool_resource.startswith(
            "projects/"
        ):
            tool_resource = f"{eval_utils.app_name}/tools/{action}"

        steps.append(
            {
                "expectation": {
                    "toolCall": {
                        "id": tool_call_id,
                        "tool": tool_resource,
                        "args": tool_call.args,
                    }
                }
            }
        )
        if tool_call.output is not None:
            steps.append(
                {
                    "expectation": {
                        "toolResponse": {
                            "id": tool_call_id,
                            "tool": tool_resource,
                            "response": tool_call.output,
                        }
                    }
                }
            )

    for seg_idx in range(num_segments):
        pre_response_tools = [
            tc for tc in segment_tools[seg_idx] if tc.action != "end_session"
        ]
        post_response_tools = [
            tc for tc in segment_tools[seg_idx] if tc.action == "end_session"
        ]
        for tool_call in pre_response_tools:
            _append_tool_expectation(tool_call)

        agent_text = (
            segment_agents[seg_idx] if seg_idx < len(segment_agents) else ""
        )
        if agent_text and "# silent" not in agent_text:
            steps.append(
                {
                    "expectation": {
                        "agentResponse": {
                            "role": "agent",
                            "chunks": [{"text": agent_text}],
                        }
                    }
                }
            )

        for tool_call in post_response_tools:
            _append_tool_expectation(tool_call)

        if seg_idx < len(transfers):
            target_name = transfers[seg_idx]
            agent_resource = eval_utils.agent_map.get(target_name, target_name)
            if (
                target_name not in eval_utils.agent_map
                and not agent_resource.startswith("projects/")
            ):
                agent_resource = f"{eval_utils.app_name}/agents/{target_name}"
            steps.append(
                {
                    "expectation": {
                        "agentTransfer": {"targetAgent": agent_resource}
                    }
                }
            )

    return {"steps": steps, "params_injected": params_injected}


def sync_evals(app_resource: str, goldens_dir: Path) -> None:
    """Replaces the app's evaluations with the goldens in ``goldens_dir``.

    Every existing evaluation is deleted first, so evaluation ids are not
    preserved across syncs.
    """
    import types
    from cxas_scrapi.core.evaluations import Evaluations
    from cxas_scrapi.utils.eval_utils import EvalUtils

    logger.info("==> Synchronizing golden evaluations to %s...", app_resource)
    eval_client = Evaluations(app_name=app_resource)
    eval_utils = EvalUtils(app_name=app_resource)
    eval_utils._process_dataset_turn = types.MethodType(
        build_ordered_turn_steps, eval_utils
    )

    try:
        existing = eval_client.list_evaluations(app_resource)
        for ev in existing:
            eval_client.delete_evaluation(ev.name, force=True)
        if existing:
            logger.info(
                "   Cleaned %d existing evaluation(s) for fresh sync.",
                len(existing),
            )
    except Exception as e:
        logger.warning(
            "   Could not clean existing evaluations prior to sync: %s", e
        )

    golden_files = sorted(Path(goldens_dir).glob("*.yaml"))
    for gf in golden_files:
        logger.info("   Pushing evals from %s...", gf.name)
        evals = eval_utils.load_golden_evals_from_yaml(str(gf))
        for eval_dict in evals:
            res = eval_client.update_evaluation(
                evaluation=eval_dict, app_name=app_resource
            )
            logger.info("   Pushed: '%s' (%s)", res.display_name, res.name)
    logger.info("✅ Golden evaluations synchronized successfully!")


def format_single_failure(row: dict) -> list[str]:
    """Formats a single evaluation failure into readable log lines."""
    lines = [
        f"  Test    : {row.get('display_name')} (Turn {row.get('turn_index') or 'N/A'})",
        f"  Type    : {row.get('failure_type')}",
        f"  Expected: {row.get('expected')}",
        f"  Actual  : {row.get('actual')}",
    ]
    if row.get("score") is not None:
        lines.append(f"  Score   : {row.get('score')}")
    lines.append(
        "  -----------------------------------------------------------------------"
    )
    return lines


def fetch_evaluation_failures(app_resource: str) -> list[dict]:
    """Queries CXAS evaluation results and extracts failure records."""
    try:
        from cxas_scrapi.utils.eval_utils import EvalUtils

        eu = EvalUtils(app_name=app_resource)
        df_dict = eu.evals_to_dataframe()
        df_failures = df_dict.get("failures")
        if df_failures is not None and not df_failures.empty:
            return df_failures.to_dict(orient="records")
    except Exception as e:
        logger.warning(
            "Could not query evaluation failure details from CXAS: %s", e
        )
    return []


def print_failure_diagnostics(
    app_resource: str,
    prefix: str,
    failures: list[dict] | None = None,
) -> None:
    """Logs a formatted diagnostic box for failed evaluation cases.

    A caller holding the failing run's own rows should pass them: querying CXAS
    afterwards returns every failure the app has on record, not just this run's.
    An empty list still falls back to the query, so a run that failed without
    producing rows (an engine error, say) is not reported as silence.
    """
    failures = failures or fetch_evaluation_failures(app_resource)
    if not failures:
        logger.error(
            "❌ Evaluations for prefix '%s' failed (no detailed failure records returned).",
            prefix,
        )
        return

    logger.error(
        "======================================================================="
    )
    logger.error("❌ EVALUATION FAILURE DIAGNOSTICS FOR PREFIX '%s'", prefix)
    logger.error(
        "======================================================================="
    )
    for row in failures:
        for line in format_single_failure(row):
            logger.error(line)
    logger.error(
        "=======================================================================\n"
    )


def resolve_evaluations_by_prefix(app_resource: str, prefix: str) -> list[str]:
    """Lists the resource names of evaluations whose display name starts with prefix.

    The API runs named evaluations; the prefix is a client-side convenience that
    `cxas run --display-name-prefix` expands the same way.
    """
    from cxas_scrapi.core.evaluations import Evaluations

    eval_client = Evaluations(app_name=app_resource)
    return [
        ev.name
        for ev in eval_client.list_evaluations(app_name=app_resource)
        if ev.display_name.startswith(prefix)
    ]


def evaluation_of_result(result) -> str:
    """Returns the resource name of the evaluation an EvaluationResult belongs to.

    `EvaluationResult` carries no `evaluation` field -- reading one raises
    `Unknown field for EvaluationResult: evaluation`. The parent is encoded in
    the result's own name: `<app>/evaluations/<id>/results/<result_id>`.
    """
    return result.name.rsplit("/results/", 1)[0]


def attempt_golden_run(
    app_resource: str,
    evaluation_names: list[str],
    tool_call_behaviour: str,
    app_version: str | None = None,
) -> tuple[bool, list[dict]]:
    """Runs one batch of goldens to completion, returning pass state and failure rows.

    No cxas_scrapi entry point can request tool fakes for platform goldens:
    `cxas run` has no flag for it, `cxas evals report --use-tool-fakes` reaches
    simulations only, and `Evaluations.run_evaluation` never sets the field. The
    platform does support it, so the RunEvaluationRequest is assembled here.
    Waiting and scoring stay the SDK's own code, borrowed rather than
    reimplemented, so a run is still scored exactly as `cxas run --wait` scored it.
    """
    import pandas as pd
    from cxas_scrapi.cli.main import filter_metrics_and_assess
    from cxas_scrapi.core.evaluations import Evaluations
    from cxas_scrapi.utils.eval_utils import EvalUtils
    from google.cloud.ces_v1beta import types

    eval_client = Evaluations(app_name=app_resource)
    eval_utils = EvalUtils(app_name=app_resource)
    version_resource = ""
    if app_version:
        version_resource = (
            app_version
            if app_version.startswith("projects/")
            else f"{app_resource}/versions/{app_version}"
        )

    batch_size = 10
    chunks = [
        evaluation_names[i : i + batch_size]
        for i in range(0, len(evaluation_names), batch_size)
    ]
    all_completed_results = []

    for chunk_idx, chunk in enumerate(chunks, start=1):
        pending_chunk = list(chunk)
        if len(chunks) > 1:
            logger.info(
                "   Running sub-batch %d/%d (%d evaluation(s))...",
                chunk_idx,
                len(chunks),
                len(pending_chunk),
            )
        for chunk_attempt in (1, 2, 3):
            request = types.RunEvaluationRequest(
                app=app_resource,
                evaluations=pending_chunk,
                run_count=1,
            )
            if version_resource:
                request.app_version = version_resource
            request.golden_run_method = types.GoldenRunMethod.NAIVE
            request.config.tool_call_behaviour = types.EvaluationToolCallBehaviour[
                tool_call_behaviour
            ]
            op = eval_client.client.run_evaluation(request=request)
            op_name = op.operation.name
            run_name = None

            start_time = time.time()
            timeout_seconds = 600
            run_completed = False
            last_completed_count = 0
            stalled_polls = 0
            batch_results = []
            while time.time() - start_time < timeout_seconds:
                if not run_name:
                    for r in eval_client.client.list_evaluation_runs(
                        parent=app_resource
                    ):
                        if r.operation == op_name:
                            run_name = r.name
                            break
                if run_name:
                    run_obj = eval_client.client.get_evaluation_run(
                        name=run_name
                    )
                    completed_count = run_obj.progress.completed_count
                    if completed_count > last_completed_count:
                        last_completed_count = completed_count
                        stalled_polls = 0
                    else:
                        stalled_polls += 1

                    if len(run_obj.evaluation_results) >= len(
                        pending_chunk
                    ) and (
                        completed_count >= len(pending_chunk) - 2
                        or run_obj.state.name
                        not in (
                            "QUEUED",
                            "RUNNING",
                            "EVALUATION_RUN_STATE_UNSPECIFIED",
                        )
                        or stalled_polls >= 18
                    ):
                        batch_results = [
                            eval_client.get_evaluation_result(res_name)
                            for res_name in run_obj.evaluation_results
                        ]
                        states = [r.execution_state.name for r in batch_results]
                        if all(s in ("COMPLETED", "ERROR") for s in states):
                            run_completed = True
                            all_completed_results.extend(batch_results)
                            break
                        if stalled_polls >= 18 and (
                            ("RUNNING" not in states and "QUEUED" in states)
                            or stalled_polls >= 36
                        ):
                            logger.warning(
                                "   ⚠️ Sub-batch %d/%d stalled (%d RUNNING, %d QUEUED); restarting remaining evaluation(s)...",
                                chunk_idx,
                                len(chunks),
                                states.count("RUNNING"),
                                states.count("QUEUED"),
                            )
                            break
                time.sleep(5)

            if not run_completed and batch_results:
                done_results = [
                    r
                    for r in batch_results
                    if r.execution_state.name in ("COMPLETED", "ERROR")
                ]
                all_completed_results.extend(done_results)
                done_evals = {evaluation_of_result(r) for r in done_results}
                pending_chunk = [
                    ev for ev in pending_chunk if ev not in done_evals
                ]

            if run_completed or not pending_chunk:
                break
            try:
                eval_client.client._transport.operations_client.cancel_operation(
                    name=op_name
                )
            except Exception:
                pass
            if run_name:
                try:
                    eval_client.client.delete_evaluation_run(name=run_name)
                except Exception:
                    pass
            if chunk_attempt == 3:
                raise TimeoutError(
                    f"Evaluation sub-batch {chunk_idx}/{len(chunks)} failed/stalled after 3 attempts"
                )

    results = eval_utils.evals_to_dataframe(results=all_completed_results)
    passed = filter_metrics_and_assess(results, False)
    df_failures = results.get("failures", pd.DataFrame())
    failures = [] if df_failures.empty else df_failures.to_dict(orient="records")
    return passed, failures


def _version_kw(app_version: str | None) -> dict[str, str]:
    """Returns ``{"app_version": app_version}`` only when ``app_version`` is set."""
    return {"app_version": app_version} if app_version else {}


def evaluate_prefix(
    app_resource: str,
    prefix: str,
    tool_call_behaviour: str = DEFAULT_TOOL_CALL_BEHAVIOUR,
    app_version: str | None = None,
) -> PrefixOutcome:
    """Executes live evaluation for a single prefix and logs diagnostics on failure.

    Includes a 1-time retry on failure to absorb transient platform/LLM variance.
    The outcome carries how many evaluations ran and how many distinct ones
    failed, so a multi-pass run can print a stability summary.
    """
    if tool_call_behaviour not in TOOL_CALL_BEHAVIOURS:
        raise ValueError(
            f"tool_call_behaviour must be one of {TOOL_CALL_BEHAVIOURS}, "
            f"got: {tool_call_behaviour!r}"
        )

    logger.info(
        "   Running live evaluations for prefix '%s' under NAIVE method (tool calls: %s)...",
        prefix,
        tool_call_behaviour,
    )
    started = time.monotonic()
    try:
        evaluation_names = resolve_evaluations_by_prefix(app_resource, prefix)
    except Exception as e:
        logger.error(
            "   ❌ Could not list evaluations on %s: %s", app_resource, e
        )
        return PrefixOutcome(prefix, passed=False)

    if not evaluation_names:
        # `cxas run` exited 0 on an empty match, so a suite that failed to sync
        # scored as a pass. A gate that is green for having run nothing is
        # worse than a red one.
        logger.error(
            "   ❌ No evaluation matches prefix '%s' on %s.",
            prefix,
            app_resource,
        )
        return PrefixOutcome(prefix, passed=False)

    total = len(evaluation_names)
    logger.info("   Found %d matching evaluation(s).", total)

    failures: list[dict] = []
    for attempt in (1, 2):
        try:
            passed, failures = attempt_golden_run(
                app_resource,
                evaluation_names,
                tool_call_behaviour,
                **_version_kw(app_version),
            )
        except (Exception, SystemExit) as e:
            # The subprocess boundary used to render both a platform error and
            # a wait timeout -- which the SDK's waiter reports by calling
            # sys.exit -- as a non-zero exit code. In-process they have to be
            # caught here or the retry below never runs.
            logger.warning(
                "   ⚠️ Evaluation run for prefix '%s' did not complete: %s",
                prefix,
                e,
            )
            passed, failures = False, []

        if passed:
            logger.info("   ✅ Prefix '%s' passed!", prefix)
            return PrefixOutcome(
                prefix,
                passed=True,
                total=total,
                seconds=time.monotonic() - started,
            )

        if attempt == 1:
            logger.warning(
                "   ⚠️ Live evaluations for prefix '%s' failed on first attempt. Retrying once...",
                prefix,
            )

    print_failure_diagnostics(app_resource, prefix, failures)
    # Failure rows are per expectation, so one evaluation can produce several;
    # a run that died without rows still counts as the whole prefix failing.
    failed_names = {row.get("display_name") for row in failures}
    return PrefixOutcome(
        prefix,
        passed=False,
        total=total,
        failed=len(failed_names) if failed_names else total,
        seconds=time.monotonic() - started,
    )


def run_evaluation_prefix(
    app_resource: str,
    prefix: str,
    tool_call_behaviour: str = DEFAULT_TOOL_CALL_BEHAVIOUR,
    app_version: str | None = None,
) -> bool:
    """Returns whether every golden under `prefix` passed (see `evaluate_prefix`)."""
    return evaluate_prefix(
        app_resource, prefix, tool_call_behaviour, **_version_kw(app_version)
    ).passed


def cancel_stale_runs(app_resource: str) -> None:
    """Cancels and deletes any lingering RUNNING/QUEUED evaluation runs on the app to free worker threads."""
    try:
        from cxas_scrapi.core.evaluations import Evaluations

        ev = Evaluations(app_name=app_resource)
        for r in ev.client.list_evaluation_runs(parent=app_resource):
            if r.state.name in ("RUNNING", "QUEUED"):
                if r.operation:
                    try:
                        ev.client._transport.operations_client.cancel_operation(
                            name=r.operation
                        )
                    except Exception:
                        pass
                try:
                    ev.client.delete_evaluation_run(name=r.name)
                except Exception:
                    pass
                logger.info(
                    "   Cancelled lingering evaluation run: %s",
                    r.name.split("/")[-1],
                )
    except Exception:
        pass


def _run_pass(
    app_resource: str,
    prefixes: list[str],
    tool_call_behaviour: str,
    stop_on_failure: bool,
    app_version: str | None = None,
) -> list[PrefixOutcome]:
    """Runs every prefix once; with `stop_on_failure` the first red prefix ends the pass."""
    outcomes = []
    for prefix in prefixes:
        outcome = evaluate_prefix(
            app_resource, prefix, tool_call_behaviour, **_version_kw(app_version)
        )
        outcomes.append(outcome)
        if stop_on_failure and not outcome.passed:
            break
    return outcomes


def _log_stability_summary(passes: list[list[PrefixOutcome]]) -> None:
    """Prints one line per pass so flakiness is visible at a glance."""
    logger.info("==> Stability summary over %d pass(es):", len(passes))
    for idx, outcomes in enumerate(passes, start=1):
        total = sum(o.total for o in outcomes)
        failed = sum(o.failed for o in outcomes)
        passed = total - failed
        seconds = sum(o.seconds for o in outcomes)
        rate = (100.0 * passed / total) if total else 0.0
        marker = "✅" if all(o.passed for o in outcomes) else "❌"
        logger.info(
            "   %s Pass %d/%d: %d/%d evaluations passed (%.1f%%) in %.0fs",
            marker,
            idx,
            len(passes),
            passed,
            total,
            rate,
            seconds,
        )


def run_live_evaluations(
    app_resource: str,
    prefixes: list[str],
    tool_call_behaviour: str = DEFAULT_TOOL_CALL_BEHAVIOUR,
    runs: int = 1,
    delay_seconds: int = 0,
    app_version: str | None = None,
) -> None:
    """Coordinates running live evaluations across journey prefixes.

    A single pass is the CI gate: it stops at the first failing prefix. Several
    passes measure stability instead, so every pass runs to completion and the
    per-pass summary is printed before the non-zero exit.
    """
    cancel_stale_runs(app_resource)

    passes: list[list[PrefixOutcome]] = []
    for run_idx in range(1, runs + 1):
        if runs > 1:
            logger.info(
                "==> Evaluation pass %d/%d on %s...", run_idx, runs, app_resource
            )
        passes.append(
            _run_pass(
                app_resource,
                prefixes,
                tool_call_behaviour,
                stop_on_failure=runs == 1,
                **_version_kw(app_version),
            )
        )
        if run_idx < runs and delay_seconds > 0:
            logger.info(
                "   Waiting %ds before next evaluation pass...", delay_seconds
            )
            time.sleep(delay_seconds)

    if runs > 1:
        _log_stability_summary(passes)
    if not all(o.passed for outcomes in passes for o in outcomes):
        sys.exit(1)


USAGE_LINE = (
    "Usage: python run_golden_evals.py [--config <gecx-config.json>] "
    "sync <target> | run [target] [FAKE|REAL] "
    "[--runs N] [--delay S] [--prefix P ...] [--app-version V]"
)


def _positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError(f"must be >= 1, got {value}")
    return number


def _non_negative_int(value: str) -> int:
    number = int(value)
    if number < 0:
        raise argparse.ArgumentTypeError(f"must be >= 0, got {value}")
    return number


def build_parser() -> argparse.ArgumentParser:
    """Builds the CLI subcommand parser for run_golden_evals.py.

    ``--config`` is a global option and goes before the subcommand.
    """
    parser = argparse.ArgumentParser(add_help=False, prog="run_golden_evals.py")
    add_config_argument(parser)
    sub = parser.add_subparsers(dest="action")

    for cmd in ("sync", "sync-evals"):
        p_sync = sub.add_parser(cmd, add_help=False)
        p_sync.add_argument("target", nargs="?", default=None)

    for cmd in ("run", "run-evals"):
        p_run = sub.add_parser(cmd, add_help=False)
        p_run.add_argument("target", nargs="?", default=None)
        p_run.add_argument(
            "behaviour",
            nargs="?",
            type=str.upper,
            choices=TOOL_CALL_BEHAVIOURS,
            default=DEFAULT_TOOL_CALL_BEHAVIOUR,
        )
        p_run.add_argument("--runs", type=_positive_int, default=1)
        p_run.add_argument("--delay", type=_non_negative_int, default=0)
        p_run.add_argument(
            "--prefix", action="append", dest="prefixes", default=None
        )
        p_run.add_argument(
            "--app-version", dest="app_version", default=None
        )

    return parser


def main(argv: list[str] | None = None) -> None:
    raw_args = sys.argv[1:] if argv is None else argv
    wants_help = raw_args and raw_args[0] == "help"
    if not raw_args or wants_help or any(a in ("-h", "--help") for a in raw_args):
        logger.info(USAGE_LINE)
        sys.exit(0 if raw_args else 1)

    args = build_parser().parse_args(raw_args)
    if not args.action:
        logger.info(USAGE_LINE)
        sys.exit(1)
    ws = load_workspace(args.config)
    app_resource = resolve_app_resource(ws, args.target)
    if args.action in ("sync", "sync-evals"):
        sync_evals(app_resource, ws.goldens_dir)
    else:
        run_live_evaluations(
            app_resource,
            args.prefixes or golden_prefixes(ws),
            tool_call_behaviour=args.behaviour,
            runs=args.runs,
            delay_seconds=args.delay,
            **_version_kw(args.app_version),
        )


if __name__ == "__main__":
    main()
