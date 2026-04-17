"""
Shared Endpoint Helpers

Cross-cutting helpers used by multiple route modules:
session validation, persistence, Drive writes, telemetry, etc.
"""
import json
import logging
from typing import Optional, Dict, Any, List

from fastapi import HTTPException

from models.schemas import HuntSession

import services.redis_session as redis_store
from services.pg_session import (
    load_session_pg,
    save_session_pg,
    get_session_metadata_pg,
    merge_session_metadata_pg,
)

logger = logging.getLogger(__name__)

# Telemetry import - wrapped to never fail
try:
    from services.telemetry_logger import get_telemetry
    _telemetry_enabled = True
except ImportError:
    _telemetry_enabled = False

# Trainer identity for fun character names
try:
    from services.trainer_identity import get_trainer_info
    _trainer_identity_enabled = True
except ImportError:
    _trainer_identity_enabled = False


# ============== Session Helpers ==============

async def _get_validated_session(session_id: str) -> HuntSession:
    """Get session or raise 404. Shared by all session-dependent endpoints.

    Strategy:
    1. Try Redis (primary cache).
    2. If miss, try PostgreSQL (durable store); on hit, restore to Redis.
    3. If none, 404.
    """
    from services.hunt_engine import hunt_engine

    session = await hunt_engine.get_session_async(session_id)
    if session:
        return session

    try:
        session = await load_session_pg(session_id)
        if session:
            meta = await get_session_metadata_pg(session_id)
            await redis_store.save_full_session(session, workflow_metadata=meta)
            logger.info(f"Session {session_id} restored from PostgreSQL → Redis")
            return session
    except Exception as e:
        logger.warning(f"Failed to restore session {session_id} from PostgreSQL: {e}")

    raise HTTPException(404, "Session not found")


async def _get_storage_with_url(session_id: str):
    """Load Colab/Drive file hints from PostgreSQL metadata. Returns (storage, has_url)."""
    meta = await get_session_metadata_pg(session_id)
    url = (meta.get("url") or meta.get("colab_url") or "").strip() or None
    storage = {
        "url": url,
        "original_content": meta.get("original_content"),
        "filename": meta.get("filename"),
        "trainer_email": meta.get("trainer_email"),
        "trainer_id": meta.get("trainer_id"),
        "trainer_name": meta.get("trainer_name"),
        "fingerprint": meta.get("fingerprint"),
        "ip_hint": meta.get("ip_hint"),
    }
    has_url = bool(url)
    return storage, has_url


async def _persist_session(session_id: str, session: HuntSession, storage: Optional[dict] = None):
    """Persist session state to Redis and PostgreSQL (notebook file metadata in JSONB)."""
    try:
        if session.notebook:
            await redis_store.set_notebook(session_id, session.notebook)
        if session.config:
            await redis_store.set_config(session_id, session.config)
    except Exception as e:
        logger.error(f"Failed to persist session {session_id} to Redis: {e}")

    if storage:
        patch: Dict[str, Any] = {}
        for k in (
            "url",
            "original_content",
            "filename",
            "trainer_email",
            "trainer_id",
            "trainer_name",
            "fingerprint",
            "ip_hint",
        ):
            if storage.get(k) is not None:
                patch[k] = storage[k]
        u = storage.get("url")
        if u:
            patch["colab_url"] = u
        if patch:
            try:
                await merge_session_metadata_pg(session_id, patch)
            except Exception as e:
                logger.error(f"Failed to merge session metadata for {session_id}: {e}")

    try:
        await save_session_pg(session)
    except Exception as e:
        logger.error(f"Failed to save session {session.session_id} to PostgreSQL: {e}")


# ============== Drive Helpers ==============

def _save_cells_to_drive(storage: dict, notebook_data: dict) -> bool:
    """Save notebook JSON to Google Drive. Returns True on success."""
    try:
        from services.google_drive_client import drive_client
        file_id = drive_client.get_file_id_from_url(storage["url"])
        if not file_id:
            return False
        updated_content = json.dumps(notebook_data, indent=2)
        success = drive_client.update_file_content(file_id, updated_content)
        if success:
            storage["original_content"] = updated_content
            return True
    except Exception as e:
        logger.error(f"Drive save error: {e}")
    return False


