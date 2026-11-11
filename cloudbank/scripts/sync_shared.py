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

"""Synchronize canonical CXAS callbacks and persona snapshots into bundle and evals.

Preserves standalone per-agent callback files under ``cxas_app/Cloudbank/agents/``
for 100% ``cxas pull`` compatibility while keeping a single source of truth in
``cxas_shared/callbacks/`` and ``shared/personas/*.json``.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import yaml

CLOUDBANK_DIR = Path(__file__).resolve().parent.parent
SHARED_CALLBACKS_DIR = CLOUDBANK_DIR / "cxas_shared" / "callbacks"
BUNDLE_AGENTS_DIR = CLOUDBANK_DIR / "cxas_app" / "Cloudbank" / "agents"
PERSONAS_DIR = CLOUDBANK_DIR / "shared" / "personas"
GOLDENS_DIR = CLOUDBANK_DIR / "evals" / "goldens"
SIMULATIONS_DIR = CLOUDBANK_DIR / "evals" / "simulations"

AGENT_NAMES = (
    "root_agent",
    "everyday_banking_agent",
    "savings_agent",
    "mortgage_agent",
)

CALLBACK_TARGETS = (
    ("capture_utterance.py", "before_model_callbacks/capture_utterance/python_code.py"),
    ("agent_transfer.py", "after_model_callbacks/agent_transfer/python_code.py"),
    ("release_line.py", "after_model_callbacks/release_line/python_code.py"),
)


def _yaml_scalar(value: Any) -> str:
    """Format a JSON scalar as an unambiguous YAML scalar literal."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    raise TypeError(f"Unsupported scalar type: {type(value)!r}")


def _render_yaml_mapping(mapping: dict[str, Any], indent: int) -> list[str]:
    """Render nested snapshot dicts and lists in deterministic readable YAML."""
    pad = " " * indent
    lines: list[str] = []
    for key, val in mapping.items():
        if key == "transactions" and isinstance(val, list):
            lines.append(f"{pad}transactions:")
            tx_pad = " " * (indent + 2)
            for tx in val:
                pairs = ", ".join(f"{k}: {_yaml_scalar(v)}" for k, v in tx.items())
                lines.append(f"{tx_pad}- {{ {pairs} }}")
        elif isinstance(val, dict):
            lines.append(f"{pad}{key}:")
            lines.extend(_render_yaml_mapping(val, indent + 2))
        elif isinstance(val, list):
            lines.append(f"{pad}{key}:")
            item_pad = " " * (indent + 2)
            for item in val:
                if isinstance(item, dict):
                    first = True
                    for ik, iv in item.items():
                        prefix = f"{item_pad}- " if first else f"{item_pad}  "
                        lines.append(f"{prefix}{ik}: {_yaml_scalar(iv)}")
                        first = False
                else:
                    lines.append(f"{item_pad}- {_yaml_scalar(item)}")
        else:
            lines.append(f"{pad}{key}: {_yaml_scalar(val)}")
    return lines


def _render_session_parameters_block(
    header_key: str,
    base_indent: int,
    existing_params: dict[str, Any],
    personas: dict[str, dict[str, Any]],
) -> list[str]:
    """Build deterministic YAML lines for common_session_parameters or session_parameters."""
    persona_id = str(existing_params["persona_id"])
    if persona_id not in personas:
        raise KeyError(f"Unknown persona_id {persona_id!r}")
    snapshot = personas[persona_id]
    first_name = str(snapshot["user"]["first_name"])
    demo_date = str(existing_params.get("demo_date") or "2026-11-24")
    time_of_day = str(existing_params.get("time_of_day") or "afternoon")

    pad = " " * base_indent
    child_pad = " " * (base_indent + 2)
    lines = [
        f"{pad}{header_key}:",
        f"{child_pad}persona_id: {_yaml_scalar(persona_id)}",
        f"{child_pad}first_name: {_yaml_scalar(first_name)}",
        f"{child_pad}demo_date: {_yaml_scalar(demo_date)}",
        f"{child_pad}time_of_day: {_yaml_scalar(time_of_day)}",
        f"{child_pad}customer_snapshot:",
    ]
    lines.extend(_render_yaml_mapping(snapshot, base_indent + 4))
    return lines


