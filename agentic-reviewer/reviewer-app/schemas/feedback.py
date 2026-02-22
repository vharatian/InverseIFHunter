"""Reviewer feedback: overall comment + per-section comments, appreciations, likes."""
from typing import List, Literal, Optional

from pydantic import BaseModel, Field, model_validator


class SectionComment(BaseModel):
    """Comment attached to a specific section (e.g. slot, criterion). Backward compat."""
    section_id: str = Field(..., description="Identifier: e.g. slot_1, criterion_C1")
    section_label: Optional[str] = Field(None, description="Human-readable label")
    comment: str = Field("", description="Reviewer comment for this section")


class SectionFeedback(BaseModel):
    """Per-section feedback: comment, appreciation, and like. Extends SectionComment."""
    section_id: str = Field(..., description="Identifier: e.g. slot_1, slot_2")
    section_label: Optional[str] = Field(None, description="Human-readable label")
    comment: str = Field("", description="Reviewer comment for this section")
    appreciation: str = Field("", description="What was good in this section")
    liked: bool = Field(False, description="Quick like for this section")


TaskRating = Literal["like", "neutral", "dislike"]


class ReviewerFeedback(BaseModel):
    """All reviewer feedback for one task/session."""
    overall_comment: str = Field("", description="Single comment for the whole task")
    section_comments: List[SectionComment] = Field(
        default_factory=list,
        description="Comments per section (legacy); prefer section_feedback.",
    )
    overall_appreciation: str = Field("", description="What was done well (whole task)")
    task_rating: TaskRating = Field("neutral", description="Quick reaction: like / neutral / dislike")
    summary_line: str = Field("", description="One-line reviewer summary")
    section_feedback: List[SectionFeedback] = Field(
        default_factory=list,
        description="Per-section comment, appreciation, liked.",
    )
    approval_comment: str = Field("", description="Reviewer comment on approval (separate from return comments)")
    revision_flags: List[str] = Field(
        default_factory=list,
        description="Sections that need revision: selection, slot_N_grade, slot_N_explanation, qc",
    )

    @model_validator(mode="before")
    @classmethod
    def normalize_section_feedback(cls, data: object) -> object:
        """If only section_comments exists, build section_feedback from it for backward compat."""
        if not isinstance(data, dict):
            return data
        section_feedback = data.get("section_feedback")
        section_comments = data.get("section_comments") or []
        if section_feedback is None and section_comments:
            data = {**data, "section_feedback": [
                {
                    "section_id": sc.get("section_id", ""),
                    "section_label": sc.get("section_label"),
                    "comment": sc.get("comment", ""),
                    "appreciation": "",
                    "liked": False,
                }
                for sc in section_comments
            ]}
        return data

    def get_section_comment(self, section_id: str) -> Optional[str]:
        """Return comment text for section_id if present (section_feedback first, then section_comments)."""
        for sf in self.section_feedback:
            if sf.section_id == section_id:
                return sf.comment or None
        for sc in self.section_comments:
            if sc.section_id == section_id:
                return sc.comment or None
        return None

    def to_legacy_dump(self) -> dict:
        """Dump for storage: section_comments derived from section_feedback so old clients still work."""
        d = self.model_dump()
        if self.section_feedback:
            d["section_comments"] = [
                {"section_id": s.section_id, "section_label": s.section_label, "comment": s.comment}
                for s in self.section_feedback
            ]
        return d
