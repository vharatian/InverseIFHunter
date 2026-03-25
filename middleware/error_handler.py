"""
Global error handler — catches all unhandled exceptions and returns
structured JSON error responses per design spec §9.2.
"""
import logging
from datetime import datetime, timezone

from fastapi import Request
from fastapi.responses import JSONResponse

from middleware.trace_id import get_trace_id

logger = logging.getLogger(__name__)


async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    trace_id = get_trace_id()
    logger.error(
        f"Unhandled exception: {exc}",
        extra={"trace_id": trace_id, "path": request.url.path},
        exc_info=True,
    )
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "code": "INTERNAL_UNEXPECTED",
                "category": "internal",
                "message": "Something went wrong. Please try again or report this error.",
                "detail": str(exc) if logger.isEnabledFor(logging.DEBUG) else None,
                "trace_id": trace_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "retry_after_seconds": None,
                "action": None,
            }
        },
    )
