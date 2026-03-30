"""Dashboard admin list and test account management routes."""
from fastapi import APIRouter, Depends, HTTPException

from auth import (
    verify_super_admin,
    get_admin_list,
    add_admin as auth_add_admin,
    remove_admin as auth_remove_admin,
    get_test_accounts_full,
    add_test_account as auth_add_test,
    remove_test_account as auth_remove_test,
)
from admin.schemas import AddDashboardAdminRequest, AddTestAccountRequest

router = APIRouter(prefix="/api/admin", tags=["admin-dashboard-admins"])


@router.get("/dashboard-admins")
async def list_dashboard_admins(_=Depends(verify_super_admin)):
    """List invited dashboard admins."""
    return get_admin_list()


@router.post("/dashboard-admins")
async def add_dashboard_admin(body: AddDashboardAdminRequest, _=Depends(verify_super_admin)):
    """Add a dashboard admin."""
    added = auth_add_admin(body.email, body.name)
    if not added:
        raise HTTPException(status_code=409, detail="Email already in admin list")
    return {"ok": True}


@router.delete("/dashboard-admins/{email}")
async def remove_dashboard_admin(email: str, _=Depends(verify_super_admin)):
    """Revoke a dashboard admin."""
    removed = auth_remove_admin(email)
    if not removed:
        raise HTTPException(status_code=404, detail="Email not found in admin list")
    return {"ok": True}


@router.get("/test-accounts")
async def list_test_accounts(_=Depends(verify_super_admin)):
    """List test accounts (excluded from analytics)."""
    return get_test_accounts_full()


@router.post("/test-accounts")
async def add_test_account(body: AddTestAccountRequest, _=Depends(verify_super_admin)):
    """Add a test account."""
    added = auth_add_test(body.email, body.name)
    if not added:
        raise HTTPException(status_code=409, detail="Email already a test account")
    return {"ok": True}


@router.delete("/test-accounts/{email}")
async def remove_test_account(email: str, _=Depends(verify_super_admin)):
    """Remove a test account."""
    removed = auth_remove_test(email)
    if not removed:
        raise HTTPException(status_code=404, detail="Email not found in test accounts")
    return {"ok": True}
