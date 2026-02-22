"""
Tests for rule engine and rules.
"""
import pytest
from pathlib import Path
from unittest.mock import patch

from agentic_reviewer.snapshot_builder import build_snapshot
from agentic_reviewer.rule_engine import run_review
from agentic_reviewer.schemas import ReviewResult, TaskSnapshot


def test_run_review_preflight_passes(mock_session_preflight):
    """Preflight with diverse selection passes."""
    snapshot = build_snapshot(
        mock_session_preflight,
        "preflight",
        selected_hunt_ids=[1, 2, 3, 4],
    )
    result = run_review(snapshot)
    assert isinstance(result, ReviewResult)
    assert result.passed is True
    assert len(result.issues) == 0


def test_run_review_model_consistency_fails():
    """Mixed models fails model_consistency."""
    session = {
        "session_id": "x",
        "notebook": {"prompt": "p", "response_reference": "C1: x"},
        "all_results": [
            {"hunt_id": 1, "model": "model-a", "response": "r1"},
            {"hunt_id": 2, "model": "model-b", "response": "r2"},
            {"hunt_id": 3, "model": "model-a", "response": "r3"},
            {"hunt_id": 4, "model": "model-b", "response": "r4"},
        ],
        "human_reviews": {},
    }
    snapshot = build_snapshot(session, "preflight", selected_hunt_ids=[1, 2, 3, 4])
    result = run_review(snapshot)
    assert result.passed is False
    assert any(i.rule_id == "model_consistency" for i in result.issues)


@patch("agentic_reviewer.council.call_model_sync")
def test_run_review_final_passes(mock_call, mock_session_final):
    """Final with valid data passes (human and LLM grades aligned)."""
    mock_call.return_value = ("PASS", None)
    snapshot = build_snapshot(mock_session_final, "final")
    result = run_review(snapshot)
    assert result.passed is True
    assert len(result.issues) == 0


def test_run_review_with_custom_config(tmp_path):
    """Custom config path is used."""
    config = tmp_path / "rules.yaml"
    config.write_text("""
rules:
  - id: model_consistency
    enabled: true
    type: deterministic
    checkpoints: [preflight]
    params: {}
""")
    session = {
        "session_id": "x",
        "notebook": {"prompt": "p", "response_reference": "C1: x"},
        "all_results": [
            {"hunt_id": i, "model": "same-model", "response": "r"}
            for i in range(1, 5)
        ],
        "human_reviews": {},
    }
    snapshot = build_snapshot(session, "preflight", selected_hunt_ids=[1, 2, 3, 4])
    result = run_review(snapshot, config_path=config)
    assert result.passed is True


@patch("agentic_reviewer.council.call_model_sync")
def test_metadata_prompt_alignment_fails_when_council_fails(mock_call):
    """metadata_prompt_alignment returns issue when council votes FAIL."""
    mock_call.return_value = ("FAIL", None)
    config_path = Path(__file__).parent.parent / "config" / "agentic_rules.yaml"
    session = {
        "session_id": "x",
        "notebook": {
            "prompt": "Write a healthcare patient care prompt.",
            "response_reference": "C1: x",
            "metadata": {"Domain": "Healthcare", "Use Case": "Patient Care"},
        },
        "all_results": [{"hunt_id": i, "model": "m", "response": "r"} for i in range(1, 5)],
        "human_reviews": {str(i): {"grades": {"C1": "pass"}, "explanation": "ok", "submitted": True} for i in range(1, 5)},
    }
    snapshot = build_snapshot(session, "final")
    result = run_review(snapshot, config_path=config_path)
    assert result.passed is False
    assert any(i.rule_id == "metadata_prompt_alignment" for i in result.issues)


@patch("agentic_reviewer.council.call_model_sync")
def test_metadata_taxonomy_alignment_fails_when_council_fails(mock_call):
    """metadata_taxonomy_alignment returns issue when council votes FAIL."""
    mock_call.return_value = ("FAIL", None)
    config_path = Path(__file__).parent.parent / "config" / "agentic_rules.yaml"
    session = {
        "session_id": "x",
        "notebook": {
            "prompt": "p",
            "response_reference": "C1: x",
            "metadata": {"Domain": "Healthcare", "Use Case": "Patient Care", "L1 Taxonomy": "QC"},
        },
        "all_results": [{"hunt_id": i, "model": "m", "response": "r"} for i in range(1, 5)],
        "human_reviews": {str(i): {"grades": {"C1": "pass"}, "explanation": "ok", "submitted": True} for i in range(1, 5)},
    }
    snapshot = build_snapshot(session, "final")
    result = run_review(snapshot, config_path=config_path)
    assert result.passed is False
    assert any(i.rule_id == "metadata_taxonomy_alignment" for i in result.issues)


def _final_session(**notebook_overrides):
    """Base final session with 4 human reviews."""
    nb = {
        "prompt": "p",
        "response_reference": "C1: x",
        **notebook_overrides,
    }
    return {
        "session_id": "x",
        "notebook": nb,
        "all_results": [{"hunt_id": i, "model": "m", "response": "r"} for i in range(1, 5)],
        "human_reviews": {str(i): {"grades": {"C1": "pass"}, "explanation": "ok", "submitted": True} for i in range(1, 5)},
    }


@patch("agentic_reviewer.council.call_model_sync")
def test_human_explanation_justifies_grade_fails_when_council_fails(mock_call):
    """human_explanation_justifies_grade returns issue when council votes FAIL."""
    mock_call.return_value = ("FAIL", None)
    config_path = Path(__file__).parent.parent / "config" / "agentic_rules.yaml"
    session = _final_session()
    snapshot = build_snapshot(session, "final")
    result = run_review(snapshot, config_path=config_path)
    assert result.passed is False
    assert any(i.rule_id == "human_explanation_justifies_grade" for i in result.issues)


@patch("agentic_reviewer.council.call_model_sync")
def test_safety_context_aware_fails_when_council_fails(mock_call):
    """safety_context_aware returns issue when council votes FAIL."""
    mock_call.return_value = ("FAIL", None)
    config_path = Path(__file__).parent.parent / "config" / "agentic_rules.yaml"
    session = _final_session()
    snapshot = build_snapshot(session, "final")
    result = run_review(snapshot, config_path=config_path)
    assert result.passed is False
    assert any(i.rule_id == "safety_context_aware" for i in result.issues)


@patch("agentic_reviewer.council.call_model_sync")
def test_qc_cfa_criteria_valid_fails_when_council_fails(mock_call):
    """qc_cfa_criteria_valid returns issue when council votes FAIL."""
    mock_call.return_value = ("FAIL", None)
    config_path = Path(__file__).parent.parent / "config" / "agentic_rules.yaml"
    session = _final_session(metadata={"L1 Taxonomy": "QC"}, response_reference="C1: Must correct the question")
    snapshot = build_snapshot(session, "final")
    result = run_review(snapshot, config_path=config_path)
    assert result.passed is False
    assert any(i.rule_id == "qc_cfa_criteria_valid" for i in result.issues)
