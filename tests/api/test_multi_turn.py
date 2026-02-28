"""
Test multi-turn workflow: advance-turn, mark-breaking, turn-status + integration chain.

Covers both individual endpoint tests and the full multi-turn workflow chain.
"""
import pytest
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from tests.conftest import inject_results_into_session, make_passing_result, make_breaking_result


@pytest.mark.api
class TestMultiTurnEndpoints:
    """Test individual multi-turn API endpoints."""

    def test_turn_status_initial(self, client, create_session):
        """Fresh session should be at turn 1 with no history."""
        r = client.get(f"/api/turn-status/{create_session}")
        assert r.status_code == 200
        data = r.json()
        assert data["current_turn"] == 1
        assert data["is_multi_turn"] == False
        assert len(data["conversation_history"]) == 0
        assert len(data["turns"]) == 0

    def test_turn_status_not_found(self, client):
        """Turn status for nonexistent session should 404."""
        r = client.get("/api/turn-status/fake-session-id-999")
        assert r.status_code == 404

    def test_advance_turn_no_results(self, client, create_session):
        """Advance-turn should fail if no hunt results exist to select from."""
        r = client.post(f"/api/advance-turn/{create_session}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up question",
            "next_criteria": '[{"id": "C1", "criteria": "test"}]',
        })
        assert r.status_code == 400

    def test_advance_turn_missing_prompt(self, client, create_session):
        """next_prompt is optional (selectGoodResponse flow); missing yields 400 from hunt not found."""
        r = client.post(f"/api/advance-turn/{create_session}", json={
            "selected_hunt_id": 1,
            "next_criteria": "test",
            # missing next_prompt — now optional
        })
        # 400 = hunt not found (no results in session), not 422
        assert r.status_code == 400

    def test_advance_turn_missing_criteria(self, client, create_session):
        """next_criteria is optional (selectGoodResponse flow); missing yields 400 from hunt not found."""
        r = client.post(f"/api/advance-turn/{create_session}", json={
            "selected_hunt_id": 1,
            "next_prompt": "test",
            # missing next_criteria — now optional
        })
        # 400 = hunt not found (no results in session), not 422
        assert r.status_code == 400

    def test_advance_turn_invalid_session(self, client):
        """Advance-turn on nonexistent session should 404."""
        r = client.post("/api/advance-turn/nonexistent-999", json={
            "selected_hunt_id": 1,
            "next_prompt": "test",
            "next_criteria": "test",
        })
        assert r.status_code == 404

    def test_mark_breaking(self, client, create_session):
        """Mark-breaking on turn 1 should succeed."""
        r = client.post(f"/api/mark-breaking/{create_session}")
        assert r.status_code == 200
        data = r.json()
        assert data["breaking_turn"] == 1
        assert data["total_turns"] == 1
        assert data["is_multi_turn"] == False  # Single turn = not multi-turn

    def test_mark_breaking_not_found(self, client):
        """Mark-breaking on nonexistent session should 404."""
        r = client.post("/api/mark-breaking/fake-session-999")
        assert r.status_code == 404

    def test_turn_status_after_mark_breaking(self, client, create_session):
        """After mark-breaking, turn status should reflect the breaking turn."""
        client.post(f"/api/mark-breaking/{create_session}")
        r = client.get(f"/api/turn-status/{create_session}")
        assert r.status_code == 200
        data = r.json()
        assert len(data["turns"]) >= 1
        # Find the turn that is breaking
        breaking_turns = [t for t in data["turns"] if t.get("status") == "breaking"]
        assert len(breaking_turns) >= 1

    def test_turn_status_response_schema(self, client, create_session):
        """Turn-status response should have all expected fields."""
        r = client.get(f"/api/turn-status/{create_session}")
        assert r.status_code == 200
        data = r.json()
        expected_fields = [
            "session_id", "current_turn", "is_multi_turn",
            "conversation_history", "turns", "status",
        ]
        for field in expected_fields:
            assert field in data, f"Missing field: {field}"

    def test_advance_turn_with_injected_results(self, client, minimal_notebook):
        """Advance-turn should succeed when session has passing results."""
        # Create session
        nb_json = json.dumps(minimal_notebook)
        files = {"file": ("adv.ipynb", nb_json, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        assert r.status_code == 200
        session_id = r.json()["session_id"]

        # Inject passing result
        injected = inject_results_into_session(session_id, [
            make_passing_result(hunt_id=1, response="Good answer"),
        ])
        if not injected:
            pytest.skip("Could not inject results — storage file not found")

        # Advance turn
        r = client.post(f"/api/advance-turn/{session_id}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up question",
            "next_criteria": '[{"id":"C1","criteria":"follow up criteria"}]',
        })
        assert r.status_code == 200
        data = r.json()
        assert data["current_turn"] == 2


# ---------------------------------------------------------------------------
# Integration: Full Multi-Turn Workflow Chain
# ---------------------------------------------------------------------------

@pytest.mark.api
@pytest.mark.integration
class TestMultiTurnWorkflowChain:
    """Full multi-turn chain — the most important test in the suite.

    Simulates: upload → inject results → advance-turn → verify state →
               inject results again → mark-breaking → verify final state.
    """

    def test_full_3_turn_workflow(self, client, minimal_notebook):
        """Complete 3-turn workflow: 2 passing turns + 1 breaking turn."""

        # === TURN 1: Upload notebook ===
        nb_json = json.dumps(minimal_notebook)
        files = {"file": ("chain.ipynb", nb_json, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        assert r.status_code == 200
        session_id = r.json()["session_id"]

        # Verify initial state
        r = client.get(f"/api/turn-status/{session_id}")
        assert r.status_code == 200
        assert r.json()["current_turn"] == 1
        assert r.json()["is_multi_turn"] == False

        # Inject passing results for turn 1
        injected = inject_results_into_session(session_id, [
            make_passing_result(hunt_id=1, response="Turn 1 good response"),
            make_breaking_result(hunt_id=2, response="Turn 1 bad response"),
        ])
        if not injected:
            pytest.skip("Could not inject results — storage not found")

        # === TURN 1 → 2: Advance with selected passing response ===
        r = client.post(f"/api/advance-turn/{session_id}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Now explain your reasoning",
            "next_criteria": '[{"id":"C1","criteria":"Provides clear explanation"}]',
        })
        assert r.status_code == 200
        data = r.json()
        assert data["current_turn"] == 2

        # Verify conversation history has turn 1
        r = client.get(f"/api/turn-status/{session_id}")
        data = r.json()
        assert data["current_turn"] == 2
        assert data["is_multi_turn"] == True
        assert len(data["conversation_history"]) == 2  # user + assistant
        assert data["conversation_history"][0]["role"] == "user"
        assert data["conversation_history"][1]["role"] == "assistant"
        assert data["conversation_history"][1]["content"] == "Turn 1 good response"
        assert len(data["turns"]) >= 1

        # === TURN 2: Inject results, advance to turn 3 ===
        injected = inject_results_into_session(session_id, [
            make_passing_result(hunt_id=3, response="Turn 2 good response"),
        ])
        if not injected:
            pytest.skip("Could not inject results for turn 2")

        r = client.post(f"/api/advance-turn/{session_id}", json={
            "selected_hunt_id": 3,
            "next_prompt": "Can you provide an example?",
            "next_criteria": '[{"id":"C1","criteria":"Provides concrete example"}]',
        })
        assert r.status_code == 200
        data = r.json()
        assert data["current_turn"] == 3

        # Verify conversation history now has turns 1+2
        r = client.get(f"/api/turn-status/{session_id}")
        data = r.json()
        assert len(data["conversation_history"]) == 4  # 2 turns × (user + assistant)
        assert len(data["turns"]) >= 2

        # === TURN 3: Mark as breaking ===
        inject_results_into_session(session_id, [
            make_breaking_result(hunt_id=5, response="Breaking response!"),
        ])

        r = client.post(f"/api/mark-breaking/{session_id}")
        assert r.status_code == 200
        data = r.json()
        assert data["breaking_turn"] == 3
        assert data["total_turns"] == 3
        assert data["is_multi_turn"] == True

        # Verify final state
        r = client.get(f"/api/turn-status/{session_id}")
        data = r.json()
        assert len(data["turns"]) == 3

    def test_single_turn_breaking_no_multi_turn_flag(self, client, minimal_notebook):
        """If user marks breaking on turn 1, is_multi_turn stays False."""
        nb_json = json.dumps(minimal_notebook)
        files = {"file": ("single.ipynb", nb_json, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        session_id = r.json()["session_id"]

        r = client.post(f"/api/mark-breaking/{session_id}")
        assert r.status_code == 200
        assert r.json()["is_multi_turn"] == False
        assert r.json()["breaking_turn"] == 1

    def test_two_turn_workflow(self, client, minimal_notebook):
        """Minimal multi-turn: 1 passing turn + 1 breaking turn."""
        nb_json = json.dumps(minimal_notebook)
        files = {"file": ("two.ipynb", nb_json, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        session_id = r.json()["session_id"]

        # Inject + advance
        injected = inject_results_into_session(session_id, [
            make_passing_result(hunt_id=1),
        ])
        if not injected:
            pytest.skip("Could not inject results")

        r = client.post(f"/api/advance-turn/{session_id}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Turn 2 prompt",
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
        })
        assert r.status_code == 200
        assert r.json()["current_turn"] == 2

        # Mark breaking
        inject_results_into_session(session_id, [make_breaking_result(hunt_id=2)])
        r = client.post(f"/api/mark-breaking/{session_id}")
        assert r.status_code == 200
        assert r.json()["breaking_turn"] == 2
        assert r.json()["is_multi_turn"] == True