def _apply_turn_cells(session: HuntSession, notebook_data: dict, cells: List[tuple]) -> dict:
    """Apply (cell_type, content) updates to a parsed notebook dict using turn-aware headings."""
    from helpers.notebook_helpers import _find_or_create_turn_cell

    current_turn = session.current_turn if session.current_turn else 1
    for cell_type, content in cells:
        _find_or_create_turn_cell(notebook_data, cell_type, content, current_turn)
    return notebook_data


def _save_turn_cells_to_drive(session: HuntSession, storage: Optional[dict],
                               has_url: bool, cells: List[tuple]) -> bool:
    """
    Save one or more cells to Colab with turn-aware headings.

    Args:
        session: Current hunt session
        storage: Session storage dict
        has_url: Whether a Colab URL is available
        cells: List of (cell_type, content) tuples

    Returns True if saved to Colab, False otherwise.
    """
    if not has_url or not storage:
        return False
    try:
        original_content = storage.get("original_content", "{}")
        notebook_data = _apply_turn_cells(session, json.loads(original_content), cells)
        return _save_cells_to_drive(storage, notebook_data)
    except Exception as e:
        logger.error(f"Error saving turn cells to Drive: {e}")
        return False


async def _save_cells_to_drive_via_url(
    session_id: str,
    session: HuntSession,
    colab_url: str,
    cells: List[tuple],
) -> bool:
    """
    Save cells to Colab when session storage has no URL/original_content
    (e.g. after resuming from queue). Fetches notebook from Drive, applies
    cell updates, writes back, and optionally updates session storage.
    Returns True if saved to Colab, False otherwise.
    """
    from services.google_drive_client import drive_client
    from services.notebook_parser import notebook_parser

    if not colab_url or not colab_url.strip():
        return False
    try:
        _, content_str = await notebook_parser.load_from_url(colab_url.strip())
        notebook_data = _apply_turn_cells(session, json.loads(content_str), cells)
        updated_content = json.dumps(notebook_data, indent=2)
        file_id = drive_client.get_file_id_from_url(colab_url)
        if not file_id:
            logger.warning("Could not extract file_id from colab_url")
            return False
        success = drive_client.update_file_content(file_id, updated_content)
        if success:
            try:
                await merge_session_metadata_pg(
                    session_id,
                    {
                        "url": colab_url.strip(),
                        "colab_url": colab_url.strip(),
                        "original_content": updated_content,
                    },
                )
                await save_session_pg(session)
            except Exception as e:
                logger.error(f"Failed to save session {session.session_id} to PostgreSQL: {e}")
        return success
    except Exception as e:
        logger.error(f"Error saving cells to Drive via URL: {e}")
        return False


# ============== Formatting / Utility Helpers ==============

def _format_judge_result(judge_result: dict, notebook) -> dict:
    """Format judge result into standard API response."""
    score = judge_result.get("score")
    return {
        "success": True,
        "score": score,
        "explanation": judge_result.get("explanation", ""),
        "criteria": judge_result.get("criteria", {}),
        "raw_output": judge_result.get("raw_output", ""),
        "is_passing": (score or 0) >= 1,
        "response_reference": notebook.response_reference
    }


def _extract_trainer_info_from_request(request, trainer_email: str = "", trainer_name: str = "") -> dict:
    """Extract trainer info from request with fingerprint fallback."""
    trainer_info = {}
    if _trainer_identity_enabled:
        try:
            trainer_info = get_trainer_info(request)
        except Exception:
            pass
    return {
        "trainer_id": trainer_info.get("trainer_id", "unknown"),
        "trainer_email": trainer_email or "",
        "trainer_name": trainer_name or "",
        "fingerprint": trainer_info.get("fingerprint", ""),
        "ip_hint": trainer_info.get("ip_hint", "")
    }


def _log_telemetry_safe(event_type: str, data: dict):
    """Log a telemetry event safely (never raises)."""
    if _telemetry_enabled:
        try:
            get_telemetry().log_event(event_type, data)
        except Exception:
            pass


def count_valid_responses(results: List[Dict[str, Any]]) -> int:
    """
    Count only valid responses (exclude empty/error responses).
    This ensures number_of_attempts_made only counts actual model responses.
    """
    count = 0
    for r in results:
        # Check if response has actual content and no error
        response = r.get("response", "") if isinstance(r, dict) else getattr(r, "response", "")
        error = r.get("error") if isinstance(r, dict) else getattr(r, "error", None)

        if response and response.strip() and not error:
            count += 1
    return count
