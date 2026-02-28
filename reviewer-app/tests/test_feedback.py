"""Tests for feedback and edit APIs (403 when not allowlisted)."""
from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def test_put_feedback_403_without_header():
    """PUT feedback without reviewer header returns 403."""
    r = client.put(
        "/api/tasks/some-id/feedback",
        json={"overall_comment": "test", "section_comments": []},
    )
    assert r.status_code == 403


def test_patch_task_403_without_header():
    """PATCH task without reviewer header returns 403."""
    r = client.patch("/api/tasks/some-id", json={"human_reviews": {}})
    assert r.status_code == 403


def test_get_feedback_403_without_header():
    """GET feedback without reviewer header returns 403."""
    r = client.get("/api/tasks/some-id/feedback")
    assert r.status_code == 403


def test_agent_run_403_without_header():
    """POST agent-run without reviewer header returns 403."""
    r = client.post("/api/tasks/some-id/agent-run")
    assert r.status_code == 403


def test_agent_result_403_without_header():
    """GET agent-result without reviewer header returns 403."""
    r = client.get("/api/tasks/some-id/agent-result")
    assert r.status_code == 403


def test_audit_403_without_header():
    """GET audit without reviewer header returns 403."""
    r = client.get("/api/audit")
    assert r.status_code == 403
