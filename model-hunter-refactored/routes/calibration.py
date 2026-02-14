"""
Calibration Routes

POST /api/generate-single/{session_id}   — generate single model response (no judging)
POST /api/judge-calibration/{session_id} — judge a specific response text
POST /api/judge-reference/{session_id}   — judge the reference response
"""
import re
import json
import logging

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel

from services.notebook_parser import notebook_parser
from storage.session_storage import get_session_storage
from helpers.shared import _get_validated_session, _format_judge_result
import services.redis_session as redis_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["calibration"])


class JudgeCalibrateRequest(BaseModel):
    """Request to judge a specific response text for calibration."""
    response_text: str


class GenerateSingleRequest(BaseModel):
    """Optional overrides for generate-single (Turn 1 test prompt)."""
    model: str | None = None
    provider: str | None = None
    prompt: str | None = None  # Use DOM prompt if not saved yet


@router.post("/judge-reference/{session_id}")
async def judge_reference(session_id: str):
    """Judge the original reference response to verify it's correct."""
    session = await _get_validated_session(session_id)
    
    # Re-fetch notebook from Colab to get latest response_reference
    # CRITICAL: Only re-fetch for Turn 1. In multi-turn mode (turn > 1),
    # advance_turn has already updated session.notebook with the new turn's
    # prompt, criteria, response, and judge prompt. Re-fetching from Colab
    # would OVERWRITE these with the original Turn 1 data.
    storage = get_session_storage(session_id)
    old_ref = session.notebook.response_reference[:100] if session.notebook.response_reference else "empty"
    
    if session.current_turn > 1:
        logger.info(f"Session {session_id}: Turn {session.current_turn} — skipping Colab re-fetch "
                    f"(using advance_turn data: prompt='{session.notebook.prompt[:80]}...', "
                    f"criteria='{session.notebook.response_reference[:80]}...')")
    elif storage and "url" in storage:
        try:
            parsed, _ = await notebook_parser.load_from_url(storage["url"])
            original_ref = session.notebook.response_reference
            if original_ref and parsed.response_reference != original_ref:
                logger.debug(f" response_reference changed in Colab. Original length: {len(original_ref)}, New length: {len(parsed.response_reference)}")
                logger.debug(f" Original (first 200 chars): {original_ref[:200]}...")
                logger.debug(f" New (first 200 chars): {parsed.response_reference[:200]}...")
            session.notebook = parsed
            await redis_store.set_notebook(session_id, parsed)
            ref = session.notebook.response_reference or ""
            array_match = re.search(r'\[.*?\]', ref, re.DOTALL)
            criteria_count = 0
            criteria_ids = []
            if array_match:
                try:
                    criteria_list = json.loads(array_match.group(0))
                    if isinstance(criteria_list, list):
                        criteria_count = len(criteria_list)
                        criteria_ids = [item.get('id', f'C{i+1}') if isinstance(item, dict) else f'C{i+1}' 
                                       for i, item in enumerate(criteria_list)]
                except Exception as parse_err:
                    logger.debug(f" Could not parse criteria list: {parse_err}")
            new_ref = ref[:100] if ref else "empty"
            logger.debug(f" Refreshed notebook from Colab for session {session_id}.")
            logger.debug(f" Old response_reference (first 100 chars): {old_ref}...")
            logger.debug(f" New response_reference (first 100 chars): {new_ref}...")
            logger.debug(f" Found {criteria_count} criteria: {criteria_ids}")
        except Exception as e:
            logger.warning(f"Could not refresh notebook from Colab: {e}. Using cached version.")
            import traceback
            traceback.print_exc()
    else:
        logger.warning(f"No storage URL found for session {session_id}. Cannot refresh from Colab.")
    
    notebook = session.notebook
    
    if not notebook.response:
        raise HTTPException(400, "No expected response available in notebook - add a **[response]** cell")
    
    try:
        from services.openai_client import get_openai_judge_client
        judge = get_openai_judge_client()
        
        ref_to_judge = notebook.response_reference or ""
        logger.debug(f" judge_reference - About to call judge with response_reference (first 500 chars): {ref_to_judge[:500]}...")
        array_match = re.search(r'\[.*?\]', ref_to_judge, re.DOTALL)
        if array_match:
            try:
                criteria_list = json.loads(array_match.group(0))
                if isinstance(criteria_list, list):
                    criteria_ids_in_ref = [item.get('id', f'C{i+1}') if isinstance(item, dict) else f'C{i+1}' 
                                          for i, item in enumerate(criteria_list)]
                    logger.debug(f" judge_reference - Criteria IDs in response_reference being sent to judge: {criteria_ids_in_ref}")
            except Exception as e:
                logger.debug(f" judge_reference - Could not parse criteria from response_reference: {e}")
        
        judge_result = await judge.judge_response(
            prompt=notebook.prompt,
            student_response=notebook.response,
            response_reference=notebook.response_reference,
            judge_system_prompt=notebook.judge_system_prompt,
            judge_prompt_template=notebook.judge_prompt_template,
            model="gpt-5",
            standard_response=notebook.response
        )
        
        logger.debug(f" judge_reference - Judge returned criteria: {list(judge_result.get('criteria', {}).keys())}")
        
        return _format_judge_result(judge_result, notebook)
    except Exception as e:
        raise HTTPException(500, f"Judge error: {str(e)}")


