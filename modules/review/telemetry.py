"""
Reviewer-app → main telemetry shim.

The reviewer-app mounts its own `services` package which shadows the main
app's `services.telemetry_logger` during import (see modules/review/router.py).
This module lazy-imports the main-app telemetry logger AT CALL TIME (when
the original sys.modules has been restored) and exposes a thin helper that
attaches the reviewer's identity to every event.

All calls are fire-and-forget; failures never raise.
"""
from typing import Any, Dict, Optional


def log_reviewer_event(
    event_type: str,
    reviewer_email: Optional[str] = None,
    data: Optional[Dict[str, Any]] = None,
) -> None:
    """Emit a telemetry event tagged with reviewer_email.

    Safe to call from reviewer-app routes; never raises.
    """
    try:
        import sys
        import importlib

        # Prefer already-loaded main-app telemetry module; fall back to a
        # fresh import if it was replaced by a namespace sibling.
        mod = sys.modules.get("services.telemetry_logger")
        if mod is None or not hasattr(mod, "log_event"):
            mod = importlib.import_module("services.telemetry_logger")
        payload: Dict[str, Any] = dict(data or {})
        if reviewer_email:
            payload.setdefault("reviewer_email", str(reviewer_email).strip().lower())
        mod.log_event(event_type, payload)
    except Exception:
        pass
