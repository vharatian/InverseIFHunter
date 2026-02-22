"""
Tests for CLI runner.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"


def test_cli_demo_preflight():
    """Demo preflight passes."""
    result = subprocess.run(
        [sys.executable, "-m", "agentic_reviewer.cli", "demo", "preflight"],
        capture_output=True,
        text=True,
        cwd=Path(__file__).parent.parent,
    )
    assert result.returncode == 0
    out = json.loads(result.stdout)
    assert out["passed"] is True
    assert out["checkpoint"] == "preflight"
    assert len(out["issues"]) == 0


def test_cli_fixture_preflight():
    """Fixture file preflight passes."""
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "agentic_reviewer.cli",
            str(FIXTURES / "session_preflight.json"),
            "preflight",
            "--ids", "1", "2", "3", "4",
        ],
        capture_output=True,
        text=True,
        cwd=Path(__file__).parent.parent,
    )
    assert result.returncode == 0
    out = json.loads(result.stdout)
    assert out["passed"] is True


def test_cli_fixture_final():
    """Fixture file final passes."""
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "agentic_reviewer.cli",
            str(FIXTURES / "session_final.json"),
            "final",
        ],
        capture_output=True,
        text=True,
        cwd=Path(__file__).parent.parent,
    )
    assert result.returncode == 0
    out = json.loads(result.stdout)
    assert out["passed"] is True
    assert out["checkpoint"] == "final"


def test_cli_fails_model_consistency_exit_1():
    """Model consistency failure (mixed models) returns exit code 1."""
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "agentic_reviewer.cli",
            str(FIXTURES / "session_fails_diversity.json"),
            "preflight",
            "--ids", "1", "2", "3", "4",
        ],
        capture_output=True,
        text=True,
        cwd=Path(__file__).parent.parent,
    )
    assert result.returncode == 1
    out = json.loads(result.stdout)
    assert out["passed"] is False
    assert any(i["rule_id"] == "model_consistency" for i in out["issues"])
