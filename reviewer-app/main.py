"""
Reviewer App — FastAPI entry point.

Run from reviewer-app/ directory:
    cd reviewer-app && uvicorn main:app --reload --port 8001

Or from agentic-reviewer root (with PYTHONPATH):
    PYTHONPATH=. uvicorn reviewer_app.main:app --reload --port 8001
    (requires renaming folder to reviewer_app or adding a runner that sets path)
"""
import asyncio
import logging
import sys
from pathlib import Path

# Paths: reviewer-app/ (this app) and agentic-reviewer/ (parent, for agentic_reviewer)
_APP_DIR = Path(__file__).resolve().parent

# Load reviewer-app/.env so REDIS_URL (e.g. tunnel) is set before config
_env_file = _APP_DIR / ".env"
if _env_file.exists():
    from dotenv import load_dotenv
    load_dotenv(_env_file)
_AGENTIC_ROOT = _APP_DIR.parent
# Prefer reviewer-app so "config", "services", "api" resolve to this app.
# Always insert reviewer-app at 0 — uvicorn may already have it elsewhere in sys.path,
# and if we skip the insert, multiturn-hunter (parent) can end up first, causing
# "services" to resolve to multiturn-hunter/services (no get_redis) instead of
# reviewer-app/services (has get_redis).
if str(_AGENTIC_ROOT) not in sys.path:
    sys.path.insert(0, str(_AGENTIC_ROOT))
sys.path.insert(0, str(_APP_DIR))

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from api.routes import health, queue, task, comments, edit, agent_routes, audit_routes, review_actions, notifications, colab, presence, notebook_preview
from services import close_redis, get_redis

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: connect Redis. Shutdown: close Redis."""
    logger.info("Reviewer app starting")
    try:
        r = await get_redis()
        await r.ping()
        logger.info("Redis connected")
    except Exception as e:
        logger.warning("Redis connection: %s", e)
    yield
    logger.info("Reviewer app shutting down")
    await close_redis()


app = FastAPI(
    title="Reviewer App",
    description="Human reviewer platform for trainer tasks — presence, bulk actions, SSE, version history",
    version="1.0.0",
    lifespan=lifespan,
)

app.include_router(health.router)
app.include_router(queue.router)
app.include_router(task.router)
app.include_router(comments.router)
app.include_router(edit.router)
app.include_router(agent_routes.router)
app.include_router(audit_routes.router)
app.include_router(review_actions.router)
app.include_router(notifications.router)
app.include_router(colab.router)
app.include_router(presence.router)
app.include_router(notebook_preview.router)

# Static assets and UI — always register "/" so the UI loads
_STATIC_DIR = _APP_DIR / "static"
_INDEX_FILE = _STATIC_DIR / "index.html"


@app.get("/")
async def index(request: Request):
    """Serve the reviewer UI. When behind proxy with X-Forwarded-Prefix (e.g. /reviewer), inject <base> so assets and API use that prefix."""
    from fastapi.responses import HTMLResponse

    if not _INDEX_FILE.exists():
        return HTMLResponse(
            "<h1>Reviewer</h1><p>Static files not found. Run from reviewer-app: <code>uvicorn main:app --port 8001</code></p>",
            status_code=200,
        )
    prefix = (request.headers.get("x-forwarded-prefix") or "").strip().rstrip("/")
    if prefix:
        html = _INDEX_FILE.read_text(encoding="utf-8")
        base_tag = f'<base href="{prefix}/">'
        if "<base" not in html.lower():
            html = html.replace("<head>", "<head>\n  " + base_tag, 1)
        return HTMLResponse(html)
    return FileResponse(_INDEX_FILE)


if _STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")


if __name__ == "__main__":
    import os
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8003")),
        reload=True,
    )
