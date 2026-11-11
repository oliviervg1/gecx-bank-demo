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

"""Manage CX Agent Studio (GECX) application imports, versions, and deployments.

Project-specific values come from ``CLOUDBANK_*`` environment overrides or the
workspace's ``gecx-config.json`` (falling back to ``gecx-config.example.json``);
see ``gecx_workspace.py``. CXAS APIs are driven through the ``cxas_scrapi`` SDK.
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import os
import re
import sys
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gecx_workspace import (  # noqa: E402
    Workspace,
    add_config_argument,
    load_workspace,
)

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

# Root entries uploaded in a CXAS bundle archive; local scratch files stay local.
APP_BUNDLE_ROOTS = (
    "app.json",
    "app.yaml",
    "global_instruction.txt",
    "environment.json",
    "agents",
    "tools",
    "toolsets",
    "examples",
    "guardrails",
    "evaluations",
    "evaluationDatasets",
    "evaluationExpectations",
)
APP_BUNDLE_WRAPPER = "agent"
_SYSTEM_TOOL_NAMES = frozenset({"end_session", "transfer_to_agent"})


def apps_client(ws: Workspace) -> Any:
    """Return an SDK ``Apps`` client for the workspace's project and location."""
    from cxas_scrapi.core.apps import Apps

    return Apps(project_id=ws.project_id, location=ws.location)


def tools_client(app_resource: str) -> Any:
    """Return an SDK ``Tools`` client scoped to ``app_resource``."""
    from cxas_scrapi.core.tools import Tools

    return Tools(app_name=app_resource)


def expected_bundle_tool_names(app_dir: Path) -> set[str]:
    """Return the set of custom tool and toolset display names in ``app_dir``."""
    names: set[str] = set()
    for subdir_name in ("tools", "toolsets"):
        root = app_dir / subdir_name
        if not root.is_dir():
            continue
        for entry in sorted(root.iterdir()):
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            manifest = entry / f"{entry.name}.json"
            if manifest.is_file():
                data = json.loads(manifest.read_text(encoding="utf-8"))
                names.add(
                    str(data.get("displayName") or data.get("name") or entry.name)
                )
    return names


def _tool_identifier(tool_obj: Any) -> str:
    """Extract display_name or trailing resource name from a ListTools item."""
    try:
        display = str(tool_obj.display_name or "")
    except AttributeError:
        display = ""
    if display:
        return display
    try:
        raw_name = str(tool_obj.name or "")
    except AttributeError:
        raw_name = ""
    return raw_name.rsplit("/", 1)[-1]


def _is_system_tool(tool_obj: Any) -> bool:
    """Return True for platform built-in system tools returned by ListTools."""
    try:
        if "system_tool" in tool_obj:
            return True
    except TypeError:
        try:
            if tool_obj.system_tool is not None:
                return True
        except AttributeError:
            pass
    return _tool_identifier(tool_obj) in _SYSTEM_TOOL_NAMES


def verify_expected_tools(ws: Workspace, app_resource: str) -> None:
    """Verify remote tool declarations match ``ws.app_dir`` with zero orphans."""
    expected = expected_bundle_tool_names(ws.app_dir)
    remote_items = tools_client(app_resource).list_tools()
    remote_names = {
        _tool_identifier(item)
        for item in remote_items
        if not _is_system_tool(item)
    }
    missing = sorted(expected - remote_names)
    orphans = sorted(remote_names - expected)
    if missing or orphans:
        parts = []
        if missing:
            parts.append(f"missing={missing}")
        if orphans:
            parts.append(f"orphans={orphans}")
        raise RuntimeError(
            f"Tool declaration mismatch on '{app_resource}': " + ", ".join(parts)
        )
    logger.info(
        "Verified %d expected tool declarations on %s: %s",
        len(expected),
        app_resource,
        ", ".join(sorted(expected)),
    )


