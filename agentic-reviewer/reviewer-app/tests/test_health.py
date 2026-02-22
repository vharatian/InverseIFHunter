"""Health and allowlist tests."""
import pytest
from fastapi.testclient import TestClient

# Import app after path is set (conftest does path)
from main import app


client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_ready_returns_json():
    r = client.get("/ready")
    assert r.status_code in (200, 503)
    data = r.json()
    assert "status" in data
    assert "redis" in data


def test_queue_without_header_returns_403():
    r = client.get("/api/queue")
    assert r.status_code == 403


def test_queue_with_empty_allowlist_returns_403():
    r = client.get("/api/queue", headers={"X-Reviewer-Email": "any@example.com"})
    assert r.status_code == 403
