"""Smoke tests for the FastAPI app routes."""
from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from proxy.main import _resolve_session_id, app


def test_health_endpoint() -> None:
    client = TestClient(app)
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_ws_endpoint_registered() -> None:
    # Confirms the WS route exists and the app starts. We don't exercise the
    # full upstream handshake here — that's covered by relay tests.
    paths = [r.path for r in app.routes]
    assert "/ws/agent" in paths


def test_resolve_session_id_keeps_a_valid_client_uuid() -> None:
    """Reusing the browser's id is what lets a reconnect resume the same CES
    conversation instead of starting a blank one."""
    requested = "3f1c8a2e-9b47-4d6a-8e21-5c7b0d9f4a13"
    assert _resolve_session_id(requested) == requested


def test_resolve_session_id_generates_one_when_absent() -> None:
    generated = _resolve_session_id(None)
    assert uuid.UUID(generated)


@pytest.mark.parametrize(
    "hostile",
    [
        "../../../other-project/sessions/steal",
        "abc/../../apps/otherapp/sessions/x",
        "not-a-uuid",
        "",
        "3f1c8a2e-9b47-4d6a-8e21-5c7b0d9f4a13/../evil",
        "3f1c8a2e_9b47_4d6a_8e21_5c7b0d9f4a13",
        "x" * 500,
    ],
)
def test_resolve_session_id_rejects_anything_that_is_not_a_uuid(hostile: str) -> None:
    """session_id is interpolated into the CES resource path in relay.py, so an
    unvalidated client string is a path-injection channel into another app's
    sessions. Anything non-UUID must be replaced, never passed through."""
    resolved = _resolve_session_id(hostile)
    assert resolved != hostile
    assert uuid.UUID(resolved)
