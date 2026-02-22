"""
Agentic Reviewer — Pre-flight and Final QA routes.

Calls agentic_reviewer (lives in parent agentic-reviewer folder).
"""
import sys
import json
from pathlib import Path

# Add agentic-reviewer root to path so we can import agentic_reviewer
_agentic_root = Path(__file__).resolve().parent.parent.parent.parent
if str(_agentic_root) not in sys.path:
    sys.path.insert(0, str(_agentic_root))

import logging
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from helpers.shared import _get_validated_session
from services.hunt_engine import hunt_engine
from routes.agentic_stream import build_content_checked, build_rationale

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["agentic"])


class PreflightRequest(BaseModel):
    selected_hunt_ids: list[int]


class FinalReviewRequest(BaseModel):
    selected_hunt_ids: list[int]
    human_reviews: dict  # { "hunt_id": { "grades": {...}, "explanation": str, "submitted": bool } }


@router.post("/review-preflight/{session_id}")
async def review_preflight(session_id: str, req: PreflightRequest):
    """
    Run agentic pre-flight check before human review.
    Returns { passed, issues, checkpoint, timestamp }.
    """
    if not req.selected_hunt_ids or len(req.selected_hunt_ids) != 4:
        raise HTTPException(
            status_code=400,
            detail="Preflight requires selected_hunt_ids with exactly 4 IDs",
        )

    try:
        from agentic_reviewer import build_snapshot, run_review
    except ImportError as e:
        logger.exception("Failed to import agentic_reviewer")
        raise HTTPException(
            status_code=500,
            detail=f"Agentic reviewer not available: {e}",
        )

    session = await _get_validated_session(session_id)
    all_results = await hunt_engine.export_results_async(session_id)

    # Build session dict for agentic_reviewer (export_results_async returns list of dicts)
    session_dict = {
        "session_id": session.session_id,
        "notebook": session.notebook.model_dump() if session.notebook else {},
        "config": session.config.model_dump() if session.config else {},
        "all_results": all_results,
        "current_turn": getattr(session, "current_turn", 1),
        "human_reviews": getattr(session, "human_reviews", {}) or {},
    }

    snapshot = build_snapshot(
        session_dict,
        "preflight",
        selected_hunt_ids=req.selected_hunt_ids,
    )
    result = run_review(snapshot)

    return {
        "passed": result.passed,
        "issues": [i.model_dump() for i in result.issues],
        "checkpoint": result.checkpoint,
        "timestamp": result.timestamp,
    }


