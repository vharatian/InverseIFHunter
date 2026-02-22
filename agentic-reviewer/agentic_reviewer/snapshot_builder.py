"""
Task Snapshot Builder.

Extracts a structured TaskSnapshot from a session-like dict.
Session structure mirrors Model Hunter (HuntSession, ParsedNotebook, HuntResult).
We do not import from model-hunter — caller passes dict.
"""
import re
import logging
from typing import Any, Dict, List, Optional

from agentic_reviewer.schemas import (
    Checkpoint,
    HumanReview,
    SelectedHunt,
    TaskSnapshot,
)

logger = logging.getLogger(__name__)


def _get_notebook(session: Dict[str, Any]) -> Dict[str, Any]:
    """Extract notebook dict from session."""
    nb = session.get("notebook")
    if nb is None:
        return {}
    return nb if isinstance(nb, dict) else {}


def _extract_task_metadata(notebook: Dict[str, Any]) -> Dict[str, str]:
    """
    Extract task metadata from notebook.metadata.
    Keys: Domain, Use Case, L1 Taxonomy, Task ID, Model, User Prompt Length.
    Supports multiple key variations (e.g. Domain, domain, L1Taxonomy).
    """
    nb_meta = notebook.get("metadata") or {}
    if not isinstance(nb_meta, dict):
        return {}

    def _get(key_variants: list) -> str:
        for k in key_variants:
            v = nb_meta.get(k)
            if v is not None and str(v).strip():
                return str(v).strip()
        return ""

    return {
        "domain": _get(["Domain", "Domain:", "domain"]),
        "use_case": _get(["Use Case", "UseCase", "Use Case:", "use_case"]),
        "l1_taxonomy": _get(["L1 Taxonomy", "L1Taxonomy", "L1 Taxonomy:", "l1_taxonomy"]),
        "task_id": _get(["Task ID", "TaskID", "task_id"]),
        "model": _get(["Model", "model"]),
        "user_prompt_length": _get(["User Prompt Length", "UserPromptLength", "user_prompt_length"]),
    }


