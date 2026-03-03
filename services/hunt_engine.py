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
from services.aggregation import classify_sample, aggregate_batch
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
        Run parallel hunts for a session. Resumable.

        If called fresh: runs all hunts from scratch.
        If called as a re-claim (container died mid-hunt): checks which
        hunts already completed in Redis and only runs the remaining ones.

        Events are published to Redis Streams (any SSE subscriber picks them up).
        Called by hunt_worker, not directly by HTTP endpoints.
        """
        config = await store.get_config(session_id)
        notebook = await store.get_notebook(session_id)
        if not config or not notebook:
            raise ValueError(f"Session {session_id} not found or missing config/notebook")

        run_start_id = config.hunt_offset

        # Check for already-completed results (from a dead worker that partially finished)
        existing_results = await store.get_results(session_id)
        completed_hunt_ids = {r.hunt_id for r in existing_results}

        # Only treat as resume if existing results belong to THIS run's hunt_id range
        expected_ids = {run_start_id + i + 1 for i in range(config.parallel_workers)}
        relevant_completed = completed_hunt_ids & expected_ids
        is_resume = len(relevant_completed) > 0

        if is_resume:
            logger.info(f"Session {session_id}: RESUMING hunt — {len(relevant_completed)} results already in Redis "
                         f"(matching this run's range), hunt_ids: {relevant_completed}")
            # Don't clear results or reset counters — we're continuing
            await store.set_status(session_id, HuntStatus.RUNNING)
        else:
            # Fresh run — reset everything (clear any stale results from previous runs)
            await store.clear_results(session_id)
            await store.set_hunt_counters(
                session_id,
                total_hunts=config.parallel_workers,
                completed_hunts=0,
                breaks_found=0,
                passes_found=0,
            )
            await store.set_status(session_id, HuntStatus.RUNNING)

            logger.info(f"Session {session_id}: Starting FRESH hunt run with offset {run_start_id}, "
                         f"workers={config.parallel_workers}")

            # Telemetry
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

            # Emit start event
            await events.publish(session_id, HuntEvent(
                event_type="start",
                data={
                    "session_id": session_id,
                    "total_hunts": config.parallel_workers,
                    "target_breaks": config.target_breaks,
                    "run_start_id": run_start_id
                }
            ))

        # Build the list of hunts to run (skip already-completed ones from THIS run only)
        tasks = []
        for i in range(config.parallel_workers):
            hunt_id = run_start_id + i + 1
            model = config.models[i % len(config.models)]

            if hunt_id in relevant_completed:
                logger.info(f"Session {session_id}: Skipping hunt {hunt_id} (already completed)")
                continue

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

        if not tasks:
            logger.info(f"Session {session_id}: All hunts already completed, nothing to run")
        else:
            # Run remaining tasks
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
        passes_found = int(meta.get("passes_found", 0))
        passing_mode = getattr(config, "passing_mode", False)
        # Passing mode: no target — success when hunt completes. Break modes: success when target met.
        success = True if passing_mode else (breaks_found >= config.target_breaks)

        logger.info(f"Session {session_id}: Accumulated {len(all_results)} total results, "
                     f"total hunts now {new_count}")

        # Telemetry
        if _telemetry_enabled:
            try:
                get_telemetry().log_hunt_complete(
                    session_id=session_id,
                    completed_hunts=completed_hunts,
                    breaks_found=breaks_found,
                    success=success
                )
            except Exception:
                pass

        # Emit complete event
        await events.publish(session_id, HuntEvent(
            event_type="complete",
            data={
                "session_id": session_id,
                "completed_hunts": completed_hunts,
                "breaks_found": breaks_found,
                "passes_found": passes_found,
                "passing_mode": passing_mode,
                "success": success,
                "total_accumulated": len(all_results)
            }
        ))

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

    # ------------------------------------------------------------------
    # InverseIF episode: run batches until proceed or budget
    # ------------------------------------------------------------------

    async def _run_single_hunt_for_batch(
        self,
        session_id: str,
        hunt_id: int,
        model: str,
        config: HuntConfig,
        notebook: ParsedNotebook,
    ) -> HuntResult:
        """Run one sample: model + judge + classify. No Redis append or counter update (caller does)."""
        result = HuntResult(
            hunt_id=hunt_id,
            model=model,
            status=HuntStatus.RUNNING
        )
        await events.publish(session_id, HuntEvent(
            event_type="hunt_start",
            hunt_id=hunt_id,
            data={"model": model}
        ))
        rate_limiter = get_rate_limiter() if _rate_limiter_enabled else None
        provider = getattr(config, 'provider', 'openrouter')
        conversation_history = config.conversation_history or []
        messages_kwarg = {"messages": conversation_history} if conversation_history else {}
        pass_threshold = 1.0 if getattr(config, "passing_mode", False) else getattr(config, "pass_threshold", 0.5)
        break_mode = getattr(config, "break_mode", "ratio")

        try:
            await events.publish(session_id, HuntEvent(
                event_type="hunt_progress",
                hunt_id=hunt_id,
                data={"step": "model_thinking", "message": "Model thinking"}
            ))
            if provider == 'fireworks':
                from services.fireworks_client import get_fireworks_client
                client = get_fireworks_client()
                if rate_limiter:
                    async with rate_limiter.acquire("fireworks"):
                        response, reasoning, error = await client.call_with_retry(
                            prompt=notebook.prompt, model=model,
                            max_retries=config.max_retries, **messages_kwarg
                        )
                else:
                    response, reasoning, error = await client.call_with_retry(
                        prompt=notebook.prompt, model=model,
                        max_retries=config.max_retries, **messages_kwarg
                    )
            else:
                client = get_openrouter_client()
                if rate_limiter:
                    async with rate_limiter.acquire("openrouter"):
                        response, reasoning, error = await client.call_with_retry(
                            prompt=notebook.prompt, model=model,
                            max_retries=config.max_retries,
                            reasoning_budget_percent=config.reasoning_budget_percent,
                            **messages_kwarg
                        )
                else:
                    response, reasoning, error = await client.call_with_retry(
                        prompt=notebook.prompt, model=model,
                        max_retries=config.max_retries,
                        reasoning_budget_percent=config.reasoning_budget_percent,
                        **messages_kwarg
                    )

            if error:
                result.status = HuntStatus.FAILED
                result.judge_score = None
                result.is_breaking = False
                result.sample_label = "ERROR"
                result.error = f"⚠️ Model failed: {error}"
                result.response = ""
                result.reasoning_trace = reasoning or ""
                return result
            if not response or not response.strip():
                result.status = HuntStatus.FAILED
                result.judge_score = None
                result.is_breaking = False
                result.sample_label = "ERROR"
                result.error = "⚠️ Model returned empty response"
                result.response = ""
                result.reasoning_trace = reasoning or ""
                return result

            result.response = response
            result.reasoning_trace = reasoning or ""
            await events.publish(session_id, HuntEvent(
                event_type="hunt_progress",
                hunt_id=hunt_id,
                data={"step": "judging", "message": "Judging"}
            ))
            await self._judge_response(config, notebook, result)

            # Classify for aggregation: set sample_label, pass_rate, counts; is_breaking from label
            classified = classify_sample(
                result.judge_criteria,
                break_mode,
                pass_threshold,
            )
            result.sample_label = classified["label"]
            result.pass_rate = classified["pass_rate"]
            result.pass_count = classified.get("pass_count")
            result.fail_count = classified.get("fail_count")
            result.missing_count = classified.get("missing_count")
            result.is_breaking = result.sample_label == "BREAK"
            result.status = HuntStatus.COMPLETED
        except Exception as e:
            result.status = HuntStatus.FAILED
            result.error = f"⚠️ Error: {str(e)}"
            result.sample_label = "ERROR"
            result.is_breaking = False
        return result

    async def _run_batch(
        self,
        session_id: str,
        batch_index: int,
        config: HuntConfig,
        notebook: ParsedNotebook,
    ) -> List[HuntResult]:
        """Run exactly config.batch_size samples in parallel; hunt_id = hunt_offset + batch_index*batch_size + sample_index + 1."""
        batch_size = getattr(config, "batch_size", 4)
        tasks = []
        for sample_index in range(batch_size):
            hunt_id = config.hunt_offset + batch_index * batch_size + sample_index + 1
            model = config.models[(batch_index * batch_size + sample_index) % len(config.models)]
            tasks.append(self._run_single_hunt_for_batch(session_id, hunt_id, model, config, notebook))
        results = await asyncio.gather(*tasks)
        results_sorted = sorted(results, key=lambda r: r.hunt_id)
        for result in results_sorted:
            await store.append_result(session_id, result)
            completed = await store.incr_completed_hunts(session_id)
            if result.sample_label == "BREAK":
                await store.incr_breaks_found(session_id)
            elif result.sample_label == "PASS" and getattr(config, "passing_mode", False):
                await store.incr_passes_found(session_id)
            meta = await store.get_meta(session_id)
            total = int(meta.get("total_hunts", 0))
            breaks = int(meta.get("breaks_found", 0))
            passes = int(meta.get("passes_found", 0))
            await events.publish(session_id, HuntEvent(
                event_type="hunt_result",
                hunt_id=result.hunt_id,
                data={
                    "status": result.status.value,
                    "score": result.judge_score,
                    "is_breaking": result.is_breaking,
                    "sample_label": result.sample_label,
                    "error": result.error,
                    "response": result.response,
                    "reasoning_trace": result.reasoning_trace,
                    "model": result.model,
                    "completed": completed,
                    "total": total,
                    "breaks": breaks,
                    "passes": passes,
                }
            ))
        return results_sorted

    async def run_episode_until_proceed(self, session_id: str) -> HuntSession:
        """
        Run batches until aggregate_batch says should_proceed, or budgets (batches, samples, wall time) exceeded.
        On error_samples > 0: rehunt up to max_error_batches; if still errors set NEEDS_ATTENTION.
        """
        config = await store.get_config(session_id)
        notebook = await store.get_notebook(session_id)
        if not config or not notebook:
            raise ValueError(f"Session {session_id} not found or missing config/notebook")

        batch_size = getattr(config, "batch_size", 4)
        max_batches = getattr(config, "max_batches_per_turn", 4)
        max_samples = getattr(config, "max_total_samples", 64)
        max_wall = getattr(config, "max_wall_time_seconds", 900)
        max_error_batches = getattr(config, "max_error_batches", 2)
        run_start_id = config.hunt_offset

        await store.clear_results(session_id)
        await store.set_hunt_counters(
            session_id,
            total_hunts=batch_size * max_batches,
            completed_hunts=0,
            breaks_found=0,
            passes_found=0,
        )
        await store.set_status(session_id, HuntStatus.RUNNING)

        await events.publish(session_id, HuntEvent(
            event_type="start",
            data={
                "session_id": session_id,
                "total_hunts": batch_size * max_batches,
                "target_breaks": config.target_breaks,
                "run_start_id": run_start_id,
            }
        ))

        episode_start = datetime.utcnow()
        batch_index = 0
        error_batches_run = 0

        try:
            while True:
                if batch_index >= max_batches:
                    await store.set_status(session_id, HuntStatus.STOPPED_BUDGET)
                    await events.publish(session_id, HuntEvent(
                        event_type="complete",
                        data={
                            "session_id": session_id,
                            "reason": "max_batches_per_turn",
                            "status": HuntStatus.STOPPED_BUDGET.value,
                        }
                    ))
                    break

                total_so_far = batch_index * batch_size
                if total_so_far + batch_size > max_samples:
                    await store.set_status(session_id, HuntStatus.STOPPED_BUDGET)
                    await events.publish(session_id, HuntEvent(
                        event_type="complete",
                        data={
                            "session_id": session_id,
                            "reason": "max_total_samples",
                            "status": HuntStatus.STOPPED_BUDGET.value,
                        }
                    ))
                    break

                elapsed = (datetime.utcnow() - episode_start).total_seconds()
                if elapsed >= max_wall:
                    await store.set_status(session_id, HuntStatus.STOPPED_BUDGET)
                    await events.publish(session_id, HuntEvent(
                        event_type="complete",
                        data={
                            "session_id": session_id,
                            "reason": "max_wall_time_seconds",
                            "status": HuntStatus.STOPPED_BUDGET.value,
                        }
                    ))
                    break

                batch_results = await self._run_batch(session_id, batch_index, config, notebook)
                labels = [r.sample_label or "ERROR" for r in batch_results]
                agg = aggregate_batch(labels, config)

                await events.publish(session_id, HuntEvent(
                    event_type="batch_aggregated",
                    data={
                        "batch_index": batch_index,
                        "breaking": agg["breaking"],
                        "passing": agg["passing"],
                        "errors": agg["errors"],
                        "should_proceed": agg["should_proceed"],
                        "reason": agg["reason"],
                    }
                ))

                if agg["errors"] > 0:
                    missing_info = [
                        {"hunt_id": r.hunt_id, "reason": r.error or "MISSING criteria"}
                        for r in batch_results if r.sample_label == "ERROR"
                    ]
                    await events.publish(session_id, HuntEvent(
                        event_type="batch_warning",
                        data={"missing_ids": [x["hunt_id"] for x in missing_info], "reasons": missing_info}
                    ))
                    error_batches_run += 1
                    if error_batches_run > max_error_batches:
                        await store.set_status(session_id, HuntStatus.NEEDS_ATTENTION)
                        await events.publish(session_id, HuntEvent(
                            event_type="complete",
                            data={
                                "session_id": session_id,
                                "reason": "persistent_errors",
                                "status": HuntStatus.NEEDS_ATTENTION.value,
                            }
                        ))
                        break
                    batch_index += 1
                    continue

                if agg["should_proceed"]:
                    await store.set_status(session_id, HuntStatus.COMPLETED)
                    break

                batch_index += 1

        except Exception as e:
            await store.set_status(session_id, HuntStatus.FAILED)
            await events.publish(session_id, HuntEvent(event_type="error", data={"error": str(e)}))

        # Accumulate and final event
        current_results = await store.get_results(session_id)
        for result in current_results:
            if result.status == HuntStatus.COMPLETED:
                await store.append_all_result(session_id, result)
        new_count = config.hunt_offset + (batch_index + 1) * batch_size
        await store.set_accumulated_hunt_count(session_id, new_count)
        meta = await store.get_meta(session_id)
        all_results = await store.get_all_results(session_id)
        final_status = await store.get_status(session_id)

        await events.publish(session_id, HuntEvent(
            event_type="complete",
            data={
                "session_id": session_id,
                "completed_hunts": int(meta.get("completed_hunts", 0)),
                "breaks_found": int(meta.get("breaks_found", 0)),
                "passes_found": int(meta.get("passes_found", 0)),
                "passing_mode": getattr(config, "passing_mode", False),
                "success": True,
                "total_accumulated": len(all_results),
                "status": final_status.value,
            }
        ))
        return await store.get_full_session(session_id)

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

            # Emit "Model thinking" once — this is the long wait (API call). Skip brief "calling_model".
            await events.publish(session_id, HuntEvent(
                event_type="hunt_progress",
                hunt_id=hunt_id,
                data={"step": "model_thinking", "message": "Model thinking"}
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
                    data={"step": "received_response", "message": "Response received"}
                ))

            if error:
                result.status = HuntStatus.FAILED
                result.judge_score = None
                result.is_breaking = False
                hint = ""
                if "404" in str(error):
                    hint = f" (model '{model}' may not exist — check OpenRouter/Fireworks model IDs)"
                result.error = f"⚠️ Model failed after 3 tries: {error}{hint}"
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
                    data={"step": "judging", "message": "Judging"}
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
        meta = await store.get_meta(session_id)
        breaks = int(meta.get("breaks_found", 0))
        passes = int(meta.get("passes_found", 0))
        if result.is_breaking:
            breaks = await store.incr_breaks_found(session_id)
        elif getattr(config, "passing_mode", False) and result.judge_score == 1:
            passes = await store.incr_passes_found(session_id)

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
                "breaks": breaks,
                "passes": passes,
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
                    standard_response=notebook.response,
                    pass_threshold=1.0 if getattr(config, "passing_mode", False) else getattr(config, "pass_threshold", 0.5),
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
        """Get all accumulated results including current run (completed AND failed)."""
        all_accumulated = await store.get_all_results(session_id)
        existing_ids = {r.hunt_id for r in all_accumulated}
        current_results = await store.get_results(session_id)
        # Include ALL results (completed + failed) so response picker shows everything
        current_additional = [r for r in current_results if r.hunt_id not in existing_ids]
        return all_accumulated + current_additional

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
