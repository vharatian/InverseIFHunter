"""Team management routes — CRUD for team.yaml."""
from fastapi import APIRouter, Depends, HTTPException

from auth import verify_admin, verify_super_admin
from admin.schemas import (
    TeamResponse,
    AddTrainerRequest,
    SetReviewerRequest,
    AddAdminRequest,
    CreatePodRequest,
)
from admin.services import team_service

router = APIRouter(prefix="/api/admin/team", tags=["admin-team"])


@router.get("", response_model=TeamResponse)
async def get_team(_=Depends(verify_admin)):
    """Get full team structure."""
    return team_service.get_team()


@router.post("/pods/{pod_id}/trainers")
async def add_trainer(pod_id: str, body: AddTrainerRequest, _=Depends(verify_super_admin)):
    """Add a trainer to a pod."""
    try:
        team_service.add_trainer(pod_id, body.email)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@router.delete("/pods/{pod_id}/trainers/{email}")
async def remove_trainer(pod_id: str, email: str, _=Depends(verify_super_admin)):
    """Remove a trainer from a pod."""
    try:
        team_service.remove_trainer(pod_id, email)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@router.put("/pods/{pod_id}/reviewer")
async def set_reviewer(pod_id: str, body: SetReviewerRequest, _=Depends(verify_super_admin)):
    """Set the reviewer for a pod."""
    try:
        team_service.set_reviewer(pod_id, body.email, body.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@router.post("/admins")
async def add_admin(body: AddAdminRequest, _=Depends(verify_super_admin)):
    """Add an admin."""
    try:
        team_service.add_admin(body.email, body.name, body.pods)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@router.delete("/admins/{email}")
async def remove_admin(email: str, _=Depends(verify_super_admin)):
    """Remove an admin."""
    try:
        team_service.remove_admin(email)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@router.post("/pods")
async def create_pod(body: CreatePodRequest, _=Depends(verify_super_admin)):
    """Create a new empty pod."""
    try:
        team_service.create_pod(body.pod_id, body.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@router.delete("/pods/{pod_id}")
async def remove_pod(pod_id: str, _=Depends(verify_super_admin)):
    """Remove an empty pod."""
    try:
        team_service.remove_pod(pod_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}