@router.post("/generate-single/{session_id}")
async def generate_single(session_id: str, request: GenerateSingleRequest | None = Body(default=None)):
    """
    Generate a single model response for calibration (Turn 2+) or test prompt (Turn 1). No judging.
    Uses request body model/provider if provided; otherwise session config.
    """
    session = await _get_validated_session(session_id)

    prompt = (
        request.prompt
        if request and request.prompt is not None
        else (session.notebook.prompt if session.notebook else "")
    )
    if not prompt or not prompt.strip():
        raise HTTPException(400, "No prompt set. Please write a prompt first.")

    provider = (
        request.provider
        if request and request.provider is not None
        else getattr(session.config, 'provider', 'openrouter')
    )
    model = (
        request.model
        if request and request.model is not None
        else (session.config.models[0] if session.config.models else "qwen/qwen3-235b-a22b-thinking-2507")
    )
    conversation_history = session.config.conversation_history or []

    try:
        messages_kwarg = {"messages": conversation_history} if conversation_history else {}

        if provider == 'fireworks':
            from services.fireworks_client import get_fireworks_client
            client = get_fireworks_client()
        else:
            from services.openrouter_client import get_openrouter_client
            client = get_openrouter_client()

        response_text, reasoning, error = await client.call_with_retry(
            prompt=prompt,
            model=model,
            max_retries=session.config.max_retries,
            reasoning_budget_percent=session.config.reasoning_budget_percent if provider != 'fireworks' else None,
            **messages_kwarg
        )

        if error:
            raise HTTPException(500, f"Model error: {error}")

        return {
            "success": True,
            "response": response_text or "",
            "reasoning": reasoning or "",
            "model": model,
            "provider": provider,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Generation error: {str(e)}")


@router.post("/judge-calibration/{session_id}")
async def judge_calibration(session_id: str, request: JudgeCalibrateRequest):
    """
    Judge a specific response text against current session criteria.
    For the calibration re-judge loop — judges request.response_text
    instead of notebook.response.
    Returns same format as judge_reference.
    """
    session = await _get_validated_session(session_id)

    notebook = session.notebook
    if not notebook:
        raise HTTPException(400, "No notebook data in session")

    if not request.response_text:
        raise HTTPException(400, "No response text provided to judge")

    try:
        from services.openai_client import get_openai_judge_client
        judge = get_openai_judge_client()

        judge_result = await judge.judge_response(
            prompt=notebook.prompt,
            student_response=request.response_text,
            response_reference=notebook.response_reference,
            judge_system_prompt=notebook.judge_system_prompt,
            judge_prompt_template=notebook.judge_prompt_template,
            model="gpt-5",
            standard_response=request.response_text
        )

        return _format_judge_result(judge_result, notebook)
    except Exception as e:
        raise HTTPException(500, f"Judge calibration error: {str(e)}")
