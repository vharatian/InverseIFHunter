"""
Shared test fixtures for Model Hunter test suite.

Uses FastAPI's TestClient for in-process testing (API tests) and
httpx Client for external server testing (E2E tests).

In-process mode allows direct access to the hunt engine's session state,
enabling result injection without real model calls.
"""
import pytest
import httpx
import json
import os
import sys

# Add model-hunter root to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from typing import Optional, List, Dict, Any

BASE_URL = "http://localhost:8000"


# ---------------------------------------------------------------------------
# In-Process TestClient (for API tests — no server needed)
# ---------------------------------------------------------------------------

@pytest.fixture
def app():
    """Import and return the FastAPI app."""
    from main import app as fastapi_app
    return fastapi_app


@pytest.fixture
def client(app):
    """In-process TestClient — no external server needed.

    Uses FastAPI's TestClient which runs the app in the same process,
    enabling direct access to the hunt engine's session state.
    """
    from starlette.testclient import TestClient
    with TestClient(app, base_url="http://testserver") as c:
        yield c


@pytest.fixture
async def async_client():
    """Async httpx client for tests that need async (SSE, etc.)."""
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=30.0) as c:
        yield c


@pytest.fixture
def external_client():
    """Synchronous httpx client pointed at external server (for E2E)."""
    with httpx.Client(base_url=BASE_URL, timeout=30.0) as c:
        yield c


# ---------------------------------------------------------------------------
# Notebook Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def minimal_notebook():
    """Minimal valid .ipynb for testing — has all required cells."""
    return {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {},
        "cells": [
            {
                "cell_type": "markdown", "id": "c1", "metadata": {},
                "source": ["**[prompt]**\n\nWhat is 2+2?"],
            },
            {
                "cell_type": "markdown", "id": "c2", "metadata": {},
                "source": ["**[response]**\n\nThe answer is 4."],
            },
            {
                "cell_type": "markdown", "id": "c3", "metadata": {},
                "source": [
                    '**[response_reference]**\n\n[{"id": "C1", "criteria": "Contains correct answer"}]'
                ],
            },
            {
                "cell_type": "markdown", "id": "c4", "metadata": {},
                "source": ["**[judge_system_prompt]**\n\nYou are a judge."],
            },
            {
                "cell_type": "markdown", "id": "c5", "metadata": {},
                "source": ["**[number_of_attempts_made]**:\n\n0"],
            },
        ],
    }


@pytest.fixture
def multi_turn_notebook():
    """Notebook for multi-turn testing scenarios."""
    return {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {},
        "cells": [
            {
                "cell_type": "markdown", "id": "c1", "metadata": {},
                "source": ["**[prompt]**\n\nTell me a joke"],
            },
            {
                "cell_type": "markdown", "id": "c2", "metadata": {},
                "source": ["**[response]**\n\nWhy did the chicken cross the road?"],
            },
            {
                "cell_type": "markdown", "id": "c3", "metadata": {},
                "source": [
                    '**[response_reference]**\n\n[{"id":"C1","criteria":"Must be humorous"}]'
                ],
            },
            {
                "cell_type": "markdown", "id": "c4", "metadata": {},
                "source": ["**[judge_system_prompt]**\n\nYou are a humor judge."],
            },
            {
                "cell_type": "markdown", "id": "c5", "metadata": {},
                "source": ["**[number_of_attempts_made]**:\n\n0"],
            },
        ],
    }


# ---------------------------------------------------------------------------
# Session Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def create_session(client, minimal_notebook):
    """Create a session via upload and return session_id."""
    nb_json = json.dumps(minimal_notebook)
    files = {"file": ("test.ipynb", nb_json, "application/json")}
    r = client.post("/api/upload-notebook", files=files)
    assert r.status_code == 200
    data = r.json()
    assert "session_id" in data
    return data["session_id"]


@pytest.fixture
def create_multi_turn_session(client, multi_turn_notebook):
    """Create a session from multi_turn_notebook, return session_id."""
    nb_json = json.dumps(multi_turn_notebook)
    files = {"file": ("multi.ipynb", nb_json, "application/json")}
    r = client.post("/api/upload-notebook", files=files)
    assert r.status_code == 200
    return r.json()["session_id"]


# ---------------------------------------------------------------------------
# Hunt Result Injection (in-process — modifies engine's session state)
# ---------------------------------------------------------------------------

def make_passing_result(hunt_id: int = 1, response: str = "A passing response.") -> dict:
    """Create a passing hunt result dict."""
    return {
        "hunt_id": hunt_id,
        "model": "nvidia/nemotron-3-nano-30b-a3b",
        "status": "complete",
        "response": response,
        "reasoning_trace": "Step 1: analyze. Step 2: respond.",
        "judge_score": 1,
        "judge_criteria": {"C1": "PASS"},
        "judge_explanation": "Meets all criteria.",
        "judge_output": '{"score": 1, "criteria": {"C1": "PASS"}}',
        "is_breaking": False,
        "error": None,
    }


def make_breaking_result(hunt_id: int = 2, response: str = "A breaking response.") -> dict:
    """Create a breaking hunt result dict."""
    return {
        "hunt_id": hunt_id,
        "model": "nvidia/nemotron-3-nano-30b-a3b",
        "status": "complete",
        "response": response,
        "reasoning_trace": "Step 1: misunderstand. Step 2: fail.",
        "judge_score": 0,
        "judge_criteria": {"C1": "FAIL"},
        "judge_explanation": "Fails criteria C1.",
        "judge_output": '{"score": 0, "criteria": {"C1": "FAIL"}}',
        "is_breaking": True,
        "error": None,
    }


def inject_results_into_session(session_id: str, results: List[dict]) -> bool:
    """Inject mock hunt results directly into the hunt engine's in-memory session.

    This accesses the hunt engine singleton and modifies its session state,
    allowing tests to test advance-turn / mark-breaking without real model calls.
    """
    from services.hunt_engine import hunt_engine
    from models.schemas import HuntResult, HuntStatus

    session = hunt_engine.get_session(session_id)
    if session is None:
        return False

    # Convert dicts to HuntResult objects
    hunt_results = []
    for r in results:
        hr = HuntResult(
            hunt_id=r["hunt_id"],
            model=r.get("model", "nvidia/nemotron-3-nano-30b-a3b"),
            status=HuntStatus.COMPLETED if r.get("status") in ("complete", "completed") else HuntStatus.PENDING,
            response=r.get("response", ""),
            reasoning_trace=r.get("reasoning_trace", ""),
            judge_score=r.get("judge_score"),
            judge_output=r.get("judge_output", ""),
            judge_criteria=r.get("judge_criteria", {}),
            judge_explanation=r.get("judge_explanation", ""),
            is_breaking=r.get("is_breaking", False),
            error=r.get("error"),
        )
        hunt_results.append(hr)

    # Inject into the session
    session.results = hunt_results
    session.all_results = list(session.all_results) + hunt_results
    session.status = HuntStatus.COMPLETED
    session.completed_hunts = len(hunt_results)
    session.total_hunts = len(hunt_results)
    session.breaks_found = sum(1 for r in hunt_results if r.is_breaking)

    return True
