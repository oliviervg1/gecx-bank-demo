"""Offline unit tests for manage_ces_app overwrite import & tool verification."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock
import zipfile
import io
import json
import sys

import pytest

CLOUDBANK_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = CLOUDBANK_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from gecx_workspace import load_workspace  # noqa: E402
import manage_ces_app  # noqa: E402


def test_expected_bundle_tool_names_matches_cloudbank_manifest() -> None:
    ws = load_workspace(CLOUDBANK_ROOT / "gecx-config.json")
    expected = manage_ces_app.expected_bundle_tool_names(ws.app_dir)
    assert expected == {
        "assist_everyday_banking",
        "assist_mortgages",
        "assist_savings",
        "route_banking_intent",
        "search_help",
    }


def test_zip_app_bundle_overrides_display_name_without_mutating_disk() -> None:
    ws = load_workspace(CLOUDBANK_ROOT / "gecx-config.json")
    archive_bytes = manage_ces_app.zip_app_bundle(ws.app_dir, "Cloudbank-sandbox")
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as zf:
        app_json = json.loads(zf.read("agent/app.json").decode("utf-8"))
        assert app_json["displayName"] == "Cloudbank-sandbox"
        assert "agent/tools/route_banking_intent/route_banking_intent.json" in zf.namelist()
    disk_app_json = json.loads((ws.app_dir / "app.json").read_text(encoding="utf-8"))
    assert disk_app_json["displayName"] == "Cloudbank"


def test_push_app_fails_closed_on_import_warnings(monkeypatch: pytest.MonkeyPatch) -> None:
    ws = load_workspace(CLOUDBANK_ROOT / "gecx-config.json")
    fake_op = MagicMock()
    fake_op.result.return_value = SimpleNamespace(
        warnings=["Skipped invalid tool python_code.py"]
    )
    fake_apps = MagicMock()
    fake_apps.import_app.return_value = fake_op
    monkeypatch.setattr(manage_ces_app, "apps_client", lambda _ws: fake_apps)

    with pytest.raises(RuntimeError, match="reported 1 warning"):
        manage_ces_app.push_app(ws, ws.prod_app_resource, ws.app_name)


def test_push_app_verifies_tools_and_ignores_builtin_system_tools(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ws = load_workspace(CLOUDBANK_ROOT / "gecx-config.json")
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

    monkeypatch.setattr(manage_ces_app, "apps_client", lambda _ws: fake_apps)
    monkeypatch.setattr(manage_ces_app, "tools_client", lambda _res: fake_tools_client)

    manage_ces_app.push_app(ws, ws.prod_app_resource, ws.app_name)
    fake_apps.import_app.assert_called_once()
    _, kwargs = fake_apps.import_app.call_args
    assert kwargs["conflict_strategy"] == "OVERWRITE"
    fake_tools_client.list_tools.assert_called_once()


def test_verify_expected_tools_rejects_missing_or_orphan_tools(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ws = load_workspace(CLOUDBANK_ROOT / "gecx-config.json")
    remote_tools = [
        SimpleNamespace(name="p/l/a/tools/1", display_name="route_banking_intent", system_tool=None),
        SimpleNamespace(name="p/l/a/tools/2", display_name="assist_everyday_banking", system_tool=None),
        SimpleNamespace(name="p/l/a/tools/3", display_name="assist_savings", system_tool=None),
        # assist_mortgages missing, legacy get_overview lingering as orphan!
        SimpleNamespace(name="p/l/a/tools/5", display_name="search_help", system_tool=None),
        SimpleNamespace(name="p/l/a/tools/old", display_name="get_overview", system_tool=None),
    ]
    fake_tools_client = MagicMock()
    fake_tools_client.list_tools.return_value = remote_tools
    monkeypatch.setattr(manage_ces_app, "tools_client", lambda _res: fake_tools_client)

    with pytest.raises(
        RuntimeError,
        match=r"missing=\['assist_mortgages'\], orphans=\['get_overview'\]",
    ):
        manage_ces_app.verify_expected_tools(ws, ws.prod_app_resource)
