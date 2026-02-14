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
from storage.session_storage import save_session_storage, get_session_storage
import services.redis_session as redis_store

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
    1. Try Redis (primary, fast).
    2. If miss, try Disk (backup, slow).
    3. If found on disk, restore to Redis and return.
    4. If neither, 404.
    """
    from services.hunt_engine import hunt_engine
    
    # 1. Try Redis
    session = await hunt_engine.get_session_async(session_id)
    if session:
        return session

    # 2. Try Disk (Backup)
    try:
        storage = get_session_storage(session_id)
        if storage and "session_data" in storage:
            session_data = storage["session_data"]
            session = HuntSession(**session_data)
            
            # 3. Restore to Redis
            await redis_store.save_full_session(session)
            return session
    except Exception as e:
        logger.warning(f"Failed to restore session {session_id} from disk: {e}")

    # 4. Not found anywhere
    raise HTTPException(404, "Session not found")


def _get_storage_with_url(session_id: str):
    """Load session storage and check for URL. Returns (storage, has_url)."""
    storage = get_session_storage(session_id)
    has_url = bool(storage and storage.get("url"))
    return storage, has_url


async def _persist_session(session_id: str, session: HuntSession, storage: Optional[dict] = None):
    """Persist session state to disk storage and Redis."""
    if storage is None:
        storage = get_session_storage(session_id) or {}
    storage["session_data"] = session.model_dump()
    save_session_storage(session_id, storage)

    # Also persist key fields to Redis
    try:
        if session.notebook:
            await redis_store.set_notebook(session_id, session.notebook)
        if session.config:
            await redis_store.set_config(session_id, session.config)
    except Exception as e:
        logger.error(f"Failed to persist session {session_id} to Redis: {e}")


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
    from helpers.notebook_helpers import _find_or_create_turn_cell
    
    if not has_url or not storage:
        return False
    try:
        original_content = storage.get("original_content", "{}")
        notebook_data = json.loads(original_content)
        current_turn = session.current_turn if session.current_turn else 1
        for cell_type, content in cells:
            _find_or_create_turn_cell(notebook_data, cell_type, content, current_turn)
        return _save_cells_to_drive(storage, notebook_data)
    except Exception as e:
        logger.error(f"Error saving turn cells to Drive: {e}")
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
