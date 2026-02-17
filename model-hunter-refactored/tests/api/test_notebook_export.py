"""
Test single-turn and multi-turn notebook export logic + save-snapshot API.
"""
import pytest
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from services.notebook_parser import NotebookParser
from models.schemas import ParsedNotebook
from tests.conftest import inject_results_into_session, make_passing_result, make_breaking_result


# ---------------------------------------------------------------------------
# Unit: NotebookParser export methods
# ---------------------------------------------------------------------------

@pytest.mark.api
class TestNotebookExport:

    def setup_method(self):
        self.parser = NotebookParser()

    def _make_original(self, cells):
        """Helper: create minimal notebook JSON string."""
        return json.dumps({
            "nbformat": 4, "nbformat_minor": 5, "metadata": {},
            "cells": cells,
        })

    def test_single_turn_export_produces_cells(self):
        """Standard single-turn export should produce output cells."""
        original = self._make_original([
            {"cell_type": "markdown", "id": "c1", "metadata": {},
             "source": ["**[prompt]**\n\nTest prompt"]},
            {"cell_type": "markdown", "id": "c2", "metadata": {},
             "source": ["**[response_reference]**\n\nTest criteria"]},
        ])
        parsed = ParsedNotebook(
            filename="test.ipynb",
            prompt="Test prompt",
            response_reference="Test criteria",
        )
        results = [
            {"hunt_id": 1, "model": "nvidia/nemotron-3-nano-30b-a3b",
             "response": "Response 1", "reasoning_trace": "Reasoning 1",
             "judge_score": 0, "judge_criteria": {"C1": "FAIL"},
             "judge_explanation": "Failed", "judge_output": "", "is_breaking": True},
        ]

        exported = self.parser.export_notebook(original, parsed, results)
        notebook = json.loads(exported)
        assert len(notebook["cells"]) > 2

    def test_multi_turn_export_single_turn_fallback(self):
        """Multi-turn export with 1 turn should still produce valid output."""
        original = self._make_original([
            {"cell_type": "markdown", "id": "c1", "metadata": {},
             "source": ["**[prompt]**\n\nTest"]},
        ])
        parsed = ParsedNotebook(filename="test.ipynb", prompt="Test")

        turns = [
            {"turn_number": 1, "prompt": "Test", "response_reference": "Crit",
             "status": "breaking"},
        ]
        results = [
            {"hunt_id": 1, "model": "nvidia/nemotron-3-nano-30b-a3b",
             "response": "R1", "reasoning_trace": "", "judge_score": 0,
             "judge_criteria": {}, "judge_explanation": "", "judge_output": "",
             "is_breaking": True},
        ]

        exported = self.parser.export_multi_turn_notebook(
            original, parsed, turns, results, total_hunts_ran=1,
        )
        notebook = json.loads(exported)
        assert len(notebook["cells"]) > 0

    def test_multi_turn_export_creates_turn_cells(self):
        """Multi-turn export with 3 turns creates prompt_2, prompt_3, etc."""
        original = self._make_original([
            {"cell_type": "markdown", "id": "c1", "metadata": {},
             "source": ["**[prompt]**\n\nTurn 1 prompt"]},
            {"cell_type": "markdown", "id": "c2", "metadata": {},
             "source": ["**[response_reference]**\n\nTurn 1 criteria"]},
        ])
        parsed = ParsedNotebook(
            filename="test.ipynb",
            prompt="Turn 3 prompt",
            response_reference="Turn 3 criteria",
        )

        turns = [
            {"turn_number": 1, "prompt": "Turn 1 prompt",
             "response_reference": "Turn 1 criteria",
             "selected_response": "Good response 1",
             "judge_result": {"score": 1}, "status": "completed"},
            {"turn_number": 2, "prompt": "Turn 2 prompt",
             "response_reference": "Turn 2 criteria",
             "selected_response": "Good response 2",
             "judge_result": {"score": 1}, "status": "completed"},
            {"turn_number": 3, "prompt": "Turn 3 prompt",
             "response_reference": "Turn 3 criteria",
             "status": "breaking"},
        ]
        results = [
            {"hunt_id": 10, "model": "nvidia/nemotron-3-nano-30b-a3b",
             "response": "Breaking response", "reasoning_trace": "",
             "judge_score": 0, "judge_criteria": {"C1": "FAIL"},
             "judge_explanation": "Failed", "judge_output": "",
             "is_breaking": True},
        ]

        exported = self.parser.export_multi_turn_notebook(
            original, parsed, turns, results, total_hunts_ran=12,
            conversation_history=[
                {"role": "user", "content": "Turn 1 prompt"},
                {"role": "assistant", "content": "Good response 1"},
                {"role": "user", "content": "Turn 2 prompt"},
                {"role": "assistant", "content": "Good response 2"},
            ],
        )
        notebook = json.loads(exported)
        all_sources = " ".join(
            "".join(c.get("source", [])) for c in notebook["cells"]
        )

        # Verify multi-turn cells exist (new format: Turn N - prompt, etc.)
        assert "**[Turn 2 - prompt]**" in all_sources
        assert "**[Turn 3 - prompt]**" in all_sources
        assert "**[Turn 1 - selected_response]**" in all_sources
        assert "**[Turn 2 - selected_response]**" in all_sources
        assert "**[number_of_attempts_made]**" in all_sources

    def test_multi_turn_export_turn1_no_suffix(self):
        """Turn 1 should use original field names (no _1 suffix) for compat."""
        original = self._make_original([
            {"cell_type": "markdown", "id": "c1", "metadata": {},
             "source": ["**[prompt]**\n\nTurn 1"]},
        ])
        parsed = ParsedNotebook(
            filename="test.ipynb",
            prompt="Turn 2 prompt",
            response_reference="Turn 2 criteria",
        )
        turns = [
            {"turn_number": 1, "prompt": "Turn 1", "response_reference": "Crit 1",
             "selected_response": "Good", "judge_result": {"score": 1},
             "status": "completed"},
            {"turn_number": 2, "prompt": "Turn 2 prompt",
             "response_reference": "Turn 2 criteria", "status": "breaking"},
        ]
        results = [
            {"hunt_id": 1, "model": "nvidia/nemotron-3-nano-30b-a3b",
             "response": "Breaking", "reasoning_trace": "", "judge_score": 0,
             "judge_criteria": {"C1": "FAIL"}, "judge_explanation": "F",
             "judge_output": "", "is_breaking": True},
        ]
        exported = self.parser.export_multi_turn_notebook(
            original, parsed, turns, results, total_hunts_ran=4,
        )
        notebook = json.loads(exported)
        all_sources = " ".join(
            "".join(c.get("source", [])) for c in notebook["cells"]
        )
        # All turns use Turn N - format (Turn 1 - prompt, Turn 2 - prompt)
        assert "**[Turn 1 - prompt]**" in all_sources
        assert "**[Turn 2 - prompt]**" in all_sources

    def test_export_preserves_number_of_attempts(self):
        """total_hunts_ran should be written to number_of_attempts_made cell."""
        original = self._make_original([
            {"cell_type": "markdown", "id": "c1", "metadata": {},
             "source": ["**[prompt]**\n\nP"]},
            {"cell_type": "markdown", "id": "c5", "metadata": {},
             "source": ["**[number_of_attempts_made]**:\n\n0"]},
        ])
        parsed = ParsedNotebook(filename="test.ipynb", prompt="P")
        turns = [
            {"turn_number": 1, "prompt": "P", "response_reference": "C",
             "status": "breaking"},
        ]
        results = [
            {"hunt_id": 1, "model": "m", "response": "R", "reasoning_trace": "",
             "judge_score": 0, "judge_criteria": {}, "judge_explanation": "",
             "judge_output": "", "is_breaking": True},
        ]
        exported = self.parser.export_multi_turn_notebook(
            original, parsed, turns, results, total_hunts_ran=15,
        )
        notebook = json.loads(exported)
        all_sources = " ".join(
            "".join(c.get("source", [])) for c in notebook["cells"]
        )
        assert "15" in all_sources


