"""
Pytest fixtures for agentic reviewer tests.

Provides mock session dicts that mirror Model Hunter structure.
"""
import pytest


@pytest.fixture
def mock_session_preflight():
    """Session dict for preflight — has 4 selected, no human reviews."""
    return {
        "session_id": "abc12345",
        "current_turn": 1,
        "notebook": {
            "prompt": "Write a haiku about coding.",
            "response_reference": '[{"id":"C1","criteria1":"Must be 3 lines"},{"id":"C2","criteria2":"Must mention code"}]',
        },
        "config": {"models": ["qwen/qwen3-235b"]},
        "all_results": [
            {
                "hunt_id": 1,
                "model": "qwen/qwen3-235b",
                "response": "Code flows like rivers\nBugs hide in the shadows\nFix and ship again",
                "judge_score": 1,
                "judge_criteria": {"C1": "PASS", "C2": "PASS"},
                "judge_explanation": "Meets all criteria.",
                "is_breaking": False,
            },
            {
                "hunt_id": 2,
                "model": "qwen/qwen3-235b",
                "response": "Broken output here",
                "judge_score": 0,
                "judge_criteria": {"C1": "FAIL", "C2": "FAIL"},
                "judge_explanation": "Fails criteria.",
                "is_breaking": True,
            },
            {
                "hunt_id": 3,
                "model": "qwen/qwen3-235b",
                "response": "Another broken one",
                "judge_score": 0,
                "is_breaking": True,
            },
            {
                "hunt_id": 4,
                "model": "qwen/qwen3-235b",
                "response": "Yet another fail",
                "judge_score": 0,
                "is_breaking": True,
            },
        ],
        "human_reviews": {},
    }


@pytest.fixture
def mock_session_final():
    """Session dict for final — has 4 human reviews."""
    base = {
        "session_id": "abc12345",
        "current_turn": 1,
        "notebook": {
            "prompt": "Write a haiku about coding.",
            "response_reference": "C1: Must be 3 lines\nC2: Must mention code",
        },
        "config": {"models": ["qwen/qwen3-235b"]},
        "all_results": [
            {"hunt_id": 1, "model": "qwen/qwen3-235b", "response": "r1", "is_breaking": False, "judge_score": 1, "judge_criteria": {"C1": "pass", "C2": "pass"}, "judge_explanation": "Meets criteria."},
            {"hunt_id": 2, "model": "qwen/qwen3-235b", "response": "r2", "is_breaking": True, "judge_score": 0, "judge_criteria": {"C1": "fail", "C2": "fail"}, "judge_explanation": "Fails criteria."},
            {"hunt_id": 3, "model": "qwen/qwen3-235b", "response": "r3", "is_breaking": True, "judge_score": 0, "judge_criteria": {"C1": "fail", "C2": "fail"}, "judge_explanation": "Fails criteria."},
            {"hunt_id": 4, "model": "qwen/qwen3-235b", "response": "r4", "is_breaking": True, "judge_score": 0, "judge_criteria": {"C1": "fail", "C2": "fail"}, "judge_explanation": "Fails criteria."},
        ],
        "human_reviews": {
            "1": {"grades": {"C1": "pass", "C2": "pass"}, "explanation": "Good.", "submitted": True},
            "2": {"grades": {"C1": "fail", "C2": "fail"}, "explanation": "Bad.", "submitted": True},
            "3": {"grades": {"C1": "fail", "C2": "fail"}, "explanation": "Bad.", "submitted": True},
            "4": {"grades": {"C1": "fail", "C2": "fail"}, "explanation": "Bad.", "submitted": True},
        },
    }
    return base
