"""Unit tests for admin/services/config_service helpers."""
import pytest

from admin.services.config_service import _set_nested, _get_nested, ALLOWED_EDIT_PREFIXES, BLOCKED_PREFIXES


def test_set_nested_creates_path():
    d = {}
    _set_nested(d, "a.b.c", 1)
    assert d == {"a": {"b": {"c": 1}}}


def test_set_nested_raises_on_non_dict_intermediate():
    d = {"a": 42}
    with pytest.raises(ValueError):
        _set_nested(d, "a.b", 1)


def test_get_nested_missing_returns_default():
    d = {"a": {"b": 1}}
    assert _get_nested(d, "a.b") == 1
    assert _get_nested(d, "a.x", 99) == 99
    assert _get_nested(d, "x.y.z", "fallback") == "fallback"


def test_allowlist_contains_expected_prefixes():
    expected = {"alignment.", "models.", "hunting.", "reviewer.", "scoring.", "rate_limits.", "judges.", "providers.", "runtime.", "features.", "notifications.", "teams.", "ui.", "analytics."}
    assert expected.issubset(set(ALLOWED_EDIT_PREFIXES))


def test_blocked_prefixes_cover_secrets():
    assert any(p.startswith("secrets") for p in BLOCKED_PREFIXES)
