"""
Tests for state machine edge cases.

Covers: invalid state transitions, boundary values, out-of-order operations,
and unexpected navigation through the multi-turn workflow.
"""
import pytest
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from tests.conftest import (
    make_passing_result,
    make_breaking_result,
    inject_results_into_session,
)


@pytest.mark.api
class TestInvalidStateTransitions:
    """Operations that shouldn't be allowed in certain states."""

    def test_advance_turn_with_no_hunts(self, client, create_session):
        """Cannot advance turn when no hunts have been run."""
        sid = create_session
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "test",
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
        })
        assert r.status_code == 400

    def test_advance_turn_with_nonexistent_hunt_id(self, client, create_session):
        """advance-turn with a hunt_id that doesn't exist in results."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 999,
            "next_prompt": "test",
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
        })
        assert r.status_code == 400

    def test_advance_turn_with_negative_hunt_id(self, client, create_session):
        """advance-turn with a negative hunt_id."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": -1,
            "next_prompt": "test",
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
        })
        assert r.status_code in [400, 422]

    def test_advance_turn_with_zero_hunt_id(self, client, create_session):
        """advance-turn with hunt_id = 0."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 0,
            "next_prompt": "test",
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
        })
        assert r.status_code in [400, 422]

    def test_advance_turn_with_breaking_result(self, client, create_session):
        """advance-turn selecting a breaking (failing) result — should still work."""
        sid = create_session
        inject_results_into_session(sid, [make_breaking_result(1)])
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up",
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
        })
        # The app allows selecting any result (even breaking)
        assert r.status_code in [200, 400]


@pytest.mark.api
class TestBoundaryValues:
    """Test with extreme/boundary parameter values."""

    def test_very_long_prompt(self, client, create_session):
        """advance-turn with a 10,000-word prompt."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        long_prompt = " ".join(["word"] * 10_000)
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": long_prompt,
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
        })
        assert r.status_code == 200
        assert r.json()["prompt"] == long_prompt

    def test_very_long_criteria(self, client, create_session):
        """advance-turn with 20 criteria items."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        criteria = json.dumps([
            {"id": f"C{i}", "criteria": f"Criteria item {i} with detailed requirements"}
            for i in range(1, 21)
        ])
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up",
            "next_criteria": criteria,
        })
        assert r.status_code == 200

    def test_special_characters_in_prompt(self, client, create_session):
        """Prompt with special chars: quotes, backslashes, newlines, tabs."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        special_prompt = 'He said "hello\\nworld"\ttab\nNew line\r\nCRLF<br/>HTML'
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": special_prompt,
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
        })
        assert r.status_code == 200

    def test_html_in_prompt(self, client, create_session):
        """Prompt containing HTML tags — should be stored as-is, not executed."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        html_prompt = '<script>alert("xss")</script><img src=x onerror=alert(1)>'
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": html_prompt,
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
        })
        assert r.status_code == 200
        # Verify stored correctly via turn-status
        r2 = client.get(f"/api/turn-status/{sid}")
        assert html_prompt in r2.json()["current_prompt"]

    def test_emoji_in_all_fields(self, client, create_session):
        """Emoji in prompt and criteria fields."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Explain quantum mechanics 🔬🧪⚛️",
            "next_criteria": '[{"id":"C1","criteria":"Uses emoji effectively 🎯"}]',
        })
        assert r.status_code == 200

    def test_many_results_in_session(self, client, create_session):
        """Session with 100 hunt results — operations still work."""
        sid = create_session
        results = [make_passing_result(i, f"Response {i}") for i in range(1, 101)]
        inject_results_into_session(sid, results)
        r = client.get(f"/api/results/{sid}")
        assert r.status_code == 200
        assert len(r.json()["results"]) == 100


