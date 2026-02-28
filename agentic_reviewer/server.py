"""
Standalone web server for Agentic Reviewer UI.

Run: python -m agentic_reviewer.server
Then open http://localhost:8765
"""
import json
import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from agentic_reviewer import build_snapshot, run_review

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Agentic Reviewer", version="0.1.0")

# Static files path
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


class ReviewRequest(BaseModel):
    session: dict
    checkpoint: str  # "preflight" | "final"
    selected_hunt_ids: list[int] | None = None


@app.post("/api/review")
def api_review(req: ReviewRequest):
    """Run review on session. Returns ReviewResult as JSON."""
    try:
        if req.checkpoint == "preflight":
            if not req.selected_hunt_ids or len(req.selected_hunt_ids) != 4:
                raise HTTPException(
                    status_code=400,
                    detail="Preflight requires selected_hunt_ids with exactly 4 IDs",
                )
            snapshot = build_snapshot(
                req.session, "preflight", selected_hunt_ids=req.selected_hunt_ids
            )
        else:
            snapshot = build_snapshot(req.session, "final")

        result = run_review(snapshot)
        return {
            "passed": result.passed,
            "checkpoint": result.checkpoint,
            "issues": [i.model_dump() for i in result.issues],
            "timestamp": result.timestamp,
        }
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Review failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/")
def index():
    """Serve the UI."""
    index_path = STATIC_DIR / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="UI not found")
    return FileResponse(index_path)


if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


def main():
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8765)


if __name__ == "__main__":
    main()