def _with_project_id(ws: Workspace, resource: str) -> str:
    """Rewrite a leading numeric project segment to ``ws.project_id``."""
    return re.sub(r"^projects/\d+/", f"projects/{ws.project_id}/", resource)


def find_app_resource(ws: Workspace, display_name: str) -> str | None:
    """Look up full CXAS app resource name from its display name."""
    app = apps_client(ws).get_app_by_display_name(display_name)
    return _with_project_id(ws, app.name) if app else None


def _bundle_files(app_dir: Path) -> list[Path]:
    """Return every file uploaded from ``app_dir`` in deterministic order."""
    files: list[Path] = []
    for root in APP_BUNDLE_ROOTS:
        path = app_dir / root
        if path.is_file():
            files.append(path)
        elif path.is_dir():
            files.extend(
                sorted(
                    p
                    for p in path.rglob("*")
                    if p.is_file() and "__pycache__" not in p.parts
                )
            )
    return files


def zip_app_bundle(app_dir: Path, display_name: str) -> bytes:
    """Zip the app bundle with ``displayName`` overridden in-memory only."""
    app_json_path = app_dir / "app.json"
    buffer = io.BytesIO()
    with zipfile.ZipFile(
        buffer, "w", zipfile.ZIP_DEFLATED, strict_timestamps=False
    ) as archive:
        for path in _bundle_files(app_dir):
            arcname = f"{APP_BUNDLE_WRAPPER}/{path.relative_to(app_dir).as_posix()}"
            if path == app_json_path:
                app_data = json.loads(path.read_text(encoding="utf-8"))
                app_data["displayName"] = display_name
                archive.writestr(
                    arcname,
                    json.dumps(app_data, indent=2, ensure_ascii=False) + "\n",
                )
            else:
                archive.write(path, arcname)
    return buffer.getvalue()


def push_app(ws: Workspace, app_resource: str, display_name: str) -> None:
    """Import the workspace's app bundle over ``app_resource`` using OVERWRITE.

    Raises ``RuntimeError`` if the platform returns any import warnings or if
    remote tool declarations do not match ``ws.app_dir``.
    """
    logger.info("==> Deploying %s to %s...", ws.app_dir, app_resource)
    content = zip_app_bundle(ws.app_dir, display_name)
    resp = (
        apps_client(ws)
        .import_app(
            app_resource, app_content=content, conflict_strategy="OVERWRITE"
        )
        .result()
    )
    warnings = list(resp.warnings) if resp is not None and resp.warnings else []
    if warnings:
        for warning in warnings:
            logger.error("Import warning on '%s': %s", display_name, warning)
        raise RuntimeError(
            f"Import of '{display_name}' reported {len(warnings)} warning(s): "
            + "; ".join(str(w) for w in warnings)
        )
    logger.info("Pushed app bundle as '%s'.", display_name)
    verify_expected_tools(ws, app_resource)


def resolve_app_resource(ws: Workspace, target: str | None = None) -> str:
    """Resolve ``target`` into a fully qualified CXAS app resource name."""
    if not target or target in ("prod", "production"):
        return ws.prod_app_resource
    if target == "dev":
        if ws.dev_app_id:
            return ws.app_resource(ws.dev_app_id)
        found = find_app_resource(ws, ws.dev_display_name)
        if found:
            return found
        raise RuntimeError("Could not find dev app resource.")
    if target.startswith("projects/"):
        return _with_project_id(ws, target)
    if re.match(r"^[0-9a-fA-F-]{36}$", target):
        return ws.app_resource(target)
    app_res = find_app_resource(ws, target)
    if not app_res:
        raise RuntimeError(f"Could not find app resource for: {target}")
    return app_res