@pytest.mark.api
class TestMultiTurnStateMachine:
    """Multi-turn workflow state transitions."""

    def test_mark_breaking_on_turn_1_not_multi_turn(self, client, create_session):
        """Breaking on turn 1 means is_multi_turn should be False."""
        sid = create_session
        r = client.post(f"/api/mark-breaking/{sid}")
        assert r.status_code == 200
        assert r.json()["is_multi_turn"] is False

    def test_mark_breaking_on_turn_2_is_multi_turn(self, client, create_session):
        """Breaking on turn 2 means is_multi_turn should be True."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Turn 2",
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
        })
        inject_results_into_session(sid, [make_breaking_result(2)])
        r = client.post(f"/api/mark-breaking/{sid}")
        assert r.status_code == 200
        assert r.json()["is_multi_turn"] is True

    def test_advance_5_turns(self, client, minimal_notebook):
        """Push through 5 turns — state machine handles deep nesting."""
        nb_json = json.dumps(minimal_notebook)
        files = {"file": ("deep.ipynb", nb_json, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        sid = r.json()["session_id"]

        for turn in range(1, 6):
            inject_results_into_session(sid, [make_passing_result(turn, f"T{turn} resp")])
            r = client.post(f"/api/advance-turn/{sid}", json={
                "selected_hunt_id": turn,
                "next_prompt": f"Turn {turn+1} prompt",
                "next_criteria": f'[{{"id":"C1","criteria":"Turn {turn+1} criteria"}}]',
            })
            assert r.status_code == 200
            assert r.json()["current_turn"] == turn + 1

        # After 5 advances, we're on turn 6
        r = client.get(f"/api/turn-status/{sid}")
        data = r.json()
        assert data["current_turn"] == 6
        assert len(data["turns"]) == 5
        assert len(data["conversation_history"]) == 10  # 5 * 2

    def test_results_reset_after_advance(self, client, create_session):
        """After advance-turn, current results should be empty."""
        sid = create_session
        inject_results_into_session(sid, [
            make_passing_result(1),
            make_breaking_result(2),
        ])
        client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up",
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
        })
        r = client.get(f"/api/results/{sid}")
        assert r.status_code == 200
        # Results should be empty after advancing
        assert len(r.json()["results"]) == 0

    def test_notebook_prompt_updates_after_advance(self, client, create_session):
        """After advance-turn, notebook prompt should be the new turn's prompt."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "UNIQUE_NEW_PROMPT",
            "next_criteria": '[{"id":"C1","criteria":"new criteria"}]',
        })
        r = client.get(f"/api/turn-status/{sid}")
        assert r.json()["current_prompt"] == "UNIQUE_NEW_PROMPT"

    def test_notebook_response_updates_after_advance(self, client, create_session):
        """After advance-turn, the advance response should contain the new prompt."""
        sid = create_session
        inject_results_into_session(sid, [
            make_passing_result(1, "SELECTED_RESPONSE_HERE"),
        ])
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up",
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
        })
        assert r.status_code == 200
        # The advance response includes prompt and response_reference
        data = r.json()
        assert data["prompt"] == "Follow up"
        # Verify selected response was stored in conversation history
        r2 = client.get(f"/api/turn-status/{sid}")
        history = r2.json()["conversation_history"]
        assert any("SELECTED_RESPONSE_HERE" in msg["content"] for msg in history if msg["role"] == "assistant")

    def test_judge_prompt_preserved_when_not_provided(self, client, create_session):
        """If next_judge_prompt not provided, the previous one should persist."""
        sid = create_session
        # Get original judge prompt via turn-status
        r1 = client.get(f"/api/turn-status/{sid}")
        original_judge = r1.json()["current_judge_prompt"]

        inject_results_into_session(sid, [make_passing_result(1)])
        client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up",
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
            # NOT providing next_judge_prompt
        })
        r2 = client.get(f"/api/turn-status/{sid}")
        assert r2.json()["current_judge_prompt"] == original_judge

    def test_judge_prompt_updates_when_provided(self, client, create_session):
        """If next_judge_prompt is provided, it should update."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up",
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
            "next_judge_prompt": "NEW_JUDGE_PROMPT",
        })
        r = client.get(f"/api/turn-status/{sid}")
        assert r.json()["current_judge_prompt"] == "NEW_JUDGE_PROMPT"
