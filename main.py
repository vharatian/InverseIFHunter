"""
Model Hunter - FastAPI Backend

Main application with endpoints for:
- Notebook upload/fetch
- Hunt execution with SSE streaming
- Results export
"""
import os
import json
import asyncio
from typing import Optional, Dict, Any
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, UploadFile, HTTPException, Query, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse, Response
from pydantic import BaseModel
from dotenv import load_dotenv
from sse_starlette.sse import EventSourceResponse

from models.schemas import (
    HuntConfig,
    HuntSession,
    HuntEvent,
    ParsedNotebook
)
from services.notebook_parser import notebook_parser
from services.hunt_engine import hunt_engine

# Load environment variables
load_dotenv()


# Lifespan handler
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    print("🔥 Model Hunter starting up...")
    yield
    # Shutdown
    print("🛑 Model Hunter shutting down...")


# Create FastAPI app
app = FastAPI(
    title="Model Hunter",
    description="Red-team LLM models with parallel hunts and automated judging",
    version="1.0.0",
    lifespan=lifespan
)


# ============== Request/Response Models ==============


class NotebookURLRequest(BaseModel):
    url: str


class StartHuntRequest(BaseModel):
    session_id: str
    config: Optional[HuntConfig] = None


class ExportRequest(BaseModel):
    session_id: str
    include_reasoning: bool = True


# ============== Storage ==============

# Storage configuration
STORAGE_DIR = os.path.join(os.getcwd(), ".storage")
os.makedirs(STORAGE_DIR, exist_ok=True)

def save_session_storage(session_id: str, data: dict):
    """Save session data to disk."""
    path = os.path.join(STORAGE_DIR, f"{session_id}.json")
    with open(path, 'w') as f:
        json.dump(data, f)

def get_session_storage(session_id: str) -> Optional[dict]:
    """Get session data from disk."""
    path = os.path.join(STORAGE_DIR, f"{session_id}.json")
    if os.path.exists(path):
        try:
            with open(path, 'r') as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading session storage {session_id}: {e}")
    return None


# ============== API Endpoints ==============


@app.post("/api/upload-notebook")
async def upload_notebook(file: UploadFile = File(...)):
    """Upload a .ipynb notebook file."""
    if not file.filename.endswith('.ipynb'):
        raise HTTPException(400, "File must be a .ipynb notebook")
    
    try:
        content = await file.read()
        content_str = content.decode('utf-8')
        
        parsed = notebook_parser.load_from_file(content_str, file.filename)
        
        # Create session
        config = HuntConfig()
        session = hunt_engine.create_session(parsed, config)
        
        # Store original content for export
        save_session_storage(session.session_id, {
            "original_content": content_str,
            "filename": file.filename
        })
        
        return {
            "success": True,
            "session_id": session.session_id,
            "notebook": {
                "filename": parsed.filename,
                "metadata": parsed.metadata,
                "prompt": parsed.prompt,
                "prompt_length": len(parsed.prompt),
                "response_reference": parsed.response_reference,
                "judge_system_prompt": parsed.judge_system_prompt,
                "judge_prompt_template": parsed.judge_prompt_template,
                "has_judge_prompt": bool(parsed.judge_system_prompt),
                "model_slots": list(parsed.model_slots.keys()),
                "attempts_made": parsed.attempts_made,
                "validation_warnings": parsed.validation_warnings
            }
        }
    except Exception as e:
        raise HTTPException(400, f"Failed to parse notebook: {str(e)}")


@app.post("/api/fetch-notebook")
async def fetch_notebook(request: NotebookURLRequest):
    """Fetch a notebook from a URL."""
    try:
        parsed, content_str = await notebook_parser.load_from_url(request.url)
        
        # Create session
        config = HuntConfig()
        session = hunt_engine.create_session(parsed, config)
        
        # We don't have original content for URL fetches, recreate from parsed
        save_session_storage(session.session_id, {
            "original_content": content_str,
            "filename": parsed.filename,
            "url": request.url
        })
        
        return {
            "success": True,
            "session_id": session.session_id,
            "notebook": {
                "filename": parsed.filename,
                "metadata": parsed.metadata,
                "prompt": parsed.prompt,
                "prompt_length": len(parsed.prompt),
                "response": parsed.response,  # The expected response from [response] heading
                "response_reference": parsed.response_reference,
                "judge_system_prompt": parsed.judge_system_prompt,
                "judge_prompt_template": parsed.judge_prompt_template,
                "has_judge_prompt": bool(parsed.judge_system_prompt),
                "model_slots": list(parsed.model_slots.keys()),
                "attempts_made": parsed.attempts_made
            }
        }
    except Exception as e:
        raise HTTPException(400, f"Failed to fetch notebook: {str(e)}")