def list_versions(ws: Workspace, app_resource: str | None = None) -> None:
    """List immutable versions for the specified CXAS application."""
    app_res = resolve_app_resource(ws, app_resource)
    logger.info("Listing versions for app: %s", app_res)
    from cxas_scrapi.core.versions import Versions

    v_client = Versions(app_name=app_res)
    versions = v_client.list_versions()
    if not versions:
        logger.info("No versions found for %s.", app_res)
        return
    logger.info("%-40s | %-30s | %s", "VERSION ID", "DISPLAY NAME", "CREATED AT")
    logger.info("-" * 95)
    for v in versions:
        v_id = v.name.split("/")[-1]
        logger.info(
            "%-40s | %-30s | %s", v_id, v.display_name or "(none)", v.create_time
        )


def create_version(
    ws: Workspace,
    version_name: str,
    description: str = "",
    app_resource: str | None = None,
) -> str:
    """Create an immutable version snapshot from the current CXAS draft."""
    app_res = resolve_app_resource(ws, app_resource)
    logger.info("Creating immutable version '%s' on %s...", version_name, app_res)
    from cxas_scrapi.core.versions import Versions

    v_client = Versions(app_name=app_res)
    created = v_client.create_version(
        display_name=version_name, description=description
    )
    logger.info("Version created successfully: %s", created.name)
    returned_name = created.display_name
    if returned_name and returned_name != version_name:
        logger.warning(
            "The app is unchanged since the latest snapshot, so CXAS returned "
            "existing version '%s' (%s) instead of creating '%s'.",
            returned_name,
            created.name,
            version_name,
        )
    out_file = os.environ.get("VERSION_RESOURCE_FILE")
    if out_file:
        Path(out_file).write_text(created.name, encoding="utf-8")
    return str(created.name)


def list_deployments(ws: Workspace, app_resource: str | None = None) -> None:
    """List active deployments and traffic routing for the CXAS app."""
    app_res = resolve_app_resource(ws, app_resource)
    logger.info("Listing deployments for app: %s", app_res)
    from cxas_scrapi.core.deployments import Deployments

    d_client = Deployments(app_name=app_res)
    deployments = d_client.list_deployments()
    if not deployments:
        logger.info("No active deployments found for %s.", app_res)
        return
    for d in deployments:
        dep_id = d.name.split("/")[-1]
        channel_type = d.channel_profile.channel_type or "UNKNOWN"
        logger.info(
            "Deployment: %s (%s)", dep_id, d.display_name or "(no display name)"
        )
        logger.info("  Resource    : %s", d.name)
        logger.info("  Channel Type: %s", channel_type)
        logger.info("  Target Ver  : %s", d.app_version)
        if d.experiment_config and d.experiment_config.version_release:
            logger.info("  Traffic Split:")
            for alloc in d.experiment_config.version_release.traffic_allocations:
                logger.info(
                    "    - %s: %s%%",
                    alloc.app_version.split("/")[-1],
                    alloc.traffic_percentage,
                )
        logger.info("  -------------------------------------------------------------")


def create_deployment(
    ws: Workspace,
    deployment_id: str,
    version: str,
    channel_type: str = "GOOGLE_TELEPHONY_PLATFORM",
    display_name: str | None = None,
    app_resource: str | None = None,
) -> str:
    """Create a channel deployment pointing to a specific CXAS app version."""
    app_res = resolve_app_resource(ws, app_resource)
    logger.info(
        "Creating deployment '%s' on %s (Channel: %s, Version: %s)...",
        deployment_id,
        app_res,
        channel_type,
        version,
    )
    from cxas_scrapi.core.deployments import Deployments

    d_client = Deployments(app_name=app_res)
    v_target = (
        version
        if version.startswith("projects/")
        else f"{app_res}/versions/{version}"
    )
    d = d_client.create_deployment(
        deployment_id=deployment_id,
        display_name=display_name or deployment_id,
        app_version=v_target,
        channel_type=channel_type,
        disable_barge_in_control=False,
        disable_dtmf=False,
    )
    logger.info("Deployment created: %s", d.name)
    return str(d.name)


