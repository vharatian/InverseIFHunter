"""
Agentic Reviewer — Quality gate for Model Hunter tasks.

Standalone package. No dependencies on model-hunter-refactored.
Caller passes session-like dict; we return ReviewResult.
"""
from agentic_reviewer.schemas import (
    TaskSnapshot,
    ReviewResult,
    ReviewIssue,
)
from agentic_reviewer.snapshot_builder import build_snapshot
from agentic_reviewer.rule_engine import run_review

__all__ = [
    "TaskSnapshot",
    "ReviewResult",
    "ReviewIssue",
    "build_snapshot",
    "run_review",
]
