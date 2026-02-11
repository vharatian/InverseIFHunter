"""
Hunt Engine Service

Orchestrates parallel hunts with:
- Configurable parallelism (1-16 workers)
- Progress tracking and SSE broadcasting
- Result aggregation with reasoning traces
- Redis-primary session persistence (stateless — survives restarts)
- Atomic Redis operations (no in-process locks)
- Rate-limited API calls (prevents overload)
"""
import asyncio
import uuid
import logging
from typing import List, Dict, Any, Optional, Callable
from datetime import datetime

logger = logging.getLogger(__name__)

# Telemetry import - wrapped to never fail
try:
    from services.telemetry_logger import get_telemetry
    _telemetry_enabled = True
except ImportError:
    _telemetry_enabled = False

# Rate limiter import - wrapped to never fail
try:
    from services.rate_limiter import get_rate_limiter
    _rate_limiter_enabled = True
except ImportError:
    _rate_limiter_enabled = False
    logger.warning("Rate limiter not available - API calls will not be throttled")

from models.schemas import (
    HuntConfig,
    HuntResult,
    HuntSession,
    HuntStatus,
    HuntEvent,
    ParsedNotebook,
    TurnData
)
from services.openrouter_client import get_openrouter_client
from services.openai_client import get_openai_judge_client
import services.redis_session as store
import services.event_stream as events


