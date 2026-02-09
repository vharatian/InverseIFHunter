"""
Test session creation, retrieval, and storage.

Tests the /api/upload-notebook and /api/session/{id} endpoints.
"""
import pytest
import json


@pytest.mark.api
class TestSessionLifecycle:

    def test_upload_creates_session(self, client, minimal_notebook):
        """Upload a valid notebook and verify session is created."""
        nb_json = json.dumps(minimal_notebook)
        files = {"file": ("test.ipynb", nb_json, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        assert r.status_code == 200
        data = r.json()
        assert "session_id" in data
        assert data.get("success") == True
        assert "notebook" in data

    def test_upload_returns_parsed_notebook(self, client, minimal_notebook):
        """Uploaded notebook should be parsed and returned in response."""
        nb_json = json.dumps(minimal_notebook)
        files = {"file": ("test.ipynb", nb_json, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        assert r.status_code == 200
        notebook = r.json()["notebook"]
        assert notebook["prompt"] == "What is 2+2?"

    def test_session_retrieval(self, client, create_session):
        """Retrieve a previously created session by ID."""
        r = client.get(f"/api/session/{create_session}")
        assert r.status_code == 200
        data = r.json()
        assert data["session_id"] == create_session
        assert "status" in data

    def test_session_not_found(self, client):
        """Requesting a nonexistent session returns 404."""
        r = client.get("/api/session/nonexistent-id-12345")
        assert r.status_code == 404

    def test_upload_invalid_json(self, client):
        """Uploading invalid JSON should return an error."""
        files = {"file": ("bad.ipynb", "not json at all", "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        assert r.status_code in [400, 422, 500]

    def test_upload_missing_cells(self, client):
        """Uploading a notebook with empty cells should succeed with empty fields."""
        nb = json.dumps({"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": []})
        files = {"file": ("empty.ipynb", nb, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        # Should succeed but parsed notebook will have empty/default fields
        assert r.status_code == 200

    def test_upload_no_file_returns_error(self, client):
        """Upload without a file should return an error."""
        r = client.post("/api/upload-notebook")
        assert r.status_code == 422

    def test_session_id_is_unique(self, client, minimal_notebook):
        """Two uploads should produce different session IDs."""
        nb_json = json.dumps(minimal_notebook)
        files1 = {"file": ("test1.ipynb", nb_json, "application/json")}
        files2 = {"file": ("test2.ipynb", nb_json, "application/json")}
        r1 = client.post("/api/upload-notebook", files=files1)
        r2 = client.post("/api/upload-notebook", files=files2)
        assert r1.status_code == 200
        assert r2.status_code == 200
        assert r1.json()["session_id"] != r2.json()["session_id"]
