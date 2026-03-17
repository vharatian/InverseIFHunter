"""
Unit tests for services/aggregation.py — classify_sample and aggregate_batch.

Covers: ratio strict (0.5 boundary), no_break, any_break, proceed patterns (4,0) and (3,1),
missing criteria => ERROR and impact on proceed/errors.
"""
import pytest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from models.schemas import HuntConfig, ProceedPolicy, ProceedPattern
from services.aggregation import classify_sample, aggregate_batch


# ---------------------------------------------------------------------------
# classify_sample — ratio / pass_threshold
# ---------------------------------------------------------------------------

def test_classify_ratio_pass_threshold_05_boundary():
    """At pass_threshold=0.5, pass_rate >= 0.5 passes (boundary inclusive)."""
    # 2/4 = 0.5 -> pass (>= 0.5)
    out = classify_sample(
        {"C1": "PASS", "C2": "FAIL", "C3": "PASS", "C4": "FAIL"},
        "ratio",
        0.5,
    )
    assert out["label"] == "PASS"
    assert out["pass_rate"] == 0.5
    assert out["pass_count"] == 2
    assert out["fail_count"] == 2
    assert out["missing_count"] == 0

    # 3/4 = 0.75 -> pass
    out2 = classify_sample(
        {"C1": "PASS", "C2": "PASS", "C3": "FAIL", "C4": "PASS"},
        "ratio",
        0.5,
    )
    assert out2["label"] == "PASS"
    assert out2["pass_rate"] == 0.75


def test_classify_ratio_threshold_10():
    """pass_threshold=1.0: only pass when pass_rate >= 1.0."""
    out = classify_sample(
        {"C1": "PASS", "C2": "PASS", "C3": "FAIL"},
        "ratio",
        1.0,
    )
    assert out["label"] == "BREAK"
    assert out["pass_rate"] == 2 / 3

    out_all = classify_sample(
        {"C1": "PASS", "C2": "PASS"},
        "ratio",
        1.0,
    )
    assert out_all["label"] == "PASS"
    assert out_all["pass_rate"] == 1.0


def test_classify_no_break():
    """no_break: not passing => BREAK, passing => PASS."""
    out_break = classify_sample(
        {"C1": "PASS", "C2": "FAIL"},
        "no_break",
        0.5,
    )
    assert out_break["label"] == "BREAK"

    out_pass = classify_sample(
        {"C1": "PASS", "C2": "PASS"},
        "no_break",
        0.5,
    )
    assert out_pass["label"] == "PASS"


def test_classify_any_break():
    """any_break: same as ratio for pass/fail; any fail can mean break."""
    out = classify_sample(
        {"C1": "FAIL", "C2": "PASS"},
        "any_break",
        0.5,
    )
    assert out["label"] == "BREAK"
    out2 = classify_sample(
        {"C1": "PASS", "C2": "PASS"},
        "any_break",
        0.5,
    )
    assert out2["label"] == "PASS"


def test_classify_missing_is_error():
    """Any criterion MISSING => sample_label ERROR; treat as format error."""
    out = classify_sample(
        {"C1": "PASS", "C2": "MISSING", "C3": "FAIL"},
        "ratio",
        0.5,
    )
    assert out["label"] == "ERROR"
    assert out["missing_count"] == 1
    assert out["pass_count"] == 1
    assert out["fail_count"] == 1

    out_all_missing = classify_sample(
        {"C1": "MISSING"},
        "ratio",
        0.5,
    )
    assert out_all_missing["label"] == "ERROR"
    assert out_all_missing["missing_count"] == 1


# ---------------------------------------------------------------------------
# aggregate_batch — proceed patterns
# ---------------------------------------------------------------------------

def test_aggregate_proceed_pattern_4_0():
    """Proceed when pattern (breaking=4, passing=0) matches and errors=0."""
    config = HuntConfig(
        target_breaks=4,
        proceed_policy=ProceedPolicy(patterns=[
            ProceedPattern(breaking=4, passing=0),
            ProceedPattern(breaking=3, passing=1),
        ]),
    )
    labels = ["BREAK", "BREAK", "BREAK", "BREAK"]
    out = aggregate_batch(labels, config)
    assert out["breaking"] == 4
    assert out["passing"] == 0
    assert out["errors"] == 0
    assert out["should_proceed"] is True
    assert "pattern" in out["reason"].lower() or "4" in out["reason"]


def test_aggregate_proceed_pattern_3_1():
    """Proceed when pattern (breaking=3, passing=1) matches."""
    config = HuntConfig(
        target_breaks=4,
        proceed_policy=ProceedPolicy(patterns=[
            ProceedPattern(breaking=4, passing=0),
            ProceedPattern(breaking=3, passing=1),
        ]),
    )
    labels = ["BREAK", "BREAK", "BREAK", "PASS"]
    out = aggregate_batch(labels, config)
    assert out["breaking"] == 3
    assert out["passing"] == 1
    assert out["errors"] == 0
    assert out["should_proceed"] is True


def test_aggregate_proceed_requires_errors_zero():
    """With proceed_policy, any ERROR in batch => should_proceed False."""
    config = HuntConfig(
        target_breaks=4,
        proceed_policy=ProceedPolicy(patterns=[
            ProceedPattern(breaking=4, passing=0),
        ]),
    )
    labels = ["BREAK", "BREAK", "BREAK", "ERROR"]
    out = aggregate_batch(labels, config)
    assert out["errors"] == 1
    assert out["should_proceed"] is False
    assert "error" in out["reason"].lower()


def test_aggregate_fallback_no_policy():
    """When no proceed_policy: passing_mode -> True; else breaking >= target_breaks."""
    config_pass = HuntConfig(target_breaks=2, passing_mode=True)
    out = aggregate_batch(["PASS", "BREAK"], config_pass)
    assert out["should_proceed"] is True
    assert "passing_mode" in out["reason"].lower()

    config_breaks = HuntConfig(target_breaks=2, passing_mode=False)
    out2 = aggregate_batch(["BREAK", "BREAK", "PASS"], config_breaks)
    assert out2["breaking"] == 2
    assert out2["should_proceed"] is True
    out3 = aggregate_batch(["BREAK", "PASS"], config_breaks)
    assert out3["should_proceed"] is False


def test_aggregate_error_samples_never_count_as_breaking_or_passing():
    """ERROR samples don't increment breaking or passing; they only add to errors."""
    config = HuntConfig(target_breaks=2, passing_mode=False)
    labels = ["BREAK", "ERROR", "ERROR", "PASS"]
    out = aggregate_batch(labels, config)
    assert out["breaking"] == 1
    assert out["passing"] == 1
    assert out["errors"] == 2
    assert out["should_proceed"] is False
