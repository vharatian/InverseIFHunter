"""
Model Hunter - FastAPI Backend

Main application entry point. Routes are organized in the `routes/` package.
Storage logic lives in `storage/`. Shared helpers live in `helpers/`.
"""
import os
import sys
import asyncio
import logging
from pathlib import Path
from contextlib import asynccontextmanager

# Multiturn-hunter is self-contained: agentic_reviewer and config live here
# In Docker, set AGENTIC_REVIEWER_ROOT to override (e.g. /workspace/multiturn-hunter)
_agentic_root = os.environ.get("AGENTIC_REVIEWER_ROOT")
if not _agentic_root:
    _agentic_root = str(Path(__file__).resolve().parent)
else:
    _agentic_root = _agentic_root.rstrip("/")
if _agentic_root not in sys.path:
    sys.path.insert(0, _agentic_root)

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from starlette.types import Receive, Scope, Send

from dotenv import load_dotenv

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Load environment variables (ignore OSError during reload — worker can be interrupted mid-read)
try:
    load_dotenv()
except OSError as e:
    if getattr(e, "errno", None) != 89:  # 89 = Operation canceled (reload race)
        raise
    logger.debug("load_dotenv skipped (reload race): %s", e)

# Auto-detect service account JSON if not explicitly set
if not os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON_PATH"):
    _sa_candidates = [
        os.path.join(os.getcwd(), "service_account.json"),
        os.path.join(os.path.dirname(__file__), "service_account.json"),
        "/app/service_account.json",
    ]
    for _sa_path in _sa_candidates:
        if os.path.exists(_sa_path):
            os.environ["GOOGLE_SERVICE_ACCOUNT_JSON_PATH"] = _sa_path
            logger.info(f"Auto-detected service account: {_sa_path}")
            break


# ============== App Version ==============

import hashlib as _hashlib
import glob as _glob

def _compute_app_version():
    """Generate version from file contents (not mtimes) so blue/green containers produce the same hash."""
    base = os.path.dirname(os.path.abspath(__file__))
    patterns = [
        os.path.join(base, "*.py"),
        os.path.join(base, "routes", "*.py"),
        os.path.join(base, "services", "*.py"),
        os.path.join(base, "models", "*.py"),
        os.path.join(base, "static", "**", "*.js"),
        os.path.join(base, "static", "**", "*.css"),
        os.path.join(base, "static", "**", "*.html"),
        os.path.join(base, "config", "*.yaml"),
        os.path.join(base, "config", "*.yml"),
        os.path.join(base, "templates", "**", "*.html"),
        os.path.join(base, "reviewer-app", "static", "**", "*.js"),
        os.path.join(base, "reviewer-app", "static", "**", "*.css"),
        os.path.join(base, "reviewer-app", "static", "**", "*.html"),
        os.path.join(base, "reviewer-app", "api", "**", "*.py"),
    ]
    content_hash = _hashlib.md5()
    for pat in patterns:
        for f in sorted(_glob.glob(pat, recursive=True)):
            try:
                with open(f, "rb") as fh:
                    content_hash.update(fh.read())
            except OSError:
                pass
    return f"1.1.{content_hash.hexdigest()[:8]}"

APP_VERSION = _compute_app_version()


# ============== Redis & Rate Limiter ==============

logger.info("Loading redis_session...")
import services.redis_session as redis_store
from redis_client import close_redis
logger.info("Loading rate_limiter...")

# Rate limiter - from config.features.rate_limiter_enabled
try:
    from services.rate_limiter import get_rate_limiter
    from config import is_rate_limiter_enabled
    _rate_limiter_enabled = is_rate_limiter_enabled()
except ImportError as e:
    logger.warning("Rate limiter import failed: %s", e)
    _rate_limiter_enabled = False
logger.info("Loading routes...")


# ============== Lifespan ==============

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info("Model Hunter starting up...")
    
    try:
        stats = await redis_store.get_stats()
        logger.info(f"Redis session store: {stats['status']} ({stats['active_sessions']} active sessions)")
    except Exception as e:
        logger.warning(f"Redis session store initialization: {e}")
    
    if _rate_limiter_enabled:
        try:
            limiter = get_rate_limiter()
            stats = limiter.get_stats()
            logger.info(f"Rate limiter initialized with limits: {stats['limits']}")
        except Exception as e:
            logger.warning(f"Rate limiter initialization: {e}")
    
    from services.hunt_worker import run_worker_loop
    worker_task = asyncio.create_task(run_worker_loop())
    logger.info("Hunt worker started")

    yield

    # Shutdown
    logger.info("Model Hunter shutting down...")
    worker_task.cancel()
    try:
        await worker_task
    except asyncio.CancelledError:
        pass
    
    try:
        await close_redis()
    except Exception:
        pass
    
    if _rate_limiter_enabled:
        try:
            limiter = get_rate_limiter()
            await limiter.close()
        except Exception:
            pass


