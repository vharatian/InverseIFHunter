"""
Tests for concurrency and race condition scenarios.

Covers: double-clicks, concurrent requests, rapid operations,
parallel session access, and atomic state transitions.
"""
import pytest
import json
import os
import sys
import concurrent.futures
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from tests.conftest import (
    make_passing_result,
    make_breaking_result,
    inject_results_into_session,
)


@pytest.mark.api
class TestDoubleClickPrevention:
    """Rapid duplicate requests shouldn't corrupt state."""

    def test_double_advance_turn(self, client, create_session):
        """Two advance-turn requests in rapid succession — only first should succeed cleanly."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])

        r1 = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up 1",
            "next_criteria": '[{"id":"C1","criteria":"test1"}]',
        })
        assert r1.status_code == 200
        assert r1.json()["current_turn"] == 2

        # Second advance — results are now cleared, hunt_id 1 may not exist
        r2 = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up 2",
            "next_criteria": '[{"id":"C1","criteria":"test2"}]',
        })
        # Should either fail (no results) or succeed but not crash
        assert r2.status_code in [200, 400]

    def test_double_mark_breaking(self, client, create_session):
        """Two mark-breaking calls in succession — should handle gracefully."""
        sid = create_session
        r1 = client.post(f"/api/mark-breaking/{sid}")
        assert r1.status_code == 200
        assert r1.json()["breaking_turn"] == 1

        r2 = client.post(f"/api/mark-breaking/{sid}")
        assert r2.status_code == 200
        # Second call creates another turn entry
        assert r2.json()["total_turns"] >= 2

    def test_rapid_session_queries(self, client, create_session):
        """50 rapid session queries — all should succeed."""
        sid = create_session
        for i in range(50):
            r = client.get(f"/api/session/{sid}")
            assert r.status_code == 200

    def test_rapid_turn_status_queries(self, client, create_session):
        """50 rapid turn-status queries — all should succeed."""
        sid = create_session
        for i in range(50):
            r = client.get(f"/api/turn-status/{sid}")
            assert r.status_code == 200


@pytest.mark.api
class TestConcurrentAccess:
    """Multiple clients accessing the same session simultaneously."""

    def test_concurrent_read_operations(self, client, create_session):
        """5 concurrent reads to the same session — no conflicts."""
        sid = create_session

        def read_session():
            return client.get(f"/api/session/{sid}")

        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            futures = [pool.submit(read_session) for _ in range(5)]
            results = [f.result() for f in futures]
            assert all(r.status_code == 200 for r in results)

    def test_concurrent_turn_status_reads(self, client, create_session):
        """5 concurrent turn-status reads — no conflicts."""
        sid = create_session

        def read_turn_status():
            return client.get(f"/api/turn-status/{sid}")

        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            futures = [pool.submit(read_turn_status) for _ in range(5)]
            results = [f.result() for f in futures]
            assert all(r.status_code == 200 for r in results)

    def test_concurrent_results_reads(self, client, create_session):
        """5 concurrent results reads — no conflicts."""
        sid = create_session
        inject_results_into_session(sid, [
            make_passing_result(1),
            make_breaking_result(2),
        ])

        def read_results():
            return client.get(f"/api/results/{sid}")

        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            futures = [pool.submit(read_results) for _ in range(5)]
            results = [f.result() for f in futures]
            assert all(r.status_code == 200 for r in results)
            # All should return the same number of results
            counts = [len(r.json()["results"]) for r in results]
            assert len(set(counts)) == 1  # All counts identical

    def test_concurrent_uploads(self, client, minimal_notebook):
        """5 concurrent notebook uploads — all should create unique sessions."""
        def upload():
            nb_json = json.dumps(minimal_notebook)
            files = {"file": ("test.ipynb", nb_json, "application/json")}
            return client.post("/api/upload-notebook", files=files)

        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            futures = [pool.submit(upload) for _ in range(5)]
            results = [f.result() for f in futures]
            assert all(r.status_code == 200 for r in results)
            session_ids = [r.json()["session_id"] for r in results]
            # All session IDs should be unique
            assert len(set(session_ids)) == 5


@pytest.mark.api
class TestAtomicStateTransitions:
    """State transitions should be atomic and consistent."""

    def test_advance_then_check_state(self, client, create_session):
        """After advance-turn, state is immediately consistent."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up",
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
        })

        # Immediately check state
        r = client.get(f"/api/turn-status/{sid}")
        data = r.json()
        assert data["current_turn"] == 2
        assert data["is_multi_turn"] is True
        assert len(data["turns"]) == 1
        assert data["turns"][0]["status"] == "completed"
        assert len(data["conversation_history"]) == 2

    def test_mark_breaking_then_check_state(self, client, create_session):
        """After mark-breaking, state is immediately consistent."""
        sid = create_session
        inject_results_into_session(sid, [make_breaking_result(1)])
        client.post(f"/api/mark-breaking/{sid}")

        r = client.get(f"/api/turn-status/{sid}")
        data = r.json()
        assert len(data["turns"]) == 1
        assert data["turns"][0]["status"] == "breaking"

    def test_multi_turn_state_consistency(self, client, minimal_notebook):
        """Full 3-turn workflow maintains consistent state throughout."""
        nb_json = json.dumps(minimal_notebook)
        files = {"file": ("chain.ipynb", nb_json, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        sid = r.json()["session_id"]

        # Turn 1 → 2
        inject_results_into_session(sid, [make_passing_result(1, "T1 good")])
        client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Turn 2 prompt",
            "next_criteria": '[{"id":"C1","criteria":"Turn 2 crit"}]',
        })
        r = client.get(f"/api/turn-status/{sid}")
        assert r.json()["current_turn"] == 2
        assert len(r.json()["conversation_history"]) == 2

        # Turn 2 → 3
        inject_results_into_session(sid, [make_passing_result(2, "T2 good")])
        client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 2,
            "next_prompt": "Turn 3 prompt",
            "next_criteria": '[{"id":"C1","criteria":"Turn 3 crit"}]',
        })
        r = client.get(f"/api/turn-status/{sid}")
        assert r.json()["current_turn"] == 3
        assert len(r.json()["conversation_history"]) == 4  # 2 turns * 2 messages
        assert len(r.json()["turns"]) == 2

        # Turn 3 breaking
        inject_results_into_session(sid, [make_breaking_result(3, "T3 breaks")])
        client.post(f"/api/mark-breaking/{sid}")
        r = client.get(f"/api/turn-status/{sid}")
        assert len(r.json()["turns"]) == 3
        assert r.json()["turns"][2]["status"] == "breaking"

    def test_selected_response_becomes_conversation_history(self, client, create_session):
        """After advance-turn, the selected response appears in conversation history."""
        sid = create_session
        inject_results_into_session(sid, [
            make_passing_result(1, "SELECTED_GOOD_RESPONSE_TEXT"),
        ])
        client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up",
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
        })
        r = client.get(f"/api/turn-status/{sid}")
        assert r.status_code == 200
        history = r.json()["conversation_history"]
        assert any("SELECTED_GOOD_RESPONSE_TEXT" in msg["content"]
                   for msg in history if msg["role"] == "assistant")

    def test_conversation_history_grows_correctly(self, client, create_session):
        """Each advance adds exactly 2 messages to conversation_history."""
        sid = create_session

        for i in range(1, 4):
            inject_results_into_session(sid, [make_passing_result(i, f"Response {i}")])
            client.post(f"/api/advance-turn/{sid}", json={
                "selected_hunt_id": i,
                "next_prompt": f"Turn {i+1} prompt",
                "next_criteria": f'[{{"id":"C1","criteria":"Turn {i+1} criteria"}}]',
            })
            r = client.get(f"/api/turn-status/{sid}")
            data = r.json()
            assert len(data["conversation_history"]) == i * 2
            assert data["current_turn"] == i + 1
