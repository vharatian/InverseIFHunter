"""
Test resilience features: active-hunts, admin endpoints.
"""
import pytest


@pytest.mark.api
class TestResilience:

    def test_active_hunts_initially_zero(self, client):
        """With no running hunts, active count should be 0."""
        r = client.get("/api/admin/active-hunts")
        assert r.status_code == 200
        data = r.json()
        assert data["count"] == 0
        assert data["sessions"] == []

    def test_active_hunts_response_schema(self, client):
        """Active-hunts response should have count and sessions fields."""
        r = client.get("/api/admin/active-hunts")
        assert r.status_code == 200
        data = r.json()
        assert "count" in data
        assert "sessions" in data
        assert isinstance(data["count"], int)
        assert isinstance(data["sessions"], list)

    def test_admin_status_endpoint(self, client):
        """Admin status endpoint should return system info."""
        r = client.get("/api/admin/status")
        assert r.status_code == 200
        data = r.json()
        assert "timestamp" in data

    def test_active_hunts_after_session_creation(self, client, create_session):
        """Creating a session should NOT add to active hunts (only running hunts count)."""
        r = client.get("/api/admin/active-hunts")
        assert r.status_code == 200
        # Session exists but no hunt is running
        assert r.json()["count"] == 0
