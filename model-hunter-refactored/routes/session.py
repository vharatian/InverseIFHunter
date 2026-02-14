"""
Session Routes

GET  /api/session/{session_id}      — get session details
POST /api/update-config/{session_id} — update hunt configuration
"""
import logging

from fastapi import APIRouter, HTTPException

from models.schemas import HuntConfig, HuntSession, HuntStatus
from storage.session_storage import get_session_storage, save_session_storage
from helpers.shared import _get_validated_session
import services.redis_session as redis_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["session"])


@router.get("/session/{session_id}")
async def get_session(session_id: str):
    """Get session details."""
    session = await _get_validated_session(session_id)
    
    return {
        "session_id": session.session_id,
        "status": session.status.value,
        "total_hunts": session.total_hunts,
        "completed_hunts": session.completed_hunts,
        "breaks_found": session.breaks_found,
        "config": session.config.model_dump(),
        "results": [r.model_dump() for r in session.results]
    }


@router.post("/update-config/{session_id}")
async def update_config(session_id: str, config: HuntConfig):
    """Update hunt configuration for a session. Restores from storage if needed."""
    # Use shared helper to get session (handles Redis cache + Disk fallback)
    session = await _get_validated_session(session_id)
    
    # CRITICAL: Preserve multi-turn fields that the frontend doesn't send
    existing_conversation_history = session.config.conversation_history if session.config else []
    existing_judge_prompt = session.config.custom_judge_system_prompt if session.config else None
    
    session.config = config
    
    # Restore multi-turn fields if the incoming config didn't include them
    if not config.conversation_history and existing_conversation_history:
        session.config.conversation_history = existing_conversation_history
        logger.info(f"Session {session_id}: Preserved conversation_history ({len(existing_conversation_history)} messages) during config update")
    if not config.custom_judge_system_prompt and existing_judge_prompt:
        session.config.custom_judge_system_prompt = existing_judge_prompt
        logger.info(f"Session {session_id}: Preserved custom_judge_system_prompt during config update")
    
    session.total_hunts = config.parallel_workers

    # Persist config to Redis
    await redis_store.set_config(session_id, session.config)
    await redis_store.set_meta_field(session_id, "total_hunts", session.total_hunts)

    # Update storage
    storage = get_session_storage(session_id) or {}
    storage["session_data"] = session.model_dump()
    save_session_storage(session_id, storage)

    return {"success": True, "config": config.model_dump()}
