"""
Trace ID middleware — generates or propagates X-Trace-Id on every request.

The trace_id is stored in contextvars so any code in the request chain
can access it via get_trace_id() without passing it explicitly.
"""
import uuid
from contextvars import ContextVar

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

trace_id_var: ContextVar[str] = ContextVar("trace_id", default="")

HEADER = "X-Trace-Id"


def get_trace_id() -> str:
    return trace_id_var.get()


class TraceIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        tid = request.headers.get(HEADER) or f"tr_{uuid.uuid4().hex[:12]}"
        trace_id_var.set(tid)
        response = await call_next(request)
        response.headers[HEADER] = tid
        return response
