"""Pytest fixtures for reviewer app. Run from reviewer-app/ with agentic-reviewer on PYTHONPATH."""
import sys
from pathlib import Path

import pytest

# Ensure reviewer-app and agentic-reviewer are on path
_APP_DIR = Path(__file__).resolve().parent.parent
_AGENTIC_ROOT = _APP_DIR.parent
for p in (str(_APP_DIR), str(_AGENTIC_ROOT)):
    if p not in sys.path:
        sys.path.insert(0, p)


@pytest.fixture
def app_dir():
    return _APP_DIR


@pytest.fixture
def agentic_root():
    return _AGENTIC_ROOT
