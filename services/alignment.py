"""
Human vs LLM criterion alignment (PASS/FAIL only, case-insensitive).

- Pure functions: tests + notebook export recomputation.
- `build_alignment_export_payload`: async helper for routes (Redis trainer snapshot + config).

Trainer UI (gate, banner, persistence): `static/modules/alignment.js` — keep formulas in sync.
"""
from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Tuple


def normalize_criterion_grade(val: Any) -> Optional[str]:
    """Return 'PASS', 'FAIL', or None (excluded: missing, UNKNOWN, etc.)."""
    if val is None:
        return None
    s = str(val).strip().upper()
    if s == "PASS":
        return "PASS"
    if s == "FAIL":
        return "FAIL"
    return None


def _slot_agreement(
    human_basis: Mapping[str, Any], llm_criteria: Mapping[str, Any]
) -> Tuple[int, int]:
    agreed = 0
    total = 0
    keys = set(human_basis.keys()) & set(llm_criteria.keys())
    for k in keys:
        hg = normalize_criterion_grade(human_basis.get(k))
        lg = normalize_criterion_grade(llm_criteria.get(k))
        if hg is None or lg is None:
            continue
        total += 1
        if hg == lg:
            agreed += 1
    return agreed, total


def compute_alignment(slots: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Args:
        slots: list of { "human_basis": dict, "llm_criteria": dict } per slot (order = slot 1..N).

    Returns:
        overall_rate, per_slot (slot_1..), total_agreed, total_criteria_compared,
        worst_slot_index (1-based, among slots with total>0; tie → lowest index).
    """
    per_slot: Dict[str, float] = {}
    total_agreed = 0
    total_compared = 0

    for i, slot in enumerate(slots, start=1):
        hb = slot.get("human_basis") or {}
        lc = slot.get("llm_criteria") or {}
        if not isinstance(hb, dict):
            hb = {}
        if not isinstance(lc, dict):
            lc = {}
        a, t = _slot_agreement(hb, lc)
        total_agreed += a
        total_compared += t
        key = f"slot_{i}"
        if t > 0:
            per_slot[key] = a / t
        else:
            per_slot[key] = 1.0

    overall_rate = (total_agreed / total_compared) if total_compared > 0 else 1.0

    worst_idx = None
    worst_rate: Optional[float] = None
    for i, slot in enumerate(slots, start=1):
        hb = slot.get("human_basis") or {}
        lc = slot.get("llm_criteria") or {}
        _, t = _slot_agreement(hb if isinstance(hb, dict) else {}, lc if isinstance(lc, dict) else {})
        if t == 0:
            continue
        rate = per_slot.get(f"slot_{i}", 1.0)
        if worst_rate is None or rate < worst_rate - 1e-15 or (
            abs(rate - worst_rate) < 1e-15 and (worst_idx is None or i < worst_idx)
        ):
            worst_rate = rate
            worst_idx = i

    if worst_idx is None:
        worst_idx = 1

    return {
        "overall_rate": overall_rate,
        "per_slot": per_slot,
        "total_agreed": total_agreed,
        "total_criteria_compared": total_compared,
        "worst_slot_index": worst_idx,
    }


def build_slots_from_reviews_and_results(
    results_in_slot_order: List[Dict[str, Any]],
    human_reviews: Mapping[str, Any],
) -> List[Dict[str, Any]]:
    """Map export-style results list + human_reviews (slotNum on each review) to compute_alignment slots."""
    by_slot: Dict[int, Dict[str, Any]] = {}
    for key, rev in human_reviews.items():
        if not isinstance(rev, dict):
            continue
        sn = rev.get("slotNum")
        if sn is None:
            continue
        try:
            sn = int(sn)
        except (TypeError, ValueError):
            continue
        by_slot[sn] = {
            "human_basis": dict(rev.get("grading_basis") or {}),
            "llm_criteria": {},
        }

    slots: List[Dict[str, Any]] = []
    for idx, result in enumerate(results_in_slot_order, start=1):
        llm = dict((result or {}).get("judge_criteria") or {})
        slot = by_slot.get(idx, {"human_basis": {}, "llm_criteria": llm})
        slot["llm_criteria"] = llm
        slots.append(slot)
    return slots


async def build_alignment_export_payload(
    session_id: str,
    results: List[Dict[str, Any]],
    human_reviews: Mapping[str, Any],
) -> Dict[str, Any]:
    """Alignment object stored at notebook.metadata.model_hunter.alignment."""
    from config import get_config_value
    import services.redis_session as redis_store

    cfg = get_config_value("alignment") or {}
    if not isinstance(cfg, dict):
        cfg = {}
    enabled = cfg.get("enabled", True) is not False
    try:
        thr = float(cfg.get("target_rate", 0.85))
    except (TypeError, ValueError):
        thr = 0.85
    if not enabled:
        return {"skipped": True, "reason": "alignment_disabled", "threshold": thr}

    tu = await redis_store.get_trainer_ui(session_id)
    snapshot = tu.get("alignment_last_snapshot") if isinstance(tu, dict) else None
    if isinstance(snapshot, dict) and snapshot.get("overall_rate") is not None:
        out = {**snapshot}
        out.setdefault("threshold", thr)
        return out

    slots = build_slots_from_reviews_and_results(results, human_reviews or {})
    comp = compute_alignment(slots)
    rounds = int(tu.get("alignment_re_review_rounds") or 0) if isinstance(tu, dict) else 0
    return {
        "overall_rate": comp["overall_rate"],
        "per_slot": comp["per_slot"],
        "re_review_rounds": rounds,
        "threshold": thr,
        "total_criteria_compared": comp["total_criteria_compared"],
        "total_agreed": comp["total_agreed"],
    }
