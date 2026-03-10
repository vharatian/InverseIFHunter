"""
Calibration Routes

POST /api/generate-single/{session_id}              — generate single model response (no judging)
POST /api/generate-single-stream/{session_id}        — SSE streaming version of the above
POST /api/judge-calibration/{session_id}             — judge a specific response text
POST /api/judge-reference/{session_id}               — judge the reference response
POST /api/judge-calibration-stream/{session_id}      — SSE streaming judge (per-criterion)
POST /api/judge-reference-stream/{session_id}        — SSE streaming reference judge (per-criterion)
"""
import re
import json
import logging

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import StreamingResponse
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
    judge_model: str | None = None
    # Optional overrides — used when calling from testbed before notebook is saved
    prompt: str | None = None
    response_reference: str | None = None  # criteria JSON / criteria string
    judge_system_prompt: str | None = None
    standard_response: str | None = None  # ideal/expected response for judge comparison


class GenerateSingleRequest(BaseModel):
    """Optional overrides for generate-single (Turn 1 test prompt)."""
    model: str | None = None
    provider: str | None = None
    prompt: str | None = None  # Use DOM prompt if not saved yet


@router.post("/judge-reference/{session_id}")
async def judge_reference(
    session_id: str,
    skip_colab_refresh: bool = Query(False, description="Use session data only; skip Colab re-fetch (e.g. from testbed)"),
):
    """Judge the original reference response to verify it's correct."""
    session = await _get_validated_session(session_id)
    
    # Re-fetch notebook from Colab to get latest response_reference
    # CRITICAL: Only re-fetch for Turn 1. In multi-turn mode (turn > 1),
    # advance_turn has already updated session.notebook with the new turn's
    # prompt, criteria, response, and judge prompt. Re-fetching from Colab
    # would OVERWRITE these with the original Turn 1 data.
    # When skip_colab_refresh=True (e.g. from testbed after save), session
    # was just updated via update-notebook-cells — Colab may be stale.
    storage = get_session_storage(session_id)
    old_ref = session.notebook.response_reference[:100] if session.notebook.response_reference else "empty"
    
    if skip_colab_refresh or session.current_turn > 1:
        reason = "skip_colab_refresh (testbed)" if skip_colab_refresh else f"Turn {session.current_turn}"
        logger.info(f"Session {session_id}: {reason} — skipping Colab re-fetch "
                    f"(using session data: prompt='{(session.notebook.prompt or '')[:80]}...', "
                    f"criteria='{(session.notebook.response_reference or '')[:80]}...')")
    elif storage and "url" in storage:
        try:
            parsed, _ = await notebook_parser.load_from_url(storage["url"])
            original_ref = session.notebook.response_reference
            if original_ref and parsed.response_reference != original_ref:
                logger.debug(f" response_reference changed in Colab. Original length: {len(original_ref)}, New length: {len(parsed.response_reference)}")
                logger.debug(f" Original (first 200 chars): {original_ref[:200]}...")
                logger.debug(f" New (first 200 chars): {parsed.response_reference[:200]}...")
            # Merge: prefer session values when Colab is empty (e.g. empty notebook, user editing in Model Hunter)
            if not (parsed.prompt or "").strip() and (session.notebook.prompt or "").strip():
                parsed.prompt = session.notebook.prompt
            if not (parsed.response or "").strip() and (session.notebook.response or "").strip():
                parsed.response = session.notebook.response
            if not (parsed.response_reference or "").strip() and (session.notebook.response_reference or "").strip():
                parsed.response_reference = session.notebook.response_reference
            if not (parsed.judge_system_prompt or "").strip() and (session.notebook.judge_system_prompt or "").strip():
                parsed.judge_system_prompt = session.notebook.judge_system_prompt
            if not (parsed.model_reasoning or "").strip() and (session.notebook.model_reasoning or "").strip():
                parsed.model_reasoning = session.notebook.model_reasoning
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
        
        judge_model = getattr(session.config, "judge_model", None)
        if not judge_model:
            raise HTTPException(400, "No judge model selected. Please select a judge model before judging.")
        judge_result = await judge.judge_response(
            prompt=notebook.prompt,
            student_response=notebook.response,
            response_reference=notebook.response_reference,
            judge_system_prompt=notebook.judge_system_prompt,
            judge_prompt_template=notebook.judge_prompt_template,
            model=judge_model,
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


@router.post("/generate-single-stream/{session_id}")
async def generate_single_stream(session_id: str, request: GenerateSingleRequest | None = Body(default=None)):
    """
    SSE streaming version of generate-single.
    Yields `event: chunk` with `{"type":"content"|"reasoning","text":"..."}`,
    then `event: done` with the full accumulated result.
    """
    session = await _get_validated_session(session_id)

    prompt = (
        request.prompt if request and request.prompt is not None
        else (session.notebook.prompt if session.notebook else "")
    )
    if not prompt or not prompt.strip():
        raise HTTPException(400, "No prompt set. Please write a prompt first.")

    provider = (
        request.provider if request and request.provider is not None
        else getattr(session.config, 'provider', 'openrouter')
    )
    model = (
        request.model if request and request.model is not None
        else (session.config.models[0] if session.config.models else "qwen/qwen3-235b-a22b-thinking-2507")
    )
    conversation_history = session.config.conversation_history or []

    async def _event_generator():
        try:
            messages_kwarg = conversation_history if conversation_history else None

            if provider == 'fireworks':
                from services.fireworks_client import get_fireworks_client
                client = get_fireworks_client()
                response_text, reasoning, error = await client.call_with_retry(
                    prompt=prompt, model=model,
                    max_retries=session.config.max_retries,
                )
                if error:
                    yield f"event: chunk\ndata: {json.dumps({'type': 'error', 'text': error})}\n\n"
                    return
                if response_text:
                    yield f"event: chunk\ndata: {json.dumps({'type': 'content', 'text': response_text})}\n\n"
                yield f"event: done\ndata: {json.dumps({'type': 'done', 'response': response_text or '', 'reasoning': reasoning or '', 'model': model, 'provider': provider})}\n\n"
            else:
                from services.openrouter_client import get_openrouter_client
                client = get_openrouter_client()
                rbp = session.config.reasoning_budget_percent if provider != 'fireworks' else 0.9
                async for chunk in client.stream_model_chunks(
                    prompt=prompt,
                    model=model,
                    max_tokens=None,
                    reasoning_budget_percent=rbp or 0.9,
                    messages=messages_kwarg,
                ):
                    chunk_type = chunk.get("type", "")
                    if chunk_type in ("content", "reasoning"):
                        yield f"event: chunk\ndata: {json.dumps(chunk)}\n\n"
                    elif chunk_type == "done":
                        chunk["provider"] = provider
                        yield f"event: done\ndata: {json.dumps(chunk)}\n\n"
                    elif chunk_type == "error":
                        yield f"event: chunk\ndata: {json.dumps(chunk)}\n\n"
                        return
        except Exception as e:
            logger.exception("Streaming generation error")
            yield f"event: chunk\ndata: {json.dumps({'type': 'error', 'text': str(e)})}\n\n"

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


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

        judge_model = request.judge_model or getattr(session.config, "judge_model", None)
        if not judge_model:
            raise HTTPException(400, "No judge model selected. Please select a judge model before judging.")

        # Use inline overrides from testbed if provided; fall back to session notebook
        effective_prompt             = request.prompt              if request.prompt              is not None else notebook.prompt
        effective_response_reference = request.response_reference  if request.response_reference  is not None else notebook.response_reference
        effective_judge_system_prompt = request.judge_system_prompt if request.judge_system_prompt is not None else notebook.judge_system_prompt

        if not effective_response_reference:
            raise HTTPException(400, "CRITICAL: Reference Answer must be VALID JSON. Error: response_reference is empty or missing")

        effective_standard_response = request.standard_response if request.standard_response is not None else notebook.response
        if not effective_standard_response or not effective_standard_response.strip():
            raise HTTPException(400, "No ideal/standard response available. Please write an ideal response before judging.")

        judge_result = await judge.judge_response(
            prompt=effective_prompt,
            student_response=request.response_text,
            response_reference=effective_response_reference,
            judge_system_prompt=effective_judge_system_prompt,
            judge_prompt_template=notebook.judge_prompt_template,
            model=judge_model,
            standard_response=effective_standard_response
        )

        return _format_judge_result(judge_result, notebook)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Judge calibration error: {str(e)}")


# ──────────────────────────────────────────────────────────────────────────────
# SSE streaming judge endpoints (per-criterion progressive results)
# ──────────────────────────────────────────────────────────────────────────────

@router.post("/judge-calibration-stream/{session_id}")
async def judge_calibration_stream(session_id: str, request: JudgeCalibrateRequest):
    """SSE streaming version of judge-calibration. Yields per-criterion results as they complete."""
    session = await _get_validated_session(session_id)
    notebook = session.notebook
    if not notebook:
        raise HTTPException(400, "No notebook data in session")
    if not request.response_text:
        raise HTTPException(400, "No response text provided to judge")

    from services.openai_client import get_openai_judge_client
    judge = get_openai_judge_client()

    judge_model = request.judge_model or getattr(session.config, "judge_model", None)
    if not judge_model:
        raise HTTPException(400, "No judge model selected. Please select a judge model before judging.")
    effective_prompt = request.prompt if request.prompt is not None else notebook.prompt
    effective_response_reference = request.response_reference if request.response_reference is not None else notebook.response_reference
    effective_judge_system_prompt = request.judge_system_prompt if request.judge_system_prompt is not None else notebook.judge_system_prompt

    if not effective_response_reference:
        raise HTTPException(400, "response_reference is empty or missing")

    effective_standard_response = request.standard_response if request.standard_response is not None else notebook.response
    if not effective_standard_response or not effective_standard_response.strip():
        raise HTTPException(400, "No ideal/standard response available. Please write an ideal response before judging.")

    async def _stream():
        try:
            async for event in judge.judge_response_streaming(
                prompt=effective_prompt,
                student_response=request.response_text,
                response_reference=effective_response_reference,
                judge_system_prompt=effective_judge_system_prompt,
                judge_prompt_template=notebook.judge_prompt_template,
                model=judge_model,
                standard_response=effective_standard_response,
            ):
                yield f"data: {json.dumps(event)}\n\n"
        except Exception as e:
            logger.exception("Streaming judge-calibration error")
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(
        _stream(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/judge-reference-stream/{session_id}")
async def judge_reference_stream(
    session_id: str,
    skip_colab_refresh: bool = Query(False),
):
    """SSE streaming version of judge-reference. Yields per-criterion results as they complete."""
    session = await _get_validated_session(session_id)

    storage = get_session_storage(session_id)
    if skip_colab_refresh or session.current_turn > 1:
        pass
    elif storage and "url" in storage:
        try:
            parsed, _ = await notebook_parser.load_from_url(storage["url"])
            if not (parsed.prompt or "").strip() and (session.notebook.prompt or "").strip():
                parsed.prompt = session.notebook.prompt
            if not (parsed.response or "").strip() and (session.notebook.response or "").strip():
                parsed.response = session.notebook.response
            if not (parsed.response_reference or "").strip() and (session.notebook.response_reference or "").strip():
                parsed.response_reference = session.notebook.response_reference
            if not (parsed.judge_system_prompt or "").strip() and (session.notebook.judge_system_prompt or "").strip():
                parsed.judge_system_prompt = session.notebook.judge_system_prompt
            if not (parsed.model_reasoning or "").strip() and (session.notebook.model_reasoning or "").strip():
                parsed.model_reasoning = session.notebook.model_reasoning
            session.notebook = parsed
            await redis_store.set_notebook(session_id, parsed)
        except Exception as e:
            logger.warning(f"Could not refresh notebook from Colab: {e}. Using cached version.")

    notebook = session.notebook
    if not notebook.response:
        raise HTTPException(400, "No expected response available in notebook")

    from services.openai_client import get_openai_judge_client
    judge = get_openai_judge_client()
    judge_model = getattr(session.config, "judge_model", None)
    if not judge_model:
        raise HTTPException(400, "No judge model selected. Please select a judge model before judging.")

    async def _stream():
        try:
            async for event in judge.judge_response_streaming(
                prompt=notebook.prompt,
                student_response=notebook.response,
                response_reference=notebook.response_reference,
                judge_system_prompt=notebook.judge_system_prompt,
                judge_prompt_template=notebook.judge_prompt_template,
                model=judge_model,
                standard_response=notebook.response,
            ):
                yield f"data: {json.dumps(event)}\n\n"
        except Exception as e:
            logger.exception("Streaming judge-reference error")
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(
        _stream(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
