"""
InverseIF aggregation — pure functions for sample classification and batch proceed decisions.

- classify_sample: judge_criteria + break_mode + pass_threshold → label, pass_rate, counts.
- aggregate_batch: list of sample labels + config → breaking, passing, errors, should_proceed, reason.
"""
from typing import Dict, List, Any, Literal, Optional

from models.schemas import HuntConfig, ProceedPolicy

# Labels per sample
SampleLabel = Literal["PASS", "BREAK", "ERROR"]


def classify_sample(
    judge_criteria: Dict[str, str],
    break_mode: Literal["ratio", "any_break", "no_break"],
    pass_threshold: float,
) -> dict:
    """
    Classify a single sample from judge criteria.

    - Any criterion status "MISSING" → sample_label = "ERROR" (treat as format error).
    - Otherwise: pass_rate = pass_count / total; compute passed the same way as ratio
      (see implementation: threshold 0 is special-cased).
    - ratio: PASS if passed else BREAK.
    - any_break: BREAK if any criterion FAIL; else same as ratio.
    - no_break: PASS only if no criterion FAIL (all PASS); else BREAK.

    Returns:
        {
            "label": "PASS" | "BREAK" | "ERROR",
            "pass_rate": float,
            "pass_count": int,
            "fail_count": int,
            "missing_count": int,
        }
    """
    statuses = list(judge_criteria.values()) if judge_criteria else []
    pass_count = sum(1 for s in statuses if (s or "").upper() == "PASS")
    fail_count = sum(1 for s in statuses if (s or "").upper() == "FAIL")
    missing_count = sum(1 for s in statuses if (s or "").upper() == "MISSING")

    total = len(statuses) or 1
    pass_rate = pass_count / total

    # Any MISSING → ERROR
    if missing_count > 0:
        return {
            "label": "ERROR",
            "pass_rate": pass_rate,
            "pass_count": pass_count,
            "fail_count": fail_count,
            "missing_count": missing_count,
        }

    # Pass rule: >= for non-zero thresholds so the boundary is correct.
    # e.g. >50% Breaking (pass_threshold=0.5): exactly 50% passing should NOT break.
    # All Breaking (pass_threshold=0.0): any criterion passing = PASS, so use strict >.
    if pass_threshold > 0:
        passed = pass_rate >= pass_threshold
    else:
        passed = pass_rate > 0  # All Breaking: break only when ALL criteria fail

    if break_mode == "no_break":
        # No failed criterion => sample did not "break"; any FAIL => BREAK.
        label = "PASS" if fail_count == 0 else "BREAK"
    elif break_mode == "any_break":
        # Any FAIL breaks the sample; otherwise same threshold rule as ratio.
        label = "BREAK" if fail_count > 0 else ("PASS" if passed else "BREAK")
    else:
        label = "PASS" if passed else "BREAK"

    return {
        "label": label,
        "pass_rate": pass_rate,
        "pass_count": pass_count,
        "fail_count": fail_count,
        "missing_count": missing_count,
    }


def aggregate_batch(
    sample_labels: List[str],
    config: HuntConfig,
) -> dict:
    """
    Aggregate a batch of sample labels into counts and a proceed decision.

    - ERROR samples never increment breaking or passing; proceed requires error_samples == 0.
    - If config.proceed_policy exists: should_proceed = (any pattern matches) and (errors == 0).
    - Else: passing_mode → should_proceed True; else should_proceed = (breaking >= target_breaks).

    Returns:
        {
            "breaking": int,
            "passing": int,
            "errors": int,
            "should_proceed": bool,
            "reason": str,
        }
    """
    breaking = sum(1 for s in sample_labels if s == "BREAK")
    passing = sum(1 for s in sample_labels if s == "PASS")
    errors = sum(1 for s in sample_labels if s == "ERROR")

    # Proceed only when no errors
    if errors > 0:
        return {
            "breaking": breaking,
            "passing": passing,
            "errors": errors,
            "should_proceed": False,
            "reason": f"error_samples={errors} (proceed requires errors=0)",
        }

    policy: Optional[ProceedPolicy] = getattr(config, "proceed_policy", None)
    if policy and getattr(policy, "patterns", None):
        for p in policy.patterns:
            if breaking == p.breaking and passing == p.passing:
                return {
                    "breaking": breaking,
                    "passing": passing,
                    "errors": errors,
                    "should_proceed": True,
                    "reason": f"pattern (breaking={p.breaking}, passing={p.passing}) matched",
                }
        return {
            "breaking": breaking,
            "passing": passing,
            "errors": errors,
            "should_proceed": False,
            "reason": "no proceed pattern matched",
        }

    # Fallback: existing behavior
    passing_mode = getattr(config, "passing_mode", False)
    target_breaks = getattr(config, "target_breaks", 4)
    if passing_mode:
        return {
            "breaking": breaking,
            "passing": passing,
            "errors": errors,
            "should_proceed": True,
            "reason": "passing_mode=True",
        }
    should = breaking >= target_breaks
    return {
        "breaking": breaking,
        "passing": passing,
        "errors": errors,
        "should_proceed": should,
        "reason": f"breaking={breaking} >= target_breaks={target_breaks}" if should else f"breaking={breaking} < target_breaks={target_breaks}",
    }
