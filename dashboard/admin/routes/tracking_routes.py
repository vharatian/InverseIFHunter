"""Tracking & analytics routes — token usage, criteria, trainer stats."""
from fastapi import APIRouter, Depends, Query

from auth import verify_admin
from log_reader import get_log_reader

router = APIRouter(prefix="/api/admin/tracking", tags=["admin-tracking"])


@router.get("/tokens")
async def get_token_usage(
    hours: int = Query(default=168, ge=1, le=720),
    _=Depends(verify_admin),
):
    """Token usage and cost breakdown by model (and trainer where available)."""
    reader = get_log_reader()
    return reader.get_cost_summary(hours=hours)


@router.get("/criteria")
async def get_criteria_stats(
    hours: int = Query(default=168, ge=1, le=720),
    _=Depends(verify_admin),
):
    """Criteria difficulty analysis — fail rates, co-failure patterns."""
    reader = get_log_reader()
    return reader.get_criteria_analysis(hours=hours)


@router.get("/trainers")
async def get_trainer_stats(
    hours: int = Query(default=168, ge=1, le=720),
    limit: int = Query(default=50, ge=1, le=200),
    _=Depends(verify_admin),
):
    """Per-trainer metrics — hunts, breaks, sessions, leaderboard."""
    reader = get_log_reader()
    return reader.get_trainer_leaderboard(hours=hours, limit=limit)


@router.get("/overview")
async def get_admin_overview(
    hours: int = Query(default=24, ge=1, le=720),
    _=Depends(verify_admin),
):
    """Aggregated admin overview — totals, costs, active trainers."""
    reader = get_log_reader()
    overview = reader.get_overview(hours=hours)
    costs = reader.get_cost_summary(hours=hours)
    return {
        "overview": overview,
        "costs": costs,
    }
