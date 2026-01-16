"""
Hunt Engine Service

Orchestrates parallel hunts with:
- Configurable parallelism (1-16 workers)
- Progress tracking and SSE broadcasting
- Early termination when target breaks found
- Result aggregation with reasoning traces
"""
import asyncio
import uuid
from typing import List, Dict, Any, Optional, AsyncGenerator, Callable
from datetime import datetime

from models.schemas import (
    HuntConfig, 
    HuntResult, 
    HuntSession, 
    HuntStatus,
    HuntEvent,
    ParsedNotebook
)
from services.openrouter_client import get_openrouter_client
from services.openai_client import get_openai_judge_client


class HuntEngine:
    """Orchestrates parallel model hunts with progress tracking."""
    
    def __init__(self):
        self.sessions: Dict[str, HuntSession] = {}
        self._event_callbacks: Dict[str, List[Callable]] = {}
        self._session_locks: Dict[str, asyncio.Lock] = {}  # Lock per session for atomic updates
    
    def create_session(self, notebook: ParsedNotebook, config: HuntConfig) -> HuntSession:
        """Create a new hunt session."""
        session_id = str(uuid.uuid4())[:8]
        
        session = HuntSession(
            session_id=session_id,
            notebook=notebook,
            config=config,
            results=[],
            total_hunts=config.parallel_workers,
            completed_hunts=0,
            breaks_found=0,
            status=HuntStatus.PENDING
        )
        
        self.sessions[session_id] = session
        self._session_locks[session_id] = asyncio.Lock()  # Create lock for this session
        return session
    
    def get_session(self, session_id: str) -> Optional[HuntSession]:
        """Get session by ID."""
        return self.sessions.get(session_id)
    
    async def run_hunt(
        self,
        session_id: str,
        progress_callback: Optional[Callable[[HuntEvent], None]] = None
    ) -> HuntSession:
        """
        Run parallel hunts for a session.
        
        Args:
            session_id: Session ID to run
            progress_callback: Optional callback for progress updates
        
        Returns:
            Updated session with results
        """
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")
        
        # RESET session counters for new run
        session.completed_hunts = 0
        session.breaks_found = 0
        session.results = []
        session.status = HuntStatus.RUNNING
        
        # Emit start event
        if progress_callback:
            await progress_callback(HuntEvent(
                event_type="start",
                data={
                    "session_id": session_id,
                    "total_hunts": session.total_hunts,
                    "target_breaks": session.config.target_breaks
                }
            ))
        
        # Create hunt tasks
        tasks = []
        for i in range(session.config.parallel_workers):
            hunt_id = i + 1
            model = session.config.models[i % len(session.config.models)]
            
            # Initialize result placeholder
            result = HuntResult(
                hunt_id=hunt_id,
                model=model,
                status=HuntStatus.PENDING
            )
            session.results.append(result)
            
            # Create task
            task = asyncio.create_task(
                self._run_single_hunt(
                    session=session,
                    result=result,
                    progress_callback=progress_callback
                )
            )
            tasks.append(task)
        
        # Run tasks with early termination check
        try:
            await self._run_with_early_stop(
                tasks=tasks,
                session=session,
                progress_callback=progress_callback
            )
        except Exception as e:
            session.status = HuntStatus.FAILED
            if progress_callback:
                await progress_callback(HuntEvent(
                    event_type="error",
                    data={"error": str(e)}
                ))
        
        # Final status
        if session.status != HuntStatus.FAILED:
            session.status = HuntStatus.COMPLETED
        
        # Emit complete event
        if progress_callback:
            await progress_callback(HuntEvent(
                event_type="complete",
                data={
                    "session_id": session_id,
                    "completed_hunts": session.completed_hunts,
                    "breaks_found": session.breaks_found,
                    "success": session.breaks_found >= session.config.target_breaks
                }
            ))
        
        return session
    
    async def _run_with_early_stop(
        self,
        tasks: List[asyncio.Task],
        session: HuntSession,
        progress_callback: Optional[Callable]
    ):
        """Run all tasks to completion (no early stop - per manager requirement)."""
        pending = set(tasks)
        
        while pending:
            # Wait for any task to complete
            done, pending = await asyncio.wait(
                pending,
                return_when=asyncio.FIRST_COMPLETED
            )
            
            # Process completed tasks
            for task in done:
                try:
                    await task
                except Exception as e:
                    # Error handled in _run_single_hunt
                    pass
            
            # NOTE: No early stop - we run ALL hunts even if target is reached
            # This is per manager requirement: need 4 responses total
    
    async def _run_single_hunt(
        self,
        session: HuntSession,
        result: HuntResult,
        progress_callback: Optional[Callable]
    ):
        """Run a single hunt: call model, then judge."""
        result.status = HuntStatus.RUNNING
        
        # Emit progress
        if progress_callback:
            await progress_callback(HuntEvent(
                event_type="hunt_start",
                hunt_id=result.hunt_id,
                data={"model": result.model}
            ))
        
        try:
            # Step 1: Call the model based on provider
            provider = getattr(session.config, 'provider', 'openrouter')
            
            # Wrap prompt with explanation request
            enhanced_prompt = (
                f"{session.notebook.prompt}\n\n"
                f"---\n"
                f"IMPORTANT: After providing your response, also include a section titled "
                f"'### Explanation' where you explain your reasoning and thought process "
                f"for arriving at this response. This explanation is mandatory."
            )
            
            if provider == 'fireworks':
                from services.fireworks_client import get_fireworks_client
                fireworks = get_fireworks_client()
                response, reasoning, error = await fireworks.call_with_retry(
                    prompt=enhanced_prompt,
                    model=result.model,
                    max_retries=session.config.max_retries
                    # No reasoning budget for Fireworks currently
                )
            else:
                # Default to OpenRouter
                openrouter = get_openrouter_client()
                response, reasoning, error = await openrouter.call_with_retry(
                    prompt=enhanced_prompt,
                    model=result.model,
                    max_retries=session.config.max_retries,
                    reasoning_budget_percent=session.config.reasoning_budget_percent
                )
            
            if error:
                # Model failed to respond after retries = FAILED (not breaking)
                # Don't count as a break - just an error
                result.status = HuntStatus.FAILED
                result.judge_score = None  # No score, not a break
                result.is_breaking = False
                result.error = f"⚠️ Model failed after 3 tries: {error}"
                result.response = ""
            else:
                result.response = response
                result.reasoning_trace = reasoning
                
                # Step 2: Judge the response
                await self._judge_response(session, result)
            
        except Exception as e:
            # Exception = FAILED (not breaking)
            result.status = HuntStatus.FAILED
            result.judge_score = None  # No score, not a break
            result.is_breaking = False
            result.error = f"⚠️ Error: {str(e)}"
            result.response = ""
        
        # Update session stats atomically using lock
        lock = self._session_locks.get(session.session_id)
        if lock:
            async with lock:
                session.completed_hunts += 1
                if result.is_breaking:
                    session.breaks_found += 1
                
                completed = session.completed_hunts
                total = session.total_hunts
                breaks = session.breaks_found
        else:
            # Fallback if no lock (shouldn't happen)
            session.completed_hunts += 1
            if result.is_breaking:
                session.breaks_found += 1
            completed = session.completed_hunts
            total = session.total_hunts
            breaks = session.breaks_found
        
        # Emit result (outside lock to avoid deadlock)
        if progress_callback:
            await progress_callback(HuntEvent(
                event_type="hunt_result",
                hunt_id=result.hunt_id,
                data={
                    "status": result.status.value,
                    "score": result.judge_score,
                    "is_breaking": result.is_breaking,
                    "error": result.error,
                    "response": result.response,  # Include response for blind judging
                    "reasoning_trace": result.reasoning_trace,  # Include reasoning
                    "completed": completed,
                    "total": total,
                    "breaks": breaks
                }
            ))
    
    async def _judge_response(self, session: HuntSession, result: HuntResult):
        """Judge a model response using GPT-5."""
        try:
            judge = get_openai_judge_client()
            
            # Use custom judge prompt if provided
            judge_system = session.config.custom_judge_system_prompt or session.notebook.judge_system_prompt
            
            judge_result = await judge.judge_response(
                prompt=session.notebook.prompt,
                student_response=result.response,
                response_reference=session.notebook.response_reference,
                judge_system_prompt=judge_system,
                judge_prompt_template=session.notebook.judge_prompt_template,
                model=session.config.judge_model,
                independent_judging=getattr(session.config, 'independent_judging', False)
            )
            
            result.judge_score = judge_result.get("score")
            
            # Retry judge if score is None (unparsed)
            retry_count = 0
            while result.judge_score is None and retry_count < 3:
                retry_count += 1
                print(f"WARNING: Judge returned None score for Hunt {result.hunt_id}, retrying ({retry_count}/3)...")
                judge_result = await judge.judge_response(
                    prompt=session.notebook.prompt,
                    student_response=result.response,
                    response_reference=session.notebook.response_reference,
                    judge_system_prompt=judge_system,
                    judge_prompt_template=session.notebook.judge_prompt_template,
                    model=session.config.judge_model
                )
                result.judge_score = judge_result.get("score")
            
            if result.judge_score is None:
                print(f"WARNING: Judge failed after retries for Hunt {result.hunt_id}")
                print(f"Raw Judge Output: {judge_result.get('raw_output', '')[:500]}...")
            
            result.judge_output = judge_result.get("raw_output", "")
            result.judge_criteria = judge_result.get("criteria", {})
            result.judge_explanation = judge_result.get("explanation", "")
            
            # Score 0 = model breaking
            result.is_breaking = result.judge_score == 0
            result.status = HuntStatus.COMPLETED
            
            if judge_result.get("error"):
                result.error = judge_result["error"]
            
        except Exception as e:
            result.error = f"Judge error: {str(e)}"
            result.status = HuntStatus.FAILED
    
    def get_breaking_results(self, session_id: str) -> List[HuntResult]:
        """Get all breaking (score 0) results from a session."""
        session = self.sessions.get(session_id)
        if not session:
            return []
        return [r for r in session.results if r.is_breaking]
    
    def get_selected_for_review(self, session_id: str, target_count: int = 4) -> List[HuntResult]:
        """
        Select responses for human review. Priority:
        - All failed (score 0) if we have 4+ failed
        - Otherwise: 3 failed + 1 passed
        - If fewer failed, include more passed to reach target_count
        
        Only includes completed results (not errors).
        """
        session = self.sessions.get(session_id)
        if not session:
            return []
        
        # Separate completed results by score
        completed = [r for r in session.results if r.status == HuntStatus.COMPLETED and r.judge_score is not None]
        failed = [r for r in completed if r.judge_score == 0]  # Score 0 = failed/breaking
        passed = [r for r in completed if r.judge_score >= 1]  # Score 1+ = passed
        
        selected = []
        
        # Priority 1: Take up to target_count failed responses
        selected.extend(failed[:target_count])
        
        # Priority 2: If we don't have enough, add passed responses
        if len(selected) < target_count:
            remaining = target_count - len(selected)
            selected.extend(passed[:remaining])
        
        return selected
    
    def export_results(self, session_id: str) -> List[Dict[str, Any]]:
        """Export results in format suitable for notebook export."""
        session = self.sessions.get(session_id)
        if not session:
            return []
        
        return [
            {
                "hunt_id": r.hunt_id,
                "model": r.model,
                "response": r.response,
                "reasoning_trace": r.reasoning_trace,
                "judge_output": r.judge_output,
                "score": r.judge_score,
                "is_breaking": r.is_breaking
            }
            for r in session.results
            if r.status == HuntStatus.COMPLETED
        ]


# Singleton instance
hunt_engine = HuntEngine()
