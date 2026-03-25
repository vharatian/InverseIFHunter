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
from services.pg_session import save_session_pg
from helpers.shared import _get_validated_session
import services.redis_session as redis_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["multiturn"])


class AdvanceTurnRequest(BaseModel):
    """Request to advance to the next turn in a multi-turn session."""
    selected_hunt_id: Optional[int] = None   # Hunt ID of the "good" response (None = no response selected)
    ideal_response: Optional[str] = None     # Ideal response text (used when selected_hunt_id is None)
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
    # Redis lock prevents concurrent advance-turn (e.g. double-click that bypasses frontend guard)
    r = await redis_store.get_redis()
    lock_key = f"mh:lock:advance:{session_id}"
    acquired = await r.set(lock_key, "1", nx=True, ex=10)
    if not acquired:
        raise HTTPException(409, "Turn advance already in progress. Please wait.")
    try:
        return await _do_advance_turn(session_id, request)
    finally:
        await r.delete(lock_key)


async def _do_advance_turn(session_id: str, request: AdvanceTurnRequest):
    session = await _get_validated_session(session_id)
    
    # Find the selected response: either a model-generated hunt result or the ideal response
    selected_result = None
    selected_response_text = ""
    if request.selected_hunt_id is not None:
        all_results = session.all_results + session.results
        for r in all_results:
            if r.hunt_id == request.selected_hunt_id:
                selected_result = r
                break
        
        if not selected_result:
            raise HTTPException(400, f"Hunt ID {request.selected_hunt_id} not found in session results")
        
        if not selected_result.response:
            raise HTTPException(400, f"Hunt ID {request.selected_hunt_id} has no response")
        selected_response_text = selected_result.response
    elif request.ideal_response and request.ideal_response.strip():
        selected_response_text = request.ideal_response.strip()
    else:
        raise HTTPException(400, "Either select a hunt response or provide an ideal response to advance.")
    
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
        selected_response=selected_response_text,
        selected_hunt_id=request.selected_hunt_id,
        judge_result={
            "score": selected_result.judge_score if selected_result else None,
            "output": selected_result.judge_output if selected_result else None,
            "criteria": selected_result.judge_criteria if selected_result else {},
            "explanation": selected_result.judge_explanation if selected_result else "",
        } if selected_result else {},
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
        "content": selected_response_text
    })
    
    # Advance to next turn
    session.current_turn = current_turn + 1
    
    # Update notebook with new turn's prompt and criteria
    if not request.next_prompt or not request.next_prompt.strip():
        raise HTTPException(400, "Next turn prompt is required. Please write a prompt for the next turn.")
    if not request.next_criteria or not request.next_criteria.strip():
        raise HTTPException(400, "Next turn criteria is required. Please add criteria for the next turn.")
    session.notebook.prompt = request.next_prompt
    session.notebook.response_reference = request.next_criteria
    session.notebook.response = selected_response_text
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
    session.total_hunts = 0
    session.completed_hunts = 0
    session.breaks_found = 0
    session.passes_found = 0
    session.status = HuntStatus.PENDING
    
    # Persist to Redis (granular writes)
    try:
        await redis_store.set_config(session_id, session.config)
        await redis_store.set_notebook(session_id, session.notebook)
        await redis_store.set_status(session_id, session.status)
        await redis_store.set_conversation_history(session_id, session.conversation_history)
        await redis_store.set_current_turn(session_id, session.current_turn)
        await redis_store.set_hunt_counters(session_id, total_hunts=0, completed_hunts=0, breaks_found=0, passes_found=0)
        await redis_store.clear_results(session_id)
        await redis_store.clear_all_results(session_id)
        if turn_data:
            await redis_store.append_turn(session_id, turn_data)
    except Exception as e:
        logger.error(f"Failed to persist session after turn advance: {e}")

    try:
        await save_session_pg(session)
    except Exception as e:
        logger.error(f"Failed to persist session to PostgreSQL after turn advance: {e}")
    
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
        "judge_model": session.config.judge_model if session.config else "",
        "status": session.status.value,
    }
