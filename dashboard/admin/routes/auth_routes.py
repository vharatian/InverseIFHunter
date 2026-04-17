"""Admin login, session, and logout routes."""
import logging

from fastapi import APIRouter, Request, Response, HTTPException

from auth import (
    verify_password,
    is_approved_admin,
    create_session_token,
    set_auth_cookie,
    clear_auth_cookie,
    get_current_user,
    is_auth_configured,
)
from admin.schemas import LoginPasswordRequest, LoginEmailRequest, MeResponse
from rate_limit import enforce as enforce_rate

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin", tags=["admin-auth"])


@router.post("/login")
async def login_password(body: LoginPasswordRequest, request: Request, response: Response):
    """Super admin login via password."""
    await enforce_rate(request, "login")
    if not is_auth_configured():
        raise HTTPException(status_code=503, detail="Auth not configured (ADMIN_PASSWORD not set)")
    if not verify_password(body.password):
        raise HTTPException(status_code=401, detail="Invalid password")
    token = create_session_token(email="super_admin", is_super=True)
    set_auth_cookie(response, token)
    return {"ok": True, "is_super": True}


@router.post("/login-email")
async def login_email(body: LoginEmailRequest, request: Request, response: Response):
    """Invited admin login via email."""
    await enforce_rate(request, "login-email")
    email = body.email.strip().lower()
    if not is_approved_admin(email):
        raise HTTPException(status_code=403, detail="Email not in approved admin list")
    token = create_session_token(email=email, is_super=False)
    set_auth_cookie(response, token)
    return {"ok": True, "is_super": False}


@router.get("/me", response_model=MeResponse)
async def get_me(request: Request):
    """Return current session user info, or 401 if not authenticated."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return MeResponse(
        email=user.get("email", ""),
        is_super=user.get("is_super", False),
    )


@router.post("/logout")
async def logout(response: Response):
    """Clear session cookie."""
    clear_auth_cookie(response)
    return {"ok": True}
