"""
Colab save service for the reviewer app.

Builds the snapshot payload from Redis session data and proxies the write
to the trainer app's /api/save-snapshot endpoint (which has the complex
notebook parsing and Google Drive write logic).

This avoids duplicating notebook_parser.export_notebook and keeps
the Colab write logic in one place.
"""
import json
import logging
import os
from typing import Any, Dict, Optional

import httpx

from .redis_client import get_redis, get_review_status
from agentic_reviewer.notifications import extract_task_display_id_from_metadata
from agentic_reviewer.resilience import retry_async

logger = logging.getLogger(__name__)

TRAINER_APP_URL = os.environ.get("TRAINER_APP_URL", "http://localhost:8000")
INTERNAL_API_SECRET = os.environ.get("INTERNAL_API_SECRET", "")
KEY_PREFIX = "mh:sess"


def _key(session_id: str, field: str) -> str:
    return f"{KEY_PREFIX}:{session_id}:{field}"


async def build_colab_preview(session_id: str) -> Dict[str, Any]:
    """Build a preview of what will be saved to Colab. Returns a summary dict."""
    r = await get_redis()

    status = await r.get(_key(session_id, "status"))
    if status is None:
        raise ValueError(f"Session {session_id} not found")

    review_status = await get_review_status(session_id)
    if review_status != "approved":
        raise ValueError(f"Task must be approved before Colab save. Current: '{review_status}'")

    pipe = r.pipeline()
    pipe.get(_key(session_id, "notebook"))
    pipe.get(_key(session_id, "reviews"))
    pipe.hgetall(_key(session_id, "meta"))
    pipe.lrange(_key(session_id, "all_results"), 0, -1)
    notebook_json, reviews_json, meta, all_results_jsons = await pipe.execute()

    notebook = {}
    if notebook_json:
        try:
            notebook = json.loads(notebook_json)
        except (json.JSONDecodeError, TypeError):
            pass

    reviews = {}
    if reviews_json:
        try:
            reviews = json.loads(reviews_json)
        except (json.JSONDecodeError, TypeError):
            pass

    all_results = []
    for item in (all_results_jsons or []):
        try:
            all_results.append(json.loads(item))
        except (json.JSONDecodeError, TypeError):
            pass

    metadata = notebook.get("metadata", {}) if isinstance(notebook, dict) else {}

    # Find selected results (those referenced in human reviews)
    selected_hunt_ids = set()
    for key, val in reviews.items():
        if isinstance(val, dict) and val.get("hunt_id"):
            selected_hunt_ids.add(str(val["hunt_id"]))

    selected_results = [r for r in all_results if str(r.get("hunt_id", "")) in selected_hunt_ids]

    # Build summary for each selected result
    slots_preview = []
    for i, result in enumerate(selected_results[:4]):
        review_key = None
        for k, v in reviews.items():
            if isinstance(v, dict) and str(v.get("hunt_id")) == str(result.get("hunt_id")):
                review_key = k
                break
        review = reviews.get(review_key, {}) if review_key else {}
        slots_preview.append({
            "slot": i + 1,
            "model": result.get("model_id", result.get("model", "unknown")),
            "hunt_id": result.get("hunt_id"),
            "response_preview": (result.get("response", "") or "")[:200],
            "judgment": review.get("judgment", ""),
            "grading_basis": review.get("grading_basis", ""),
        })

    task_display_id = extract_task_display_id_from_metadata(metadata)

    return {
        "session_id": session_id,
        "task_display_id": task_display_id,
        "review_status": review_status,
        "metadata": {
            "domain": metadata.get("Domain", ""),
            "use_case": metadata.get("Use Case", ""),
            "taxonomy": metadata.get("L1 Taxonomy", ""),
        },
        "prompt_preview": (notebook.get("prompt", "") or "")[:300],
        "total_hunts": int(meta.get("accumulated_hunt_count", 0)) or len(all_results),
        "selected_slots": slots_preview,
        "reviews_count": len([v for v in reviews.values() if isinstance(v, dict) and v.get("judgment")]),
        "has_notebook": bool(notebook_json),
    }