@router.post("/review-final/{session_id}")
async def review_final(session_id: str, req: FinalReviewRequest):
    """
    Run agentic final QA check before saving to Colab.
    Requires human reviews. Returns { passed, issues, checkpoint, timestamp }.
    """
    if not req.selected_hunt_ids or len(req.selected_hunt_ids) != 4:
        raise HTTPException(
            status_code=400,
            detail="Final review requires selected_hunt_ids with exactly 4 IDs",
        )
    if not req.human_reviews or len(req.human_reviews) < 4:
        raise HTTPException(
            status_code=400,
            detail="Final review requires human_reviews for all 4 selected hunts",
        )

    try:
        from agentic_reviewer import build_snapshot, run_review
    except ImportError as e:
        logger.exception("Failed to import agentic_reviewer")
        raise HTTPException(
            status_code=500,
            detail=f"Agentic reviewer not available: {e}",
        )

    session = await _get_validated_session(session_id)
    all_results = await hunt_engine.export_results_async(session_id)

    # Build human_reviews in agentic format: { "hunt_id": { grades, explanation, submitted } }
    human_reviews_for_agentic = {}
    for hid in req.selected_hunt_ids:
        key = str(hid)
        if key in req.human_reviews:
            r = req.human_reviews[key]
            grading_basis = r.get("grading_basis") or r.get("grades") or {}
            grades = {k: str(v).lower() for k, v in grading_basis.items()}
            human_reviews_for_agentic[key] = {
                "grades": grades,
                "explanation": str(r.get("explanation", "")),
                "submitted": True,
            }

    session_dict = {
        "session_id": session.session_id,
        "notebook": session.notebook.model_dump() if session.notebook else {},
        "config": session.config.model_dump() if session.config else {},
        "all_results": all_results,
        "current_turn": getattr(session, "current_turn", 1),
        "human_reviews": human_reviews_for_agentic,
    }

    snapshot = build_snapshot(session_dict, "final")
    result = run_review(snapshot)

    # Build evaluation data for UI (slot-by-slot comparison) — always include for trainer learning
    human_by_id = {r.hunt_id: r for r in snapshot.human_reviews}
    eval_slots = []
    for i, hunt in enumerate(snapshot.selected_hunts[:4], 1):
        human = human_by_id.get(hunt.hunt_id)
        llm_criteria = hunt.judge_criteria or {}
        human_grades = human.grades if human else {}
        disagreements = []
        for cid in set(llm_criteria.keys()) | set(human_grades.keys()):
            h_val = str(human_grades.get(cid, "")).lower() if human_grades.get(cid) else None
            l_val = str(llm_criteria.get(cid, "")).lower() if llm_criteria.get(cid) else None
            if h_val and l_val and h_val != l_val:
                disagreements.append({"criterion": cid, "human": h_val, "llm": l_val})
        eval_slots.append({
            "slot": i,
            "hunt_id": hunt.hunt_id,
            "model": hunt.model,
            "response_preview": (hunt.response or "")[:300],
            "human_grades": human_grades if human else {},
            "human_explanation": (human.explanation or "")[:500] if human else "",
            "llm_judge_score": hunt.judge_score,
            "llm_judge_criteria": llm_criteria,
            "llm_judge_explanation": (hunt.judge_explanation or "")[:500],
            "disagreements": disagreements,
        })
    evaluation = {
        "slots": eval_slots,
        "prompt": (snapshot.prompt or "")[:1000],
        "criteria": [{"id": c.get("id"), "description": (c.get("description") or "")[:200]} for c in snapshot.criteria],
    }

    # Ensure human_llm_grade_alignment issue has full details (slots, etc.) for evaluation page
    issues_out = []
    for i in result.issues:
        d = i.model_dump()
        if i.rule_id == "human_llm_grade_alignment":
            existing = d.get("details") or {}
            d["details"] = {**evaluation, "council_votes": existing.get("council_votes", []), **existing}
        issues_out.append(d)

    return {
        "passed": result.passed,
        "issues": issues_out,
        "checkpoint": result.checkpoint,
        "timestamp": result.timestamp,
        "evaluation": evaluation,
    }


def _get_council_prompt(rule_id, snapshot, params):
    """Get council prompt for a rule. Rules with params pass them to get_council_prompt."""
    mods = {
        "human_llm_grade_alignment": "agentic_reviewer.rules.human_llm_grade_alignment",
        "metadata_prompt_alignment": "agentic_reviewer.rules.metadata_prompt_alignment",
        "metadata_taxonomy_alignment": "agentic_reviewer.rules.metadata_taxonomy_alignment",
        "human_explanation_justifies_grade": "agentic_reviewer.rules.human_explanation_justifies_grade",
        "safety_context_aware": "agentic_reviewer.rules.safety_context_aware",
        "qc_cfa_criteria_valid": "agentic_reviewer.rules.qc_cfa_criteria_valid",
    }
    mod = __import__(mods[rule_id], fromlist=["get_council_prompt"])
    fn = getattr(mod, "get_council_prompt")
    if rule_id in ("safety_context_aware", "qc_cfa_criteria_valid"):
        return fn(snapshot, params)
    return fn(snapshot)


