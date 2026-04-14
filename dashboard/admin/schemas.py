"""Pydantic request/response models for admin API routes."""
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field, field_validator
import re

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _check_email(v: str) -> str:
    v = v.strip().lower()
    if not _EMAIL_RE.match(v):
        raise ValueError("Invalid email format")
    return v


# ── Auth ──────────────────────────────────────────────────────────

class LoginPasswordRequest(BaseModel):
    password: str

class LoginEmailRequest(BaseModel):
    email: str

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        return _check_email(v)

class MeResponse(BaseModel):
    email: str
    is_super: bool


# ── Team ──────────────────────────────────────────────────────────

class PodSummary(BaseModel):
    pod_id: str
    name: str
    pod_lead: Optional[Dict[str, str]] = None
    reviewer: Optional[Dict[str, str]] = None
    trainers: List[str] = []

class TeamResponse(BaseModel):
    super_admins: List[Dict[str, str]] = []
    admins: List[Dict] = []
    pods: List[PodSummary] = []

class AddTrainerRequest(BaseModel):
    email: str

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        return _check_email(v)

class SetReviewerRequest(BaseModel):
    email: str
    name: str = ""

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        return _check_email(v)


class SetPodLeadRequest(BaseModel):
    email: str
    name: str = ""

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        return _check_email(v)


class AddAdminRequest(BaseModel):
    email: str
    name: str = ""
    pods: List[str] = []

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        return _check_email(v)

class AddSuperAdminRequest(BaseModel):
    email: str
    name: str = ""

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        return _check_email(v)

class CreatePodRequest(BaseModel):
    pod_id: str = Field(..., pattern=r"^[a-z0-9_]+$", min_length=1, max_length=50)
    name: str = Field(..., min_length=1, max_length=100)


# ── Config ────────────────────────────────────────────────────────

class ConfigUpdateRequest(BaseModel):
    updates: Dict[str, Any] = Field(
        ...,
        description="Dotted-path keys to update, e.g. {'alignment.target_rate': 0.90}",
    )


# ── Dashboard Admins ──────────────────────────────────────────────

class AddDashboardAdminRequest(BaseModel):
    email: str
    name: str = ""

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        return _check_email(v)

class AddTestAccountRequest(BaseModel):
    email: str
    name: str = ""

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        return _check_email(v)