def _rewrite_yaml_session_blocks(
    raw_text: str,
    header_key: str,
    personas: dict[str, dict[str, Any]],
) -> str:
    """Replace every header_key block in raw_text while keeping conversations/steps verbatim."""
    loaded = yaml.safe_load(raw_text)
    if header_key == "common_session_parameters":
        param_blocks = [loaded["common_session_parameters"]]
    else:
        param_blocks = [entry["session_parameters"] for entry in loaded["evals"]]

    src_lines = raw_text.splitlines()
    out_lines: list[str] = []
    block_idx = 0
    idx = 0
    total = len(src_lines)

    while idx < total:
        line = src_lines[idx]
        stripped = line.lstrip(" ")
        indent = len(line) - len(stripped)
        if stripped == f"{header_key}:":
            if block_idx >= len(param_blocks):
                raise RuntimeError(f"Unexpected extra {header_key} block at line {idx + 1}")
            replacement = _render_session_parameters_block(
                header_key, indent, param_blocks[block_idx], personas
            )
            out_lines.extend(replacement)
            block_idx += 1
            idx += 1
            trailing_blanks = 0
            while idx < total:
                cand = src_lines[idx]
                if not cand.strip():
                    trailing_blanks += 1
                    idx += 1
                    continue
                cand_indent = len(cand) - len(cand.lstrip(" "))
                if cand_indent <= indent:
                    break
                idx += 1
            if trailing_blanks > 0:
                out_lines.extend([""] * trailing_blanks)
            continue
        out_lines.append(line)
        idx += 1

    if block_idx != len(param_blocks):
        raise RuntimeError(
            f"Expected {len(param_blocks)} {header_key} block(s), found {block_idx}"
        )

    rendered = "\n".join(out_lines) + "\n"
    verified = yaml.safe_load(rendered)
    if header_key == "common_session_parameters":
        cp = verified["common_session_parameters"]
        pid = cp["persona_id"]
        if cp["customer_snapshot"] != personas[pid] or cp["first_name"] != personas[pid]["user"]["first_name"]:
            raise RuntimeError(f"Post-render YAML verification failed for persona {pid!r}")
    else:
        for item in verified["evals"]:
            sp = item["session_parameters"]
            pid = sp["persona_id"]
            if sp["customer_snapshot"] != personas[pid] or sp["first_name"] != personas[pid]["user"]["first_name"]:
                raise RuntimeError(f"Post-render YAML verification failed for simulation {item['name']!r}")
    return rendered


def load_personas() -> dict[str, dict[str, Any]]:
    """Load all canonical persona JSON snapshots from cloudbank/shared/personas/."""
    personas: dict[str, dict[str, Any]] = {}
    for path in sorted(PERSONAS_DIR.glob("*.json")):
        personas[path.stem] = json.loads(path.read_text(encoding="utf-8"))
    if not personas:
        raise FileNotFoundError(f"No persona fixtures found in {PERSONAS_DIR}")
    return personas


def sync_all(write: bool) -> list[str]:
    """Compare or write all synced callback and eval YAML files, returning drifted paths."""
    drifted: list[str] = []

    for src_name, rel_dest in CALLBACK_TARGETS:
        src_path = SHARED_CALLBACKS_DIR / src_name
        if not src_path.is_file():
            raise FileNotFoundError(f"Missing canonical callback source: {src_path}")
        canonical_text = src_path.read_text(encoding="utf-8")
        for agent in AGENT_NAMES:
            dest_path = BUNDLE_AGENTS_DIR / agent / rel_dest
            current_text = dest_path.read_text(encoding="utf-8") if dest_path.is_file() else ""
            if current_text != canonical_text:
                drifted.append(str(dest_path.relative_to(CLOUDBANK_DIR)))
                if write:
                    dest_path.parent.mkdir(parents=True, exist_ok=True)
                    dest_path.write_text(canonical_text, encoding="utf-8")

    personas = load_personas()

    for golden_path in sorted(GOLDENS_DIR.glob("*.yaml")):
        original = golden_path.read_text(encoding="utf-8")
        expected = _rewrite_yaml_session_blocks(
            original, "common_session_parameters", personas
        )
        if original != expected:
            drifted.append(str(golden_path.relative_to(CLOUDBANK_DIR)))
            if write:
                golden_path.write_text(expected, encoding="utf-8")

    for sim_path in sorted(SIMULATIONS_DIR.glob("*.yaml")):
        original = sim_path.read_text(encoding="utf-8")
        expected = _rewrite_yaml_session_blocks(
            original, "session_parameters", personas
        )
        if original != expected:
            drifted.append(str(sim_path.relative_to(CLOUDBANK_DIR)))
            if write:
                sim_path.write_text(expected, encoding="utf-8")

    return drifted


def build_parser() -> argparse.ArgumentParser:
    """Build the CLI argument parser for sync_shared.py."""
    parser = argparse.ArgumentParser(
        prog="sync_shared.py",
        description="Synchronize canonical callbacks and persona fixtures into the CXAS bundle and evals.",
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--check",
        action="store_true",
        help="Verify all callbacks and eval YAML snapshots match canonical sources without modifying files.",
    )
    mode.add_argument(
        "--write",
        action="store_true",
        help="Write canonical callbacks and persona snapshots into agent callbacks and eval YAMLs.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run sync_shared CLI and return process exit status."""
    args = build_parser().parse_args(argv)
    drifted = sync_all(write=args.write)
    if args.check:
        if drifted:
            for rel in drifted:
                print(f"drift: {rel}", file=sys.stderr)
            print(
                f"{len(drifted)} file(s) out of sync. Run: uv run --locked python scripts/sync_shared.py --write",
                file=sys.stderr,
            )
            return 1
        print("All 12 agent callbacks and evaluation persona snapshots are in sync.")
        return 0

    if drifted:
        for rel in drifted:
            print(f"updated: {rel}")
        print(f"Synchronized {len(drifted)} file(s).")
    else:
        print("Already up to date (0 files modified).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
