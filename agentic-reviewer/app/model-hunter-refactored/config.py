"""
App config helpers — thin wrapper over agentic_reviewer.config_loader.

Provides app-specific helpers and avoids duplicate config logic.
"""
from typing import Any, Optional


def get_config_value(path: str, default: Any = None) -> Any:
    """Get config value by dotted path. Returns default on error."""
    try:
        from agentic_reviewer.config_loader import get_config_value as _get
        return _get(path, default)
    except Exception:
        return default


def is_rate_limiter_enabled() -> bool:
    """Whether rate limiter is enabled (from features.rate_limiter_enabled)."""
    features = get_config_value("features") or {}
    return features.get("rate_limiter_enabled", True)


def get_app_config() -> dict:
    """Safe subset of config for frontend (app, hunt limits, auto_save, no secrets)."""
    try:
        from agentic_reviewer.config_loader import get_config_value
        return {
            "app": get_config_value("app") or {},
            "hunt": get_config_value("hunt") or {},
            "features": get_config_value("features") or {},
            "auto_save": get_config_value("auto_save") or {},
            "notifications": {
                "poll_interval_ms": (get_config_value("notifications.poll_interval_ms") or 15000),
            },
        }
    except Exception:
        return {}