def resolve_deployment_id(
    ws: Workspace,
    deployment_id: str | None = None,
    app_resource: str | None = None,
) -> str:
    """Resolve deployment ID from arguments, gecx-config.json, or live deployments."""
    if deployment_id and deployment_id not in ("", "default", "auto"):
        return deployment_id
    if ws.deployed_channel_id:
        return ws.deployed_channel_id
    app_res = resolve_app_resource(ws, app_resource)
    from cxas_scrapi.core.deployments import Deployments

    d_client = Deployments(app_name=app_res)
    deps = d_client.list_deployments()
    if len(deps) == 1:
        return str(deps[0].name.split("/")[-1])
    raise ValueError(
        "No deployment_id specified and could not resolve deployed_channel_id from gecx-config.json."
    )


def resolve_version_resource(version: str, app_resource: str) -> str:
    """Resolve a version string (full resource, UUID, or display name) to a resource name."""
    if version.startswith("projects/"):
        return version
    from cxas_scrapi.core.versions import Versions

    v_client = Versions(app_name=app_resource)
    try:
        versions = v_client.list_versions()
        for v in versions:
            v_id = v.name.split("/")[-1]
            if version in (v_id, v.display_name):
                return str(v.name)
    except Exception as e:
        logger.warning("Could not list versions to resolve '%s': %s", version, e)
    return f"{app_resource}/versions/{version}"


def promote_deployment(
    ws: Workspace,
    deployment_id: str | None = None,
    version: str | None = None,
    traffic_split_str: str | None = None,
    app_resource: str | None = None,
) -> None:
    """Promote live traffic on a deployment to a new version or canary split."""
    app_res = resolve_app_resource(ws, app_resource)
    dep_id = resolve_deployment_id(ws, deployment_id, app_resource)
    logger.info("Promoting deployment '%s' on %s...", dep_id, app_res)
    from cxas_scrapi.core.deployments import Deployments

    d_client = Deployments(app_name=app_res)

    if traffic_split_str:
        traffic_split = {}
        for pair in traffic_split_str.split(","):
            ver, pct = pair.strip().split(":")
            traffic_split[ver] = int(pct)
        logger.info("   Applying canary traffic split: %s", traffic_split)
        d_client.update_deployment(deployment_id=dep_id, traffic_split=traffic_split)
    elif version:
        v_target = resolve_version_resource(version, app_res)
        current = next(
            (
                d.app_version
                for d in (d_client.list_deployments() or [])
                if d.name.endswith(f"/deployments/{dep_id}")
            ),
            "",
        )
        if current == v_target:
            logger.info(
                "Deployment '%s' already serves %s; nothing to promote.",
                dep_id,
                v_target,
            )
            return
        logger.info("   Switching 100%% traffic to version: %s", v_target)
        d_client.update_deployment(deployment_id=dep_id, app_version=v_target)
    else:
        raise ValueError(
            "Either version or traffic_split_str must be specified for promotion."
        )

    logger.info("Deployment '%s' promoted successfully.", dep_id)


USAGE_LINE = (
    "Usage: python manage_app.py [--config <gecx-config.json>] "
    "[push|resolve-resource|list-versions|create-version|list-deployments|"
    "create-deployment|promote] [args...]"
)


def _display_name_for_target(ws: Workspace, target: str | None) -> str:
    """Resolve the displayName written into the imported app archive."""
    if not target or target in ("prod", "production"):
        return ws.app_name
    if target == "dev":
        return ws.dev_display_name
    if target.startswith("projects/") or re.match(r"^[0-9a-fA-F-]{36}$", target):
        app_res = resolve_app_resource(ws, target)
        if app_res == ws.prod_app_resource:
            return ws.app_name
        if ws.dev_app_id and app_res == ws.app_resource(ws.dev_app_id):
            return ws.dev_display_name
        return ws.app_name
    return target