def _build_council_issue(rule_id, snapshot, votes, params):
    """Build ReviewIssue for a council rule that failed."""
    from agentic_reviewer.schemas import ReviewIssue, IssueSeverity
    vote_summary = ", ".join(f"{m}: {'PASS' if v else 'FAIL' if v is False else '?'}" for m, v in votes)
    council_votes = [{"model": m, "vote": "PASS" if v else "FAIL" if v is False else "unclear"} for m, v in votes]
    task_meta = (getattr(snapshot, "metadata", {}) or {}).get("task_metadata") or {}

    if rule_id == "human_llm_grade_alignment":
        human_by_id = {r.hunt_id: r for r in snapshot.human_reviews}
        slots = []
        for i, hunt in enumerate(snapshot.selected_hunts[:4], 1):
            human = human_by_id.get(hunt.hunt_id)
            llm_criteria = hunt.judge_criteria or {}
            human_grades = human.grades if human else {}
            disagreements = []
            for cid in set(llm_criteria.keys()) | set(human_grades.keys()):
                h_val = str(human_grades.get(cid, "")).lower() if human_grades.get(cid) else None
                l_val = str(llm_criteria.get(cid, "")).lower() if llm_criteria.get(cid) else None
                if h_val and l_val and h_val != l_val:
                    disagreements.append({"criterion": cid, "human": h_val, "llm": l_val})
            slots.append({
                "slot": i, "hunt_id": hunt.hunt_id, "model": hunt.model,
                "response_preview": (hunt.response or "")[:300],
                "human_grades": human_grades if human else {},
                "human_explanation": (human.explanation or "")[:500] if human else "",
                "llm_judge_score": hunt.judge_score, "llm_judge_criteria": llm_criteria,
                "llm_judge_explanation": (hunt.judge_explanation or "")[:500],
                "disagreements": disagreements,
            })
        return ReviewIssue(rule_id=rule_id, severity=IssueSeverity.ERROR,
            message=f"Council detected a significant disagreement between human and LLM grading. Votes: {vote_summary}",
            hint="Review your grades and explanations. Ensure they align with the LLM judge criteria.",
            details={"council_votes": council_votes, "slots": slots})
    if rule_id == "metadata_prompt_alignment":
        return ReviewIssue(rule_id=rule_id, severity=IssueSeverity.ERROR,
            message=f"Council detected misalignment between prompt content and claimed metadata. Votes: {vote_summary}",
            hint="Ensure the prompt content matches the Domain and Use Case in notebook metadata.",
            details={"council_votes": council_votes, "domain": task_meta.get("domain"), "use_case": task_meta.get("use_case"), "prompt_preview": (snapshot.prompt or "")[:500]})
    if rule_id == "metadata_taxonomy_alignment":
        return ReviewIssue(rule_id=rule_id, severity=IssueSeverity.ERROR,
            message=f"Council detected inconsistency between L1 Taxonomy and Domain/Use Case. Votes: {vote_summary}",
            hint="Ensure the L1 Taxonomy aligns with the Domain and Use Case in notebook metadata.",
            details={"council_votes": council_votes, "domain": task_meta.get("domain"), "use_case": task_meta.get("use_case"), "l1_taxonomy": task_meta.get("l1_taxonomy")})
    if rule_id == "human_explanation_justifies_grade":
        human_by_id = {r.hunt_id: r for r in snapshot.human_reviews}
        slots = []
        for i, h in enumerate(snapshot.selected_hunts[:4], 1):
            hr = human_by_id.get(h.hunt_id)
            slots.append({"slot": i, "grades": hr.grades if hr else {}, "explanation": (hr.explanation or "")[:300] if hr else ""})
        return ReviewIssue(rule_id=rule_id, severity=IssueSeverity.ERROR,
            message=f"Council detected generic or non-substantive explanations. Votes: {vote_summary}",
            hint="Provide concrete explanations that justify your grades.",
            details={"council_votes": council_votes, "slots": slots})
    if rule_id == "safety_context_aware":
        return ReviewIssue(rule_id=rule_id, severity=IssueSeverity.ERROR,
            message=f"Council detected prohibited content in prompt. Votes: {vote_summary}",
            hint="Revise to discuss or avoid such topics without encouraging harmful use.",
            details={"council_votes": council_votes, "prompt_preview": (snapshot.prompt or "")[:500]})
    if rule_id == "qc_cfa_criteria_valid":
        return ReviewIssue(rule_id=rule_id, severity=IssueSeverity.ERROR,
            message=f"Council detected invalid or inconsistent criteria for {task_meta.get('l1_taxonomy', '')}. Votes: {vote_summary}",
            hint="Ensure criteria are valid for QC/CFA: they may reference what's not in the prompt.",
            details={"council_votes": council_votes, "l1_taxonomy": task_meta.get("l1_taxonomy"), "criteria": [{"id": c.get("id"), "description": (c.get("description") or "")[:200]} for c in snapshot.criteria]})
    return ReviewIssue(rule_id=rule_id, severity=IssueSeverity.ERROR, message=f"Council failed. Votes: {vote_summary}", hint="", details={"council_votes": council_votes})


