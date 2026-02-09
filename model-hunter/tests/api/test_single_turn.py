"""
Verify single-turn workflow is completely unchanged by multi-turn additions.

These tests ensure backward compatibility — existing notebooks and workflows
should work identically after the multi-turn feature was added.
"""
import pytest


@pytest.mark.api
class TestSingleTurnBackwardCompat:

    def test_session_has_default_multi_turn_fields(self, client, create_session):
        """New multi-turn fields should exist with correct defaults."""
        r = client.get(f"/api/turn-status/{create_session}")
        assert r.status_code == 200
        data = r.json()
        assert data["current_turn"] == 1
        assert data["is_multi_turn"] == False
        assert data["conversation_history"] == []
        assert data["turns"] == []

    def test_session_status_is_accessible(self, client, create_session):
        """Session should be retrievable via /api/session/{id}."""
        r = client.get(f"/api/session/{create_session}")
        assert r.status_code == 200
        data = r.json()
        assert "status" in data
        assert "session_id" in data

    def test_health_endpoint_unchanged(self, client):
        """Health endpoint should still work."""
        r = client.get("/api/health")
        assert r.status_code == 200
        data = r.json()
        assert "status" in data

    def test_version_endpoint_unchanged(self, client):
        """Version endpoint should return version string."""
        r = client.get("/api/version")
        assert r.status_code == 200
        data = r.json()
        assert "version" in data
        assert isinstance(data["version"], str)

    def test_models_endpoint_unchanged(self, client):
        """Models endpoint should return available models."""
        r = client.get("/api/models")
        assert r.status_code == 200
        data = r.json()
        assert "models" in data
        assert isinstance(data["models"], (list, dict))  # May be dict or list
