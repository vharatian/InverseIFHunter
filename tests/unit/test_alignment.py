"""Regression tests for criterion alignment (mirror JS gate logic)."""
import pytest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from services.alignment import compute_alignment, build_slots_from_reviews_and_results


def test_perfect_agreement_four_slots():
    slots = [
        {"human_basis": {"C1": "PASS", "C2": "FAIL"}, "llm_criteria": {"C1": "PASS", "C2": "FAIL"}},
        {"human_basis": {"C1": "PASS"}, "llm_criteria": {"C1": "pass"}},
        {"human_basis": {"C1": "FAIL", "C2": "PASS"}, "llm_criteria": {"C1": "FAIL", "C2": "PASS"}},
        {"human_basis": {"C1": "PASS"}, "llm_criteria": {"C1": "PASS"}},
    ]
    r = compute_alignment(slots)
    assert r["total_criteria_compared"] == 6
    assert r["total_agreed"] == 6
    assert r["overall_rate"] == 1.0
    assert r["worst_slot_index"] == 1


def test_partial_disagreement_worst_slot():
    slots = [
        {"human_basis": {"C1": "PASS"}, "llm_criteria": {"C1": "FAIL"}},
        {"human_basis": {"C1": "PASS", "C2": "PASS"}, "llm_criteria": {"C1": "PASS", "C2": "PASS"}},
    ]
    r = compute_alignment(slots)
    assert r["total_criteria_compared"] == 3
    assert r["total_agreed"] == 2
    assert abs(r["overall_rate"] - 2 / 3) < 1e-9
    assert r["worst_slot_index"] == 1


def test_missing_and_unknown_excluded():
    slots = [
        {
            "human_basis": {"C1": "PASS", "C2": "MISSING"},
            "llm_criteria": {"C1": "PASS", "C2": "FAIL"},
        },
    ]
    r = compute_alignment(slots)
    assert r["total_criteria_compared"] == 1
    assert r["total_agreed"] == 1


def test_tie_worst_slot_lowest_index():
    slots = [
        {"human_basis": {"C1": "PASS"}, "llm_criteria": {"C1": "FAIL"}},
        {"human_basis": {"C1": "PASS"}, "llm_criteria": {"C1": "FAIL"}},
    ]
    r = compute_alignment(slots)
    assert r["worst_slot_index"] == 1


def test_build_slots_from_reviews():
    results = [
        {"hunt_id": 1, "judge_criteria": {"C1": "PASS"}},
        {"hunt_id": 2, "judge_criteria": {"C1": "FAIL"}},
    ]
    human_reviews = {
        "row_0": {"slotNum": 1, "grading_basis": {"C1": "PASS"}},
        "row_1": {"slotNum": 2, "grading_basis": {"C1": "PASS"}},
    }
    slots = build_slots_from_reviews_and_results(results, human_reviews)
    r = compute_alignment(slots)
    assert r["total_criteria_compared"] == 2
    assert r["total_agreed"] == 1
    assert r["worst_slot_index"] == 2
