"""Health, readiness, and version endpoints. No allowlist required."""
import logging
import sys
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from services import get_redis

logger = logging.getLogger(__name__)

_repo_root = str(Path(__file__).resolve().parents[3])
if _repo_root not in sys.path:
    sys.path.insert(0, _repo_root)

router = APIRouter(tags=["health"])


def _compute_version():
    """Content-based hash of all files that affect the reviewer app."""
    import hashlib, glob
    base = str(Path(__file__).resolve().parents[2])
    repo = str(Path(__file__).resolve().parents[3])
    h = hashlib.md5()
    for pat in [
        f"{base}/static/**/*.js", f"{base}/static/**/*.css", f"{base}/static/**/*.html",
        f"{base}/api/**/*.py", f"{base}/services/**/*.py", f"{base}/config/**/*.py",
        f"{repo}/agentic_reviewer/**/*.py", f"{repo}/providers/**/*.py",
        f"{repo}/config/*.yaml", f"{repo}/notebook_headings.py",
    ]:
        for f in sorted(glob.glob(pat, recursive=True)):
            try:
                with open(f, "rb") as fh:
                    h.update(fh.read())
            except OSError:
                pass
    return f"rev.{h.hexdigest()[:10]}"

_cached_version = _compute_version()

@router.get("/api/version")
async def version():
    """Return app version hash. Polled by the UI to detect code changes."""
    return {"version": _cached_version}


@router.get("/api/council-models")
async def council_models():
    """Return council model list + chairman from config for dynamic UI."""
    try:
        from agentic_reviewer.config_loader import get_agentic_council
        cfg = get_agentic_council()
        models = []
        for m in cfg.get("models") or []:
            if isinstance(m, dict) and m.get("enabled", True):
                models.append(m.get("id", ""))
            elif isinstance(m, str):
                models.append(m)
        chairman = cfg.get("chairman_model", "")
        return {"models": models, "chairman": chairman}
    except Exception:
        return {"models": [], "chairman": ""}


@router.get("/health")
async def health():
    """Liveness: app is running."""
    return {"status": "ok"}


@router.get("/ready")
async def ready():
    """Readiness: app and Redis are available."""
    try:
        r = await get_redis()
        await r.ping()
        return {"status": "ok", "redis": "connected"}
    except Exception as e:
        logger.exception("Readiness check failed")
        return JSONResponse(
            status_code=503,
            content={"status": "degraded", "redis": str(e)},
        )
