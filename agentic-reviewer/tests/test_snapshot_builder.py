"""
Tests for snapshot_builder.
"""
import pytest

from agentic_reviewer.snapshot_builder import build_snapshot
from agentic_reviewer.schemas import TaskSnapshot, SelectedHunt, HumanReview


def test_build_snapshot_preflight(mock_session_preflight):
    """Preflight snapshot has selected_hunts, no human_reviews."""
    snapshot = build_snapshot(
        mock_session_preflight,
        "preflight",
        selected_hunt_ids=[1, 2, 3, 4],
    )
    assert isinstance(snapshot, TaskSnapshot)
    assert snapshot.checkpoint == "preflight"
    assert snapshot.session_id == "abc12345"
    assert "haiku" in snapshot.prompt.lower()
    assert len(snapshot.criteria) >= 1
    assert len(snapshot.selected_hunts) == 4
    assert len(snapshot.human_reviews) == 0
    assert snapshot.metadata.get("turn") == 1


def test_build_snapshot_preflight_extracts_criteria_json(mock_session_preflight):
    """Criteria extracted from JSON array in reference."""
    snapshot = build_snapshot(
        mock_session_preflight,
        "preflight",
        selected_hunt_ids=[1, 2, 3, 4],
    )
    assert len(snapshot.criteria) == 2
    ids = [c["id"] for c in snapshot.criteria]
    assert "C1" in ids
    assert "C2" in ids


def test_build_snapshot_preflight_selected_hunts(mock_session_preflight):
    """Selected hunts have correct structure."""
    snapshot = build_snapshot(
        mock_session_preflight,
        "preflight",
        selected_hunt_ids=[1, 2, 3, 4],
    )
    for sh in snapshot.selected_hunts:
        assert isinstance(sh, SelectedHunt)
        assert sh.hunt_id in (1, 2, 3, 4)
        assert sh.model
        assert isinstance(sh.response, str)


def test_build_snapshot_preflight_missing_selected_ids_raises(mock_session_preflight):
    """Preflight without selected_hunt_ids raises."""
    with pytest.raises(ValueError, match="selected_hunt_ids"):
        build_snapshot(mock_session_preflight, "preflight")


def test_build_snapshot_preflight_wrong_count_raises(mock_session_preflight):
    """Preflight with != 4 selected raises."""
    with pytest.raises(ValueError, match="selected_hunt_ids"):
        build_snapshot(mock_session_preflight, "preflight", selected_hunt_ids=[1, 2, 3])


def test_build_snapshot_final(mock_session_final):
    """Final snapshot has human_reviews."""
    snapshot = build_snapshot(mock_session_final, "final")
    assert snapshot.checkpoint == "final"
    assert len(snapshot.human_reviews) == 4
    assert len(snapshot.selected_hunts) == 4
    for hr in snapshot.human_reviews:
        assert isinstance(hr, HumanReview)
        assert hr.hunt_id in (1, 2, 3, 4)
        assert hr.grades
        assert hr.submitted


def test_build_snapshot_final_criteria_plain_text(mock_session_final):
    """Criteria extracted from plain C1: desc format."""
    snapshot = build_snapshot(mock_session_final, "final")
    assert len(snapshot.criteria) == 2
    assert any(c["id"] == "C1" for c in snapshot.criteria)
    assert any(c["id"] == "C2" for c in snapshot.criteria)


def test_build_snapshot_final_incomplete_reviews_raises():
    """Final with != 4 human reviews raises."""
    session = {
        "session_id": "x",
        "notebook": {"prompt": "p", "response_reference": "C1: x"},
        "all_results": [{"hunt_id": i, "model": "m", "response": "r"} for i in range(1, 5)],
        "human_reviews": {"1": {}, "2": {}},  # Only 2
    }
    with pytest.raises(ValueError, match="4 human reviews"):
        build_snapshot(session, "final")


def test_build_snapshot_extracts_task_metadata():
    """Task metadata (domain, use_case, l1_taxonomy) extracted from notebook.metadata."""
    session = {
        "session_id": "x",
        "notebook": {
            "prompt": "p",
            "response_reference": "C1: x",
            "metadata": {
                "Domain": "Healthcare",
                "Use Case": "Patient Care",
                "L1 Taxonomy": "QC",
                "Task ID": "T-001",
            },
        },
        "all_results": [{"hunt_id": i, "model": "m", "response": "r"} for i in range(1, 5)],
        "human_reviews": {str(i): {"grades": {"C1": "pass"}, "explanation": "ok", "submitted": True} for i in range(1, 5)},
    }
    snapshot = build_snapshot(session, "final")
    tm = snapshot.metadata.get("task_metadata") or {}
    assert tm.get("domain") == "Healthcare"
    assert tm.get("use_case") == "Patient Care"
    assert tm.get("l1_taxonomy") == "QC"
    assert tm.get("task_id") == "T-001"
