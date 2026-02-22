"""
Tests for LLM Council.
"""
import pytest
from pathlib import Path
from unittest.mock import patch

from agentic_reviewer.council import run_council, _get_enabled_models
from agentic_reviewer.config_loader import get_agentic_council
from agentic_reviewer.llm_client import parse_pass_fail


def test_parse_pass_fail():
    """Parse PASS/FAIL from various response formats."""
    assert parse_pass_fail("PASS") is True
    assert parse_pass_fail("FAIL") is False
    assert parse_pass_fail("pass") is True
    assert parse_pass_fail("fail") is False
    assert parse_pass_fail("Yes, I would say PASS") is True
    assert parse_pass_fail("The answer is FAIL because...") is False
    assert parse_pass_fail("YES") is True
    assert parse_pass_fail("NO") is False
    assert parse_pass_fail("") is None
    assert parse_pass_fail("Maybe") is None


def test_load_council_config():
    """Council config loads from YAML."""
    config_path = Path(__file__).parent.parent / "config" / "agentic_rules.yaml"
    config = get_agentic_council(config_path)
    assert "models" in config
    assert "consensus" in config


def test_get_enabled_models():
    """Enabled models are filtered correctly."""
    config = {
        "models": [
            {"id": "openai/gpt-4o", "enabled": True},
            {"id": "anthropic/claude-3.5-sonnet", "enabled": True},
            {"id": "google/gemini", "enabled": False},
        ],
        "consensus": "majority",
    }
    models = _get_enabled_models(config)
    assert "openai/gpt-4o" in models
    assert "anthropic/claude-3.5-sonnet" in models
    assert "google/gemini" not in models


@patch("agentic_reviewer.council.call_model_sync")
def test_run_council_majority_pass(mock_call):
    """Council passes with majority PASS votes."""
    mock_call.return_value = ("PASS", None)
    config_path = Path(__file__).parent.parent / "config" / "agentic_rules.yaml"
    passed, votes = run_council("Test prompt", "test_rule", config_path=config_path)
    assert passed is True
    assert len(votes) >= 1


@patch("agentic_reviewer.council.call_model_sync")
def test_run_council_majority_fail(mock_call):
    """Council fails when majority votes FAIL."""
    mock_call.return_value = ("FAIL", None)
    config_path = Path(__file__).parent.parent / "config" / "agentic_rules.yaml"
    passed, votes = run_council("Test prompt", "test_rule", config_path=config_path)
    assert passed is False
