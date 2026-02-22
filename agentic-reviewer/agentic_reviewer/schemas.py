"""
Schemas for Agentic Reviewer.

Defines TaskSnapshot (input to rules) and ReviewResult (output).
Mirrors Model Hunter session structure — we accept dict, no import from model-hunter.
"""
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Checkpoint
# ---------------------------------------------------------------------------

Checkpoint = Literal["preflight", "final"]


# ---------------------------------------------------------------------------
# Task Snapshot — input to rule engine
# ---------------------------------------------------------------------------


class SelectedHunt(BaseModel):
    """One selected hunt result (for preflight or final)."""

    hunt_id: int
    model: str
    response: str
    judge_score: Optional[int] = None
    judge_criteria: Dict[str, str] = Field(default_factory=dict)
    judge_explanation: str = ""
    is_breaking: bool = False


class HumanReview(BaseModel):
    """Human review for one hunt."""

    hunt_id: int
    grades: Dict[str, str] = Field(default_factory=dict)  # criterion_id -> "pass"|"fail"
    explanation: str = ""
    submitted: bool = False


class TaskSnapshot(BaseModel):
    """
    Structured payload for the rule engine.

    Preflight: has selected_hunts, no human_reviews.
    Final: has selected_hunts + human_reviews.
    """

    checkpoint: Checkpoint
    session_id: str
    prompt: str = ""
    criteria: List[Dict[str, str]] = Field(default_factory=list)  # [{"id": "C1", "description": "..."}]
    reference: str = ""  # Ideal response / reference text
    selected_hunts: List[SelectedHunt] = Field(default_factory=list)
    human_reviews: List[HumanReview] = Field(default_factory=list)  # Only for checkpoint="final"
    metadata: Dict[str, Any] = Field(default_factory=dict)  # turn, models_used, etc.


# ---------------------------------------------------------------------------
# Review Result — output from rule engine
# ---------------------------------------------------------------------------


class IssueSeverity(str, Enum):
    ERROR = "error"
    WARNING = "warning"


class ReviewIssue(BaseModel):
    """One issue from a rule."""

    rule_id: str
    severity: IssueSeverity = IssueSeverity.ERROR
    message: str
    hint: str = ""
    details: Optional[Dict[str, Any]] = None  # e.g. council_votes, slot_comparisons


class ReviewResult(BaseModel):
    """Aggregated result from the rule engine."""

    passed: bool
    issues: List[ReviewIssue] = Field(default_factory=list)
    checkpoint: Checkpoint
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"))