@app.get("/api/session/{session_id}")
async def get_session(session_id: str):
    """Get session details."""
    session = hunt_engine.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    
    return {
        "session_id": session.session_id,
        "status": session.status.value,
        "total_hunts": session.total_hunts,
        "completed_hunts": session.completed_hunts,
        "breaks_found": session.breaks_found,
        "config": session.config.model_dump(),
        "results": [r.model_dump() for r in session.results]
    }


@app.post("/api/update-config/{session_id}")
async def update_config(session_id: str, config: HuntConfig):
    """Update hunt configuration for a session."""
    session = hunt_engine.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    
    session.config = config
    session.total_hunts = config.parallel_workers
    
    return {"success": True, "config": config.model_dump()}


class UpdateResponseRequest(BaseModel):
    response: str


@app.post("/api/update-response/{session_id}")
async def update_response(session_id: str, request: UpdateResponseRequest):
    """Update the [response] section in the notebook and save to Colab."""
    session = hunt_engine.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    
    # Get session storage for URL and original content
    storage = get_session_storage(session_id)
    if not storage or "url" not in storage:
        raise HTTPException(400, "No source URL found - cannot save back to Colab")
    
    try:
        # Parse original notebook content
        original_content = storage.get("original_content", "{}")
        notebook_data = json.loads(original_content)
        
        # Find and update the [response] cell
        updated = False
        for cell in notebook_data.get("cells", []):
            if cell.get("cell_type") == "markdown":
                source = "".join(cell.get("source", []))
                if "**[response]**" in source.lower() or "**[response]**" in source:
                    # Update the cell content, preserving the heading
                    lines = source.split("\n")
                    new_source = lines[0] + "\n\n" + request.response
                    cell["source"] = [new_source]
                    updated = True
                    break
        
        if not updated:
            raise HTTPException(400, "Could not find [response] cell in notebook")
        
        # Save to Google Drive
        from services.google_drive_client import drive_client
        file_id = drive_client.get_file_id_from_url(storage["url"])
        if not file_id:
            raise HTTPException(400, "Could not extract file ID from URL")
        
        # Convert notebook back to JSON
        updated_content = json.dumps(notebook_data, indent=2)
        
        # Update file on Drive
        success = drive_client.update_file_content(file_id, updated_content)
        if not success:
            raise HTTPException(500, "Failed to update file on Google Drive")
        
        # Update session's notebook with new response
        session.notebook.response = request.response
        
        # Update storage with new content
        storage["original_content"] = updated_content
        save_session_storage(session_id, storage)
        
        return {"success": True, "message": "Response saved to Colab notebook"}
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Error saving to Colab: {str(e)}")


@app.post("/api/judge-reference/{session_id}")
async def judge_reference(session_id: str):
    """Judge the original reference response to verify it's correct."""
    session = hunt_engine.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    
    # Re-fetch notebook from Colab to get latest response_reference
    storage = get_session_storage(session_id)
    old_ref = session.notebook.response_reference[:100] if session.notebook.response_reference else "empty"
    
    if storage and "url" in storage:
        try:
            # Re-fetch the notebook to get latest content
            parsed, _ = await notebook_parser.load_from_url(storage["url"])
            # Update session with latest notebook data
            session.notebook = parsed
            # Extract criteria count for debugging
            import re
            import json as json_lib
            ref = session.notebook.response_reference or ""
            array_match = re.search(r'\[.*?\]', ref, re.DOTALL)
            criteria_count = 0
            criteria_ids = []
            if array_match:
                try:
                    criteria_list = json_lib.loads(array_match.group(0))
                    if isinstance(criteria_list, list):
                        criteria_count = len(criteria_list)
                        criteria_ids = [item.get('id', f'C{i+1}') if isinstance(item, dict) else f'C{i+1}' 
                                       for i, item in enumerate(criteria_list)]
                except Exception as parse_err:
                    print(f"DEBUG: Could not parse criteria list: {parse_err}")
            new_ref = ref[:100] if ref else "empty"
            print(f"DEBUG: Refreshed notebook from Colab for session {session_id}.")
            print(f"DEBUG: Old response_reference (first 100 chars): {old_ref}...")
            print(f"DEBUG: New response_reference (first 100 chars): {new_ref}...")
            print(f"DEBUG: Found {criteria_count} criteria: {criteria_ids}")
        except Exception as e:
            print(f"WARNING: Could not refresh notebook from Colab: {e}. Using cached version.")
            import traceback
            traceback.print_exc()
    else:
        print(f"WARNING: No storage URL found for session {session_id}. Cannot refresh from Colab.")
    
    notebook = session.notebook
    
    # The 'response' is the expected answer to judge
    if not notebook.response:
        raise HTTPException(400, "No expected response available in notebook - add a **[response]** cell")
    
    try:
        from services.openai_client import get_openai_judge_client
        judge = get_openai_judge_client()
        
        judge_result = await judge.judge_response(
            prompt=notebook.prompt,
            student_response=notebook.response,  # Judge the expected response
            response_reference=notebook.response_reference,  # Against the criteria (now fresh from Colab)
            judge_system_prompt=notebook.judge_system_prompt,
            judge_prompt_template=notebook.judge_prompt_template,
            model="gpt-5"
        )
        
        score = judge_result.get("score")
        criteria = judge_result.get("criteria", {})
        
        # Check for missing criteria by comparing with initial criteria from session
        # We need to get the initial criteria that was loaded when notebook was first uploaded
        # For now, we'll let the frontend handle this comparison since it has state.initialCriteria
        
        # Also return the current response_reference so frontend can re-parse criteria
        # This ensures state.criteria is always in sync with what was actually judged
        return {
            "success": True,
            "score": score,
            "explanation": judge_result.get("explanation", ""),
            "criteria": criteria,
            "raw_output": judge_result.get("raw_output", ""),
            "is_passing": (score or 0) >= 1,  # Handle None score
            "response_reference": notebook.response_reference  # Include fresh response_reference
        }
    except Exception as e:
        raise HTTPException(500, f"Judge error: {str(e)}")


