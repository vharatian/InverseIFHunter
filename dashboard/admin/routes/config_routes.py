"""Runtime config management routes."""
from fastapi import APIRouter, Depends, HTTPException

from auth import verify_admin, verify_super_admin
from admin.schemas import ConfigUpdateRequest
from admin.services import config_service

router = APIRouter(prefix="/api/admin/config", tags=["admin-config"])


@router.get("")
async def get_config(_=Depends(verify_admin)):
    """Get full config with secrets redacted."""
    return config_service.get_config_redacted()


@router.patch("")
async def update_config(body: ConfigUpdateRequest, _=Depends(verify_super_admin)):
    """Update whitelisted config keys. Writes to global.yaml and reloads cache."""
    try:
        applied = config_service.update_config(body.updates)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "applied": applied}


@router.post("/reload")
async def reload_config(_=Depends(verify_super_admin)):
    """Force reload config cache without writing."""
    try:
        config_service.reload_config()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Reload failed: {e}")
    return {"ok": True}
