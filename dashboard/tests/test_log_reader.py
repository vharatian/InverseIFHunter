"""Unit tests for log_reader helpers and core aggregations."""
from log_reader import _normalize_verdict


def test_normalize_verdict_pass_variants():
    assert _normalize_verdict("Pass") == "PASS"
    assert _normalize_verdict("passed") == "PASS"
    assert _normalize_verdict(True) == "PASS"
    assert _normalize_verdict(1) == "PASS"
    assert _normalize_verdict("OK") == "PASS"
    assert _normalize_verdict({"verdict": "pass"}) == "PASS"


def test_normalize_verdict_fail_variants():
    assert _normalize_verdict("FAIL") == "FAIL"
    assert _normalize_verdict("failed") == "FAIL"
    assert _normalize_verdict(False) == "FAIL"
    assert _normalize_verdict(0) == "FAIL"
    assert _normalize_verdict({"status": "ERROR"}) == "FAIL"


def test_normalize_verdict_unknown():
    assert _normalize_verdict(None) is None
    assert _normalize_verdict("maybe") is None
    assert _normalize_verdict(42) is None
    assert _normalize_verdict("") is None
    assert _normalize_verdict({}) is None
