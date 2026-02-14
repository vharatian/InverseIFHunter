"""
Model Hunter - FastAPI Backend

Main application entry point. Routes are organized in the `routes/` package.
Storage logic lives in `storage/`. Shared helpers live in `helpers/`.
"""
import os
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.types import Receive, Scope, Send

from dotenv import load_dotenv

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv()

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

def _compute_app_version():
    """Generate version from modification times of key files. Changes automatically on any update."""
    files = [__file__, os.path.join(os.path.dirname(__file__), "static", "app.js"),
             os.path.join(os.path.dirname(__file__), "static", "index.html")]
    mtimes = ""
    for f in files:
        try: mtimes += str(os.path.getmtime(f))
        except: pass
    short_hash = _hashlib.md5(mtimes.encode()).hexdigest()[:8]
    return f"1.1.{short_hash}"

APP_VERSION = _compute_app_version()


# ============== Redis & Rate Limiter ==============

import services.redis_session as redis_store

# Rate limiter import - wrapped to never fail
try:
    from services.rate_limiter import get_rate_limiter
    _rate_limiter_enabled = True
except ImportError:
    _rate_limiter_enabled = False


# ============== Lifespan ==============

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info("🔥 Model Hunter starting up...")
    
    try:
        stats = await redis_store.get_stats()
        logger.info(f"📦 Redis session store: {stats['status']} ({stats['active_sessions']} active sessions)")
    except Exception as e:
        logger.warning(f"⚠️ Redis session store initialization: {e}")
    
    if _rate_limiter_enabled:
        try:
            limiter = get_rate_limiter()
            stats = limiter.get_stats()
            logger.info(f"🚦 Rate limiter initialized with limits: {stats['limits']}")
        except Exception as e:
            logger.warning(f"⚠️ Rate limiter initialization: {e}")
    
    from services.hunt_worker import run_worker_loop
    worker_task = asyncio.create_task(run_worker_loop())
    logger.info("🏗️ Hunt worker started")

    yield

    # Shutdown
    logger.info("🛑 Model Hunter shutting down...")
    worker_task.cancel()
    try:
        await worker_task
    except asyncio.CancelledError:
        pass
    
    try:
        await redis_store.close()
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

# Import and include all route modules
from routes.trainer import router as trainer_router
from routes.session import router as session_router
from routes.notebook import router as notebook_router
from routes.hunt import router as hunt_router
from routes.calibration import router as calibration_router
from routes.multiturn import router as multiturn_router
from routes.system import router as system_router

app.include_router(trainer_router)
app.include_router(session_router)
app.include_router(notebook_router)
app.include_router(hunt_router)
app.include_router(calibration_router)
app.include_router(multiturn_router)
app.include_router(system_router)


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


# ============== Run with uvicorn ==============

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=False
    )
