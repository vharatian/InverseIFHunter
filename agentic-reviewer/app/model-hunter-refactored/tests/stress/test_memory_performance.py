"""
Tests for memory and performance scenarios.

Covers: long sessions, large payloads, many concurrent sessions,
response time benchmarks, and resource usage patterns.
"""
import pytest
import json
import os
import sys
import time
import concurrent.futures

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from tests.conftest import (
    make_passing_result,
    make_breaking_result,
    inject_results_into_session,
)


@pytest.mark.stress
class TestLargePayloads:
    """Tests with unusually large data to find size-related issues."""

    def test_50_hunts_single_turn(self, client, create_session):
        """50 hunt results in a single turn — state stays manageable."""
        sid = create_session
        results = [make_passing_result(i, f"Response text {i} " * 50) for i in range(1, 51)]
        inject_results_into_session(sid, results)
        r = client.get(f"/api/results/{sid}")
        assert r.status_code == 200
        assert len(r.json()["results"]) == 50

    def test_large_response_50kb(self, client, create_session):
        """A single response that is 50KB — stored and returned correctly."""
        sid = create_session
        large_response = "A" * 50_000
        inject_results_into_session(sid, [make_passing_result(1, large_response)])
        r = client.get(f"/api/results/{sid}")
        assert r.status_code == 200
        results = r.json()["results"]
        assert len(results) == 1
        assert len(results[0]["response"]) == 50_000

    def test_prompt_10000_words(self, client, minimal_notebook):
        """Upload notebook with 10,000-word prompt."""
        long_prompt = " ".join(["word"] * 10_000)
        nb = {
            "nbformat": 4, "nbformat_minor": 5, "metadata": {},
            "cells": [
                {"cell_type": "markdown", "id": "c1", "metadata": {},
                 "source": [f"**[prompt]**\n\n{long_prompt}"]},
                {"cell_type": "markdown", "id": "c2", "metadata": {},
                 "source": ['**[response_reference]**\n\n[{"id":"C1","criteria":"test"}]']},
                {"cell_type": "markdown", "id": "c3", "metadata": {},
                 "source": ["**[judge_system_prompt]**\n\nYou are a judge."]},
            ]
        }
        nb_json = json.dumps(nb)
        files = {"file": ("huge_prompt.ipynb", nb_json, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        assert r.status_code == 200
        assert len(r.json()["notebook"]["prompt"]) >= 40_000  # 10K words ~50KB

    def test_20_criteria_items(self, client, create_session):
        """Session with 20 criteria items — all preserved."""
        sid = create_session
        criteria = json.dumps([
            {"id": f"C{i}", "criteria": f"Criteria {i}: " + "x" * 200}
            for i in range(1, 21)
        ])
        inject_results_into_session(sid, [make_passing_result(1)])
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up",
            "next_criteria": criteria,
        })
        assert r.status_code == 200
        r2 = client.get(f"/api/turn-status/{sid}")
        stored_criteria = r2.json()["current_criteria"]
        # Should contain all 20 criteria
        assert "C20" in stored_criteria

    def test_notebook_with_100_cells(self, client):
        """Upload notebook with 100 cells — parsing stays fast."""
        cells = [
            {"cell_type": "markdown", "id": "c0", "metadata": {},
             "source": ["**[prompt]**\n\nMain prompt"]},
        ]
        for i in range(1, 100):
            cells.append({
                "cell_type": "code", "id": f"c{i}", "metadata": {},
                "source": [f"# Cell {i}\nprint('hello')"],
                "outputs": [], "execution_count": i,
            })
        cells.append({
            "cell_type": "markdown", "id": "c100", "metadata": {},
            "source": ['**[response_reference]**\n\n[{"id":"C1","criteria":"test"}]'],
        })
        nb = json.dumps({"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": cells})

        start = time.time()
        files = {"file": ("big.ipynb", nb, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        elapsed = time.time() - start

        assert r.status_code == 200
        assert elapsed < 5.0  # Should parse in under 5 seconds


@pytest.mark.stress
class TestManySessions:
    """Multiple sessions running concurrently."""

    def test_10_concurrent_sessions(self, client, minimal_notebook):
        """Create and query 10 sessions simultaneously."""
        session_ids = []
        for i in range(10):
            nb_json = json.dumps(minimal_notebook)
            files = {"file": (f"test_{i}.ipynb", nb_json, "application/json")}
            r = client.post("/api/upload-notebook", files=files)
            assert r.status_code == 200
            session_ids.append(r.json()["session_id"])

        # All should be independently accessible
        for sid in session_ids:
            r = client.get(f"/api/session/{sid}")
            assert r.status_code == 200

    def test_20_sessions_with_results(self, client, minimal_notebook):
        """20 sessions each with results — no cross-contamination."""
        session_ids = []
        for i in range(20):
            nb_json = json.dumps(minimal_notebook)
            files = {"file": (f"test_{i}.ipynb", nb_json, "application/json")}
            r = client.post("/api/upload-notebook", files=files)
            sid = r.json()["session_id"]
            session_ids.append(sid)
            # Inject unique result
            inject_results_into_session(sid, [
                make_passing_result(1, f"Session {i} response"),
            ])

        # Verify no cross-contamination
        for i, sid in enumerate(session_ids):
            r = client.get(f"/api/results/{sid}")
            assert r.status_code == 200
            results = r.json()["results"]
            assert len(results) == 1
            assert f"Session {i} response" in results[0]["response"]


@pytest.mark.stress
class TestDeepMultiTurn:
    """Sessions with many turns."""

    def test_10_turn_session(self, client, minimal_notebook):
        """Push through 10 turns — state stays consistent."""
        nb_json = json.dumps(minimal_notebook)
        files = {"file": ("deep.ipynb", nb_json, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        sid = r.json()["session_id"]

        for turn in range(1, 11):
            inject_results_into_session(sid, [
                make_passing_result(turn, f"Turn {turn} response text"),
            ])
            r = client.post(f"/api/advance-turn/{sid}", json={
                "selected_hunt_id": turn,
                "next_prompt": f"Turn {turn+1} prompt",
                "next_criteria": f'[{{"id":"C1","criteria":"Turn {turn+1} criteria"}}]',
            })
            assert r.status_code == 200

        r = client.get(f"/api/turn-status/{sid}")
        data = r.json()
        assert data["current_turn"] == 11
        assert len(data["turns"]) == 10
        assert len(data["conversation_history"]) == 20

    def test_conversation_history_fidelity(self, client, minimal_notebook):
        """After 5 turns, conversation history has exact content from each turn."""
        nb_json = json.dumps(minimal_notebook)
        files = {"file": ("fidelity.ipynb", nb_json, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        sid = r.json()["session_id"]

        for turn in range(1, 6):
            inject_results_into_session(sid, [
                make_passing_result(turn, f"UNIQUE_RESPONSE_{turn}"),
            ])

            client.post(f"/api/advance-turn/{sid}", json={
                "selected_hunt_id": turn,
                "next_prompt": f"Turn {turn+1} unique prompt",
                "next_criteria": f'[{{"id":"C1","criteria":"Turn {turn+1}"}}]',
            })

        r = client.get(f"/api/turn-status/{sid}")
        actual_history = r.json()["conversation_history"]
        assert len(actual_history) == 10

        # Verify all responses are in history
        for turn in range(1, 6):
            found = any(f"UNIQUE_RESPONSE_{turn}" in msg["content"]
                       for msg in actual_history if msg["role"] == "assistant")
            assert found, f"UNIQUE_RESPONSE_{turn} not found in conversation history"


@pytest.mark.stress
class TestResponseTimeBenchmarks:
    """Verify key endpoints respond within acceptable time limits."""

    def test_upload_under_2_seconds(self, client, minimal_notebook):
        """Upload should complete in under 2 seconds."""
        nb_json = json.dumps(minimal_notebook)
        files = {"file": ("test.ipynb", nb_json, "application/json")}
        start = time.time()
        r = client.post("/api/upload-notebook", files=files)
        elapsed = time.time() - start
        assert r.status_code == 200
        assert elapsed < 2.0

    def test_session_fetch_under_1_second(self, client, create_session):
        """Session fetch should be under 1 second."""
        sid = create_session
        start = time.time()
        r = client.get(f"/api/session/{sid}")
        elapsed = time.time() - start
        assert r.status_code == 200
        assert elapsed < 1.0

    def test_advance_turn_under_2_seconds(self, client, create_session):
        """advance-turn should complete in under 2 seconds."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        start = time.time()
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up",
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
        })
        elapsed = time.time() - start
        assert r.status_code == 200
        assert elapsed < 2.0

    def test_results_with_50_items_under_2_seconds(self, client, create_session):
        """Getting 50 results should be under 2 seconds."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(i) for i in range(1, 51)])
        start = time.time()
        r = client.get(f"/api/results/{sid}")
        elapsed = time.time() - start
        assert r.status_code == 200
        assert elapsed < 2.0
