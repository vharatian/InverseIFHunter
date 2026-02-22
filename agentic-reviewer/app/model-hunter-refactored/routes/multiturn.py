"""
Multi-Turn Routes

POST /api/advance-turn/{session_id}   — advance to next turn
POST /api/mark-breaking/{session_id}  — mark current turn as breaking
GET  /api/turn-status/{session_id}    — get turn status and history
"""
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from models.schemas import TurnData, HuntStatus
from storage.session_storage import get_session_storage, save_session_storage
from helpers.shared import _get_validated_session
import services.redis_session as redis_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["multiturn"])


class AdvanceTurnRequest(BaseModel):
    """Request to advance to the next turn in a multi-turn session."""
    selected_hunt_id: int                    # Hunt ID of the "good" response from current turn
    next_prompt: Optional[str] = ""          # Optional — set later via full editor (selectGoodResponse flow)
    next_criteria: Optional[str] = ""        # Optional — set later via full editor
    next_judge_prompt: Optional[str] = None  # Optional judge system prompt for next turn
    # When provided (selectGoodResponse flow), use for turn_data instead of session.notebook
    current_prompt: Optional[str] = None
    current_criteria: Optional[str] = None


@router.post("/advance-turn/{session_id}")
async def advance_turn(session_id: str, request: AdvanceTurnRequest):
    """
    Advance to the next turn in a multi-turn session.
    
    Takes the selected "good" response from the current turn,
    builds conversation history, and prepares the session for
    the next turn with new prompt and criteria.
    """
    session = await _get_validated_session(session_id)
    
    # Find the selected response from current results
    selected_result = None
    all_results = session.all_results + session.results
    for r in all_results:
        if r.hunt_id == request.selected_hunt_id:
            selected_result = r
            break
    
    if not selected_result:
        raise HTTPException(400, f"Hunt ID {request.selected_hunt_id} not found in session results")
    
    if not selected_result.response:
        raise HTTPException(400, f"Hunt ID {request.selected_hunt_id} has no response")
    
    current_turn = session.current_turn
    
    # Use request current_prompt/current_criteria when provided (selectGoodResponse flow)
    # so Turn 2+ history shows correctly even if session.notebook wasn't saved
    prompt_for_turn = request.current_prompt if request.current_prompt is not None else session.notebook.prompt
    criteria_for_turn = request.current_criteria if request.current_criteria is not None else session.notebook.response_reference
    
    # Save current turn data
    turn_data = TurnData(
        turn_number=current_turn,
        prompt=prompt_for_turn,
        response_reference=criteria_for_turn,
        judge_system_prompt=session.config.custom_judge_system_prompt or session.notebook.judge_system_prompt,
        selected_response=selected_result.response,
        selected_hunt_id=request.selected_hunt_id,
        judge_result={
            "score": selected_result.judge_score,
            "output": selected_result.judge_output,
            "criteria": selected_result.judge_criteria,
            "explanation": selected_result.judge_explanation,
        },
        status="completed",
        results=[r.model_dump() for r in session.results if r.status == HuntStatus.COMPLETED]
    )
    session.turns.append(turn_data)
    
    # Build conversation history: add current turn's user prompt + selected response
    session.conversation_history.append({
        "role": "user",
        "content": prompt_for_turn
    })
    session.conversation_history.append({
        "role": "assistant",
        "content": selected_result.response
    })
    
    # Advance to next turn
    session.current_turn = current_turn + 1
    
    # Update notebook with new turn's prompt and criteria
    session.notebook.prompt = request.next_prompt or ""
    session.notebook.response_reference = request.next_criteria or ""
    session.notebook.response = selected_result.response
    if request.next_judge_prompt is not None:
        session.notebook.judge_system_prompt = request.next_judge_prompt
        session.config.custom_judge_system_prompt = request.next_judge_prompt
    
    # Update config conversation history (used by hunt engine for model calls)
    session.config.conversation_history = list(session.conversation_history)
    
    # Mark notebook as multi-turn
    session.notebook.is_multi_turn = True
    
    # Reset current run results for the new turn
    session.results = []
    session.all_results = []
    session.completed_hunts = 0
    session.breaks_found = 0
    session.status = HuntStatus.PENDING
    
    # Persist to Redis (granular writes)
    try:
        await redis_store.set_config(session_id, session.config)
        await redis_store.set_notebook(session_id, session.notebook)
        await redis_store.set_status(session_id, session.status)
        await redis_store.set_conversation_history(session_id, session.conversation_history)
        await redis_store.set_current_turn(session_id, session.current_turn)
        await redis_store.set_hunt_counters(session_id, total_hunts=0, completed_hunts=0, breaks_found=0)
        await redis_store.clear_results(session_id)
        await redis_store.clear_all_results(session_id)
        if turn_data:
            await redis_store.append_turn(session_id, turn_data)
    except Exception as e:
        logger.error(f"Failed to persist session after turn advance: {e}")

    # Also persist to disk storage
    try:
        storage = get_session_storage(session_id)
        if storage:
            storage["session_data"] = session.model_dump()
            save_session_storage(session_id, storage)
    except Exception as e:
        logger.error(f"Failed to persist to disk after turn advance: {e}")
    
    logger.info(f"Session {session_id}: Advanced to turn {session.current_turn} "
                f"(history: {len(session.conversation_history)} messages)")
    
    return {
        "success": True,
        "session_id": session_id,
        "current_turn": session.current_turn,
        "conversation_history_length": len(session.conversation_history),
        "turns_completed": len(session.turns),
        "prompt": session.notebook.prompt,
        "response_reference": session.notebook.response_reference,
    }


