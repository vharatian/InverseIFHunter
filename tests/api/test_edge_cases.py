"""
Test edge cases and error handling.
"""
import pytest
import json
import concurrent.futures
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from tests.conftest import inject_results_into_session, make_passing_result


@pytest.mark.api
class TestEdgeCases:

    def test_advance_turn_invalid_session(self, client):
        """Advance-turn on nonexistent session should 404."""
        r = client.post("/api/advance-turn/nonexistent-abc", json={
            "selected_hunt_id": 1,
            "next_prompt": "test",
            "next_criteria": "test",
        })
        assert r.status_code == 404

    def test_double_mark_breaking(self, client, create_session):
        """Marking breaking twice should still succeed."""
        r1 = client.post(f"/api/mark-breaking/{create_session}")
        assert r1.status_code == 200
        r2 = client.post(f"/api/mark-breaking/{create_session}")
        assert r2.status_code == 200

    def test_advance_turn_nonexistent_hunt_id(self, client, minimal_notebook):
        """Advance with a hunt_id that doesn't exist should fail."""
        nb_json = json.dumps(minimal_notebook)
        files = {"file": ("edge.ipynb", nb_json, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        session_id = r.json()["session_id"]

        # Inject a result with hunt_id=1, then ask for hunt_id=999
        injected = inject_results_into_session(session_id, [
            make_passing_result(hunt_id=1),
        ])
        if not injected:
            pytest.skip("Could not inject results")

        r = client.post(f"/api/advance-turn/{session_id}", json={
            "selected_hunt_id": 999,
            "next_prompt": "test",
            "next_criteria": "test",
        })
        assert r.status_code == 400

    def test_concurrent_turn_status_requests(self, client, create_session):
        """Multiple concurrent reads should not conflict."""
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            futures = [
                pool.submit(client.get, f"/api/turn-status/{create_session}")
                for _ in range(5)
            ]
            results = [f.result() for f in futures]
            assert all(r.status_code == 200 for r in results)

    def test_advance_turn_empty_prompt(self, client, minimal_notebook):
        """Advance-turn with empty string prompt should be handled."""
        nb_json = json.dumps(minimal_notebook)
        files = {"file": ("empty_prompt.ipynb", nb_json, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        session_id = r.json()["session_id"]

        injected = inject_results_into_session(session_id, [
            make_passing_result(hunt_id=1),
        ])
        if not injected:
            pytest.skip("Could not inject results")

        r = client.post(f"/api/advance-turn/{session_id}", json={
            "selected_hunt_id": 1,
            "next_prompt": "",
            "next_criteria": "test",
        })
        # May succeed (empty is technically valid) or fail — just not 500
        assert r.status_code != 500

    def test_upload_very_large_notebook(self, client):
        """Upload a notebook with many cells should not crash."""
        cells = []
        for i in range(100):
            cells.append({
                "cell_type": "markdown", "id": f"c{i}", "metadata": {},
                "source": [f"Cell content {i}"],
            })
        nb = json.dumps({
            "nbformat": 4, "nbformat_minor": 5, "metadata": {},
            "cells": cells,
        })
        files = {"file": ("large.ipynb", nb, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        assert r.status_code == 200
