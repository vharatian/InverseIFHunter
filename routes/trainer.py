"""
Trainer Routes

POST /api/register-trainer  — register/update trainer profile
POST /api/heartbeat         — trainer heartbeat (every 60s)
"""
import logging

from fastapi import APIRouter, HTTPException

from pydantic import BaseModel

from helpers.shared import _log_telemetry_safe
from middleware.trace_id import get_trace_id

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
        trainer = {
            "name": request.name,
            "email": request.email,
        }
        _log_telemetry_safe("trainer_registered", {
            "trainer_email": request.email,
            "trainer_name": request.name
        })
        return {"success": True, "trainer": trainer}
    except Exception as e:
        # Previously swallowed into {"success": True} — now surfaces so the
        # client toast can show the trace id. global_exception_handler also
        # logs with trace_id; this explicit raise lets us attach a clearer
        # detail without waiting for the catch-all.
        trace_id = get_trace_id()
        logger.error(
            f"Error registering trainer: {e}",
            extra={"trace_id": trace_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=500,
            detail=f"Failed to register trainer (trace_id={trace_id}): {e}",
        )


@router.post("/heartbeat")
async def api_heartbeat(request: HeartbeatRequest):
    """Heartbeat endpoint for trainer activity tracking. Called every 60s by the frontend."""
    try:
        _log_telemetry_safe("trainer_heartbeat", {
            "session_id": request.session_id,
            "trainer_email": request.trainer_email
        })
    except Exception:
        pass  # Fire-and-forget, never fail

    return {"ok": True}
