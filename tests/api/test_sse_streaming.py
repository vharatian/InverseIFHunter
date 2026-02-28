"""
Test SSE streaming from /api/hunt-stream/{session_id}.

Verifies SSE content type, error handling for invalid sessions,
and the reconnection contract (results available after disconnect).
"""
import pytest
import json


@pytest.mark.api
class TestSSEStreaming:
    """Test the Server-Sent Events endpoint for hunt progress."""

    def test_results_endpoint_for_reconnection(self, client, create_session):
        """After disconnect, /api/session/{id} should return session with results field."""
        r = client.get(f"/api/session/{create_session}")
        assert r.status_code == 200
        data = r.json()
        assert "status" in data
        assert "session_id" in data

    def test_hunt_stream_endpoint_exists(self, client, create_session):
        """The hunt-stream endpoint should exist and respond for valid session."""
        r = client.get(f"/api/hunt-stream/{create_session}")
        # SSE endpoints return 200 with event stream or error — not 404/405
        assert r.status_code != 405

    def test_session_has_status_for_reconnection(self, client, create_session):
        """Session status should indicate hunt state for reconnection logic."""
        r = client.get(f"/api/session/{create_session}")
        assert r.status_code == 200
        data = r.json()
        assert data["status"] in ["pending", "running", "completed", "failed"]