async def submit_to_colab(session_id: str, reviewer_email: str = "") -> Dict[str, Any]:
    """Submit the approved task to Colab via the trainer app's save-snapshot endpoint.
    Builds the payload from Redis and proxies to the trainer backend."""
    r = await get_redis()

    review_status = await get_review_status(session_id)
    if review_status != "approved":
        raise ValueError(f"Task must be approved. Current: '{review_status}'")

    pipe = r.pipeline()
    pipe.get(_key(session_id, "notebook"))
    pipe.get(_key(session_id, "reviews"))
    pipe.hgetall(_key(session_id, "meta"))
    pipe.lrange(_key(session_id, "all_results"), 0, -1)
    pipe.lrange(_key(session_id, "turns"), 0, -1)
    pipe.get(_key(session_id, "history"))
    notebook_json_str, reviews_json, meta, all_results_jsons, turns_jsons, history_json = await pipe.execute()

    if not notebook_json_str:
        raise ValueError("No notebook data found for this session")

    notebook = json.loads(notebook_json_str)
    reviews = json.loads(reviews_json) if reviews_json else {}

    all_results = []
    for item in (all_results_jsons or []):
        try:
            all_results.append(json.loads(item))
        except (json.JSONDecodeError, TypeError):
            pass

    turns = []
    for item in (turns_jsons or []):
        try:
            turns.append(json.loads(item))
        except (json.JSONDecodeError, TypeError):
            pass

    conversation_history = []
    if history_json:
        try:
            conversation_history = json.loads(history_json)
        except (json.JSONDecodeError, TypeError):
            pass

    # Build selected results from human reviews
    selected_hunt_ids = []
    for key in sorted(reviews.keys()):
        val = reviews.get(key)
        if isinstance(val, dict) and val.get("hunt_id"):
            selected_hunt_ids.append(str(val["hunt_id"]))

    selected_results = []
    for hid in selected_hunt_ids:
        for result in all_results:
            if str(result.get("hunt_id", "")) == hid:
                selected_results.append(result)
                break

    if not selected_results:
        raise ValueError("No selected results found to save")

    # Determine the Colab URL/file_id from the notebook
    url = notebook.get("url", "") or notebook.get("source_url", "") or ""
    file_id = notebook.get("file_id", "") or ""

    if not url and not file_id:
        metadata = notebook.get("metadata", {})
        url = metadata.get("url", "") or metadata.get("source_url", "") or ""

    is_multi_turn = len(turns) > 0
    total_hunts = int(meta.get("accumulated_hunt_count", 0)) or len(all_results)

    # Build the snapshot payload matching NotebookSnapshot schema
    snapshot_payload = {
        "original_notebook_json": notebook_json_str,
        "url": url,
        "file_id": file_id,
        "selected_results": selected_results[:4],
        "human_reviews": reviews,
        "total_hunts_ran": total_hunts,
        "include_reasoning": True,
        "metadata": {
            "session_id": session_id,
            "parsed_notebook": notebook,
            "is_multi_turn": is_multi_turn,
            "turns": turns if is_multi_turn else [],
            "conversation_history": conversation_history if is_multi_turn else [],
        },
        "session_id": session_id,
    }

    headers = {}
    if INTERNAL_API_SECRET:
        headers["X-Internal-Secret"] = INTERNAL_API_SECRET
    else:
        headers["X-Admin-Mode"] = "true"

    async def _post_snapshot() -> httpx.Response:
        async with httpx.AsyncClient(timeout=120.0) as client:
            return await client.post(
                f"{TRAINER_APP_URL}/api/save-snapshot",
                json=snapshot_payload,
                headers=headers,
            )

    try:
        resp = await retry_async(
            _post_snapshot,
            retryable=(httpx.TimeoutException, httpx.ConnectError, httpx.RequestError),
            context=f"colab save proxy for {session_id}",
        )
    except httpx.TimeoutException:
        raise ValueError("Colab save timed out — the trainer app did not respond within 120s")
    except httpx.ConnectError:
        raise ValueError(f"Cannot reach trainer app at {TRAINER_APP_URL}. Is it running?")
    except httpx.RequestError as exc:
        raise ValueError(f"Network error contacting trainer app: {exc}")

    if resp.status_code != 200:
        detail = "Unknown error"
        try:
            detail = resp.json().get("detail", resp.text)
        except Exception:
            detail = resp.text
        raise ValueError(f"Colab save failed ({resp.status_code}): {detail}")

    result = resp.json()

    # Mark as saved in Redis
    await r.hset(_key(session_id, "meta"), "colab_saved", "1")
    await r.hset(_key(session_id, "meta"), "colab_saved_by", reviewer_email)

    logger.info(f"Colab save completed for session {session_id} by {reviewer_email}")
    return result
