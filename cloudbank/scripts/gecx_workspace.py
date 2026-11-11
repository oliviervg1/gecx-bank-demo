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

"""Workspace configuration shared by Cloudbank CX Agent Studio lifecycle scripts.

Project-specific values come from environment overrides
(``CLOUDBANK_GCP_PROJECT_ID``, ``CLOUDBANK_LOCATION``, ``CLOUDBANK_APP_ID``)
or the workspace's ``gecx-config.json`` (falling back to
``gecx-config.example.json`` when local config has not been created yet).
"""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

CONFIG_FILENAME = "gecx-config.json"
EXAMPLE_CONFIG_FILENAME = "gecx-config.example.json"
CONFIG_ENV_VAR = "GECX_CONFIG"
PROJECT_ID_ENV_VAR = "CLOUDBANK_GCP_PROJECT_ID"
LOCATION_ENV_VAR = "CLOUDBANK_LOCATION"
APP_ID_ENV_VAR = "CLOUDBANK_APP_ID"


@dataclass(frozen=True)
class Workspace:
    """A loaded ``gecx-config.json`` plus resolved workspace directory paths."""

    root: Path
    project_id: str
    location: str
    app_name: str
    prod_app_id: str
    app_dir: Path
    dev_app_id: str = ""
    dev_app_name: str = ""
    deployed_channel_id: str = ""
    goldens_dir: Path = Path("evals/goldens")
    simulations_dir: Path = Path("evals/simulations")
    reports_dir: Path = Path("eval-reports/simulations")
    golden_prefixes: tuple[str, ...] = ()
    callback_sources_dir: Path | None = None
    post_sync_command: tuple[str, ...] = ()
    leak_patterns: tuple[str, ...] = ()
    protected_branches: tuple[str, ...] = ("main", "master", "dev")
    default_language_code: str = "en-GB"
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @property
    def parent(self) -> str:
        return f"projects/{self.project_id}/locations/{self.location}"

    def app_resource(self, app_id: str) -> str:
        return f"{self.parent}/apps/{app_id}"

    @property
    def prod_app_resource(self) -> str:
        return self.app_resource(self.prod_app_id)

    @property
    def dev_display_name(self) -> str:
        return self.dev_app_name or f"{self.app_name}-dev"


def find_config(explicit: str | os.PathLike[str] | None = None) -> Path:
    """Locate ``gecx-config.json`` (or ``gecx-config.example.json`` fallback)."""
    candidate = explicit or os.environ.get(CONFIG_ENV_VAR)
    if candidate:
        source = "--config" if explicit else CONFIG_ENV_VAR
        path = Path(candidate).expanduser().resolve()
        if path.is_dir():
            primary = path / CONFIG_FILENAME
            fallback = path / EXAMPLE_CONFIG_FILENAME
            if primary.is_file():
                return primary
            if fallback.is_file():
                return fallback
            path = primary
        elif path.name == CONFIG_FILENAME and not path.is_file():
            fallback = path.parent / EXAMPLE_CONFIG_FILENAME
            if fallback.is_file():
                return fallback
        if not path.is_file():
            raise FileNotFoundError(f"No {CONFIG_FILENAME} at {path} (from {source})")
        return path

    script_workspace = Path(__file__).resolve().parent.parent
    search_dirs = (*Path.cwd().resolve().parents,)
    for directory in (Path.cwd().resolve(), *search_dirs, script_workspace):
        for filename in (CONFIG_FILENAME, EXAMPLE_CONFIG_FILENAME):
            path = directory / filename
            if path.is_file():
                return path
    raise FileNotFoundError(
        f"No {CONFIG_FILENAME} or {EXAMPLE_CONFIG_FILENAME} found from {Path.cwd()} upwards; "
        f"pass --config or set {CONFIG_ENV_VAR}."
    )


def load_workspace(config_path: str | os.PathLike[str] | None = None) -> Workspace:
    """Read workspace configuration with ``CLOUDBANK_*`` environment overrides."""
    path = find_config(config_path)
    data = json.loads(path.read_text(encoding="utf-8"))
    root = path.parent

    def resolved_required(key: str, default: str) -> Path:
        value = str(data.get(key) or default)
        return (root / value).resolve()

    def resolved_optional(key: str) -> Path | None:
        value = data.get(key)
        return (root / str(value)).resolve() if value else None

    project_id = (
        os.environ.get(PROJECT_ID_ENV_VAR, "").strip()
        or str(data["gcp_project_id"]).strip()
    )
    location = (
        os.environ.get(LOCATION_ENV_VAR, "").strip()
        or str(data["location"]).strip()
    )
    prod_app_id = (
        os.environ.get(APP_ID_ENV_VAR, "").strip()
        or str(data["deployed_app_id"]).strip()
    )
    app_name = str(data["app_name"]).strip()

    return Workspace(
        root=root,
        project_id=project_id,
        location=location,
        app_name=app_name,
        prod_app_id=prod_app_id,
        app_dir=(root / str(data.get("app_dir") or ".") / app_name).resolve(),
        dev_app_id=str(data.get("dev_deployed_app_id") or ""),
        dev_app_name=str(data.get("dev_app_name") or ""),
        deployed_channel_id=str(data.get("deployed_channel_id") or ""),
        goldens_dir=resolved_required("goldens_dir", "evals/goldens"),
        simulations_dir=resolved_required("simulations_dir", "evals/simulations"),
        reports_dir=resolved_required("reports_dir", "eval-reports/simulations"),
        golden_prefixes=tuple(data.get("golden_prefixes", ())),
        callback_sources_dir=resolved_optional("callback_sources_dir"),
        post_sync_command=tuple(data.get("post_sync_command", ())),
        leak_patterns=tuple(data.get("leak_patterns", ())),
        protected_branches=tuple(
            data.get("protected_branches", ("main", "master", "dev"))
        ),
        default_language_code=str(data.get("default_language_code") or "en-GB"),
        raw=data,
    )


def add_config_argument(parser: argparse.ArgumentParser) -> None:
    """Add the shared ``--config`` option to a script's parser."""
    parser.add_argument(
        "--config",
        default=None,
        help=(
            f"Path to {CONFIG_FILENAME} (default: ${CONFIG_ENV_VAR}, else the "
            f"nearest {CONFIG_FILENAME} or {EXAMPLE_CONFIG_FILENAME})."
        ),
    )
