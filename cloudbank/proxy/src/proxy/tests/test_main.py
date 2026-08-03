"""Smoke tests for the FastAPI app routes."""
from __future__ import annotations

from fastapi.testclient import TestClient

from proxy.main import app


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