def _push_cli(ws: Workspace, args: argparse.Namespace) -> None:
    """Execute ``push [target] [--create-version [VERSION_NAME]]``."""
    app_resource = resolve_app_resource(ws, args.target)
    display_name = _display_name_for_target(ws, args.target)
    push_app(ws, app_resource, display_name)
    if args.create_version is not None:
        version_name = args.create_version or datetime.now(UTC).strftime(
            "v-%Y%m%d-%H%M%S"
        )
        create_version(ws, version_name, app_resource=app_resource)


def _promote_cli(ws: Workspace, args: argparse.Namespace) -> None:
    """Execute ``promote <deployment-id> <version | v1:90,v2:10> [target]``."""
    if ":" in args.version_or_split:
        promote_deployment(
            ws,
            deployment_id=args.deployment_id,
            traffic_split_str=args.version_or_split,
            app_resource=args.target,
        )
    else:
        promote_deployment(
            ws,
            deployment_id=args.deployment_id,
            version=args.version_or_split,
            app_resource=args.target,
        )


def build_parser() -> argparse.ArgumentParser:
    """Build the CLI subcommand parser for manage_app.py."""
    parser = argparse.ArgumentParser(add_help=False, prog="manage_app.py")
    add_config_argument(parser)
    sub = parser.add_subparsers(dest="action")

    p_push = sub.add_parser("push", add_help=False)
    p_push.add_argument("target", nargs="?", default=None)
    p_push.add_argument(
        "--create-version",
        dest="create_version",
        nargs="?",
        const="",
        default=None,
    )
    p_push.set_defaults(func=_push_cli)

    p_resolve = sub.add_parser("resolve-resource", add_help=False)
    p_resolve.add_argument("target", nargs="?", default=None)
    p_resolve.set_defaults(
        func=lambda ws, a: print(resolve_app_resource(ws, a.target))
    )

    p_list_v = sub.add_parser("list-versions", add_help=False)
    p_list_v.add_argument("target", nargs="?", default=None)
    p_list_v.set_defaults(func=lambda ws, a: list_versions(ws, a.target))

    p_create_v = sub.add_parser("create-version", add_help=False)
    p_create_v.add_argument("version_name")
    p_create_v.add_argument("description", nargs="?", default="")
    p_create_v.add_argument("target", nargs="?", default=None)
    p_create_v.set_defaults(
        func=lambda ws, a: create_version(
            ws, a.version_name, description=a.description, app_resource=a.target
        )
    )

    p_list_d = sub.add_parser("list-deployments", add_help=False)
    p_list_d.add_argument("target", nargs="?", default=None)
    p_list_d.set_defaults(func=lambda ws, a: list_deployments(ws, a.target))

    p_create_d = sub.add_parser("create-deployment", add_help=False)
    p_create_d.add_argument("deployment_id")
    p_create_d.add_argument("version")
    p_create_d.add_argument(
        "channel_type", nargs="?", default="GOOGLE_TELEPHONY_PLATFORM"
    )
    p_create_d.add_argument("target", nargs="?", default=None)
    p_create_d.set_defaults(
        func=lambda ws, a: create_deployment(
            ws,
            a.deployment_id,
            a.version,
            channel_type=a.channel_type,
            app_resource=a.target,
        )
    )

    p_promote = sub.add_parser("promote", add_help=False)
    p_promote.add_argument("deployment_id")
    p_promote.add_argument("version_or_split")
    p_promote.add_argument("target", nargs="?", default=None)
    p_promote.set_defaults(func=_promote_cli)

    return parser


def main(argv: list[str] | None = None) -> None:
    """Parse arguments and run the requested CXAS management subcommand."""
    raw_args = sys.argv[1:] if argv is None else argv
    wants_help = bool(raw_args and raw_args[0] == "help")
    if not raw_args or wants_help or any(a in ("-h", "--help") for a in raw_args):
        logger.info(USAGE_LINE)
        sys.exit(0 if raw_args else 1)

    args = build_parser().parse_args(raw_args)
    if not args.action:
        logger.info(USAGE_LINE)
        sys.exit(1)
    args.func(load_workspace(args.config), args)


if __name__ == "__main__":
    main()
