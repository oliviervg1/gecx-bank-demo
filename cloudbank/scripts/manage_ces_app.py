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

"""Manage CXAS applications, branch/sandbox environments, versions, and deployments.

Every project-specific value (project, location, app ids, app directory,
protected branches) comes from the workspace's ``gecx-config.json``; see
``gecx_workspace.py`` for how it is found and which keys it reads. CXAS is
driven through the ``cxas_scrapi`` SDK directly, never by shelling out to the
``cxas`` CLI.
"""

import argparse
import base64
import io
import json
import logging
import os
from pathlib import Path
import re
import subprocess
import sys
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gecx_workspace import (  # noqa: E402
    Workspace,
    add_config_argument,
    load_workspace,
)

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

# The root entries `cxas push` uploads; anything else in the app directory
# (scratch files, notes) stays local.
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
# The wrapper directory CXAS expects at the top of an imported archive.
APP_BUNDLE_WRAPPER = "agent"


def apps_client(ws: Workspace):
    """Returns an SDK ``Apps`` client for the workspace's project and location."""
    from cxas_scrapi.core.apps import Apps

    return Apps(project_id=ws.project_id, location=ws.location)


def sanitize_branch_name(branch_name: str) -> str:
    """Sanitize branch name for CXAS display name compliance."""
    sanitized = re.sub(r"[^a-zA-Z0-9_-]", "-", branch_name)
    return sanitized.strip("-")


def branch_display_name(ws: Workspace, branch_name: str) -> str:
    """The display name of the branch app for ``branch_name``."""
    return f"{ws.app_name}-{sanitize_branch_name(branch_name)}"


