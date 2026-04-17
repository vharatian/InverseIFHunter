"""Team management routes — CRUD for team.yaml."""
from fastapi import APIRouter, Depends, HTTPException

from auth import verify_admin, verify_super_admin
from admin.schemas import (
    TeamResponse,
    AddTrainerRequest,
    SetReviewerRequest,
    SetPodLeadRequest,
    SetTrainerReviewersRequest,
    AddAdminRequest,
    AddSuperAdminRequest,
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


@router.post("/pods/{pod_id}/reviewers")
async def add_reviewer(pod_id: str, body: SetReviewerRequest, _=Depends(verify_super_admin)):
    """Add a reviewer to a pod (pods support multiple reviewers)."""
    try:
        team_service.add_reviewer(pod_id, body.email, body.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@router.delete("/pods/{pod_id}/reviewers/{email}")
async def remove_reviewer(pod_id: str, email: str, _=Depends(verify_super_admin)):
    """Remove a specific reviewer from a pod. Also scrubs them from all trainer_assignments."""
    try:
        team_service.remove_reviewer(pod_id, email)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@router.put("/pods/{pod_id}/trainers/{trainer_email}/reviewers")
async def set_trainer_reviewers(
    pod_id: str,
    trainer_email: str,
    body: SetTrainerReviewersRequest,
    _=Depends(verify_super_admin),
):
    """Replace a trainer's reviewer assignments with the given list.
    Empty list clears the mapping (trainer becomes unassigned).
    All entries must already be reviewers of this pod."""
    try:
        team_service.set_trainer_reviewers(pod_id, trainer_email, body.reviewers)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@router.put("/pods/{pod_id}/pod-lead")
async def set_pod_lead(pod_id: str, body: SetPodLeadRequest, _=Depends(verify_super_admin)):
    """Set the pod lead for a pod."""
    try:
        team_service.set_pod_lead(pod_id, body.email, body.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@router.delete("/pods/{pod_id}/pod-lead")
async def remove_pod_lead(pod_id: str, _=Depends(verify_super_admin)):
    """Remove the pod lead from a pod."""
    try:
        team_service.remove_pod_lead(pod_id)
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


@router.post("/super-admins")
async def add_super_admin(body: AddSuperAdminRequest, _=Depends(verify_super_admin)):
    """Add a team super admin in team.yaml (trainer/reviewer role). Dashboard login is separate: Dashboard Admins tab or ADMIN_PASSWORD."""
    try:
        team_service.add_super_admin(body.email, body.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@router.delete("/super-admins/{email}")
async def remove_super_admin(email: str, _=Depends(verify_super_admin)):
    """Remove a team super admin."""
    try:
        team_service.remove_super_admin(email)
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