@app.post("/api/start-hunt")
async def start_hunt(request: StartHuntRequest):
    """Start a hunt (non-streaming, returns when complete)."""
    session = hunt_engine.get_session(request.session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    
    if request.config:
        session.config = request.config
        session.total_hunts = request.config.parallel_workers
    
    # Run hunt
    result_session = await hunt_engine.run_hunt(request.session_id)
    
    return {
        "success": True,
        "session_id": result_session.session_id,
        "status": result_session.status.value,
        "completed_hunts": result_session.completed_hunts,
        "breaks_found": result_session.breaks_found,
        "results": [r.model_dump() for r in result_session.results]
    }


@app.get("/api/hunt-stream/{session_id}")
async def hunt_stream(session_id: str, request: Request):
    """
    SSE endpoint for real-time hunt progress.
    
    Starts the hunt and streams events as they happen.
    """
    session = hunt_engine.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    
    async def event_generator():
        queue = asyncio.Queue()
        
        async def callback(event: HuntEvent):
            await queue.put(event)
        
        # Start hunt in background
        hunt_task = asyncio.create_task(
            hunt_engine.run_hunt(session_id, progress_callback=callback)
        )
        
        try:
            while True:
                # Check if client disconnected
                if await request.is_disconnected():
                    hunt_task.cancel()
                    break
                
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=1.0)
                    yield {
                        "event": event.event_type,
                        "data": json.dumps({
                            "hunt_id": event.hunt_id,
                            **event.data
                        })
                    }
                    
                    # Stop on complete or error
                    if event.event_type in ("complete", "error"):
                        break
                        
                except asyncio.TimeoutError:
                    # Send keepalive
                    yield {"event": "ping", "data": "{}"}
                    
        except asyncio.CancelledError:
            pass
        finally:
            if not hunt_task.done():
                hunt_task.cancel()
    
    return EventSourceResponse(event_generator())