def get_current_branch() -> str:
    try:
        res = subprocess.run(
            ["git", "symbolic-ref", "--short", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        )
        return res.stdout.strip()
    except subprocess.CalledProcessError:
        return ""


def _with_project_id(ws: Workspace, resource: str) -> str:
    """CXAS answers with the project *number*; callers compare against the id.

    Only a numeric project segment is rewritten, so a resource that already
    names a project id (even a different one) is left untouched.
    """
    return re.sub(r"^projects/\d+/", f"projects/{ws.project_id}/", resource)


def find_app_resource(ws: Workspace, display_name: str) -> str | None:
    """Look up full app resource name from its display name."""
    app = apps_client(ws).get_app_by_display_name(display_name)
    return _with_project_id(ws, app.name) if app else None


def branch_app(ws: Workspace, branch_name: str | None = None) -> str | None:
    """Create or branch an isolated app for the given branch name."""
    if branch_name and branch_name.startswith("-"):
        logger.error("Refusing to treat option flag as branch name: %s", branch_name)
        return None
    branch = branch_name or get_current_branch()
    if not branch or branch in ws.protected_branches:
        logger.info("On base branch '%s'; skipping branch app creation.", branch)
        return None

    target_display_name = branch_display_name(ws, branch)
    source_app_resource = ws.app_resource(ws.dev_app_id or ws.prod_app_id)

    existing_resource = find_app_resource(ws, target_display_name)
    if existing_resource:
        logger.info(
            "ℹ️ Branch app '%s' already exists: %s",
            target_display_name,
            existing_resource,
        )
        return existing_resource

    logger.info("🌿 Provisioning branch app for '%s'...", branch)
    logger.info("   Target Display Name: %s", target_display_name)
    logger.info("   Source App: %s", source_app_resource)

    apps = apps_client(ws)
    try:
        exported = apps.export_app(source_app_resource).result()
        created = apps.import_as_new_app(
            target_display_name, app_content=exported.app_content
        ).result()
    except Exception as e:
        logger.warning("Failed to create branch app: %s", e)
        return None

    logger.info("✅ Branch app provisioned successfully!")
    return _with_project_id(ws, created.name)


def delete_app(
    ws: Workspace,
    display_name: str | None = None,
    branch_name: str | None = None,
) -> None:
    for raw in (display_name, branch_name):
        if raw and raw.startswith("-"):
            logger.error(
                "Refusing to treat option flag as app or branch name: %s", raw
            )
            return

    protected_names = {
        ws.app_name,
        f"{ws.app_name}-dev",
        ws.dev_display_name,
        ws.prod_app_id,
        ws.dev_app_id,
    }

    target_name = display_name
    if not target_name:
        branch = branch_name or get_current_branch()
        if branch and branch not in ws.protected_branches:
            target_name = branch_display_name(ws, branch)

    if not target_name:
        logger.warning("No target branch app name provided for deletion.")
        return

    if target_name in protected_names or target_name in ws.protected_branches:
        logger.warning("Refusing to delete protected permanent app: %s", target_name)
        return

    logger.info("🗑️ Deleting branch app '%s'...", target_name)
    apps = apps_client(ws)
    app = apps.get_app_by_display_name(target_name)
    if app is None:
        logger.info("Branch app '%s' not found or already deleted.", target_name)
        return
    try:
        apps.delete_app(app.name)
    except Exception as e:
        logger.warning("Failed to delete branch app '%s': %s", target_name, e)
        return
    logger.info("✅ Deleted branch app: %s", target_name)


def _bundle_files(app_dir: Path) -> list[Path]:
    """Every file `cxas push` would upload from ``app_dir``, in a stable order."""
    files = []
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
    """Zips the app bundle the way `cxas push` does, with ``displayName`` overridden.

    The override happens in the archive only, so the checked-in ``app.json``
    keeps the production display name.
    """
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
    """Imports the workspace's app bundle over ``app_resource`` (OVERWRITE).

    Raises ``RuntimeError`` if the platform returns any import warnings (for
    example a Python tool or sub-resource that was silently skipped).
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
            logger.error("❌ Import warning on '%s': %s", display_name, warning)
        raise RuntimeError(
            f"Import of '{display_name}' reported {len(warnings)} warning(s): "
            + "; ".join(str(w) for w in warnings)
        )
    logger.info("✅ Pushed app bundle as '%s'.", display_name)


def pr_eval(ws: Workspace, branch_name: str) -> None:
    """Run full deployment and platform evaluations against the branch app in CI/PR."""
    from run_golden_evals import golden_prefixes, run_live_evaluations, sync_evals

    if branch_name in ws.protected_branches:
        logger.info(
            "🚀 Running PR evaluation directly against permanent '%s' app...",
            branch_name,
        )
        is_dev = branch_name == "dev"
        app_resource = resolve_app_resource(ws, "dev" if is_dev else "prod")
        target_display_name = ws.dev_display_name if is_dev else ws.app_name
    else:
        target_display_name = branch_display_name(ws, branch_name)
        logger.info(
            "🚀 Preparing PR evaluation for branch '%s' (App: %s)...",
            branch_name,
            target_display_name,
        )
        app_resource = find_app_resource(ws, target_display_name)
        if not app_resource:
            logger.info(
                "App '%s' does not exist yet. Branching from dev base...",
                target_display_name,
            )
            app_resource = branch_app(ws, branch_name)
            if not app_resource:
                raise RuntimeError(
                    f"Could not provision branch app: {target_display_name}"
                )

    logger.info("Target App Resource: %s", app_resource)
    push_app(ws, app_resource, target_display_name)
    sync_evals(app_resource, ws.goldens_dir)

    logger.info(
        "==> Running live platform golden evaluations across journeys (Method: NAIVE)..."
    )
    run_live_evaluations(app_resource, golden_prefixes(ws))
    logger.info(
        "🎉 All PR evaluations passed successfully on %s!", target_display_name
    )


def provision_sandbox(ws: Workspace, sandbox_name: str) -> str:
    """Provisions a CXAS sandbox app and syncs all golden evaluations."""
    from run_golden_evals import sync_evals

    target_display_name = branch_display_name(ws, sandbox_name)
    logger.info("==> Provisioning CXAS sandbox app for '%s'...", sandbox_name)
    app_resource = branch_app(ws, sandbox_name)
    if not app_resource:
        app_resource = find_app_resource(ws, target_display_name)
    if not app_resource:
        logger.error("Failed to resolve app resource for sandbox '%s'.", sandbox_name)
        sys.exit(1)

    sync_evals(app_resource, ws.goldens_dir)
    logger.info(
        "=========================================================================="
    )
    logger.info("🎉 SANDBOX READY FOR VISUAL EDITING IN CX AGENT STUDIO!")
    logger.info("App Resource: %s", app_resource)
    logger.info("Display Name: %s", target_display_name)
    logger.info("Console URL: https://ces.cloud.google.com/%s", app_resource)
    logger.info(
        "=========================================================================="
    )
    return app_resource


def fetch_active_remote_branches(ws: Workspace) -> set[str] | None:
    """Return the branches on ``origin``, or None when the list cannot be trusted.

    Each branch is recorded as-is and sanitised, since branch apps are named
    after the sanitised form. None means the list is unknown: git failed, timed
    out or is missing, or its answer names no base branch. An empty or partial
    list would make every open branch look deleted, so callers must then
    delete nothing.
    """
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    token = (
        os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
    ).strip()
    if token:
        b64 = base64.b64encode(f"x-access-token:{token}".encode("utf-8")).decode(
            "ascii"
        )
        env.update(
            {
                "GIT_CONFIG_COUNT": "2",
                "GIT_CONFIG_KEY_0": "credential.helper",
                "GIT_CONFIG_VALUE_0": "",
                "GIT_CONFIG_KEY_1": "http.https://github.com/.extraheader",
                "GIT_CONFIG_VALUE_1": f"AUTHORIZATION: basic {b64}",
            }
        )
    try:
        res = subprocess.run(
            ["git", "ls-remote", "--heads", "origin"],
            capture_output=True,
            text=True,
            timeout=15,
            env=env,
        )
    except (OSError, subprocess.SubprocessError) as e:
        logger.warning("⚠️ Could not run 'git ls-remote --heads origin': %s", e)
        return None

    if res.returncode != 0:
        stderr_lines = [
            line.strip()
            for line in (res.stderr or "").splitlines()
            if line.strip()
        ]
        detail = (
            re.sub(r"(?<=://)[^/@\s]+@", "***@", stderr_lines[-1])
            if stderr_lines
            else "no error output"
        )
        logger.warning(
            "⚠️ 'git ls-remote --heads origin' exited with %s: %s",
            res.returncode,
            detail,
        )
        return None

    names = []
    for line in res.stdout.splitlines():
        parts = line.strip().split()
        if len(parts) >= 2 and parts[1].startswith("refs/heads/"):
            names.append(parts[1][len("refs/heads/") :])
    if not set(names) & set(ws.protected_branches):
        logger.warning(
            "⚠️ 'git ls-remote --heads origin' listed %d branch(es), none of them %s.",
            len(names),
            "/".join(ws.protected_branches),
        )
        return None
    return set(names) | {sanitize_branch_name(name) for name in names}


def cleanup_stale_apps(ws: Workspace) -> None:
    """Clean up branch apps in CXAS whose branch no longer exists or was merged.

    Fails closed: an app is deleted only once its branch is known to be gone,
    so when the remote branch list is unavailable nothing is deleted.
    """
    protected_apps = {ws.app_name, f"{ws.app_name}-dev", ws.dev_display_name}

    logger.info("🔍 Checking for merged/stale branch apps in CXAS...")

    active_branches = fetch_active_remote_branches(ws)
    if active_branches is None:
        logger.warning(
            "⚠️ Skipping branch app cleanup: the remote branch list is unavailable, so nothing was deleted."
        )
        return

    try:
        apps = apps_client(ws).list_apps()
    except Exception as e:
        logger.warning("Could not list CXAS apps: %s", e)
        return

    prefix = f"{ws.app_name}-"
    for app in apps:
        display_name = app.display_name
        if display_name in protected_apps or not display_name.startswith(prefix):
            continue

        branch_suffix = display_name[len(prefix) :]
        if (
            branch_suffix in active_branches
            or branch_suffix in ws.protected_branches
        ):
            logger.info(
                "ℹ️ Branch '%s' is still active on remote; keeping '%s'.",
                branch_suffix,
                display_name,
            )
        else:
            logger.info(
                "🗑️ Branch '%s' is not active on remote; deleting '%s'...",
                branch_suffix,
                display_name,
            )
            delete_app(ws, display_name=display_name)


def resolve_app_resource(ws: Workspace, target: str | None = None) -> str:
    """Resolves target into a fully qualified CXAS app resource name.

    ``target`` may be empty / ``prod`` / ``production`` (the production app),
    ``dev`` (the dev app), a full resource name, a bare app id, a branch name
    (resolved to its branch app), or an app display name.
    """
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
    app_res = find_app_resource(
        ws, branch_display_name(ws, target)
    ) or find_app_resource(ws, target)
    if not app_res:
        raise RuntimeError(f"Could not find app resource for: {target}")
    return app_res


def list_versions(ws: Workspace, app_resource: str | None = None) -> None:
    """List all deployed immutable versions for the specified app."""
    app_res = resolve_app_resource(ws, app_resource)
    logger.info("📋 Listing versions for app: %s", app_res)
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
    """Creates an immutable version snapshot from current app state.

    CXAS does not create a new version when the draft is unchanged since the
    latest snapshot: it returns that snapshot instead, which may carry another
    display name or be a hidden evaluation snapshot. The returned resource name
    is therefore the only reliable handle on "the version for this build". When
    the VERSION_RESOURCE_FILE environment variable is set, it is also written
    there so a later CD step can promote exactly this version.
    """
    app_res = resolve_app_resource(ws, app_resource)
    logger.info("📦 Creating immutable version '%s' on %s...", version_name, app_res)
    from cxas_scrapi.core.versions import Versions

    v_client = Versions(app_name=app_res)
    created = v_client.create_version(
        display_name=version_name, description=description
    )
    logger.info("✅ Version created successfully: %s", created.name)
    returned_name = created.display_name
    if returned_name and returned_name != version_name:
        logger.warning(
            "⚠️ The app is unchanged since the latest snapshot, so CXAS returned the "
            "existing version '%s' (%s) instead of creating '%s'.",
            returned_name,
            created.name,
            version_name,
        )
    out_file = os.environ.get("VERSION_RESOURCE_FILE")
    if out_file:
        with open(out_file, "w", encoding="utf-8") as fh:
            fh.write(created.name)
    return created.name


def list_deployments(ws: Workspace, app_resource: str | None = None) -> None:
    """List active deployments and traffic routing for the app."""
    app_res = resolve_app_resource(ws, app_resource)
    logger.info("📡 Listing deployments for app: %s", app_res)
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
    """Creates a new channel deployment pointing to a specific app version."""
    app_res = resolve_app_resource(ws, app_resource)
    logger.info(
        "🚀 Creating deployment '%s' on %s (Channel: %s, Version: %s)...",
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
    logger.info("✅ Deployment created: %s", d.name)
    return d.name


def resolve_deployment_id(
    ws: Workspace,
    deployment_id: str | None = None,
    app_resource: str | None = None,
) -> str:
    """Resolves deployment ID from arguments, gecx-config.json, or live deployment list."""
    if deployment_id and deployment_id not in ("", "default", "auto"):
        return deployment_id
    if ws.deployed_channel_id:
        return ws.deployed_channel_id
    app_res = resolve_app_resource(ws, app_resource)
    from cxas_scrapi.core.deployments import Deployments

    d_client = Deployments(app_name=app_res)
    deps = d_client.list_deployments()
    if len(deps) == 1:
        return deps[0].name.split("/")[-1]
    raise ValueError(
        "No deployment_id specified and could not resolve deployed_channel_id from gecx-config.json."
    )


def resolve_version_resource(version: str, app_resource: str) -> str:
    """Resolves a version string (full resource, UUID, or display name) to a full resource name."""
    if version.startswith("projects/"):
        return version
    from cxas_scrapi.core.versions import Versions

    v_client = Versions(app_name=app_resource)
    try:
        versions = v_client.list_versions()
        for v in versions:
            v_id = v.name.split("/")[-1]
            if version in (v_id, v.display_name):
                return v.name
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
    """Promotes live traffic on a deployment to a new version or canary split."""
    app_res = resolve_app_resource(ws, app_resource)
    dep_id = resolve_deployment_id(ws, deployment_id, app_resource)
    logger.info("🔀 Promoting deployment '%s' on %s...", dep_id, app_res)
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
                "ℹ️ Deployment '%s' already serves %s; nothing to promote.",
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

    logger.info("✅ Deployment '%s' promoted successfully!", dep_id)


def handle_post_checkout(
    ws: Workspace, prev_head: str, new_head: str, is_branch_checkout: str
) -> None:
    if is_branch_checkout != "1":
        return
    branch = get_current_branch()
    if branch and branch not in ws.protected_branches:
        branch_app(ws, branch)


USAGE_LINE = (
    "Usage: python manage_ces_app.py [--config <gecx-config.json>] "
    "[branch|delete|cleanup-stale|checkout|pr-eval|provision-sandbox|"
    "resolve-resource|list-versions|create-version|list-deployments|"
    "create-deployment|promote] [args...]"
)


def _delete_cli(ws: Workspace, args: argparse.Namespace) -> None:
    """`delete <target>` accepts either a branch name or a full app display name."""
    target = args.target
    if target and not target.startswith(f"{ws.app_name}-"):
        delete_app(ws, branch_name=target)
    else:
        delete_app(ws, display_name=target)


def _promote_cli(ws: Workspace, args: argparse.Namespace) -> None:
    """`promote <deployment-id> <version | v1:90,v2:10> [target]`."""
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
    """Builds the CLI subcommand parser for manage_ces_app.py.

    ``--config`` is a global option and goes before the subcommand.
    """
    parser = argparse.ArgumentParser(add_help=False, prog="manage_ces_app.py")
    add_config_argument(parser)
    sub = parser.add_subparsers(dest="action")

    p_branch = sub.add_parser("branch", add_help=False)
    p_branch.add_argument("branch_name", nargs="?", default=None)
    p_branch.set_defaults(func=lambda ws, a: branch_app(ws, a.branch_name))

    p_delete = sub.add_parser("delete", add_help=False)
    p_delete.add_argument("target", nargs="?", default=None)
    p_delete.set_defaults(func=_delete_cli)

    p_cleanup = sub.add_parser("cleanup-stale", add_help=False)
    p_cleanup.set_defaults(func=lambda ws, a: cleanup_stale_apps(ws))

    p_pr = sub.add_parser("pr-eval", add_help=False)
    p_pr.add_argument("branch_name")
    p_pr.set_defaults(func=lambda ws, a: pr_eval(ws, a.branch_name))

    p_sandbox = sub.add_parser("provision-sandbox", add_help=False)
    p_sandbox.add_argument("sandbox_name")
    p_sandbox.set_defaults(func=lambda ws, a: provision_sandbox(ws, a.sandbox_name))

    # Cloud Build captures this with $(...), so only the resource goes to stdout.
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

    p_checkout = sub.add_parser("checkout", add_help=False)
    p_checkout.add_argument("prev_head", nargs="?", default="")
    p_checkout.add_argument("new_head", nargs="?", default="")
    p_checkout.add_argument("is_branch", nargs="?", default="0")
    p_checkout.set_defaults(
        func=lambda ws, a: handle_post_checkout(
            ws, a.prev_head, a.new_head, a.is_branch
        )
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
    args.func(load_workspace(args.config), args)


if __name__ == "__main__":
    main()
