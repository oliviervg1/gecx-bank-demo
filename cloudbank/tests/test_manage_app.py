"""Offline unit tests for manage_app overwrite import, config fallback, and tool verification."""

from __future__ import annotations

import argparse
import io
import json
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

CLOUDBANK_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = CLOUDBANK_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import manage_app  # noqa: E402
from gecx_workspace import load_workspace  # noqa: E402


def test_workspace_loads_example_fallback_and_env_overrides(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify gecx_workspace falls back to gecx-config.example.json and honors CLOUDBANK_* env vars."""
    monkeypatch.setenv("CLOUDBANK_GCP_PROJECT_ID", "demo-bank-proj")
    monkeypatch.setenv("CLOUDBANK_LOCATION", "eu")
    monkeypatch.setenv("CLOUDBANK_APP_ID", "11111111-2222-3333-4444-555555555555")

    ws = load_workspace(CLOUDBANK_ROOT / "gecx-config.json")
    assert ws.project_id == "demo-bank-proj"
    assert ws.location == "eu"
    assert ws.prod_app_id == "11111111-2222-3333-4444-555555555555"
    assert (
        ws.prod_app_resource
        == "projects/demo-bank-proj/locations/eu/apps/11111111-2222-3333-4444-555555555555"
    )


def test_expected_bundle_tool_names_matches_cloudbank_manifest() -> None:
    ws = load_workspace(CLOUDBANK_ROOT)
    expected = manage_app.expected_bundle_tool_names(ws.app_dir)
    assert expected == {
        "assist_everyday_banking",
        "assist_mortgages",
        "assist_savings",
        "route_banking_intent",
        "search_help",
    }


def test_trimmed_cli_omits_destructive_branch_and_stale_cleanup_commands() -> None:
    """Ensure prefix-based cleanup-stale and branch deletion commands were removed."""
    parser = manage_app.build_parser()
    subparsers_actions = [
        action
        for action in parser._actions
        if isinstance(action, argparse._SubParsersAction)
    ]
    assert len(subparsers_actions) == 1
    commands = set(subparsers_actions[0].choices.keys())
    assert commands == {
        "push",
        "resolve-resource",
        "list-versions",
        "create-version",
        "list-deployments",
        "create-deployment",
        "promote",
    }


def test_zip_app_bundle_overrides_display_name_without_mutating_disk() -> None:
    ws = load_workspace(CLOUDBANK_ROOT)
    archive_bytes = manage_app.zip_app_bundle(ws.app_dir, "Cloudbank-staging")
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as zf:
        app_json = json.loads(zf.read("agent/app.json").decode("utf-8"))
        assert app_json["displayName"] == "Cloudbank-staging"
        assert "agent/tools/route_banking_intent/route_banking_intent.json" in zf.namelist()
    disk_app_json = json.loads((ws.app_dir / "app.json").read_text(encoding="utf-8"))
    assert disk_app_json["displayName"] == "Cloudbank"


def test_push_app_fails_closed_on_import_warnings(monkeypatch: pytest.MonkeyPatch) -> None:
    ws = load_workspace(CLOUDBANK_ROOT)
    fake_op = MagicMock()
    fake_op.result.return_value = SimpleNamespace(
        warnings=["Skipped invalid tool python_code.py"]
    )
    fake_apps = MagicMock()
    fake_apps.import_app.return_value = fake_op
    monkeypatch.setattr(manage_app, "apps_client", lambda _ws: fake_apps)

    with pytest.raises(RuntimeError, match="reported 1 warning"):
        manage_app.push_app(ws, ws.prod_app_resource, ws.app_name)


def test_push_app_verifies_tools_and_ignores_builtin_system_tools(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ws = load_workspace(CLOUDBANK_ROOT)
    fake_op = MagicMock()
    fake_op.result.return_value = SimpleNamespace(warnings=[])
    fake_apps = MagicMock()
    fake_apps.import_app.return_value = fake_op

    remote_tools = [
        SimpleNamespace(name="p/l/a/tools/1", display_name="route_banking_intent", system_tool=None),
        SimpleNamespace(name="p/l/a/tools/2", display_name="assist_everyday_banking", system_tool=None),
        SimpleNamespace(name="p/l/a/tools/3", display_name="assist_savings", system_tool=None),
        SimpleNamespace(name="p/l/a/tools/4", display_name="assist_mortgages", system_tool=None),
        SimpleNamespace(name="p/l/a/tools/5", display_name="search_help", system_tool=None),
        SimpleNamespace(name="p/l/a/tools/sys1", display_name="end_session", system_tool=object()),
        SimpleNamespace(name="p/l/a/tools/sys2", display_name="transfer_to_agent", system_tool=object()),
    ]
    fake_tools_client = MagicMock()
    fake_tools_client.list_tools.return_value = remote_tools

    monkeypatch.setattr(manage_app, "apps_client", lambda _ws: fake_apps)
    monkeypatch.setattr(manage_app, "tools_client", lambda _res: fake_tools_client)

    manage_app.push_app(ws, ws.prod_app_resource, ws.app_name)
    fake_apps.import_app.assert_called_once()
    _, kwargs = fake_apps.import_app.call_args
    assert kwargs["conflict_strategy"] == "OVERWRITE"
    fake_tools_client.list_tools.assert_called_once()


def test_verify_expected_tools_rejects_missing_or_orphan_tools(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ws = load_workspace(CLOUDBANK_ROOT)
    remote_tools = [
        SimpleNamespace(name="p/l/a/tools/1", display_name="route_banking_intent", system_tool=None),
        SimpleNamespace(name="p/l/a/tools/2", display_name="assist_everyday_banking", system_tool=None),
        SimpleNamespace(name="p/l/a/tools/3", display_name="assist_savings", system_tool=None),
        SimpleNamespace(name="p/l/a/tools/5", display_name="search_help", system_tool=None),
        SimpleNamespace(name="p/l/a/tools/old", display_name="get_overview", system_tool=None),
    ]
    fake_tools_client = MagicMock()
    fake_tools_client.list_tools.return_value = remote_tools
    monkeypatch.setattr(manage_app, "tools_client", lambda _res: fake_tools_client)

    with pytest.raises(
        RuntimeError,
        match=r"missing=\['assist_mortgages'\], orphans=\['get_overview'\]",
    ):
        manage_app.verify_expected_tools(ws, ws.prod_app_resource)


def test_confirm_prod_overwrite_blocks_all_unconfirmed_prod_aliases(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify M-2: non-interactive push to prod via any alias/UUID/resource requires --yes."""
    monkeypatch.setenv("CLOUDBANK_GCP_PROJECT_ID", "demo-bank-proj")
    monkeypatch.setenv("CLOUDBANK_LOCATION", "eu")
    monkeypatch.setenv("CLOUDBANK_APP_ID", "11111111-2222-3333-4444-555555555555")
    ws = load_workspace(CLOUDBANK_ROOT)

    fake_apps = MagicMock()
    fake_apps.get_app_by_display_name.side_effect = lambda name: (
        SimpleNamespace(
            name="projects/999999/locations/eu/apps/11111111-2222-3333-4444-555555555555"
        )
        if name == "Cloudbank"
        else SimpleNamespace(
            name="projects/999999/locations/eu/apps/22222222-2222-3333-4444-555555555555"
        )
    )
    pushed: list[tuple[str, str]] = []
    monkeypatch.setattr(manage_app, "apps_client", lambda _ws: fake_apps)
    monkeypatch.setattr(
        manage_app,
        "push_app",
        lambda _ws, res, disp: pushed.append((res, disp)),
    )
    monkeypatch.setattr(manage_app.sys, "stdin", SimpleNamespace(isatty=lambda: False))

    for prod_alias in (
        None,
        "prod",
        "production",
        "Cloudbank",
        "11111111-2222-3333-4444-555555555555",
        "projects/999999/locations/eu/apps/11111111-2222-3333-4444-555555555555",
    ):
        args_no = manage_app.build_parser().parse_args(
            ["push"] + ([prod_alias] if prod_alias is not None else [])
        )
        with pytest.raises(RuntimeError, match="pass --yes"):
            args_no.func(ws, args_no)
    assert pushed == []

    # Passing --yes on Cloudbank / prod succeeds; dev without --yes also succeeds.
    args_yes = manage_app.build_parser().parse_args(["push", "Cloudbank", "--yes"])
    args_yes.func(ws, args_yes)
    assert len(pushed) == 1

    args_dev = manage_app.build_parser().parse_args(["push", "dev"])
    args_dev.func(ws, args_dev)
    assert len(pushed) == 2