def _get_all_results(session: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Extract all_results from session (accumulated hunt results)."""
    results = session.get("all_results") or session.get("results") or []
    if not isinstance(results, list):
        return []
    return [r if isinstance(r, dict) else {} for r in results]


def _get_human_reviews(session: Dict[str, Any]) -> Dict[str, Any]:
    """Extract human_reviews from session. Keys are hunt_id as string."""
    reviews = session.get("human_reviews") or {}
    if not isinstance(reviews, dict):
        return {}
    return reviews


def _extract_criteria(reference: str) -> List[Dict[str, str]]:
    """
    Extract criteria from reference text.
    Supports: JSON array [{"id":"C1","criteria1":"..."}] or plain "C1: desc".
    """
    if not reference or not reference.strip():
        return []

    # Try JSON array
    array_match = re.search(r"\[.*?\]", reference, re.DOTALL)
    if array_match:
        import json

        try:
            parsed = json.loads(array_match.group(0))
            if isinstance(parsed, list):
                out = []
                for i, item in enumerate(parsed):
                    if isinstance(item, dict):
                        cid = item.get("id", f"C{i + 1}")
                        desc = None
                        for k, v in item.items():
                            if k.startswith("criteria") and k != "id":
                                desc = str(v)
                                break
                        if desc:
                            out.append({"id": str(cid).upper(), "description": desc})
                return out
        except json.JSONDecodeError:
            pass

    # Plain text: C1: desc, C2: desc
    pattern = re.compile(r"^(C\d+)\s*[:：]\s*(.+)$", re.MULTILINE | re.IGNORECASE)
    matches = pattern.findall(reference)
    if matches:
        return [{"id": m[0].upper(), "description": m[1].strip()} for m in matches]

    return []


def _hunt_to_selected(h: Dict[str, Any]) -> SelectedHunt:
    """Convert hunt dict to SelectedHunt."""
    return SelectedHunt(
        hunt_id=int(h.get("hunt_id", 0)),
        model=str(h.get("model", "")),
        response=str(h.get("response", "")),
        judge_score=h.get("judge_score"),
        judge_criteria=h.get("judge_criteria") or {},
        judge_explanation=str(h.get("judge_explanation", "")),
        is_breaking=bool(h.get("is_breaking", False)),
    )


def _review_to_human(hunt_id: int, r: Dict[str, Any]) -> HumanReview:
    """Convert review dict to HumanReview."""
    grades = r.get("grades") or r.get("criteria") or {}
    if isinstance(grades, dict):
        grades = {str(k): str(v) for k, v in grades.items()}
    else:
        grades = {}
    return HumanReview(
        hunt_id=hunt_id,
        grades=grades,
        explanation=str(r.get("explanation", "")),
        submitted=bool(r.get("submitted", False)),
    )


def build_snapshot(
    session: Dict[str, Any],
    checkpoint: Checkpoint,
    selected_hunt_ids: Optional[List[int]] = None,
) -> TaskSnapshot:
    """
    Build a TaskSnapshot from a session-like dict.

    Args:
        session: Dict with keys notebook, all_results, human_reviews, etc.
        checkpoint: "preflight" or "final"
        selected_hunt_ids: For preflight, the 4 hunt IDs selected for review.
                           For final, inferred from human_reviews keys.

    Returns:
        TaskSnapshot for the rule engine.

    Raises:
        ValueError: If required data is missing.
    """
    notebook = _get_notebook(session)
    all_results = _get_all_results(session)
    human_reviews_raw = _get_human_reviews(session)

    # Resolve prompt and reference from notebook (support multi-turn)
    prompt = notebook.get("prompt", "")
    reference = notebook.get("response_reference", "")

    # Multi-turn: use current turn's data from turns if available
    turns = notebook.get("turns") or []
    current_turn = session.get("current_turn", 1)
    if turns and current_turn >= 1:
        turn_idx = current_turn - 1
        if turn_idx < len(turns):
            t = turns[turn_idx]
            if isinstance(t, dict):
                prompt = t.get("prompt", prompt)
                reference = t.get("response_reference", reference)

    criteria = _extract_criteria(reference)
    session_id = str(session.get("session_id", ""))

    # Resolve selected hunt IDs
    if checkpoint == "preflight":
        if not selected_hunt_ids or len(selected_hunt_ids) != 4:
            raise ValueError("Preflight requires selected_hunt_ids (list of 4 hunt IDs)")
        ids_to_use = [int(x) for x in selected_hunt_ids]
    else:
        # Final: use human_reviews keys
        ids_to_use = [int(k) for k in human_reviews_raw.keys() if str(k).isdigit()]
        if len(ids_to_use) != 4:
            raise ValueError(
                f"Final checkpoint expects 4 human reviews, got {len(ids_to_use)}"
            )

    # Build hunt_id -> result lookup
    by_id = {int(r.get("hunt_id", 0)): r for r in all_results if r.get("hunt_id") is not None}

    selected_hunts: List[SelectedHunt] = []
    for hid in ids_to_use:
        if hid in by_id:
            selected_hunts.append(_hunt_to_selected(by_id[hid]))
        else:
            logger.warning(f"Hunt {hid} not found in all_results")

    human_reviews: List[HumanReview] = []
    if checkpoint == "final":
        for hid in ids_to_use:
            key = str(hid)
            if key in human_reviews_raw:
                human_reviews.append(_review_to_human(hid, human_reviews_raw[key]))

    config = session.get("config") or {}
    models_used = config.get("models", []) if isinstance(config, dict) else []
    task_metadata = _extract_task_metadata(notebook)

    return TaskSnapshot(
        checkpoint=checkpoint,
        session_id=session_id,
        prompt=prompt,
        criteria=criteria,
        reference=reference,
        selected_hunts=selected_hunts,
        human_reviews=human_reviews,
        metadata={
            "turn": current_turn,
            "models_used": models_used,
            "task_metadata": task_metadata,
        },
    )
