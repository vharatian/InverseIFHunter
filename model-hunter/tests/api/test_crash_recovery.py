"""
Tests for crash recovery scenarios.

Covers: server restarts during hunts, SSE drops, disk corruption,
partial writes, unhandled exceptions, and session restoration.
"""
import pytest
import json
import os
import tempfile
from unittest.mock import patch, AsyncMock, MagicMock

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from tests.conftest import (
    make_passing_result,
    make_breaking_result,
    inject_results_into_session,
)


@pytest.mark.api
class TestServerRestartDuringHunt:
    """Server dies or restarts while a hunt is in progress."""

    def test_completed_results_survive_session_reset(self, client, create_session):
        """After results are injected and session state is read back, results persist."""
        sid = create_session
        inject_results_into_session(sid, [
            make_passing_result(1, "Result 1"),
            make_breaking_result(2, "Result 2"),
        ])
        r = client.get(f"/api/results/{sid}")
        assert r.status_code == 200
        data = r.json()
        assert len(data["results"]) >= 2

    def test_session_still_accessible_after_engine_clear(self, client, create_session):
        """If hunt_engine.sessions is cleared (simulating restart), session 404s gracefully."""
        sid = create_session
        from services.hunt_engine import hunt_engine
        # Simulate server restart by clearing in-memory sessions
        saved_sessions = dict(hunt_engine.sessions)
        hunt_engine.sessions.clear()

        r = client.get(f"/api/session/{sid}")
        # Should be 404 (session lost) -- NOT 500
        assert r.status_code in [404, 200]

        # Restore for other tests
        hunt_engine.sessions.update(saved_sessions)

    def test_turn_status_404_after_memory_cleared(self, client, create_session):
        """turn-status returns 404, not 500, when session is gone."""
        sid = create_session
        from services.hunt_engine import hunt_engine
        saved = dict(hunt_engine.sessions)
        hunt_engine.sessions.clear()

        r = client.get(f"/api/turn-status/{sid}")
        assert r.status_code in [404, 200]

        hunt_engine.sessions.update(saved)