def _stream_review_events(snapshot):
    """Sync generator: run rules one by one, yield SSE events. Council rules stream votes live."""
    from agentic_reviewer.rule_engine import get_rules_for_checkpoint, run_rule
    from agentic_reviewer.council import run_council_streaming
    from agentic_reviewer.schemas import ReviewIssue, IssueSeverity

    issues_out = []
    evaluation = None
    rules = get_rules_for_checkpoint(snapshot.checkpoint)
    council_rules = {"human_llm_grade_alignment", "metadata_prompt_alignment", "metadata_taxonomy_alignment", "human_explanation_justifies_grade", "safety_context_aware", "qc_cfa_criteria_valid"}

    for rule_def in rules:
        rule_id = rule_def.get("id", "?")
        if not rule_id:
            continue
        params = rule_def.get("params") or {}
        desc = rule_def.get("description", rule_id)
        content_checked = build_content_checked(rule_id, snapshot)
        council_responses = {}
        votes = []
        chairman_model_id = None
        chairman_verdict_str = None
        chairman_rationale = None

        yield f"data: {json.dumps({'type': 'rule_start', 'rule_id': rule_id, 'description': desc, 'content_checked': content_checked})}\n\n"

        if rule_id in council_rules:
            try:
                prompt = _get_council_prompt(rule_id, snapshot, params)
            except ValueError as e:
                if "OPENROUTER" in str(e) or "API" in str(e):
                    issue = None
                    passed = True
                else:
                    raise
            else:
                passed = True
                for event in run_council_streaming(prompt, rule_id):
                    if event[0] == "prompt":
                        _, p = event
                        yield f"data: {json.dumps({'type': 'council_prompt', 'rule_id': rule_id, 'prompt': p})}\n\n"
                    elif event[0] == "model_start":
                        _, model_id = event
                        yield f"data: {json.dumps({'type': 'council_model_start', 'rule_id': rule_id, 'model_id': model_id})}\n\n"
                    elif event[0] == "model_chunk":
                        _, model_id, chunk = event
                        yield f"data: {json.dumps({'type': 'council_model_chunk', 'rule_id': rule_id, 'model_id': model_id, 'chunk': chunk})}\n\n"
                    elif event[0] == "model_verdict":
                        _, model_id, vote_str, full_response = event
                        council_responses[model_id] = full_response or ""
                        yield f"data: {json.dumps({'type': 'council_model_verdict', 'rule_id': rule_id, 'model_id': model_id, 'vote': vote_str, 'response': full_response})}\n\n"
                        votes.append((model_id, True if vote_str == "PASS" else False if vote_str == "FAIL" else None))
                    elif event[0] == "chairman_start":
                        _, ch_model = event
                        chairman_model_id = ch_model
                        yield f"data: {json.dumps({'type': 'council_chairman_start', 'rule_id': rule_id, 'model_id': ch_model})}\n\n"
                    elif event[0] == "chairman_verdict":
                        _, ch_passed, ch_rationale = event
                        passed = ch_passed
                        chairman_rationale = ch_rationale or ""
                        chairman_verdict_str = "PASS" if passed else "FAIL"
                        yield f"data: {json.dumps({'type': 'council_chairman_verdict', 'rule_id': rule_id, 'passed': passed, 'rationale': chairman_rationale})}\n\n"
                    elif event[0] == "complete":
                        _, passed, votes = event

                issue = None
                if not passed:
                    issue = _build_council_issue(rule_id, snapshot, votes, params)
        else:
            # Normal rule
            try:
                issue = run_rule(rule_id, snapshot, params)
            except KeyError:
                issue = None
            except Exception as e:
                logger.exception("Rule %s failed", rule_id)
                issue = ReviewIssue(rule_id=rule_id, message=f"Rule error: {e}", hint="Check logs.")

        passed = issue is None
        if issue:
            issues_out.append(issue.model_dump())
        rationale = build_rationale(rule_id, issue, content_checked)
        rule_done_payload = {
            "type": "rule_done",
            "rule_id": rule_id,
            "passed": passed,
            "issue": issue.model_dump() if issue else None,
            "rationale": rationale,
            "content_checked": content_checked,
        }
        if rule_id in council_rules:
            council_votes = [{"model": m, "model_id": m, "vote": "PASS" if v else "FAIL" if v is False else "unclear"} for m, v in votes]
            rule_done_payload["council_votes"] = council_votes
            if chairman_model_id and chairman_verdict_str is not None:
                rule_done_payload["chairman_model"] = chairman_model_id
                rule_done_payload["chairman_verdict"] = chairman_verdict_str
                rule_done_payload["chairman_rationale"] = chairman_rationale or ""
                # Omit council_responses when chairman is used — UI shows only votes + chairman reasoning
            else:
                rule_done_payload["council_responses"] = council_responses
        yield f"data: {json.dumps(rule_done_payload)}\n\n"

    # Build evaluation (same as review_final)
    human_by_id = {r.hunt_id: r for r in snapshot.human_reviews}
    eval_slots = []
    for i, hunt in enumerate(snapshot.selected_hunts[:4], 1):
        human = human_by_id.get(hunt.hunt_id)
        llm_criteria = hunt.judge_criteria or {}
        human_grades = human.grades if human else {}
        disagreements = []
        for cid in set(llm_criteria.keys()) | set(human_grades.keys()):
            h_val = str(human_grades.get(cid, "")).lower() if human_grades.get(cid) else None
            l_val = str(llm_criteria.get(cid, "")).lower() if llm_criteria.get(cid) else None
            if h_val and l_val and h_val != l_val:
                disagreements.append({"criterion": cid, "human": h_val, "llm": l_val})
        eval_slots.append({
            "slot": i,
            "hunt_id": hunt.hunt_id,
            "model": hunt.model,
            "response_preview": (hunt.response or "")[:300],
            "human_grades": human_grades if human else {},
            "human_explanation": (human.explanation or "")[:500] if human else "",
            "llm_judge_score": hunt.judge_score,
            "llm_judge_criteria": llm_criteria,
            "llm_judge_explanation": (hunt.judge_explanation or "")[:500],
            "disagreements": disagreements,
        })
    evaluation = {
        "slots": eval_slots,
        "prompt": (snapshot.prompt or "")[:1000],
        "criteria": [{"id": c.get("id"), "description": (c.get("description") or "")[:200]} for c in snapshot.criteria],
    }

    # Enrich human_llm_grade_alignment issues with full details
    for i in issues_out:
        if i.get("rule_id") == "human_llm_grade_alignment":
            existing = i.get("details") or {}
            i["details"] = {**evaluation, "council_votes": existing.get("council_votes", []), **existing}

    from datetime import datetime, timezone
    result = {
        "type": "complete",
        "passed": len(issues_out) == 0,
        "issues": issues_out,
        "evaluation": evaluation,
        "checkpoint": "final",
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    yield f"data: {json.dumps(result)}\n\n"


@router.post("/review-final-stream/{session_id}")
async def review_final_stream(session_id: str, req: FinalReviewRequest):
    """
    Run agentic final QA with Server-Sent Events for live UI.
    Streams rule_start, rule_done, then complete.
    """
    if not req.selected_hunt_ids or len(req.selected_hunt_ids) != 4:
        raise HTTPException(
            status_code=400,
            detail="Final review requires selected_hunt_ids with exactly 4 IDs",
        )
    if not req.human_reviews or len(req.human_reviews) < 4:
        raise HTTPException(
            status_code=400,
            detail="Final review requires human_reviews for all 4 selected hunts",
        )

    try:
        from agentic_reviewer import build_snapshot
    except ImportError as e:
        logger.exception("Failed to import agentic_reviewer")
        raise HTTPException(
            status_code=500,
            detail=f"Agentic reviewer not available: {e}",
        )

    session = await _get_validated_session(session_id)
    all_results = await hunt_engine.export_results_async(session_id)

    human_reviews_for_agentic = {}
    for hid in req.selected_hunt_ids:
        key = str(hid)
        if key in req.human_reviews:
            r = req.human_reviews[key]
            grading_basis = r.get("grading_basis") or r.get("grades") or {}
            grades = {k: str(v).lower() for k, v in grading_basis.items()}
            human_reviews_for_agentic[key] = {
                "grades": grades,
                "explanation": str(r.get("explanation", "")),
                "submitted": True,
            }

    session_dict = {
        "session_id": session.session_id,
        "notebook": session.notebook.model_dump() if session.notebook else {},
        "config": session.config.model_dump() if session.config else {},
        "all_results": all_results,
        "current_turn": getattr(session, "current_turn", 1),
        "human_reviews": human_reviews_for_agentic,
    }

    from agentic_reviewer import build_snapshot
    snapshot = build_snapshot(session_dict, "final")

    def gen():
        # 2KB padding (SSE comment) to prevent proxy/browser buffering
        yield ": " + (" " * 2040) + "\n\n"
        try:
            for chunk in _stream_review_events(snapshot):
                yield chunk
        except Exception as e:
            logger.exception("Stream error")
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
