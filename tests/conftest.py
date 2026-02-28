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
    """Inject mock hunt results directly into Redis.

    Uses a fresh, local Redis client to avoid asyncio loop mismatch issues
    with the global app client used by TestClient.
    """
    import services.redis_session as redis_store
    import redis.asyncio as aioredis
    import asyncio
    import os
    import json
    from models.schemas import HuntResult, HuntStatus, HuntConfig, ParsedNotebook, TurnData, HuntSession

    REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    KEY_PREFIX = "mh:sess"

    def _key(sid, field):
        return f"{KEY_PREFIX}:{sid}:{field}"

    async def _update_redis():
        # Create fresh client
        r = aioredis.from_url(REDIS_URL, encoding="utf-8", decode_responses=True)
        try:
            # 1. Get session status to verify existence
            status_val = await r.get(_key(session_id, "status"))
            if status_val is None:
                return False

            # 2. Reconstruct session (partial, just what we need)
            # We need all_results to calculate new state
            all_results_jsons = await r.lrange(_key(session_id, "all_results"), 0, -1)
            all_results = [HuntResult.model_validate_json(rj) for rj in (all_results_jsons or [])]
            
            # Get meta for total_hunts
            meta = await r.hgetall(_key(session_id, "meta"))
            total_hunts = int(meta.get("total_hunts", 0))

            # 3. Process new results
            hunt_results = []
            for item in results:
                hr = HuntResult(
                    hunt_id=item["hunt_id"],
                    model=item.get("model", "nvidia/nemotron-3-nano-30b-a3b"),
                    status=HuntStatus.COMPLETED if item.get("status") in ("complete", "completed") else HuntStatus.PENDING,
                    response=item.get("response", ""),
                    reasoning_trace=item.get("reasoning_trace", ""),
                    judge_score=item.get("judge_score"),
                    judge_output=item.get("judge_output", ""),
                    judge_criteria=item.get("judge_criteria", {}),
                    judge_explanation=item.get("judge_explanation", ""),
                    is_breaking=item.get("is_breaking", False),
                    error=item.get("error"),
                )
                hunt_results.append(hr)

            # 4. Merge results
            existing_ids = {res.hunt_id for res in all_results}
            new_results = [res for res in hunt_results if res.hunt_id not in existing_ids]

            # 5. Update Redis
            if new_results:
                pipe = r.pipeline()
                
                # Append to 'results' (current run)
                for res in new_results:
                    pipe.rpush(_key(session_id, "results"), res.model_dump_json())
                    
                # Append to 'all_results'
                for res in new_results:
                    pipe.rpush(_key(session_id, "all_results"), res.model_dump_json())
                
                # Update status
                pipe.set(_key(session_id, "status"), HuntStatus.COMPLETED.value)
                
                # Update counters
                final_all_results = all_results + new_results
                completed_count = len([res for res in final_all_results if res.status == HuntStatus.COMPLETED])
                breaks_found = len([res for res in final_all_results if res.is_breaking])
                
                pipe.hset(_key(session_id, "meta"), mapping={
                    "total_hunts": max(total_hunts, len(final_all_results)), # Should probably match config but this is safe
                    "completed_hunts": completed_count,
                    "breaks_found": breaks_found,
                })
                
                await pipe.execute()
                
            return True
        finally:
            await r.close()

    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
             # If called from async test, await directly
             # But this fixture is called from sync tests...
             # We forcedly create a new loop? No, that causes "different loop" error.
             # Use asyncio.run() creates a NEW loop.
             pass
    except RuntimeError:
        pass

    return asyncio.run(_update_redis())