# ---------------------------------------------------------------------------
# API: save-snapshot endpoint with multi-turn data
# ---------------------------------------------------------------------------

@pytest.mark.api
class TestSaveSnapshotAPI:
    """Test /api/save-snapshot for multi-turn sessions."""

    def test_save_snapshot_single_turn_does_not_500(self, client, create_session):
        """save-snapshot with single-turn session should not return 500."""
        r = client.post("/api/save-snapshot", json={
            "session_id": create_session,
            "selected_indices": [0],
            "human_reviews": [{"score": 0, "explanation": "Breaking"}],
        })
        # May fail with 400 if no results — that's OK, just not 500
        assert r.status_code != 500

    def test_save_snapshot_multi_turn_after_workflow(self, client, minimal_notebook):
        """save-snapshot after a multi-turn workflow should not error."""
        # Create session
        nb_json = json.dumps(minimal_notebook)
        files = {"file": ("snap.ipynb", nb_json, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        session_id = r.json()["session_id"]

        # Inject + advance to make it multi-turn
        injected = inject_results_into_session(session_id, [
            make_passing_result(hunt_id=1, response="Good"),
        ])
        if not injected:
            pytest.skip("Could not inject results")

        client.post(f"/api/advance-turn/{session_id}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up",
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
        })

        # Inject breaking for turn 2
        inject_results_into_session(session_id, [
            make_breaking_result(hunt_id=2, response="Breaking!"),
        ])
        client.post(f"/api/mark-breaking/{session_id}")

        # Attempt save-snapshot
        r = client.post("/api/save-snapshot", json={
            "session_id": session_id,
            "selected_indices": [0],
            "human_reviews": [{"score": 0, "explanation": "Breaking"}],
        })
        # Should not be a 500 server error
        assert r.status_code != 500
