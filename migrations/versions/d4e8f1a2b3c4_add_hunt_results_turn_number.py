"""add hunt_results.turn_number for per-turn PG restore

Revision ID: d4e8f1a2b3c4
Revises: a919b3585582
Create Date: 2026-04-16

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d4e8f1a2b3c4"
down_revision: Union[str, Sequence[str], None] = "a919b3585582"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "hunt_results",
        sa.Column("turn_number", sa.Integer(), nullable=True),
    )
    op.create_index(
        "ix_hunt_results_session_turn",
        "hunt_results",
        ["session_id", "turn_number"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_hunt_results_session_turn", table_name="hunt_results")
    op.drop_column("hunt_results", "turn_number")