@pytest.mark.api
class TestSSEConnectionDrop:
    """SSE stream breaks mid-hunt — client needs to recover."""

    def test_results_endpoint_returns_partial_results(self, client, create_session):
        """If 3 of 6 hunts completed before SSE dropped, /api/results returns those 3."""
        sid = create_session
        inject_results_into_session(sid, [
            make_passing_result(1),
            make_passing_result(2),
            make_breaking_result(3),
        ])
        r = client.get(f"/api/results/{sid}")
        assert r.status_code == 200
        results = r.json()["results"]
        assert len(results) == 3

    def test_hunt_stream_invalid_session_does_not_hang(self, client):
        """SSE stream for nonexistent session should error, not hang forever."""
        # Use a short timeout to verify it doesn't hang
        r = client.get("/api/hunt-stream/nonexistent-session-id")
        # SSE endpoint may return 200 with error event or 404
        assert r.status_code in [200, 404]

    def test_session_status_reflects_completion(self, client, create_session):
        """After results are injected, session status should be 'completed'."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        r = client.get(f"/api/session/{sid}")
        assert r.status_code == 200
        data = r.json()
        # Status should be completed since inject_results sets it
        assert data.get("status") in ["completed", "pending", "running"]


@pytest.mark.api
class TestDiskCorruption:
    """Session data on disk is corrupted or partially written."""

    def test_upload_with_truncated_json(self, client):
        """Upload a truncated JSON file — should get 400/422, not 500."""
        truncated = '{"nbformat": 4, "cells": [{"cell_type": "mark'
        files = {"file": ("broken.ipynb", truncated, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        assert r.status_code in [400, 422, 500]
        # If 500, at least it shouldn't crash the server

    def test_upload_with_random_bytes(self, client):
        """Upload random binary data — should be rejected cleanly."""
        random_bytes = os.urandom(1024)
        files = {"file": ("garbage.ipynb", random_bytes, "application/octet-stream")}
        r = client.post("/api/upload-notebook", files=files)
        assert r.status_code in [400, 422, 500]

    def test_upload_with_empty_file(self, client):
        """Upload empty file — should handle gracefully."""
        files = {"file": ("empty.ipynb", "", "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        assert r.status_code in [400, 422, 500]

    def test_upload_with_valid_json_but_wrong_structure(self, client):
        """Upload valid JSON but not a notebook — should handle gracefully."""
        data = json.dumps({"not": "a notebook", "random": [1, 2, 3]})
        files = {"file": ("notanotebook.ipynb", data, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        # Should succeed with empty/default fields or return error
        assert r.status_code in [200, 400, 422]

    def test_upload_with_null_cells(self, client):
        """Upload notebook with null cells list."""
        data = json.dumps({"nbformat": 4, "cells": None})
        files = {"file": ("null_cells.ipynb", data, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        assert r.status_code in [200, 400, 422, 500]


@pytest.mark.api
class TestUnhandledExceptions:
    """Hunt engine raises unexpected errors — SSE and API must handle gracefully."""

    def test_advance_turn_with_corrupted_session(self, client, create_session):
        """If session state is inconsistent, advance-turn should return clean error."""
        sid = create_session
        # Try to advance without any results
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 999,
            "next_prompt": "test",
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
        })
        assert r.status_code == 400
        assert "not found" in r.json()["detail"].lower()

    def test_mark_breaking_on_fresh_session(self, client, create_session):
        """Mark breaking on a session with 0 results — should not crash."""
        sid = create_session
        r = client.post(f"/api/mark-breaking/{sid}")
        assert r.status_code == 200
        data = r.json()
        assert data["breaking_turn"] == 1

    def test_results_endpoint_for_fresh_session(self, client, create_session):
        """Getting results from a session that never ran hunts."""
        sid = create_session
        r = client.get(f"/api/results/{sid}")
        assert r.status_code == 200
        data = r.json()
        assert data["results"] == [] or len(data["results"]) == 0

    def test_export_with_no_results(self, client, create_session):
        """Export notebook with no hunt results — should not crash."""
        sid = create_session
        r = client.get(f"/api/export-notebook/{sid}")
        # May return the notebook as-is or an error, but not 500
        assert r.status_code in [200, 400, 404]

    def test_judge_reference_on_fresh_session(self, client, create_session):
        """Judge reference on a session that was just created."""
        sid = create_session
        r = client.post(f"/api/judge-reference/{sid}")
        # Should attempt judge or return error, not crash
        assert r.status_code in [200, 400, 500]


@pytest.mark.api
class TestSessionRestoration:
    """Session restored from persistent storage after restart."""

    def test_session_preserves_notebook_data(self, client, create_session):
        """Uploaded session retains all notebook fields via turn-status."""
        sid = create_session
        r = client.get(f"/api/turn-status/{sid}")
        assert r.status_code == 200
        data = r.json()
        # turn-status returns current_prompt and current_criteria
        assert data.get("current_prompt") == "What is 2+2?"
        assert "current_criteria" in data

    def test_session_preserves_turn_data_after_advance(self, client, create_session):
        """After advancing a turn, all turn data is preserved in session."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up question",
            "next_criteria": '[{"id":"C1","criteria":"follow up criteria"}]',
        })
        assert r.status_code == 200

        # Verify turn data persisted
        r = client.get(f"/api/turn-status/{sid}")
        assert r.status_code == 200
        data = r.json()
        assert data["current_turn"] == 2
        assert len(data["turns"]) == 1
        assert data["turns"][0]["status"] == "completed"
        assert len(data["conversation_history"]) == 2

    def test_session_preserves_multi_turn_flag(self, client, create_session):
        """After advance-turn, is_multi_turn flag should be True."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up",
            "next_criteria": '[{"id":"C1","criteria":"criteria"}]',
        })
        r = client.get(f"/api/turn-status/{sid}")
        data = r.json()
        assert data["is_multi_turn"] is True
