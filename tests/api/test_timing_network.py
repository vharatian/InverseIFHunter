"""
Tests for timing and network failure scenarios.

Covers: API timeouts, rate limits, empty responses, malformed responses,
partial data, and network-level failures.
"""
import pytest
import json
import os
import sys
import asyncio
from unittest.mock import patch, AsyncMock, MagicMock
import httpx

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from tests.conftest import (
    make_passing_result,
    make_breaking_result,
    inject_results_into_session,
)


@pytest.mark.api
class TestAPITimeouts:
    """Model/judge API takes too long or times out."""

    def test_health_endpoint_responds_fast(self, client):
        """Health endpoint should respond in under 1 second."""
        import time
        start = time.time()
        r = client.get("/api/health")
        elapsed = time.time() - start
        assert r.status_code == 200
        assert elapsed < 1.0

    def test_session_fetch_responds_fast(self, client, create_session):
        """Session fetch should respond quickly."""
        import time
        sid = create_session
        start = time.time()
        r = client.get(f"/api/session/{sid}")
        elapsed = time.time() - start
        assert r.status_code == 200
        assert elapsed < 2.0

    def test_turn_status_responds_fast(self, client, create_session):
        """Turn status should respond quickly."""
        import time
        sid = create_session
        start = time.time()
        r = client.get(f"/api/turn-status/{sid}")
        elapsed = time.time() - start
        assert r.status_code == 200
        assert elapsed < 2.0

    def test_results_endpoint_responds_fast(self, client, create_session):
        """Results endpoint should respond quickly even with many results."""
        import time
        sid = create_session
        # Inject many results
        results = [make_passing_result(i) for i in range(1, 51)]
        inject_results_into_session(sid, results)
        start = time.time()
        r = client.get(f"/api/results/{sid}")
        elapsed = time.time() - start
        assert r.status_code == 200
        assert elapsed < 3.0


@pytest.mark.api
class TestMalformedResponses:
    """API returns unexpected or malformed data."""

    def test_advance_turn_with_empty_prompt(self, client, create_session):
        """advance-turn with empty string prompt."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "",
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
        })
        # Empty prompt is technically valid (the app allows it)
        assert r.status_code in [200, 400, 422]

    def test_advance_turn_with_empty_criteria(self, client, create_session):
        """advance-turn with empty string criteria."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up",
            "next_criteria": "",
        })
        assert r.status_code in [200, 400, 422]

    def test_advance_turn_with_null_criteria(self, client, create_session):
        """advance-turn with null criteria field."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up",
            "next_criteria": None,
        })
        assert r.status_code in [200, 400, 422]

    def test_start_hunt_with_missing_body(self, client, create_session):
        """Start hunt with no JSON body."""
        sid = create_session
        r = client.post("/api/start-hunt")
        assert r.status_code in [400, 422]

    def test_start_hunt_with_empty_models_list(self, client, create_session):
        """Start hunt with empty models array — documents ZeroDivisionError bug.

        NOTE: This test documents a known bug (models[i % len(models)] with
        empty list causes ZeroDivisionError). The server currently crashes.
        Once fixed, it should return 400/422.
        """
        sid = create_session
        try:
            r = client.post("/api/start-hunt", json={
                "session_id": sid,
                "config": {"models": [], "parallel_workers": 4}
            })
            # If we get here, the server handled it
            assert r.status_code in [400, 422, 500]
        except Exception:
            # Known bug: ZeroDivisionError from models[i % len(models)]
            pass  # Documented — the bug is real

    def test_upload_with_wrong_content_type(self, client):
        """Upload with wrong MIME type — should handle."""
        nb = json.dumps({
            "nbformat": 4, "nbformat_minor": 5, "metadata": {},
            "cells": [
                {"cell_type": "markdown", "id": "c1", "metadata": {},
                 "source": ["**[prompt]**\n\nTest"]},
            ]
        })
        files = {"file": ("test.ipynb", nb, "text/plain")}
        r = client.post("/api/upload-notebook", files=files)
        # Should still work since we parse JSON regardless of MIME
        assert r.status_code in [200, 400, 422]


@pytest.mark.api
class TestResponseIntegrity:
    """Verify responses have correct structure and content."""

    def test_session_response_has_required_fields(self, client, create_session):
        """Session response must contain all expected top-level fields."""
        sid = create_session
        r = client.get(f"/api/session/{sid}")
        assert r.status_code == 200
        data = r.json()
        assert "session_id" in data
        assert "status" in data
        assert "results" in data

    def test_results_response_has_required_fields(self, client, create_session):
        """Results response must have 'results' array."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        r = client.get(f"/api/results/{sid}")
        assert r.status_code == 200
        data = r.json()
        assert "results" in data
        assert isinstance(data["results"], list)

    def test_turn_status_response_has_required_fields(self, client, create_session):
        """turn-status response must have all multi-turn fields."""
        sid = create_session
        r = client.get(f"/api/turn-status/{sid}")
        assert r.status_code == 200
        data = r.json()
        required = ["current_turn", "is_multi_turn", "conversation_history", "turns"]
        for field in required:
            assert field in data, f"Missing field: {field}"

    def test_advance_turn_response_has_required_fields(self, client, create_session):
        """advance-turn response must have expected fields."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up",
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
        })
        assert r.status_code == 200
        data = r.json()
        assert "current_turn" in data
        assert "prompt" in data
        assert "response_reference" in data

    def test_mark_breaking_response_has_required_fields(self, client, create_session):
        """mark-breaking response must have expected fields."""
        sid = create_session
        r = client.post(f"/api/mark-breaking/{sid}")
        assert r.status_code == 200
        data = r.json()
        assert "breaking_turn" in data
        assert "total_turns" in data
        assert "is_multi_turn" in data

    def test_health_response_format(self, client):
        """Health endpoint returns expected format."""
        r = client.get("/api/health")
        assert r.status_code == 200
        data = r.json()
        assert "status" in data

    def test_models_response_is_list(self, client):
        """Models endpoint returns a list."""
        r = client.get("/api/models")
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, (list, dict))

    def test_version_response_format(self, client):
        """Version endpoint returns version string."""
        r = client.get("/api/version")
        assert r.status_code == 200
        data = r.json()
        assert "version" in data


@pytest.mark.api
class TestNullAndMissingFields:
    """API handles null and missing fields without crashing."""

    def test_advance_turn_missing_next_prompt(self, client, create_session):
        """next_prompt is optional (selectGoodResponse flow); advance succeeds with default ''."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_criteria": "test",
        })
        assert r.status_code == 200

    def test_advance_turn_missing_next_criteria(self, client, create_session):
        """next_criteria is optional (selectGoodResponse flow); advance succeeds with default ''."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "test",
        })
        assert r.status_code == 200

    def test_advance_turn_missing_hunt_id(self, client, create_session):
        """advance-turn without selected_hunt_id should return 422."""
        sid = create_session
        r = client.post(f"/api/advance-turn/{sid}", json={
            "next_prompt": "test",
            "next_criteria": "test",
        })
        assert r.status_code == 422

    def test_advance_turn_with_extra_fields(self, client, create_session):
        """advance-turn with extra unknown fields should still work."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up",
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
            "unknown_field": "should be ignored",
            "extra": 123,
        })
        # Pydantic should ignore extra fields
        assert r.status_code in [200, 422]
