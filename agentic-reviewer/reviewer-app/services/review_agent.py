"""
Reviewer-side agent: one LLM call to produce a structured review (summary, suggestions, checks).
Uses agentic_reviewer for snapshot and OpenRouter LLM. Config via reviewer.agent in global.yaml.
"""
import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from config import get_reviewer_agent_config

logger = logging.getLogger(__name__)


def _ensure_path():
    import sys
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent.parent
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))


def build_review_prompt(snapshot: Dict[str, Any]) -> str:
    """
    Build a prompt for the reviewer agent from a task snapshot.
    Asks for: summary, suggestions, and checks in a structured format.
    """
    prompt_text = (snapshot.get("prompt") or "").strip() or "(no prompt)"
    criteria = snapshot.get("criteria") or []
    criteria_text = "\n".join(
        f"- {c.get('id', '')}: {c.get('description', '')}" for c in criteria
    ) or "(no criteria)"
    selected = snapshot.get("selected_hunts") or []
    human_reviews = snapshot.get("human_reviews") or []

    slots_text = []
    for i, hunt in enumerate(selected[:4]):
        slot = i + 1
        model = hunt.get("model", "")
        response = (hunt.get("response") or "")[:500]
        if len((hunt.get("response") or "")) > 500:
            response += "..."
        grade = ""
        explanation = ""
        for hr in human_reviews:
            if str(hr.get("hunt_id")) == str(hunt.get("hunt_id", "")):
                grade = str(hr.get("grades", ""))
                explanation = (hr.get("explanation") or "")[:300]
                break
        slots_text.append(
            f"Slot {slot} (model: {model}):\n  Response: {response}\n  Human grade: {grade}\n  Explanation: {explanation}"
        )
    slots_block = "\n\n".join(slots_text) or "(no slots)"

    return f"""You are an expert reviewer helping a human reviewer evaluate a trainer task. The task involves a prompt, criteria, and 4 selected model responses that were graded by a trainer.

TASK PROMPT:
{prompt_text}

CRITERIA:
{criteria_text}

SELECTED RESPONSES AND TRAINER GRADES:
{slots_block}

Provide your review in the following structure. Use exactly these section headers.

## Summary
(2–4 sentences on overall task quality: clarity of prompt, appropriateness of criteria, quality of selected responses and trainer grading.)

## Suggestions
(Bullet list of concrete suggestions for the trainer or for improving this task. E.g. "Consider adding a criterion for X", "Slot 2 explanation could be more specific.", "Prompt could clarify Y.")

## Checks
(Bullet list of any concerns: factuality, safety, rule-following, appropriateness. Write "No concerns." if none.)

Do not add other sections. Be concise and actionable."""


def run_agent_sync(session_dict: Dict[str, Any]) -> Dict[str, Any]:
    """
    Run the reviewer agent given a session dict (snapshot built, prompt sent to LLM).
    Synchronous LLM call; invoke from API via asyncio.to_thread(sync_llm_only, session_dict).
    Returns dict: { review_text, model_used, timestamp, error? }.
    """
    _ensure_path()
    from agentic_reviewer.snapshot_builder import build_snapshot

    if not session_dict:
        return {"error": "Session not found", "review_text": "", "model_used": "", "timestamp": _now_iso()}

    try:
        snapshot = build_snapshot(session_dict, "final")
        snapshot_dict = snapshot.model_dump()
    except Exception as e:
        return {"error": f"Snapshot build failed: {e}", "review_text": "", "model_used": "", "timestamp": _now_iso()}

    prompt = build_review_prompt(snapshot_dict)
    cfg = get_reviewer_agent_config()
    model = cfg.get("model", "anthropic/claude-sonnet-4")
    max_tokens = cfg.get("max_tokens", 2048)
    timeout = cfg.get("timeout", 120.0)

    try:
        from agentic_reviewer.llm_client import call_model_sync
        review_text, err = call_model_sync(prompt, model, max_tokens=max_tokens, timeout=timeout)
        if err:
            return {"error": err, "review_text": review_text or "", "model_used": model, "timestamp": _now_iso()}
    except Exception as e:
        logger.exception("Agent LLM call failed")
        return {"error": str(e), "review_text": "", "model_used": model, "timestamp": _now_iso()}

    return {
        "review_text": review_text,
        "model_used": model,
        "timestamp": _now_iso(),
        "error": None,
    }


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
