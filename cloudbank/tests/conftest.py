"""Shared pytest fixtures and CXAS sandbox loaders for Cloudbank agent tests."""

from __future__ import annotations

import json
import types
from pathlib import Path
from typing import Any, Callable

import cxas_scrapi.utils.callback_libs as callback_libs
import pytest
from google.protobuf import json_format, struct_pb2

CLOUDBANK_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = CLOUDBANK_DIR.parent
BUNDLE_DIR = CLOUDBANK_DIR / "cxas_app" / "Cloudbank"
SHARED_DIR = CLOUDBANK_DIR / "shared"
FIXTURES_DIR = CLOUDBANK_DIR / "web" / "src" / "fixtures"
GOLDENS_DIR = CLOUDBANK_DIR / "evals" / "goldens"
SIMULATIONS_DIR = CLOUDBANK_DIR / "evals" / "simulations"

PERSONA_IDS = ("chloe", "david", "tom", "sarah")
AGENT_NAMES = (
    "root_agent",
    "everyday_banking_agent",
    "savings_agent",
    "mortgage_agent",
)
CONTROLLER_NAMES = (
    "route_banking_intent",
    "assist_everyday_banking",
    "assist_savings",
    "assist_mortgages",
)


def roundtrip_protobuf_struct(payload: dict[str, Any]) -> dict[str, Any]:
    """Round-trip JSON through google.protobuf.Struct so numbers become floats."""
    proto_struct = struct_pb2.Struct()
    json_format.ParseDict(payload, proto_struct)
    return json_format.MessageToDict(proto_struct)


def load_fake_search_help() -> Callable[[dict[str, Any]], dict[str, Any] | None]:
    """Load the bundle's real search_help toolFakeConfig code block."""
    fake_path = (
        BUNDLE_DIR
        / "tools"
        / "search_help"
        / "tool_fake_config"
        / "code_block"
        / "python_code.py"
    )
    namespace: dict[str, Any] = {
        "CallbackContext": callback_libs.CallbackContext,
        "Tool": callback_libs.Tool,
    }
    exec(compile(fake_path.read_text(encoding="utf-8"), str(fake_path), "exec"), namespace)
    fake_fn = namespace["fake_tool_call"]
    tool_meta = callback_libs.Tool(name="search_help", description="Google Search")

    def _call(inp: dict[str, Any]) -> dict[str, Any] | None:
        cb_ctx = callback_libs.CallbackContext()
        return fake_fn(tool_meta, inp, cb_ctx)

    return _call


def load_controller_namespace(
    tool_name: str,
    state: dict[str, Any],
    search_handler: Callable[[dict[str, Any]], Any] | None = None,
) -> dict[str, Any]:
    """Execute a controller Python file with sandbox globals context and tools."""
    code_path = (
        BUNDLE_DIR / "tools" / tool_name / "python_function" / "python_code.py"
    )
    tool_ctx = callback_libs.ToolContext()
    tool_ctx.state = state
    active_search = search_handler if search_handler is not None else load_fake_search_help()
    tools_ns = types.SimpleNamespace(search_help=active_search)
    namespace: dict[str, Any] = {
        "__name__": f"cxas_tool_{tool_name}",
        "context": tool_ctx,
        "tools": tools_ns,
    }
    exec(compile(code_path.read_text(encoding="utf-8"), str(code_path), "exec"), namespace)
    return namespace


def load_callback_namespace(
    agent_name: str,
    stage_dir: str,
    callback_name: str,
) -> dict[str, Any]:
    """Execute an agent callback Python file with callback_libs sandbox symbols."""
    cb_path = (
        BUNDLE_DIR
        / "agents"
        / agent_name
        / stage_dir
        / callback_name
        / "python_code.py"
    )
    namespace: dict[str, Any] = {"__name__": f"cxas_cb_{agent_name}_{callback_name}"}
    for sym in (
        "Blob",
        "CallbackContext",
        "Content",
        "Event",
        "EventActions",
        "FunctionCall",
        "FunctionDeclaration",
        "FunctionResponse",
        "GenerateContentConfig",
        "LlmRequest",
        "LlmResponse",
        "Part",
        "Tool",
        "ToolContext",
        "ToolDeclaration",
    ):
        namespace[sym] = getattr(callback_libs, sym)
    exec(compile(cb_path.read_text(encoding="utf-8"), str(cb_path), "exec"), namespace)
    return namespace


def make_seeded_state(
    persona_id: str,
    struct_fixtures: dict[str, dict[str, Any]],
    demo_date: str = "2026-11-24",
    time_of_day: str = "afternoon",
) -> dict[str, Any]:
    """Build initial BidiRunSession state with Struct-coerced float snapshot."""
    snap = roundtrip_protobuf_struct(struct_fixtures[persona_id])
    first_name = str(snap["user"]["first_name"])
    return {
        "persona_id": persona_id,
        "first_name": first_name,
        "demo_date": demo_date,
        "time_of_day": time_of_day,
        "customer_snapshot": snap,
    }


@pytest.fixture(scope="session")
def raw_fixtures() -> dict[str, dict[str, Any]]:
    """Return exact parsed JSON fixtures prior to protobuf.Struct coercion."""
    return {
        pid: json.loads((FIXTURES_DIR / f"{pid}.json").read_text(encoding="utf-8"))
        for pid in PERSONA_IDS
    }


@pytest.fixture(scope="session")
def struct_fixtures(raw_fixtures: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Return persona fixtures round-tripped through google.protobuf.Struct."""
    return {pid: roundtrip_protobuf_struct(data) for pid, data in raw_fixtures.items()}


@pytest.fixture(scope="session")
def snapshot_schema() -> dict[str, Any]:
    """Return customer_snapshot.schema.json."""
    return json.loads(
        (SHARED_DIR / "customer_snapshot.schema.json").read_text(encoding="utf-8")
    )


@pytest.fixture(scope="session")
def ui_view_state_schema() -> dict[str, Any]:
    """Return ui_view_state.schema.json."""
    return json.loads(
        (SHARED_DIR / "ui_view_state.schema.json").read_text(encoding="utf-8")
    )


@pytest.fixture(scope="session")
def parity_vectors() -> dict[str, Any]:
    """Return cross-runtime parity_vectors.json."""
    return json.loads((SHARED_DIR / "parity_vectors.json").read_text(encoding="utf-8"))
