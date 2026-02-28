"""
Trainer Routes

POST /api/register-trainer  — register/update trainer profile
POST /api/heartbeat         — trainer heartbeat (every 60s)
"""
import logging

from fastapi import APIRouter

from pydantic import BaseModel

from storage.trainer_registry import register_or_update_trainer, update_trainer_last_seen
from helpers.shared import _log_telemetry_safe

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["trainer"])


class TrainerRegistrationRequest(BaseModel):
    name: str
    email: str


class HeartbeatRequest(BaseModel):
    session_id: str
    trainer_email: str


@router.post("/register-trainer")
async def api_register_trainer(request: TrainerRegistrationRequest):
    """Register a trainer (name + email). Called on first visit and on each page load."""
    try:
        trainer = register_or_update_trainer(request.email, request.name)
        _log_telemetry_safe("trainer_registered", {
            "trainer_email": request.email,
            "trainer_name": request.name
        })
        return {"success": True, "trainer": trainer}
    except Exception as e:
        logger.error(f"Error registering trainer: {e}")
        return {"success": True}  # Don't block the frontend on registry errors


@router.post("/heartbeat")
async def api_heartbeat(request: HeartbeatRequest):
    """Heartbeat endpoint for trainer activity tracking. Called every 60s by the frontend."""
    try:
        update_trainer_last_seen(request.trainer_email)
        _log_telemetry_safe("trainer_heartbeat", {
            "session_id": request.session_id,
            "trainer_email": request.trainer_email
        })
    except Exception:
        pass  # Fire-and-forget, never fail
    
    return {"ok": True}
