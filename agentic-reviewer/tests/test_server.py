"""
Tests for standalone web server.
"""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from agentic_reviewer.server import app

client = TestClient(app)


def test_index_returns_html():
    """GET / serves the UI."""
    r = client.get("/")
    assert r.status_code == 200
    assert "Agentic Reviewer" in r.text
    assert "text/html" in r.headers.get("content-type", "")


def test_api_review_preflight_passes():
    """POST /api/review preflight with valid data passes."""
    session = {
        "session_id": "x",
        "current_turn": 1,
        "notebook": {"prompt": "p", "response_reference": "C1: x"},
        "all_results": [
            {"hunt_id": i, "model": "qwen/qwen3-235b", "response": f"r{i}"}
            for i in range(1, 5)
        ],
        "human_reviews": {},
    }
    r = client.post(
        "/api/review",
        json={
            "session": session,
            "checkpoint": "preflight",
            "selected_hunt_ids": [1, 2, 3, 4],
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["passed"] is True
    assert data["checkpoint"] == "preflight"


def test_api_review_preflight_missing_ids_returns_400():
    """Preflight without 4 IDs returns 400."""
    session = {
        "session_id": "x",
        "notebook": {"prompt": "p", "response_reference": "C1: x"},
        "all_results": [{"hunt_id": i, "model": "m", "response": "r"} for i in range(1, 5)],
        "human_reviews": {},
    }
    r = client.post(
        "/api/review",
        json={"session": session, "checkpoint": "preflight", "selected_hunt_ids": [1, 2, 3]},
    )
    assert r.status_code == 400


def test_api_review_final_passes():
    """POST /api/review final with valid data passes (human and LLM aligned)."""
    session = {
        "session_id": "x",
        "notebook": {"prompt": "p", "response_reference": "C1: x"},
        "all_results": [
            {
                "hunt_id": i,
                "model": "qwen/qwen3-235b",
                "response": f"r{i}",
                "judge_score": 1,
                "judge_criteria": {"C1": "pass"},
                "judge_explanation": "Meets criteria.",
            }
            for i in range(1, 5)
        ],
        "human_reviews": {
            str(i): {"grades": {"C1": "pass"}, "explanation": "ok", "submitted": True}
            for i in range(1, 5)
        },
    }
    r = client.post(
        "/api/review",
        json={"session": session, "checkpoint": "final"},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["passed"] is True
    assert data["checkpoint"] == "final"