class HuntEngine:
    """
    Orchestrates parallel model hunts.

    Fully stateless — all session state lives in Redis.
    No in-memory session dict, no in-process locks.
    Any app instance can serve any request.
    """

    # ------------------------------------------------------------------
    # Session lifecycle (delegates to redis_session)
    # ------------------------------------------------------------------

    async def create_session(self, notebook: ParsedNotebook, config: HuntConfig) -> HuntSession:
        """Create a new hunt session in Redis."""
        session_id = str(uuid.uuid4())[:8]
        await store.create_session(session_id, notebook, config)

        # Return a HuntSession object for the caller
        return HuntSession(
            session_id=session_id,
            notebook=notebook,
            config=config,
            results=[],
            total_hunts=config.parallel_workers,
            completed_hunts=0,
            breaks_found=0,
            status=HuntStatus.PENDING
        )

    async def get_session_async(self, session_id: str) -> Optional[HuntSession]:
        """Get session from Redis. Returns None if not found."""
        return await store.get_full_session(session_id)

    # Keep sync version for backward compat (wraps async)
    def get_session(self, session_id: str) -> Optional[HuntSession]:
        """Sync wrapper — prefer get_session_async."""
        try:
            loop = asyncio.get_running_loop()
            # If we're in an async context, we can't call run_until_complete.
            # Return None and let callers use get_session_async instead.
            return None
        except RuntimeError:
            return None

    # ------------------------------------------------------------------
    # Hunt execution
    # ------------------------------------------------------------------

    async def run_hunt(self, session_id: str) -> HuntSession:
        """
        Run parallel hunts for a session.

        Reads config/notebook from Redis once, then runs workers.
        Each worker writes results directly to Redis (atomic).
        Events are published to Redis Streams (any SSE subscriber picks them up).
        """
        # Read config and notebook from Redis (read-only during hunt)
        config = await store.get_config(session_id)
        notebook = await store.get_notebook(session_id)
        if not config or not notebook:
            raise ValueError(f"Session {session_id} not found or missing config/notebook")

        # Reset counters for this run
        await store.clear_results(session_id)
        await store.set_hunt_counters(
            session_id,
            total_hunts=config.parallel_workers,
            completed_hunts=0,
            breaks_found=0
        )
        await store.set_status(session_id, HuntStatus.RUNNING)

        run_start_id = config.hunt_offset

        logger.info(f"Session {session_id}: Starting hunt run with offset {run_start_id}, "
                     f"workers={config.parallel_workers}, total_hunts={config.parallel_workers}")

        # Telemetry: Log hunt start
        if _telemetry_enabled:
            try:
                get_telemetry().log_hunt_start(
                    session_id=session_id,
                    workers=config.parallel_workers,
                    models=config.models,
                    target_breaks=config.target_breaks
                )
            except Exception:
                pass

        # Emit start event to Redis Stream
        await events.publish(session_id, HuntEvent(
            event_type="start",
            data={
                "session_id": session_id,
                "total_hunts": config.parallel_workers,
                "target_breaks": config.target_breaks,
                "run_start_id": run_start_id
            }
        ))

        # Create hunt tasks
        tasks = []
        for i in range(config.parallel_workers):
            hunt_id = run_start_id + i + 1
            model = config.models[i % len(config.models)]

            task = asyncio.create_task(
                self._run_single_hunt(
                    session_id=session_id,
                    hunt_id=hunt_id,
                    model=model,
                    config=config,
                    notebook=notebook,
                )
            )
            tasks.append(task)

        # Run all tasks to completion
        try:
            await self._run_with_early_stop(tasks)
        except Exception as e:
            await store.set_status(session_id, HuntStatus.FAILED)
            await events.publish(session_id, HuntEvent(
                event_type="error",
                data={"error": str(e)}
            ))

        # Final status
        current_status = await store.get_status(session_id)
        if current_status != HuntStatus.FAILED:
            await store.set_status(session_id, HuntStatus.COMPLETED)

        # Accumulate current results into all_results
        current_results = await store.get_results(session_id)
        for result in current_results:
            if result.status == HuntStatus.COMPLETED:
                await store.append_all_result(session_id, result)

        # Update accumulated hunt count
        new_count = config.hunt_offset + config.parallel_workers
        await store.set_accumulated_hunt_count(session_id, new_count)

        all_results = await store.get_all_results(session_id)
        meta = await store.get_meta(session_id)
        completed_hunts = int(meta.get("completed_hunts", 0))
        breaks_found = int(meta.get("breaks_found", 0))

        logger.info(f"Session {session_id}: Accumulated {len(all_results)} total results, "
                     f"total hunts now {new_count}")

        # Telemetry: Log hunt completion
        if _telemetry_enabled:
            try:
                get_telemetry().log_hunt_complete(
                    session_id=session_id,
                    completed_hunts=completed_hunts,
                    breaks_found=breaks_found,
                    success=breaks_found >= config.target_breaks
                )
            except Exception:
                pass

        # Emit complete event to Redis Stream
        await events.publish(session_id, HuntEvent(
            event_type="complete",
            data={
                "session_id": session_id,
                "completed_hunts": completed_hunts,
                "breaks_found": breaks_found,
                "success": breaks_found >= config.target_breaks,
                "total_accumulated": len(all_results)
            }
        ))

        # Return full session for the caller
        return await store.get_full_session(session_id)

    async def _run_with_early_stop(self, tasks: List[asyncio.Task]):
        """Run all tasks to completion (no early stop - per manager requirement)."""
        pending = set(tasks)

        while pending:
            done, pending = await asyncio.wait(
                pending,
                return_when=asyncio.FIRST_COMPLETED
            )

            for task in done:
                try:
                    await task
                except Exception:
                    pass

    async def _run_single_hunt(
        self,
        session_id: str,
        hunt_id: int,
        model: str,
        config: HuntConfig,
        notebook: ParsedNotebook,
    ):
        """Run a single hunt: call model, then judge. Write result to Redis."""
        result = HuntResult(
            hunt_id=hunt_id,
            model=model,
            status=HuntStatus.RUNNING
        )

        # Emit progress to Redis Stream
        await events.publish(session_id, HuntEvent(
            event_type="hunt_start",
            hunt_id=hunt_id,
            data={"model": model}
        ))

        try:
            # Step 1: Call the model
            provider = getattr(config, 'provider', 'openrouter')
            enhanced_prompt = notebook.prompt

            conversation_history = config.conversation_history or []
            messages_kwarg = {"messages": conversation_history} if conversation_history else {}

            rate_limiter = get_rate_limiter() if _rate_limiter_enabled else None

            await events.publish(session_id, HuntEvent(
                event_type="hunt_progress",
                hunt_id=hunt_id,
                data={"step": "calling_model", "message": f"🔄 Calling {provider}..."}
            ))

            if provider == 'fireworks':
                from services.fireworks_client import get_fireworks_client
                client = get_fireworks_client()
                if rate_limiter:
                    async with rate_limiter.acquire("fireworks"):
                        response, reasoning, error = await client.call_with_retry(
                            prompt=enhanced_prompt, model=model,
                            max_retries=config.max_retries, **messages_kwarg
                        )
                else:
                    response, reasoning, error = await client.call_with_retry(
                        prompt=enhanced_prompt, model=model,
                        max_retries=config.max_retries, **messages_kwarg
                    )
            else:
                client = get_openrouter_client()
                if rate_limiter:
                    async with rate_limiter.acquire("openrouter"):
                        response, reasoning, error = await client.call_with_retry(
                            prompt=enhanced_prompt, model=model,
                            max_retries=config.max_retries,
                            reasoning_budget_percent=config.reasoning_budget_percent,
                            **messages_kwarg
                        )
                else:
                    response, reasoning, error = await client.call_with_retry(
                        prompt=enhanced_prompt, model=model,
                        max_retries=config.max_retries,
                        reasoning_budget_percent=config.reasoning_budget_percent,
                        **messages_kwarg
                    )

            if not error:
                await events.publish(session_id, HuntEvent(
                    event_type="hunt_progress",
                    hunt_id=hunt_id,
                    data={"step": "received_response", "message": "📥 Response received"}
                ))

            if error:
                result.status = HuntStatus.FAILED
                result.judge_score = None
                result.is_breaking = False
                result.error = f"⚠️ Model failed after 3 tries: {error}"
                result.response = ""
                result.reasoning_trace = reasoning or ""
            elif not response or not response.strip():
                result.status = HuntStatus.FAILED
                result.judge_score = None
                result.is_breaking = False
                result.error = "⚠️ Model returned empty response (possible timeout or token limit exceeded)"
                result.response = ""
                result.reasoning_trace = reasoning or ""
            else:
                result.response = response
                result.reasoning_trace = reasoning

                await events.publish(session_id, HuntEvent(
                    event_type="hunt_progress",
                    hunt_id=hunt_id,
                    data={"step": "judging", "message": "⚖️ Judging response..."}
                ))

                # Step 2: Judge the response
                await self._judge_response(config, notebook, result)

        except Exception as e:
            result.status = HuntStatus.FAILED
            result.judge_score = None
            result.is_breaking = False
            result.error = f"⚠️ Error: {str(e)}"
            result.response = ""

        # Write result to Redis (atomic RPUSH)
        await store.append_result(session_id, result)

        # Update counters atomically in Redis (no locks needed)
        completed = await store.incr_completed_hunts(session_id)
        breaks = 0
        if result.is_breaking:
            breaks = await store.incr_breaks_found(session_id)
        else:
            meta = await store.get_meta(session_id)
            breaks = int(meta.get("breaks_found", 0))

        total_meta = await store.get_meta(session_id)
        total = int(total_meta.get("total_hunts", 0))

        # Telemetry
        if _telemetry_enabled:
            try:
                get_telemetry().log_hunt_result(
                    session_id=session_id,
                    hunt_id=result.hunt_id,
                    model=result.model,
                    score=result.judge_score,
                    is_breaking=result.is_breaking,
                    error=result.error,
                    response_preview=result.response,
                    reasoning_preview=result.reasoning_trace,
                    criteria=result.judge_criteria,
                    judge_explanation=result.judge_explanation
                )
            except Exception:
                pass

        # Emit result to Redis Stream
        await events.publish(session_id, HuntEvent(
            event_type="hunt_result",
            hunt_id=result.hunt_id,
            data={
                "status": result.status.value,
                "score": result.judge_score,
                "is_breaking": result.is_breaking,
                "error": result.error,
                "response": result.response,
                "reasoning_trace": result.reasoning_trace,
                "model": result.model,
                "completed": completed,
                "total": total,
                "breaks": breaks
            }
        ))

    async def _judge_response(self, config: HuntConfig, notebook: ParsedNotebook, result: HuntResult):
        """Judge a model response using GPT-5 with rate limiting."""
        try:
            judge = get_openai_judge_client()

            judge_system = config.custom_judge_system_prompt or notebook.judge_system_prompt

            rate_limiter = get_rate_limiter() if _rate_limiter_enabled else None

            async def make_judge_call():
                return await judge.judge_response(
                    prompt=notebook.prompt,
                    student_response=result.response,
                    response_reference=notebook.response_reference,
                    judge_system_prompt=judge_system,
                    judge_prompt_template=notebook.judge_prompt_template,
                    model=config.judge_model,
                    independent_judging=True,
                    standard_response=notebook.response
                )

            if rate_limiter:
                async with rate_limiter.acquire("openai"):
                    judge_result = await make_judge_call()
            else:
                judge_result = await make_judge_call()

            result.judge_score = judge_result.get("score")

            # Retry judge if score is None
            retry_count = 0
            while result.judge_score is None and retry_count < 3:
                retry_count += 1
                logger.warning(f"Judge returned None score for Hunt {result.hunt_id}, retrying ({retry_count}/3)...")

                if rate_limiter:
                    async with rate_limiter.acquire("openai"):
                        judge_result = await make_judge_call()
                else:
                    judge_result = await make_judge_call()

                result.judge_score = judge_result.get("score")

            if result.judge_score is None:
                logger.warning(f"Judge failed after retries for Hunt {result.hunt_id}")
                logger.warning(f"Raw Judge Output: {judge_result.get('raw_output', '')[:500]}...")

            result.judge_output = judge_result.get("raw_output", "")
            result.judge_criteria = judge_result.get("criteria", {})
            result.judge_explanation = judge_result.get("explanation", "")

            result.is_breaking = result.judge_score == 0
            result.status = HuntStatus.COMPLETED

            if judge_result.get("error"):
                result.error = judge_result["error"]

        except Exception as e:
            result.error = f"Judge error: {str(e)}"
            result.status = HuntStatus.FAILED

    # ------------------------------------------------------------------
    # Result queries (read from Redis)
    # ------------------------------------------------------------------

    async def get_breaking_results_async(self, session_id: str) -> List[HuntResult]:
        """Get all breaking (score 0) results from a session."""
        all_results = await self._get_all_accumulated_results_async(session_id)
        return [r for r in all_results if r.is_breaking]

    # Sync wrapper for backward compat
    def get_breaking_results(self, session_id: str) -> List[HuntResult]:
        """Sync wrapper — returns empty list. Use get_breaking_results_async."""
        return []

    async def _get_all_accumulated_results_async(self, session_id: str) -> List[HuntResult]:
        """Get all accumulated results including current run."""
        all_accumulated = await store.get_all_results(session_id)
        existing_ids = {r.hunt_id for r in all_accumulated}
        current_results = await store.get_results(session_id)
        current_completed = [r for r in current_results
                             if r.status == HuntStatus.COMPLETED and r.hunt_id not in existing_ids]
        return all_accumulated + current_completed

    async def get_selected_for_review_async(self, session_id: str, target_count: int = 4) -> List[HuntResult]:
        """Select responses for human review."""
        all_results = await self._get_all_accumulated_results_async(session_id)

        completed = [r for r in all_results if r.status == HuntStatus.COMPLETED and r.judge_score is not None]
        failed = [r for r in completed if r.judge_score == 0]
        passed = [r for r in completed if r.judge_score >= 1]

        selected = []
        selected.extend(failed[:target_count])
        if len(selected) < target_count:
            remaining = target_count - len(selected)
            selected.extend(passed[:remaining])

        return selected

    # Sync wrapper for backward compat
    def get_selected_for_review(self, session_id: str, target_count: int = 4) -> List[HuntResult]:
        """Sync wrapper — returns empty list. Use get_selected_for_review_async."""
        return []

    async def export_results_async(self, session_id: str) -> List[Dict[str, Any]]:
        """Export ALL accumulated results for notebook export."""
        all_results = await self._get_all_accumulated_results_async(session_id)

        return [
            {
                "hunt_id": r.hunt_id,
                "model": r.model,
                "response": r.response,
                "reasoning_trace": r.reasoning_trace,
                "judge_output": r.judge_output,
                "judge_score": r.judge_score,
                "judge_criteria": r.judge_criteria,
                "judge_explanation": r.judge_explanation,
                "score": r.judge_score,
                "is_breaking": r.is_breaking
            }
            for r in all_results
        ]

    # Sync wrapper for backward compat
    def export_results(self, session_id: str) -> List[Dict[str, Any]]:
        """Sync wrapper — returns empty list. Use export_results_async."""
        return []


# Singleton instance
hunt_engine = HuntEngine()
