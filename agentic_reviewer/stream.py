"""
Shared streaming logic for agentic review — used by both trainer and reviewer sides.

Extracted from routes/agentic.py so both apps can import without duplication.
"""
import json
import logging
from typing import Any, Dict, List, Tuple

logger = logging.getLogger(__name__)


def get_council_prompt(rule_id, snapshot, params):
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


def build_eval_slots(snapshot):
    """Build eval slot dicts from snapshot.selected_hunts[:4] with human review data."""
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
    return slots


def build_council_issue(rule_id, snapshot, votes, params):
    """Build ReviewIssue for a council rule that failed."""
    from agentic_reviewer.schemas import ReviewIssue, IssueSeverity
    vote_summary = ", ".join(f"{m}: {'PASS' if v else 'FAIL' if v is False else '?'}" for m, v in votes)
    council_votes = [{"model": m, "vote": "PASS" if v else "FAIL" if v is False else "unclear"} for m, v in votes]
    task_meta = (getattr(snapshot, "metadata", {}) or {}).get("task_metadata") or {}

    if rule_id == "human_llm_grade_alignment":
        slots = build_eval_slots(snapshot)
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


COUNCIL_RULES = {
    "human_llm_grade_alignment",
    "metadata_prompt_alignment",
    "metadata_taxonomy_alignment",
    "human_explanation_justifies_grade",
    "safety_context_aware",
    "qc_cfa_criteria_valid",
}


def _build_overall_summary_prompt(snapshot, issues, pass_count, total_rules):
    """Build prompt for chairman to summarize overall task quality."""
    lines = [
        f"You are a senior QA reviewer. A task was checked against {total_rules} quality rules.",
        f"{pass_count} passed, {len(issues)} failed.",
        "",
        "TASK PROMPT (first 500 chars):",
        (snapshot.prompt or "")[:500],
        "",
        "FAILED RULES:",
    ]
    for issue in issues:
        rid = issue.get("rule_id", "?")
        msg = issue.get("message", "")[:200]
        lines.append(f"  - {rid}: {msg}")
    lines.extend([
        "",
        "Write a brief overall assessment (3-5 sentences). Rate the task quality as one of:",
        "  EXCELLENT (all pass), GOOD (1-2 minor issues), NEEDS WORK (3+ issues), POOR (critical failures).",
        "",
        "Format: Start with the rating on its own line (EXCELLENT/GOOD/NEEDS WORK/POOR),",
        "then your brief assessment.",
    ])
    return "\n".join(lines)


def stream_review_events(snapshot):
    """Sync generator: run rules one by one, yield SSE events. Council rules stream votes live."""
    from agentic_reviewer.rule_engine import get_rules_for_checkpoint, run_rule
    from agentic_reviewer.council import run_council_streaming
    from agentic_reviewer.schemas import ReviewIssue, IssueSeverity

    import importlib
    _stream_mod = None
    for mod_path in ("routes.agentic_stream", "reviewer_app.routes.agentic_stream"):
        try:
            _stream_mod = importlib.import_module(mod_path)
            break
        except ImportError:
            continue
    if _stream_mod is None:
        import sys as _sys
        from pathlib import Path as _Path
        _project_root = _Path(__file__).resolve().parent.parent
        if str(_project_root) not in _sys.path:
            _sys.path.insert(0, str(_project_root))
        _stream_mod = importlib.import_module("routes.agentic_stream")
    build_content_checked = _stream_mod.build_content_checked
    build_rationale = _stream_mod.build_rationale

    issues_out = []
    evaluation = None
    rules = get_rules_for_checkpoint(snapshot.checkpoint)
    yield f"data: {json.dumps({'type': 'council_init', 'total_rules': len(rules)})}\n\n"

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

        if rule_id in COUNCIL_RULES:
            try:
                prompt = get_council_prompt(rule_id, snapshot, params)
            except ValueError as e:
                if "OPENROUTER" in str(e) or "API" in str(e):
                    issue = None
                    passed = True
                else:
                    raise
            else:
                passed = True
                try:
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
                        elif event[0] == "chairman_chunk":
                            _, ch_model, ch_chunk = event
                            yield f"data: {json.dumps({'type': 'council_chairman_chunk', 'rule_id': rule_id, 'model_id': ch_model, 'chunk': ch_chunk})}\n\n"
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
                        issue = build_council_issue(rule_id, snapshot, votes, params)
                except Exception as e:
                    logger.exception("Council streaming failed for rule %s", rule_id)
                    passed = False
                    issue = ReviewIssue(rule_id=rule_id, message=f"Council error: {e}", hint="Network or API issue. Try re-running.")
        else:
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
        if rule_id in COUNCIL_RULES:
            council_votes = [{"model": m, "model_id": m, "vote": "PASS" if v else "FAIL" if v is False else "unclear"} for m, v in votes]
            rule_done_payload["council_votes"] = council_votes
            rule_done_payload["council_responses"] = council_responses
            if chairman_model_id and chairman_verdict_str is not None:
                rule_done_payload["chairman_model"] = chairman_model_id
                rule_done_payload["chairman_verdict"] = chairman_verdict_str
                rule_done_payload["chairman_rationale"] = chairman_rationale or ""
        yield f"data: {json.dumps(rule_done_payload)}\n\n"

    eval_slots = build_eval_slots(snapshot)
    evaluation = {
        "slots": eval_slots,
        "prompt": (snapshot.prompt or "")[:1000],
        "criteria": [{"id": c.get("id"), "description": (c.get("description") or "")[:200]} for c in snapshot.criteria],
    }

    for i in issues_out:
        if i.get("rule_id") == "human_llm_grade_alignment":
            existing = i.get("details") or {}
            i["details"] = {**evaluation, "council_votes": existing.get("council_votes", []), **existing}

    from datetime import datetime, timezone
    total_rules = len(rules)
    pass_count = total_rules - len(issues_out)
    result = {
        "type": "complete",
        "passed": len(issues_out) == 0,
        "issues": issues_out,
        "evaluation": evaluation,
        "checkpoint": "final",
        "total_rules": total_rules,
        "pass_count": pass_count,
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    yield f"data: {json.dumps(result)}\n\n"

    # Overall performance summary via chairman LLM call
    try:
        from agentic_reviewer.config_loader import get_agentic_council
        from providers.openrouter import call_model_streaming as _stream_model
        council_config = get_agentic_council()
        chairman = (council_config.get("chairman_model") or "").strip()
        if chairman and issues_out:
            summary_prompt = _build_overall_summary_prompt(
                snapshot, issues_out, pass_count, total_rules,
            )
            yield f"data: {json.dumps({'type': 'overall_start', 'model': chairman})}\n\n"
            full = []
            for chunk, err in _stream_model(summary_prompt, chairman, max_tokens=1024, timeout=120.0):
                if err:
                    break
                if chunk:
                    full.append(chunk)
                    yield f"data: {json.dumps({'type': 'overall_chunk', 'chunk': chunk})}\n\n"
            yield f"data: {json.dumps({'type': 'overall_done', 'summary': ''.join(full)})}\n\n"
    except Exception as e:
        logger.warning("Overall summary failed: %s", e)
