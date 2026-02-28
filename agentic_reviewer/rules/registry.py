"""
Rule registry — maps rule_id to rule function.

Each rule: (snapshot: TaskSnapshot, params: dict) -> Optional[ReviewIssue]
Returns None if passed, ReviewIssue if failed.
"""
import logging
from typing import Any, Callable, Dict, Optional

from agentic_reviewer.schemas import ReviewIssue, TaskSnapshot

logger = logging.getLogger(__name__)

_RULES: Dict[str, Callable[[TaskSnapshot, Dict[str, Any]], Optional[ReviewIssue]]] = {}


def register_rule(rule_id: str) -> Callable:
    """Decorator to register a rule function."""

    def decorator(fn: Callable[[TaskSnapshot, Dict[str, Any]], Optional[ReviewIssue]]):
        _RULES[rule_id] = fn
        return fn

    return decorator


def get_registry() -> Dict[str, Callable]:
    """Return the rule registry (read-only)."""
    return dict(_RULES)


def run_rule(
    rule_id: str, snapshot: TaskSnapshot, params: Dict[str, Any]
) -> Optional[ReviewIssue]:
    """
    Run a rule by id. Returns None if passed, ReviewIssue if failed.
    Raises KeyError if rule_id not registered.
    """
    fn = _RULES.get(rule_id)
    if fn is None:
        raise KeyError(f"Unknown rule: {rule_id}")
    try:
        return fn(snapshot, params)
    except Exception as e:
        logger.exception("Rule %s failed", rule_id)
        return ReviewIssue(
            rule_id=rule_id,
            message=f"Rule error: {e}",
            hint="Check logs for details.",
        )