@app.get("/api/export-notebook/{session_id}")
async def export_notebook(session_id: str, include_reasoning: bool = True):
    """Export modified notebook with hunt results."""
    try:
        session = hunt_engine.get_session(session_id)
        if not session:
            raise HTTPException(404, "Session not found")
        
        storage = get_session_storage(session_id)
        if not storage:
            raise HTTPException(400, "Original notebook content not available")
        
        original_content = storage.get("original_content")
        if not original_content:
            raise HTTPException(400, "Original notebook content not stored (URL fetch)")
        
        # Get results for export
        results = hunt_engine.export_results(session_id)
        
        # Get human reviews (saved via /api/save-reviews)
        human_reviews = getattr(session, 'human_reviews', {})
        
        # Generate modified notebook
        modified_content = notebook_parser.export_notebook(
            original_content=original_content,
            parsed=session.notebook,
            results=results,
            include_reasoning=include_reasoning,
            human_reviews=human_reviews
        )
        
        # Return as downloadable file
        filename = storage.get("filename", "notebook.ipynb")
        if not filename.endswith('.ipynb'):
            filename += '.ipynb'
        
        # Sanitize filename for header
        safe_filename = filename.replace('"', '').replace('\n', '').replace('\r', '').strip()
        
        return Response(
            content=modified_content,
            media_type="application/json",
            headers={
                "Content-Disposition": f'attachment; filename="modified_{safe_filename}"'
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        print(f"Export error trace:")
        import traceback
        traceback.print_exc()
        raise HTTPException(500, f"Export failed: {str(e)}")


@app.post("/api/save-reviews/{session_id}")
async def save_reviews(session_id: str, request: Request):
    """Save human reviews for notebook export."""
    session = hunt_engine.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    
    data = await request.json()
    reviews = data.get("reviews", {})
    
    # Store reviews in session for export
    if not hasattr(session, 'human_reviews'):
        session.human_reviews = {}
    session.human_reviews = reviews
    
    return {"success": True, "saved_count": len(reviews)}


@app.post("/api/save-to-drive/{session_id}")
async def save_to_drive(session_id: str, request: Request):
    """Save ONLY SELECTED results to the Google Drive notebook."""
    try:
        from services.google_drive_client import drive_client
        
        # Parse request body to get selected hunt IDs
        body = await request.json()
        selected_hunt_ids = body.get("selected_hunt_ids", [])
        
        session = hunt_engine.get_session(session_id)
        if not session:
            raise HTTPException(404, "Session not found")
            
        # Get URL from storage
        storage = get_session_storage(session_id)
        if not storage or not storage.get("url"):
            raise HTTPException(400, "No Google Drive URL found for this session")
            
        url = storage.get("url")
        file_id = drive_client.get_file_id_from_url(url)
        
        if not file_id:
            raise HTTPException(400, "Could not extract File ID from URL")
            
        # Generate content - FILTER to only selected results
        original_content = storage.get("original_content")
        all_results = hunt_engine.export_results(session_id)
        
        # Filter results to only include selected hunt IDs
        if selected_hunt_ids:
            results = [r for r in all_results if r.get('hunt_id') in selected_hunt_ids]
            print(f"DEBUG: Filtering to {len(results)} selected results out of {len(all_results)} total")
        else:
            # Fallback: use all if no selection provided
            results = all_results
            print(f"WARNING: No selected_hunt_ids provided, saving all {len(results)} results")
        
        human_reviews = getattr(session, 'human_reviews', {})
        
        modified_content = notebook_parser.export_notebook(
            original_content=original_content,
            parsed=session.notebook,
            results=results,
            include_reasoning=True,
            human_reviews=human_reviews
        )
        
        # Update file (export_notebook returns JSON string already)
        success = drive_client.update_file_content(file_id, modified_content)
        
        if not success:
            raise HTTPException(500, "Failed to update file on Google Drive (Auth error?)")
            
        return {"success": True, "message": f"Successfully updated notebook {file_id}"}
        
    except ImportError:
         raise HTTPException(500, "Google Drive dependencies not installed")
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"Drive save error: {str(e)}")
        raise HTTPException(500, f"Drive save failed: {str(e)}")


@app.get("/api/results/{session_id}")
async def get_all_results(session_id: str):
    """Get ALL results for a session (for selection UI)."""
    session = hunt_engine.sessions.get(session_id)
    if not session:
        return {"count": 0, "results": []}
    
    # Return all completed results
    completed = [r for r in session.results if r.status.value == "completed"]
    return {
        "count": len(completed),
        "results": [r.model_dump() for r in completed]
    }


@app.get("/api/breaking-results/{session_id}")
async def get_breaking_results(session_id: str):
    """Get only the breaking (score 0) results."""
    results = hunt_engine.get_breaking_results(session_id)
    return {
        "count": len(results),
        "results": [r.model_dump() for r in results]
    }


@app.get("/api/review-results/{session_id}")
async def get_review_results(session_id: str):
    """
    Get 4 selected responses for human review.
    Priority: 4 failed (score 0) OR 3 failed + 1 passed.
    """
    results = hunt_engine.get_selected_for_review(session_id, target_count=4)
    return {
        "count": len(results),
        "results": [r.model_dump() for r in results],
        "summary": {
            "failed_count": len([r for r in results if r.judge_score == 0]),
            "passed_count": len([r for r in results if r.judge_score >= 1])
        }
    }


@app.get("/api/models")
async def get_available_models():
    """Get available models for hunting."""
    from services.openrouter_client import OpenRouterClient
    return {
        "models": OpenRouterClient.MODELS,
        "judge_models": ["gpt-5", "gpt-4o", "gpt-4-turbo"]
    }


@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "service": "model-hunter"}


# ============== Static Files & Frontend ==============


# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root():
    """Serve the main frontend page."""
    return FileResponse("static/index.html")


# ============== Run with uvicorn ==============


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True
    )