# ============== Create App & Include Routers ==============

app = FastAPI(
    title="Model Hunter",
    description="Red-team LLM models with parallel hunts and automated judging",
    version="1.0.0",
    lifespan=lifespan
)

from middleware.trace_id import TraceIdMiddleware
from middleware.error_handler import global_exception_handler

app.add_middleware(TraceIdMiddleware)
app.add_exception_handler(Exception, global_exception_handler)

_metrics_exposed = False
try:
    from prometheus_fastapi_instrumentator import Instrumentator

    Instrumentator().instrument(app).expose(app, endpoint="/metrics", include_in_schema=False)
    _metrics_exposed = True
except Exception:
    logger.exception("prometheus_fastapi_instrumentator failed; using minimal /metrics")

if not _metrics_exposed:
    from fastapi.responses import PlainTextResponse

    @app.get("/metrics", include_in_schema=False)
    async def _prometheus_metrics_minimal():
        return PlainTextResponse(
            "# HELP mh_python_core_up python-core up\n# TYPE mh_python_core_up gauge\nmh_python_core_up 1\n",
            media_type="text/plain; version=0.0.4",
        )

from resilience.health import health_live, health_ready, health_deep


@app.get("/health/live")
async def _health_live():
    return await health_live()


@app.get("/health/ready")
async def _health_ready():
    return await health_ready()


@app.get("/health/deep")
async def _health_deep():
    return await health_deep()


# Import and include all route modules
from routes.trainer import router as trainer_router
from routes.session import router as session_router
from routes.notebook import router as notebook_router
from routes.hunt import router as hunt_router
from routes.calibration import router as calibration_router
from routes.multiturn import router as multiturn_router
from routes.system import router as system_router
from routes.agentic import router as agentic_router
from routes.notifications import router as notifications_router

app.include_router(trainer_router)
app.include_router(session_router)
app.include_router(notebook_router)
app.include_router(hunt_router)
app.include_router(calibration_router)
app.include_router(multiturn_router)
app.include_router(system_router)
app.include_router(agentic_router)
app.include_router(notifications_router)

# Reviewer app routes (absorbed from reviewer-app/)
try:
    from modules.review.router import reviewer_router
    app.include_router(reviewer_router, prefix="/reviewer")
    logger.info("Reviewer routes loaded at /reviewer/")
except Exception as e:
    logger.warning(f"Reviewer routes not loaded: {e}")

logger.info("All routes loaded.")

# ============== Static Files ==============

class NoCacheStaticFiles(StaticFiles):
    """StaticFiles with no-cache headers to prevent browser caching."""
    
    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        async def send_wrapper(message: dict) -> None:
            if message["type"] == "http.response.start":
                headers = dict(message.get("headers", []))
                headers[b"cache-control"] = b"no-cache, no-store, must-revalidate"
                headers[b"pragma"] = b"no-cache"
                headers[b"expires"] = b"0"
                message["headers"] = list(headers.items())
            await send(message)
        
        await super().__call__(scope, receive, send_wrapper)

app.mount("/static", NoCacheStaticFiles(directory="static"), name="static")

# Reviewer static files
_reviewer_static = os.path.join(os.path.dirname(__file__), "reviewer-app", "static")
if os.path.isdir(_reviewer_static):
    app.mount("/reviewer/static", NoCacheStaticFiles(directory=_reviewer_static), name="reviewer-static")


@app.get("/reviewer/")
async def reviewer_index(request: Request):
    """Serve the reviewer UI index page."""
    index_path = os.path.join(os.path.dirname(__file__), "reviewer-app", "static", "index.html")
    if os.path.exists(index_path):
        from starlette.responses import HTMLResponse
        with open(index_path) as f:
            content = f.read()
        path = request.url.path.rstrip("/") or "/"
        if path.endswith("/reviewer"):
            base_href = f"{path}/"
        else:
            prefix = (request.headers.get("x-forwarded-prefix") or "").rstrip("/")
            base_href = f"{prefix}/reviewer/"
        base_tag = f'<base href="{base_href}">'
        if "<base" not in content.lower():
            content = content.replace("<head>", "<head>\n  " + base_tag, 1)
        return HTMLResponse(content)
    return {"error": "Reviewer UI not found"}


# ============== Run with uvicorn ==============

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=False
    )
