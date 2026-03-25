"""
SQLAlchemy ORM models — PostgreSQL schema.

Maps to the schema defined in the design spec §2.
JSONB columns store semi-structured data that would be painful to normalize.
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, DateTime, Integer, String, Text, UniqueConstraint,
    ForeignKey, Index, text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


def _utcnow():
    return datetime.now(timezone.utc)


def _genuuid():
    return uuid.uuid4()


class TrainerRow(Base):
    __tablename__ = "trainers"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=_genuuid,
        server_default=text("gen_random_uuid()"),
    )
    email: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    display_name: Mapped[str | None] = mapped_column(String)
    team: Mapped[str | None] = mapped_column(String)
    role: Mapped[str] = mapped_column(String, default="trainer", server_default="trainer")
    config: Mapped[dict] = mapped_column(JSONB, default=dict, server_default=text("'{}'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, server_default=text("now()"), onupdate=_utcnow)

    sessions: Mapped[list["SessionRow"]] = relationship(back_populates="trainer")


class SessionRow(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    trainer_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("trainers.id"))
    notebook_json: Mapped[dict | None] = mapped_column(JSONB)
    config: Mapped[dict | None] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String, default="pending", server_default="pending")
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, default=dict, server_default=text("'{}'::jsonb"))
    human_reviews: Mapped[dict] = mapped_column(JSONB, default=dict, server_default=text("'{}'::jsonb"))
    conversation_history: Mapped[list] = mapped_column(JSONB, default=list, server_default=text("'[]'::jsonb"))
    turns: Mapped[list] = mapped_column(JSONB, default=list, server_default=text("'[]'::jsonb"))
    total_hunts: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    completed_hunts: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    breaks_found: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    passes_found: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    accumulated_hunt_count: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    current_turn: Mapped[int] = mapped_column(Integer, default=1, server_default=text("1"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, server_default=text("now()"), onupdate=_utcnow)

    trainer: Mapped[TrainerRow | None] = relationship(back_populates="sessions")
    hunt_results: Mapped[list["HuntResultRow"]] = relationship(back_populates="session", cascade="all, delete-orphan")
    qc_runs: Mapped[list["QCRunRow"]] = relationship(back_populates="session", cascade="all, delete-orphan")


class HuntResultRow(Base):
    __tablename__ = "hunt_results"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=_genuuid,
        server_default=text("gen_random_uuid()"),
    )
    session_id: Mapped[str] = mapped_column(String, ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False)
    hunt_id: Mapped[int] = mapped_column(Integer, nullable=False)
    model: Mapped[str] = mapped_column(String, nullable=False)
    provider: Mapped[str] = mapped_column(String, nullable=False, server_default="openrouter")
    status: Mapped[str] = mapped_column(String, default="pending", server_default="pending")
    prompt: Mapped[str | None] = mapped_column(Text)
    response: Mapped[str | None] = mapped_column(Text)
    reasoning_trace: Mapped[str | None] = mapped_column(Text)
    judge_score: Mapped[int | None] = mapped_column(Integer)
    judge_output: Mapped[str | None] = mapped_column(Text)
    judge_explanation: Mapped[str | None] = mapped_column(Text)
    judge_criteria: Mapped[dict] = mapped_column(JSONB, default=dict, server_default=text("'{}'::jsonb"))
    scores: Mapped[dict] = mapped_column(JSONB, default=dict, server_default=text("'{}'::jsonb"))
    error: Mapped[str | None] = mapped_column(Text)
    is_breaking: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    sample_label: Mapped[str | None] = mapped_column(String)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, server_default=text("now()"))

    session: Mapped[SessionRow] = relationship(back_populates="hunt_results")


class QCRunRow(Base):
    __tablename__ = "qc_runs"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=_genuuid,
        server_default=text("gen_random_uuid()"),
    )
    session_id: Mapped[str] = mapped_column(String, ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False)
    run_type: Mapped[str] = mapped_column(String, nullable=False)
    result: Mapped[dict] = mapped_column(JSONB, nullable=False)
    rules_applied: Mapped[list] = mapped_column(JSONB, default=list, server_default=text("'[]'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, server_default=text("now()"))

    session: Mapped[SessionRow] = relationship(back_populates="qc_runs")


class NotificationRow(Base):
    __tablename__ = "notifications"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=_genuuid,
        server_default=text("gen_random_uuid()"),
    )
    user_email: Mapped[str] = mapped_column(String, nullable=False)
    type: Mapped[str] = mapped_column(String, nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    read: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, server_default=text("now()"))

    __table_args__ = (
        Index("idx_notifications_user_unread", "user_email", "read", postgresql_where=text("NOT read")),
    )


class TelemetryEventRow(Base):
    __tablename__ = "telemetry_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=_genuuid,
        server_default=text("gen_random_uuid()"),
    )
    event_type: Mapped[str] = mapped_column(String, nullable=False)
    session_id: Mapped[str | None] = mapped_column(String)
    trainer_email: Mapped[str | None] = mapped_column(String)
    payload: Mapped[dict] = mapped_column(JSONB, default=dict, server_default=text("'{}'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, server_default=text("now()"))
