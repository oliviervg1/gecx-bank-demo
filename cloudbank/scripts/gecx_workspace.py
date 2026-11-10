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

"""Workspace configuration shared by the skill's scripts.

Every project-specific value the scripts need comes from the workspace's
``gecx-config.json`` -- the same file ``cxas`` itself reads -- so the scripts
carry no knowledge of any particular app. The file is found, in order, from
``--config``, the ``GECX_CONFIG`` environment variable, or by walking up from
the current directory, which is how ``cxas llm-lint`` locates it too.

Relative paths in the file resolve against the directory that contains it
(the *workspace*).

Keys beyond the ones ``cxas init`` writes (all optional):

    goldens_dir            evals/goldens
    simulations_dir        evals/simulations
    reports_dir            eval-reports/simulations
    golden_prefixes        []    -> every evaluation runs as one group
    callback_sources_dir   null  -> no callback names added to the leak scan
    post_sync_command      null  -> argv run from the workspace after a UI sync
    leak_patterns          []    -> extra regexes the audio transcript scan flags
    protected_branches     ["main", "master", "dev"]
    default_language_code  en-US
"""

import argparse
from dataclasses import dataclass, field
import json
import os
from pathlib import Path

CONFIG_FILENAME = "gecx-config.json"
CONFIG_ENV_VAR = "GECX_CONFIG"


@dataclass(frozen=True)
class Workspace:
    """A loaded ``gecx-config.json`` plus the directory it lives in."""

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
    default_language_code: str = "en-US"
    raw: dict = field(default_factory=dict, repr=False, compare=False)

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


def find_config(explicit: str | os.PathLike | None = None) -> Path:
    """Locates ``gecx-config.json`` from a flag, the environment, or the cwd."""
    candidate = explicit or os.environ.get(CONFIG_ENV_VAR)
    if candidate:
        source = "--config" if explicit else CONFIG_ENV_VAR
        path = Path(candidate).expanduser().resolve()
        if path.is_dir():
            path = path / CONFIG_FILENAME
        if not path.is_file():
            raise FileNotFoundError(f"No {CONFIG_FILENAME} at {path} (from {source})")
        return path
    for directory in (Path.cwd().resolve(), *Path.cwd().resolve().parents):
        path = directory / CONFIG_FILENAME
        if path.is_file():
            return path
    raise FileNotFoundError(
        f"No {CONFIG_FILENAME} found from {Path.cwd()} upwards; pass --config "
        f"or set {CONFIG_ENV_VAR}."
    )


def load_workspace(config_path: str | os.PathLike | None = None) -> Workspace:
    """Reads ``gecx-config.json`` into a Workspace with all paths resolved."""
    path = find_config(config_path)
    data = json.loads(path.read_text(encoding="utf-8"))
    root = path.parent

    def resolved(key: str, default: str | None) -> Path | None:
        value = data.get(key, default)
        return (root / value).resolve() if value else None

    return Workspace(
        root=root,
        project_id=data["gcp_project_id"],
        location=data["location"],
        app_name=data["app_name"],
        prod_app_id=data["deployed_app_id"],
        app_dir=(root / data.get("app_dir", ".") / data["app_name"]).resolve(),
        dev_app_id=data.get("dev_deployed_app_id", ""),
        dev_app_name=data.get("dev_app_name", ""),
        deployed_channel_id=data.get("deployed_channel_id", ""),
        goldens_dir=resolved("goldens_dir", "evals/goldens"),
        simulations_dir=resolved("simulations_dir", "evals/simulations"),
        reports_dir=resolved("reports_dir", "eval-reports/simulations"),
        golden_prefixes=tuple(data.get("golden_prefixes", ())),
        callback_sources_dir=resolved("callback_sources_dir", None),
        post_sync_command=tuple(data.get("post_sync_command", ())),
        leak_patterns=tuple(data.get("leak_patterns", ())),
        protected_branches=tuple(
            data.get("protected_branches", ("main", "master", "dev"))
        ),
        default_language_code=data.get("default_language_code", "en-US"),
        raw=data,
    )


def add_config_argument(parser: argparse.ArgumentParser) -> None:
    """Adds the shared ``--config`` option to a script's parser."""
    parser.add_argument(
        "--config",
        default=None,
        help=(
            f"Path to {CONFIG_FILENAME} (default: ${CONFIG_ENV_VAR}, else the "
            "nearest one above the current directory)."
        ),
    )