@router.post("/mark-breaking/{session_id}")
async def mark_breaking(session_id: str):
    """
    Mark the current turn as the breaking turn.
    
    This enters the standard review/selection flow.
    The trainer will then do blind human review of the 
    worst responses from this turn.
    """
    session = await _get_validated_session(session_id)
    
    current_turn = session.current_turn
    
    # Save current turn data with "breaking" status
    turn_data = TurnData(
        turn_number=current_turn,
        prompt=session.notebook.prompt,
        response_reference=session.notebook.response_reference,
        judge_system_prompt=session.config.custom_judge_system_prompt or session.notebook.judge_system_prompt,
        status="breaking",
        results=[r.model_dump() for r in session.results if r.status == HuntStatus.COMPLETED]
    )
    session.turns.append(turn_data)
    session.notebook.is_multi_turn = len(session.turns) > 1
    
    # Persist to Redis
    try:
        await redis_store.set_notebook(session_id, session.notebook)
        await redis_store.append_turn(session_id, turn_data)
    except Exception as e:
        logger.error(f"Failed to persist session after mark-breaking: {e}")

    logger.info(f"Session {session_id}: Turn {current_turn} marked as breaking "
                f"(total turns: {len(session.turns)})")
    
    return {
        "success": True,
        "session_id": session_id,
        "breaking_turn": current_turn,
        "total_turns": len(session.turns),
        "is_multi_turn": session.notebook.is_multi_turn,
    }


@router.get("/turn-status/{session_id}")
async def get_turn_status(session_id: str):
    """
    Get current turn status, conversation history, and all past turns.
    """
    session = await _get_validated_session(session_id)
    
    return {
        "session_id": session_id,
        "current_turn": session.current_turn,
        "is_multi_turn": session.notebook.is_multi_turn if session.notebook else False,
        "conversation_history": session.conversation_history,
        "turns": [t.model_dump() for t in session.turns],
        "current_prompt": session.notebook.prompt if session.notebook else "",
        "current_criteria": session.notebook.response_reference if session.notebook else "",
        "current_judge_prompt": session.notebook.judge_system_prompt if session.notebook else "",
        "status": session.status.value,
    }
