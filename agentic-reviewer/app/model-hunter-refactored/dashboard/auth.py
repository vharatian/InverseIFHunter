"""
Dashboard Authentication Module

Two-tier auth:
1. Super admin: uses ADMIN_PASSWORD env var (full access + can manage admin list)
2. Invited admins: added by super admin via email, one-time login, cookie persists

Admin registry stored in .storage/dashboard_admins.json
"""
import os
import json
import hashlib
import time
from typing import Optional, List, Dict
from pathlib import Path
from fastapi import Request, HTTPException, Response
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

# Configuration
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
COOKIE_NAME = "admin_session"
COOKIE_MAX_AGE = 30 * 24 * 60 * 60  # 30 days (long-lived for "one-time login" feel)

# Admin registry path
_STORAGE_PATH = os.environ.get("SESSION_STORAGE_PATH", "/app/.storage")
ADMINS_FILE = os.path.join(_STORAGE_PATH, "dashboard_admins.json")

# Derive signing key from password hash
_SECRET_KEY = hashlib.sha256(f"model-hunter-dashboard-{ADMIN_PASSWORD}".encode()).hexdigest()
_serializer = URLSafeTimedSerializer(_SECRET_KEY)


# ============== Auth Basics ==============

def is_auth_configured() -> bool:
    """Check if authentication is properly configured."""
    return bool(ADMIN_PASSWORD)


def verify_password(password: str) -> bool:
    """Verify the super admin password."""
    if not ADMIN_PASSWORD:
        return False
    return password == ADMIN_PASSWORD


def create_session_token(email: str = "super_admin", is_super: bool = False) -> str:
    """Create a signed session token."""
    return _serializer.dumps({
        "auth": True,
        "email": email,
        "is_super": is_super,
        "ts": int(time.time())
    })


def verify_session_token(token: str) -> Optional[Dict]:
    """
    Verify a session token. Returns token data if valid, None if invalid.
    Also checks that email-based admins haven't been revoked.
    """
    try:
        data = _serializer.loads(token, max_age=COOKIE_MAX_AGE)
        if data.get("auth") is not True:
            return None

        # Super admin always valid
        if data.get("is_super"):
            return data

        # Email-based admin: check they're still in the approved list
        email = data.get("email", "")
        if email and is_approved_admin(email):
            return data

        return None  # Email was removed from admin list
    except (BadSignature, SignatureExpired):
        return None


def set_auth_cookie(response: Response, token: str):
    """Set the authentication cookie on a response."""
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=False,  # Set to True if using HTTPS
    )


def clear_auth_cookie(response: Response):
    """Clear the authentication cookie."""
    response.delete_cookie(key=COOKIE_NAME)


def get_session_token(request: Request) -> Optional[str]:
    """Extract session token from request cookies."""
    return request.cookies.get(COOKIE_NAME)


def get_current_user(request: Request) -> Optional[Dict]:
    """Get the current authenticated user's token data, or None."""
    token = get_session_token(request)
    if not token:
        return None
    return verify_session_token(token)


async def verify_admin(request: Request):
    """
    FastAPI dependency that verifies admin authentication.
    When ADMIN_PASSWORD is not set, skips auth (allows unauthenticated access).
    Raises 401 if auth is configured but not authenticated.
    """
    if not is_auth_configured():
        return
    token = get_session_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    data = verify_session_token(token)
    if not data:
        raise HTTPException(status_code=401, detail="Not authenticated")


async def verify_super_admin(request: Request):
    """
    FastAPI dependency that verifies SUPER admin (password-based) authentication.
    Only super admins can manage the admin list.
    When ADMIN_PASSWORD is not set, skips (no super admin features available).
    """
    if not is_auth_configured():
        return
    token = get_session_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    data = verify_session_token(token)
    if not data or not data.get("is_super"):
        raise HTTPException(status_code=403, detail="Super admin access required")


# ============== Admin Registry ==============

def _load_admin_registry() -> Dict:
    """Load the admin registry from disk."""
    try:
        os.makedirs(os.path.dirname(ADMINS_FILE), exist_ok=True)
        if os.path.exists(ADMINS_FILE):
            with open(ADMINS_FILE, "r") as f:
                return json.load(f)
    except Exception:
        pass
    return {"admins": []}


def _save_admin_registry(registry: Dict):
    """Save the admin registry to disk."""
    try:
        os.makedirs(os.path.dirname(ADMINS_FILE), exist_ok=True)
        with open(ADMINS_FILE, "w") as f:
            json.dump(registry, f, indent=2)
    except Exception as e:
        print(f"Error saving admin registry: {e}")


def get_admin_list() -> List[Dict]:
    """Get list of approved admins."""
    registry = _load_admin_registry()
    return registry.get("admins", [])


def is_approved_admin(email: str) -> bool:
    """Check if an email is in the approved admin list."""
    email = email.strip().lower()
    admins = get_admin_list()
    return any(a.get("email", "").lower() == email for a in admins)


def add_admin(email: str, name: str = "", added_by: str = "super_admin") -> bool:
    """Add an admin to the approved list. Returns True if newly added."""
    email = email.strip().lower()
    if is_approved_admin(email):
        return False

    registry = _load_admin_registry()
    registry.setdefault("admins", []).append({
        "email": email,
        "name": name,
        "added_by": added_by,
        "added_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })
    _save_admin_registry(registry)
    return True


def remove_admin(email: str) -> bool:
    """Remove an admin from the approved list. Returns True if found and removed."""
    email = email.strip().lower()
    registry = _load_admin_registry()
    admins = registry.get("admins", [])
    new_admins = [a for a in admins if a.get("email", "").lower() != email]
    if len(new_admins) == len(admins):
        return False
    registry["admins"] = new_admins
    _save_admin_registry(registry)
    return True


# ============== Test Account Exclusion ==============

def get_test_accounts() -> List[str]:
    """Get list of test account emails (excluded from analytics and ML exports)."""
    registry = _load_admin_registry()
    return [a.get("email", "").lower() for a in registry.get("test_accounts", [])]


def get_test_accounts_full() -> List[Dict]:
    """Get full test account entries (for the management UI)."""
    registry = _load_admin_registry()
    return registry.get("test_accounts", [])


def is_test_account(email: str) -> bool:
    """Check if an email is a test account."""
    return email.strip().lower() in get_test_accounts()


def add_test_account(email: str, name: str = "") -> bool:
    """Add a test account. Returns True if newly added."""
    email = email.strip().lower()
    if is_test_account(email):
        return False

    registry = _load_admin_registry()
    registry.setdefault("test_accounts", []).append({
        "email": email,
        "name": name,
        "added_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })
    _save_admin_registry(registry)
    return True


def remove_test_account(email: str) -> bool:
    """Remove a test account. Returns True if found and removed."""
    email = email.strip().lower()
    registry = _load_admin_registry()
    accounts = registry.get("test_accounts", [])
    new_accounts = [a for a in accounts if a.get("email", "").lower() != email]
    if len(new_accounts) == len(accounts):
        return False
    registry["test_accounts"] = new_accounts
    _save_admin_registry(registry)
    return True
