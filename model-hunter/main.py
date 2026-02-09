"""
Model Hunter - FastAPI Backend

Main application with endpoints for:
- Notebook upload/fetch
- Hunt execution with SSE streaming
- Results export
- Snapshot-based WYSIWYG saving
"""
import os
import json
import asyncio
import logging
from typing import Optional, Dict, Any, List

# App version - increment this on each deployment for update prompt
APP_VERSION = "1.0.4"
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI, File, UploadFile, HTTPException, Query, Request, BackgroundTasks
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse, Response
from pydantic import BaseModel
from dotenv import load_dotenv
from sse_starlette.sse import EventSourceResponse

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

from models.schemas import (
    HuntConfig,
    HuntSession,
    HuntEvent,
    ParsedNotebook,
    TurnData,
    HuntStatus
)
from services.notebook_parser import notebook_parser
from services.hunt_engine import hunt_engine
from services.snapshot_service import snapshot_service, NotebookSnapshot

# Telemetry import - wrapped to never fail
try:
    from services.telemetry_logger import get_telemetry
    _telemetry_enabled = True
except ImportError:
    _telemetry_enabled = False

# Trainer identity for fun character names
try:
    from services.trainer_identity import get_trainer_info
    _trainer_identity_enabled = True
except ImportError:
    _trainer_identity_enabled = False

# Session store import - wrapped to never fail
try:
    from services.session_store import get_session_store
    _session_store_enabled = True
except ImportError:
    _session_store_enabled = False

# Rate limiter import - wrapped to never fail
try:
    from services.rate_limiter import get_rate_limiter
    _rate_limiter_enabled = True
except ImportError:
    _rate_limiter_enabled = False

# Load environment variables
load_dotenv()


# ============== Shared Constants ==============

# Heading map for notebook cell types
HEADING_MAP = {
    "prompt": "**[prompt]**",
    "response": "**[response]**",
    "response_reference": "**[response_reference]**",
    "judge_system_prompt": "**[judge_system_prompt]**"
}

# Cell order for notebook structure
CELL_ORDER = ["prompt", "response", "response_reference", "judge_system_prompt"]


# ============== Notebook Cell Helpers ==============

def _find_metadata_cell_index(notebook_data: dict) -> int:
    """
    Find the index of the metadata cell in a notebook.
    
    Returns:
        Index of metadata cell, or -1 if not found
    """
    for i, cell in enumerate(notebook_data.get("cells", [])):
        if cell.get("cell_type") == "markdown":
            source = "".join(cell.get("source", []))
            if "# Metadata" in source or "Metadata" in source:
                return i
    return -1


def _find_cell_insertion_index(
    notebook_data: dict,
    target_cell_type: str,
    metadata_index: int = -1
) -> int:
    """
    Find the correct insertion index for a new cell based on cell order.
    
    Ensures cells are in correct order: prompt, response, response_reference, judge_system_prompt.
    
    Args:
        notebook_data: The notebook data dict
        target_cell_type: The cell type being inserted (e.g., "response")
        metadata_index: Index of metadata cell (pass -1 to auto-detect)
    
    Returns:
        The index where the new cell should be inserted
    """
    if metadata_index == -1:
        metadata_index = _find_metadata_cell_index(notebook_data)
    
    # Start insertion after metadata if found, otherwise at start
    insert_index = metadata_index + 1 if metadata_index >= 0 else 0
    
    # Get target cell's position in order
    current_cell_index = CELL_ORDER.index(target_cell_type) if target_cell_type in CELL_ORDER else -1
    
    if current_cell_index == -1:
        return insert_index
    
    # Find where to insert based on cell order
    for i, cell in enumerate(notebook_data.get("cells", [])):
        if i <= (metadata_index if metadata_index >= 0 else -1):
            continue  # Skip metadata and cells before it
            
        if cell.get("cell_type") == "markdown":
            source = "".join(cell.get("source", []))
            
            # Check if this cell is one of our ordered cells
            for j, cell_type in enumerate(CELL_ORDER):
                if cell_type == target_cell_type:
                    continue  # Skip the cell we're creating
                    
                heading = HEADING_MAP.get(cell_type, "")
                if heading and heading.lower() in source.lower():
                    if j < current_cell_index:
                        # This cell comes before ours - insert after it
                        insert_index = i + 1
                    elif j > current_cell_index:
                        # Found a cell that comes after - insert before it
                        return i
                    break
    
    # Ensure we don't insert before metadata
    if metadata_index >= 0 and insert_index <= metadata_index:
        insert_index = metadata_index + 1
    
    return insert_index


def _create_notebook_cell(heading_pattern: str, content: str) -> dict:
    """
    Create a new markdown cell with proper Jupyter format.
    
    Args:
        heading_pattern: The heading pattern (e.g., "**[response]**")
        content: The cell content
    
    Returns:
        A dict representing the notebook cell
    """
    full_content = f"{heading_pattern}\n\n{content}"
    content_lines = full_content.split("\n")
    
    # Jupyter format: each line as separate string with newline except last
    source = [line + "\n" for line in content_lines[:-1]] + [content_lines[-1]] if content_lines else [""]
    
    return {
        "cell_type": "markdown",
        "metadata": {},
        "source": source
    }


def _update_session_notebook_field(session: HuntSession, cell_type: str, content: str):
    """
    Update the appropriate field in session.notebook based on cell type.
    
    Args:
        session: The hunt session
        cell_type: The cell type (prompt, response, response_reference, judge_system_prompt)
        content: The new content
    """
    if cell_type == "prompt":
        session.notebook.prompt = content
    elif cell_type == "response":
        session.notebook.response = content
    elif cell_type == "response_reference":
        session.notebook.response_reference = content
    elif cell_type == "judge_system_prompt":
        session.notebook.judge_system_prompt = content


# Lifespan handler
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info("🔥 Model Hunter starting up...")
    
    # Initialize Redis session store
    if _session_store_enabled:
        try:
            store = get_session_store()
            stats = await store.get_stats()
            logger.info(f"📦 Session store: {stats['backend']} ({stats['active_sessions']} active sessions)")
        except Exception as e:
            logger.warning(f"⚠️ Session store initialization: {e}")
    
    # Initialize rate limiter
    if _rate_limiter_enabled:
        try:
            limiter = get_rate_limiter()
            stats = limiter.get_stats()
            logger.info(f"🚦 Rate limiter initialized with limits: {stats['limits']}")
        except Exception as e:
            logger.warning(f"⚠️ Rate limiter initialization: {e}")
    
    yield
    
    # Shutdown - cleanup
    logger.info("🛑 Model Hunter shutting down...")
    
    # Close session store
    if _session_store_enabled:
        try:
            store = get_session_store()
            await store.close()
        except Exception:
            pass
    
    # Close rate limiter
    if _rate_limiter_enabled:
        try:
            limiter = get_rate_limiter()
            await limiter.close()
        except Exception:
            pass


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

# Helper function to reorder notebook cells to ensure correct order
def _reorder_notebook_cells(notebook_data: dict, heading_map: dict, cell_order: list):
    """Reorder cells to ensure they're in the correct order: prompt, response, response_reference, judge_system_prompt"""
    if "cells" not in notebook_data:
        return
    
    # Find metadata cell index using shared helper
    metadata_index = _find_metadata_cell_index(notebook_data)
    
    # Separate cells into ordered cells and other cells
    ordered_cells = []  # List of (index_in_order, cell, original_index)
    other_cells = []  # List of (original_index, cell)
    
    for i, cell in enumerate(notebook_data["cells"]):
        if cell.get("cell_type") == "markdown":
            source = "".join(cell.get("source", []))
            # Check if this is one of our ordered cells
            found_ordered = False
            for j, cell_type in enumerate(cell_order):
                heading = heading_map.get(cell_type, "")
                if heading and heading.lower() in source.lower():
                    ordered_cells.append((j, cell, i))
                    found_ordered = True
                    break
            if not found_ordered and i != metadata_index:
                # Not an ordered cell, but also not metadata
                other_cells.append((i, cell))
        else:
            # Not a markdown cell
            if i != metadata_index:
                other_cells.append((i, cell))
    
    # Sort ordered cells by their order
    ordered_cells.sort(key=lambda x: x[0])
    
    # Rebuild cells list: metadata first, then ordered cells, then others
    new_cells = []
    
    # Add metadata cell if it exists
    if metadata_index >= 0:
        new_cells.append(notebook_data["cells"][metadata_index])
    
    # Add ordered cells in correct order
    for _, cell, _ in ordered_cells:
        new_cells.append(cell)
    
    # Add other cells (preserving their relative order, but after ordered cells)
    for _, cell in sorted(other_cells, key=lambda x: x[0]):
        new_cells.append(cell)
    
    notebook_data["cells"] = new_cells

# Session expiration: 2 hours (7200 seconds)
SESSION_EXPIRATION_SECONDS = 2 * 60 * 60  # 2 hours

def save_session_storage(session_id: str, data: dict):
    """Save session data to disk with timestamp."""
    path = os.path.join(STORAGE_DIR, f"{session_id}.json")
    # Add/update timestamp
    data["last_accessed"] = datetime.now().isoformat()
    if "created_at" not in data:
        data["created_at"] = datetime.now().isoformat()
    with open(path, 'w') as f:
        json.dump(data, f)

def get_session_storage(session_id: str) -> Optional[dict]:
    """Get session data from disk, checking expiration."""
    path = os.path.join(STORAGE_DIR, f"{session_id}.json")
    if os.path.exists(path):
        try:
            with open(path, 'r') as f:
                data = json.load(f)
            
            # Check expiration
            if "last_accessed" in data:
                last_accessed = datetime.fromisoformat(data["last_accessed"])
                elapsed = (datetime.now() - last_accessed).total_seconds()
                if elapsed > SESSION_EXPIRATION_SECONDS:
                    # Session expired, delete it
                    logger.info(f"Session {session_id} expired (elapsed: {elapsed:.0f}s, limit: {SESSION_EXPIRATION_SECONDS}s)")
                    try:
                        os.remove(path)
                    except Exception as e:
                        logger.error(f"Error deleting expired session file: {e}")
                    return None
            
            # Update last accessed time
            data["last_accessed"] = datetime.now().isoformat()
            with open(path, 'w') as f:
                json.dump(data, f)
            
            return data
        except Exception as e:
            logger.error(f"Error loading session storage {session_id}: {e}")
    return None


# ============== API Endpoints ==============


@app.post("/api/upload-notebook")
async def upload_notebook(request: Request, file: UploadFile = File(...)):
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
        
        # Get trainer identity from fingerprint
        trainer_info = {}
        if _trainer_identity_enabled:
            try:
                trainer_info = get_trainer_info(request)
            except Exception:
                pass
        
        # Telemetry: Log session creation
        if _telemetry_enabled:
            try:
                get_telemetry().log_session_created(
                    session_id=session.session_id,
                    notebook=file.filename,
                    source="upload"
                )
            except Exception:
                pass
        
        # Store original content and session data for export (with trainer info)
        save_session_storage(session.session_id, {
            "original_content": content_str,
            "filename": file.filename,
            "url": None,  # No URL for uploaded files
            "session_data": session.model_dump(),  # Store full session for restoration
            "trainer_id": trainer_info.get("trainer_id", "unknown"),
            "fingerprint": trainer_info.get("fingerprint", ""),
            "ip_hint": trainer_info.get("ip_hint", "")
        })
        
        # Extract model prefix from metadata or model slots
        model_prefix = notebook_parser.extract_model_prefix(parsed)
        print(f"DEBUG: Extracted model_prefix: '{model_prefix}'")
        
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
                "model_prefix": model_prefix,  # Will be from metadata if available, otherwise from slots
                "attempts_made": parsed.attempts_made,
                "validation_warnings": parsed.validation_warnings
            },
            "original_notebook_json": content_str  # Include original notebook JSON for WYSIWYG
        }
    except Exception as e:
        raise HTTPException(400, f"Failed to parse notebook: {str(e)}")


@app.post("/api/fetch-notebook")
async def fetch_notebook(http_request: Request, request: NotebookURLRequest):
    """Fetch a notebook from a URL."""
    try:
        parsed, content_str = await notebook_parser.load_from_url(request.url)
        
        # Create session
        config = HuntConfig()
        session = hunt_engine.create_session(parsed, config)
        
        # Get trainer identity from fingerprint
        trainer_info = {}
        if _trainer_identity_enabled:
            try:
                trainer_info = get_trainer_info(http_request)
            except Exception:
                pass
        
        # Telemetry: Log session creation (from URL fetch)
        if _telemetry_enabled:
            try:
                get_telemetry().log_session_created(
                    session_id=session.session_id,
                    notebook=parsed.filename,
                    source="url"
                )
            except Exception:
                pass
        
        # We don't have original content for URL fetches, recreate from parsed (with trainer info)
        save_session_storage(session.session_id, {
            "original_content": content_str,
            "filename": parsed.filename,
            "url": request.url,
            "session_data": session.model_dump(),  # Store full session for restoration
            "trainer_id": trainer_info.get("trainer_id", "unknown"),
            "fingerprint": trainer_info.get("fingerprint", ""),
            "ip_hint": trainer_info.get("ip_hint", "")
        })
        
        # Extract model prefix from metadata or model slots
        model_prefix = notebook_parser.extract_model_prefix(parsed)
        print(f"DEBUG: Extracted model_prefix: '{model_prefix}'")
        
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
                "model_prefix": model_prefix,  # Will be from metadata if available, otherwise from slots
                "attempts_made": parsed.attempts_made
            },
            "original_notebook_json": content_str  # Include original notebook JSON for WYSIWYG
        }
    except Exception as e:
        raise HTTPException(400, f"Failed to fetch notebook: {str(e)}")


@app.post("/api/warmup-connections")
async def warmup_connections(background_tasks: BackgroundTasks):
    """
    Warm up API connections for faster hunt execution.
    Call this when notebook is loaded to pre-establish TCP/TLS connections.
    Returns immediately, warm-up happens in background.
    """
    from services.http_config import warmup_all_connections
    
    # Run warm-up in background so it doesn't block
    async def do_warmup():
        try:
            results = await warmup_all_connections()
            logger.info(f"Connection warm-up completed: {results}")
        except Exception as e:
            logger.error(f"Connection warm-up failed: {e}")
    
    # Schedule warm-up
    import asyncio
    asyncio.create_task(do_warmup())
    
    return {"status": "warming_up", "message": "Connection warm-up started in background"}


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
    """Update hunt configuration for a session. Restores from storage if needed."""
    session = hunt_engine.get_session(session_id)
    
    # If not in memory, try to restore from storage
    if not session:
        storage = get_session_storage(session_id)
        if storage and "session_data" in storage:
            try:
                from models.schemas import HuntSession
                session_data = storage["session_data"]
                session = HuntSession(**session_data)
                hunt_engine.sessions[session_id] = session
                logger.info(f"Restored session {session_id} from storage")
            except Exception as e:
                logger.error(f"Error restoring session {session_id}: {e}")
                raise HTTPException(404, "Session not found or expired")
    
    if not session:
        raise HTTPException(404, "Session not found or expired")
    
    # CRITICAL: Preserve multi-turn fields that the frontend doesn't send
    # but were set by advance_turn. The frontend's getConfig() doesn't include
    # conversation_history or custom_judge_system_prompt, so a naive replacement
    # would wipe them out and cause Turn 2+ hunts to lose conversational context.
    existing_conversation_history = session.config.conversation_history if session.config else []
    existing_judge_prompt = session.config.custom_judge_system_prompt if session.config else None
    
    session.config = config
    
    # Restore multi-turn fields if the incoming config didn't include them
    if not config.conversation_history and existing_conversation_history:
        session.config.conversation_history = existing_conversation_history
        logger.info(f"Session {session_id}: Preserved conversation_history ({len(existing_conversation_history)} messages) during config update")
    if not config.custom_judge_system_prompt and existing_judge_prompt:
        session.config.custom_judge_system_prompt = existing_judge_prompt
        logger.info(f"Session {session_id}: Preserved custom_judge_system_prompt during config update")
    
    session.total_hunts = config.parallel_workers
    
    # Update storage
    storage = get_session_storage(session_id) or {}
    storage["session_data"] = session.model_dump()
    save_session_storage(session_id, storage)
    
    return {"success": True, "config": config.model_dump()}


class UpdateResponseRequest(BaseModel):
    response: str


class UpdateNotebookCellRequest(BaseModel):
    cell_type: str  # prompt, response, response_reference, judge_system_prompt
    content: str


class UpdateNotebookCellsRequest(BaseModel):
    cells: List[UpdateNotebookCellRequest]


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
        
        # If cell not found, create it using helper functions
        if not updated:
            insert_index = _find_cell_insertion_index(notebook_data, "response")
            new_cell = _create_notebook_cell("**[response]**", request.response)
            
            if "cells" not in notebook_data:
                notebook_data["cells"] = []
            notebook_data["cells"].insert(insert_index, new_cell)
            updated = True
            
            # After inserting, reorder cells to ensure correct order
            _reorder_notebook_cells(notebook_data, HEADING_MAP, CELL_ORDER)
        
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
        # Update session data in storage
        storage["session_data"] = session.model_dump()
        save_session_storage(session_id, storage)
        
        return {"success": True, "message": "Response saved to Colab notebook"}
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Error saving to Colab: {str(e)}")


@app.post("/api/update-notebook-cell/{session_id}")
async def update_notebook_cell(session_id: str, request: UpdateNotebookCellRequest):
    """Update a specific cell in the notebook and save to Colab."""
    session = hunt_engine.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    
    # Get session storage for URL and original content
    storage = get_session_storage(session_id)
    if not storage or "url" not in storage:
        raise HTTPException(400, "No source URL found - cannot save back to Colab")
    
    # Validate cell_type against shared heading map
    if request.cell_type not in HEADING_MAP:
        raise HTTPException(400, f"Invalid cell_type: {request.cell_type}")
    
    heading_pattern = HEADING_MAP[request.cell_type]
    
    try:
        # Parse original notebook content
        original_content = storage.get("original_content", "{}")
        notebook_data = json.loads(original_content)
        
        # Find and update the cell
        updated = False
        for cell in notebook_data.get("cells", []):
            if cell.get("cell_type") == "markdown":
                source = "".join(cell.get("source", []))
                if heading_pattern.lower() in source.lower():
                    # Update the cell content, preserving the heading
                    heading_line = source.split("\n")[0]
                    # Build new content with heading + blank line + content
                    full_content = heading_line + "\n\n" + request.content
                    # Split into lines for proper Jupyter format (each line as separate string)
                    content_lines = full_content.split("\n")
                    # Add newline to each line except the last (Jupyter format)
                    cell["source"] = [line + "\n" for line in content_lines[:-1]] + [content_lines[-1]] if content_lines else [""]
                    updated = True
                    break
        
        # If cell not found, create it using helper functions
        if not updated:
            insert_index = _find_cell_insertion_index(notebook_data, request.cell_type)
            new_cell = _create_notebook_cell(heading_pattern, request.content)
            
            if "cells" not in notebook_data:
                notebook_data["cells"] = []
            notebook_data["cells"].insert(insert_index, new_cell)
            updated = True
            
            # After inserting, reorder cells to ensure correct order
            _reorder_notebook_cells(notebook_data, HEADING_MAP, CELL_ORDER)
        
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
        
        # Update session's notebook using helper
        _update_session_notebook_field(session, request.cell_type, request.content)
        
        # Update storage with new content
        storage["original_content"] = updated_content
        # Update session data in storage
        storage["session_data"] = session.model_dump()
        save_session_storage(session_id, storage)
        
        return {"success": True, "message": f"{request.cell_type} saved to Colab notebook"}
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Error saving to Colab: {str(e)}")


@app.post("/api/update-notebook-cells/{session_id}")
async def update_notebook_cells(session_id: str, request: UpdateNotebookCellsRequest):
    """Update multiple cells in the notebook and save to Colab."""
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
        
        updated_cells = []
        
        # Track which cells need to be created
        cells_to_create = []
        
        # Update each cell
        for cell_request in request.cells:
            if cell_request.cell_type not in HEADING_MAP:
                continue
            
            heading_pattern = HEADING_MAP[cell_request.cell_type]
            updated = False
            
            for cell in notebook_data.get("cells", []):
                if cell.get("cell_type") == "markdown":
                    source = "".join(cell.get("source", []))
                    if heading_pattern.lower() in source.lower():
                        # Update the cell content, preserving the heading
                        heading_line = source.split("\n")[0]
                        full_content = heading_line + "\n\n" + cell_request.content
                        content_lines = full_content.split("\n")
                        cell["source"] = [line + "\n" for line in content_lines[:-1]] + [content_lines[-1]] if content_lines else [""]
                        updated = True
                        updated_cells.append(cell_request.cell_type)
                        
                        # Update session's notebook using helper
                        _update_session_notebook_field(session, cell_request.cell_type, cell_request.content)
                        break
            
            # If cell not found, mark it for creation
            if not updated:
                cells_to_create.append((cell_request, heading_pattern))
        
        # Create cells that don't exist using helper functions
        if cells_to_create:
            # Sort cells to create by their order in CELL_ORDER
            cells_to_create_sorted = sorted(cells_to_create, key=lambda x: (
                CELL_ORDER.index(x[0].cell_type) if x[0].cell_type in CELL_ORDER else 999
            ))
            
            # Create and insert new cells in correct order
            for cell_request, heading_pattern in cells_to_create_sorted:
                insert_index = _find_cell_insertion_index(notebook_data, cell_request.cell_type)
                new_cell = _create_notebook_cell(heading_pattern, cell_request.content)
                
                if "cells" not in notebook_data:
                    notebook_data["cells"] = []
                notebook_data["cells"].insert(insert_index, new_cell)
                updated_cells.append(cell_request.cell_type)
                
                # Update session's notebook using helper
                _update_session_notebook_field(session, cell_request.cell_type, cell_request.content)
            
            # After creating all cells, reorder to ensure correct order
            _reorder_notebook_cells(notebook_data, HEADING_MAP, CELL_ORDER)
        
        if not updated_cells:
            raise HTTPException(400, "Could not find any matching cells in notebook")
        
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
        
        # Update storage with new content
        storage["original_content"] = updated_content
        # Update session data in storage
        storage["session_data"] = session.model_dump()
        save_session_storage(session_id, storage)
        
        return {
            "success": True,
            "message": f"Saved {len(updated_cells)} cell(s) to Colab notebook",
            "updated_cells": updated_cells
        }
        
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
    # CRITICAL: Only re-fetch for Turn 1. In multi-turn mode (turn > 1),
    # advance_turn has already updated session.notebook with the new turn's
    # prompt, criteria, response, and judge prompt. Re-fetching from Colab
    # would OVERWRITE these with the original Turn 1 data.
    storage = get_session_storage(session_id)
    old_ref = session.notebook.response_reference[:100] if session.notebook.response_reference else "empty"
    
    if session.current_turn > 1:
        # Multi-turn: DO NOT re-fetch from Colab — notebook was updated by advance_turn
        logger.info(f"Session {session_id}: Turn {session.current_turn} — skipping Colab re-fetch "
                    f"(using advance_turn data: prompt='{session.notebook.prompt[:80]}...', "
                    f"criteria='{session.notebook.response_reference[:80]}...')")
    elif storage and "url" in storage:
        try:
            # Re-fetch the notebook to get latest content
            parsed, _ = await notebook_parser.load_from_url(storage["url"])
            # Log if response_reference changed
            original_ref = session.notebook.response_reference
            if original_ref and parsed.response_reference != original_ref:
                print(f"DEBUG: response_reference changed in Colab. Original length: {len(original_ref)}, New length: {len(parsed.response_reference)}")
                print(f"DEBUG: Original (first 200 chars): {original_ref[:200]}...")
                print(f"DEBUG: New (first 200 chars): {parsed.response_reference[:200]}...")
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
        
        # Log the exact response_reference being sent to judge
        ref_to_judge = notebook.response_reference or ""
        print(f"DEBUG: judge_reference - About to call judge with response_reference (first 500 chars): {ref_to_judge[:500]}...")
        import re
        import json as json_lib
        array_match = re.search(r'\[.*?\]', ref_to_judge, re.DOTALL)
        if array_match:
            try:
                criteria_list = json_lib.loads(array_match.group(0))
                if isinstance(criteria_list, list):
                    criteria_ids_in_ref = [item.get('id', f'C{i+1}') if isinstance(item, dict) else f'C{i+1}' 
                                          for i, item in enumerate(criteria_list)]
                    print(f"DEBUG: judge_reference - Criteria IDs in response_reference being sent to judge: {criteria_ids_in_ref}")
            except Exception as e:
                print(f"DEBUG: judge_reference - Could not parse criteria from response_reference: {e}")
        
        judge_result = await judge.judge_response(
            prompt=notebook.prompt,
            student_response=notebook.response,  # Judge the expected response
            response_reference=notebook.response_reference,  # Against the criteria (now fresh from Colab)
            judge_system_prompt=notebook.judge_system_prompt,
            judge_prompt_template=notebook.judge_prompt_template,
            model="gpt-5",
            standard_response=notebook.response  # Standard response from [response] cell
        )
        
        print(f"DEBUG: judge_reference - Judge returned criteria: {list(judge_result.get('criteria', {}).keys())}")
        
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


@app.get("/api/get-original-notebook/{session_id}")
async def get_original_notebook(session_id: str):
    """Get the original notebook JSON for a session."""
    try:
        storage = get_session_storage(session_id)
        if not storage:
            raise HTTPException(404, "Session not found")
        
        original_content = storage.get("original_content")
        if not original_content:
            raise HTTPException(404, "Original notebook content not available")
        
        return {
            "success": True,
            "original_notebook_json": original_content
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to get original notebook: {str(e)}")


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
        # Total hunts = total number of completed hunts (rows in hunt progress table)
        total_hunts_ran = len(results)  # Total completed hunts across all runs
        
        # Generate modified notebook
        modified_content = notebook_parser.export_notebook(
            original_content=original_content,
            parsed=session.notebook,
            results=results,
            include_reasoning=include_reasoning,
            human_reviews=human_reviews,
            total_hunts_ran=total_hunts_ran
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
    
    # Telemetry: Log human review submission
    try:
        if _telemetry_enabled:
            # Count how many reviews have actual judgment content
            reviews_with_judgment = sum(
                1 for r in reviews.values()
                if isinstance(r, dict) and r.get("judgment")
            )
            get_telemetry().log_event("human_review_submitted", {
                "session_id": session_id,
                "total_reviews": len(reviews),
                "reviews_with_judgment": reviews_with_judgment
            })
    except Exception:
        pass
    
    return {"success": True, "saved_count": len(reviews)}


@app.post("/api/save-snapshot")
async def save_snapshot(request: Request):
    """
    Save notebook snapshot to Colab (WYSIWYG approach).
    
    Frontend sends complete notebook JSON snapshot.
    Backend validates, normalizes, queues, and writes.
    """
    try:
        from services.google_drive_client import drive_client
        
        body = await request.json()
        
        # Validate snapshot
        is_valid, error_msg, snapshot = snapshot_service.validate_snapshot(body)
        if not is_valid:
            logger.error(f"❌ Snapshot validation failed: {error_msg}")
            raise HTTPException(400, f"Invalid snapshot: {error_msg}")
        
        # Normalize snapshot
        snapshot = snapshot_service.normalize_snapshot(snapshot)
        
        # Get file_id from snapshot
        file_id = snapshot.file_id
        if not file_id and snapshot.url:
            file_id = drive_client.get_file_id_from_url(snapshot.url)
        
        if not file_id:
            raise HTTPException(400, "Could not determine file_id from snapshot")
        
        logger.info(f"📝 Received snapshot for file_id {file_id}")
        logger.info(f"   - Timestamp: {datetime.now().isoformat()}")
        logger.info(f"   - Results: {len(snapshot.selected_results)} (order preserved)")
        
        # Define write function
        async def write_to_colab(file_id: str, snapshot: NotebookSnapshot):
            """Write snapshot to Colab notebook."""
            # Get original notebook content
            original_content = snapshot.original_notebook_json
            
            # Reconstruct parsed notebook from metadata if available
            # If metadata has parsed notebook info, use it; otherwise parse from original
            if snapshot.metadata and 'parsed_notebook' in snapshot.metadata:
                # Use provided parsed notebook data
                from models.schemas import ParsedNotebook
                parsed_data = snapshot.metadata['parsed_notebook'].copy()
                
                # Convert model_slots from list to dict if needed
                # Frontend sends model_slots as a list of keys, but ParsedNotebook expects a dict
                if 'model_slots' in parsed_data and isinstance(parsed_data['model_slots'], list):
                    # Convert list of slot names to dict: {slot_name: ""}
                    parsed_data['model_slots'] = {slot_name: "" for slot_name in parsed_data['model_slots']}
                
                # Same for judge_slots and human_judge_slots
                if 'judge_slots' in parsed_data and isinstance(parsed_data['judge_slots'], list):
                    parsed_data['judge_slots'] = {slot_name: "" for slot_name in parsed_data['judge_slots']}
                
                if 'human_judge_slots' in parsed_data and isinstance(parsed_data['human_judge_slots'], list):
                    parsed_data['human_judge_slots'] = {slot_name: "" for slot_name in parsed_data['human_judge_slots']}
                
                parsed = ParsedNotebook(**parsed_data)
            else:
                # Parse from original content (fallback)
                parsed = notebook_parser.load_from_file(original_content, "notebook.ipynb")
            
            # Use selected_results in exact order sent from frontend (no reordering)
            results = snapshot.selected_results
            
            # Use total_hunts_ran from frontend - it correctly counts ALL successful responses
            # (not just the 4 selected ones). The frontend calculates this from state.allResponses.
            # We only validate that selected results have valid responses.
            selected_valid_count = count_valid_responses(results)
            total_hunts_ran = snapshot.total_hunts_ran
            logger.info(f"📊 Total hunts ran: {total_hunts_ran} (selected: {selected_valid_count} valid of {len(results)} sent)")
            
            # Check if this is a multi-turn session
            is_multi_turn = (
                snapshot.metadata and 
                snapshot.metadata.get('is_multi_turn', False) and
                snapshot.metadata.get('turns')
            )
            
            if is_multi_turn:
                # Multi-turn export: includes all turns' data
                turns_data = snapshot.metadata.get('turns', [])
                conversation_history = snapshot.metadata.get('conversation_history', [])
                logger.info(f"📝 Multi-turn export: {len(turns_data)} turns")
                
                modified_content = notebook_parser.export_multi_turn_notebook(
                    original_content=original_content,
                    parsed=parsed,
                    turns=turns_data,
                    breaking_turn_results=results,
                    include_reasoning=snapshot.include_reasoning,
                    human_reviews=snapshot.human_reviews,
                    total_hunts_ran=total_hunts_ran,
                    conversation_history=conversation_history
                )
            else:
                # Standard single-turn export
                modified_content = notebook_parser.export_notebook(
                    original_content=original_content,
                    parsed=parsed,
                    results=results,
                    include_reasoning=snapshot.include_reasoning,
                    human_reviews=snapshot.human_reviews,
                    total_hunts_ran=total_hunts_ran  # Use frontend's count (all successful responses)
                )
            
            # Write to Drive (export_notebook returns JSON string)
            success = drive_client.update_file_content(file_id, modified_content)
            if not success:
                raise Exception("Failed to update file on Google Drive")
            
            # Parse to count cells
            notebook_json = json.loads(modified_content)
            return {"file_id": file_id, "cells_updated": len(notebook_json.get('cells', []))}
        
        # Queue the write
        queued = await snapshot_service.queue_write(file_id, snapshot)
        if not queued:
            raise HTTPException(503, "Write queue is full. Please try again in a moment.")
        
        # Process the queue (this will execute the write)
        result = await snapshot_service.process_write_queue(file_id, write_to_colab)
        
        if not result.get("success"):
            raise HTTPException(500, result.get("error", "Write failed"))
        
        logger.info(f"✅ Successfully saved snapshot to file_id {file_id}")
        
        # Telemetry: Log snapshot save (task completion via snapshot method)
        try:
            if _telemetry_enabled:
                get_telemetry().log_event("task_completed", {
                    "session_id": snapshot.session_id if hasattr(snapshot, 'session_id') else None,
                    "file_id": file_id,
                    "save_method": "save_snapshot"
                })
        except Exception:
            pass
        
        return {
            "success": True,
            "file_id": file_id,
            "message": "Notebook saved successfully",
            "details": result.get("result", {})
        }
        
    except HTTPException:
        raise
    except ImportError:
        raise HTTPException(500, "Google Drive dependencies not installed")
    except Exception as e:
        import traceback
        logger.error(f"❌ Snapshot save error: {str(e)}", exc_info=True)
        traceback.print_exc()
        raise HTTPException(500, f"Snapshot save failed: {str(e)}")


@app.post("/api/save-to-drive/{session_id}")
async def save_to_drive(session_id: str, request: Request):
    """Save ONLY SELECTED results to the Google Drive notebook."""
    try:
        from services.google_drive_client import drive_client
        
        # Parse request body to get selected hunt IDs and total hunts
        body = await request.json()
        selected_hunt_ids = body.get("selected_hunt_ids", [])
        total_hunts_from_frontend = body.get("total_hunts")  # Total hunts from frontend (state.allResponses.length)
        
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
        print(f"DEBUG: Total results from export_results: {len(all_results)}")
        print(f"DEBUG: All result hunt_ids: {[r.get('hunt_id') for r in all_results]}")
        
        # Filter results to only include selected hunt IDs
        # Normalize hunt_ids to integers for comparison (handle both string and int)
        if selected_hunt_ids:
            normalized_selected = [int(hid) if isinstance(hid, str) else hid for hid in selected_hunt_ids]
            print(f"DEBUG: Selected hunt_ids (normalized): {normalized_selected}")
            results = [r for r in all_results if int(r.get('hunt_id', 0)) in normalized_selected]
            # Preserve order of selected_hunt_ids
            results = sorted(results, key=lambda r: normalized_selected.index(int(r.get('hunt_id', 0))) if int(r.get('hunt_id', 0)) in normalized_selected else 999)
            print(f"DEBUG: Filtering to {len(results)} selected results out of {len(all_results)} total")
            print(f"DEBUG: Selected hunt_ids: {normalized_selected}, Found results: {[r.get('hunt_id') for r in results]}")
            
            # CRITICAL: Check if all selected hunt_ids were found
            found_hunt_ids = [int(r.get('hunt_id', 0)) for r in results]
            missing_hunt_ids = [hid for hid in normalized_selected if hid not in found_hunt_ids]
            if missing_hunt_ids:
                print(f"ERROR: Selected hunt_ids {missing_hunt_ids} not found in all_results!")
                print(f"ERROR: This will cause empty slots. Available hunt_ids: {[int(r.get('hunt_id', 0)) for r in all_results]}")
                # Check session results directly to see all hunt_ids (including non-completed)
                session = hunt_engine.get_session(session_id)
                if session:
                    all_session_hunt_ids = [r.hunt_id for r in session.results]
                    print(f"DEBUG: All session hunt_ids (including non-completed): {all_session_hunt_ids}")
                    missing_results = [r for r in session.results if r.hunt_id in missing_hunt_ids]
                    if missing_results:
                        print(f"DEBUG: Missing hunt_ids found in session but not completed:")
                        for r in missing_results:
                            print(f"  - hunt_id {r.hunt_id}: status={r.status.value}, has_response={bool(r.response)}")
                # This is a critical error - we can't save properly if hunt_ids are missing
                raise HTTPException(400, f"Selected hunt_ids {missing_hunt_ids} not found in results. Available: {[int(r.get('hunt_id', 0)) for r in all_results]}")
            
            if len(results) < 4:
                print(f"WARNING: Only {len(results)} results found, but 4 slots will be created. Slots {len(results)+1}-4 will be empty.")
        else:
            # Fallback: use all if no selection provided
            results = all_results
            print(f"WARNING: No selected_hunt_ids provided, saving all {len(results)} results")
        
        # Results are already in the correct order (preserved from selected_hunt_ids order)
        print(f"DEBUG: Using results in order: {[r.get('hunt_id') for r in results[:4]]}")
        
        human_reviews = getattr(session, 'human_reviews', {})
        # Calculate valid response count on backend (excludes empty/error responses)
        # This ensures correct count even if frontend sends old value
        valid_response_count = count_valid_responses(all_results)
        print(f"DEBUG: valid_response_count = {valid_response_count} (frontend sent: {total_hunts_from_frontend}, total results: {len(all_results)})")
        
        modified_content = notebook_parser.export_notebook(
            original_content=original_content,
            parsed=session.notebook,
            results=results,
            include_reasoning=True,
            human_reviews=human_reviews,
            total_hunts_ran=valid_response_count  # Use backend-calculated count
        )
        
        # Update file (export_notebook returns JSON string already)
        success = drive_client.update_file_content(file_id, modified_content)
        
        if not success:
            raise HTTPException(500, "Failed to update file on Google Drive (Auth error?)")
        
        # Telemetry: Log task completion (save to drive = trainer finished the task)
        try:
            if _telemetry_enabled:
                get_telemetry().log_event("task_completed", {
                    "session_id": session_id,
                    "selected_hunts": len(selected_hunt_ids) if selected_hunt_ids else 0,
                    "total_results": len(all_results),
                    "has_human_reviews": bool(human_reviews),
                    "save_method": "save_to_drive"
                })
        except Exception:
            pass
            
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
    """Get ALL results for a session (for selection UI) - accumulated across all runs."""
    session = hunt_engine.sessions.get(session_id)
    if not session:
        return {"count": 0, "results": []}
    
    # Return ALL accumulated results across all runs (not just current run)
    # all_results contains completed results from all hunt runs
    all_accumulated = session.all_results if session.all_results else []
    
    # Also include any completed results from current run that haven't been accumulated yet
    current_completed = [r for r in session.results if r.status.value == "completed"]
    
    # Merge: all_accumulated + current_completed (avoiding duplicates by hunt_id)
    existing_ids = {r.hunt_id for r in all_accumulated}
    merged_results = list(all_accumulated) + [r for r in current_completed if r.hunt_id not in existing_ids]
    
    # Telemetry: Log results viewing (trainer reviewing results for slot selection)
    try:
        if _telemetry_enabled:
            breaking = sum(1 for r in merged_results if getattr(r, 'score', None) == 0)
            get_telemetry().log_event("results_viewed", {
                "session_id": session_id,
                "total_results": len(merged_results),
                "breaking_results": breaking,
                "accumulated_count": len(all_accumulated)
            })
    except Exception:
        pass
    
    return {
        "count": len(merged_results),
        "results": [r.model_dump() for r in merged_results],
        "accumulated_count": len(all_accumulated)
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
    """Health check endpoint with system status."""
    health = {
        "status": "healthy",
        "service": "model-hunter",
        "timestamp": datetime.utcnow().isoformat() + "Z"
    }
    
    # Check Redis
    if _session_store_enabled:
        try:
            store = get_session_store()
            stats = await store.get_stats()
            health["redis"] = {
                "status": "connected" if stats["backend"] == "redis" else "fallback",
                "backend": stats["backend"],
                "active_sessions": stats["active_sessions"]
            }
        except Exception as e:
            health["redis"] = {"status": "error", "error": str(e)}
    
    # Check rate limiter
    if _rate_limiter_enabled:
        try:
            limiter = get_rate_limiter()
            health["rate_limiter"] = limiter.get_stats()
        except Exception as e:
            health["rate_limiter"] = {"status": "error", "error": str(e)}
    
    return health


@app.get("/api/version")
async def get_version():
    """Get app version for soft-reload detection."""
    return {"version": APP_VERSION}


def count_valid_responses(results: List[Dict[str, Any]]) -> int:
    """
    Count only valid responses (exclude empty/error responses).
    This ensures number_of_attempts_made only counts actual model responses.
    """
    count = 0
    for r in results:
        # Check if response has actual content and no error
        response = r.get("response", "") if isinstance(r, dict) else getattr(r, "response", "")
        error = r.get("error") if isinstance(r, dict) else getattr(r, "error", None)
        
        if response and response.strip() and not error:
            count += 1
    return count


@app.get("/api/admin/status")
async def admin_status():
    """Detailed admin status endpoint with all system metrics."""
    status = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "sessions": {
            "in_memory": len(hunt_engine.sessions),
            "session_ids": list(hunt_engine.sessions.keys())[:10]  # First 10 only
        }
    }
    
    # Redis status
    if _session_store_enabled:
        try:
            store = get_session_store()
            stats = await store.get_stats()
            redis_sessions = await store.list_sessions()
            status["redis"] = {
                **stats,
                "session_count": len(redis_sessions),
                "session_ids": redis_sessions[:10]  # First 10 only
            }
        except Exception as e:
            status["redis"] = {"error": str(e)}
    
    # Rate limiter status
    if _rate_limiter_enabled:
        try:
            limiter = get_rate_limiter()
            status["rate_limiter"] = limiter.get_stats()
        except Exception as e:
            status["rate_limiter"] = {"error": str(e)}
    
    return status


# ============== Multi-Turn Endpoints ==============


class AdvanceTurnRequest(BaseModel):
    """Request to advance to the next turn in a multi-turn session."""
    selected_hunt_id: int                    # Hunt ID of the "good" response from current turn
    next_prompt: str                          # New prompt for next turn
    next_criteria: str                        # New criteria/rubrics for next turn
    next_judge_prompt: Optional[str] = None   # Optional judge system prompt for next turn


@app.post("/api/advance-turn/{session_id}")
async def advance_turn(session_id: str, request: AdvanceTurnRequest):
    """
    Advance to the next turn in a multi-turn session.
    
    Takes the selected "good" response from the current turn,
    builds conversation history, and prepares the session for
    the next turn with new prompt and criteria.
    """
    session = await hunt_engine.get_session_async(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    
    # Find the selected response from current results
    selected_result = None
    all_results = session.all_results + session.results
    for r in all_results:
        if r.hunt_id == request.selected_hunt_id:
            selected_result = r
            break
    
    if not selected_result:
        raise HTTPException(400, f"Hunt ID {request.selected_hunt_id} not found in session results")
    
    if not selected_result.response:
        raise HTTPException(400, f"Hunt ID {request.selected_hunt_id} has no response")
    
    current_turn = session.current_turn
    
    # Save current turn data
    turn_data = TurnData(
        turn_number=current_turn,
        prompt=session.notebook.prompt,
        response_reference=session.notebook.response_reference,
        judge_system_prompt=session.config.custom_judge_system_prompt or session.notebook.judge_system_prompt,
        selected_response=selected_result.response,
        selected_hunt_id=request.selected_hunt_id,
        judge_result={
            "score": selected_result.judge_score,
            "output": selected_result.judge_output,
            "criteria": selected_result.judge_criteria,
            "explanation": selected_result.judge_explanation,
        },
        status="completed",
        results=[r.model_dump() for r in session.results if r.status == HuntStatus.COMPLETED]
    )
    session.turns.append(turn_data)
    
    # Build conversation history: add current turn's user prompt + selected response
    session.conversation_history.append({
        "role": "user",
        "content": session.notebook.prompt
    })
    session.conversation_history.append({
        "role": "assistant",
        "content": selected_result.response
    })
    
    # Advance to next turn
    session.current_turn = current_turn + 1
    
    # Update notebook with new turn's prompt and criteria
    session.notebook.prompt = request.next_prompt
    session.notebook.response_reference = request.next_criteria
    # CRITICAL: Update response to the selected good response from this turn
    # This is the response that should be judged against the new turn's criteria
    session.notebook.response = selected_result.response
    if request.next_judge_prompt is not None:
        session.notebook.judge_system_prompt = request.next_judge_prompt
        session.config.custom_judge_system_prompt = request.next_judge_prompt
    
    # Update config conversation history (used by hunt engine for model calls)
    session.config.conversation_history = list(session.conversation_history)
    
    # Mark notebook as multi-turn
    session.notebook.is_multi_turn = True
    
    # Reset current run results for the new turn
    session.results = []
    session.all_results = []
    session.completed_hunts = 0
    session.breaks_found = 0
    session.status = HuntStatus.PENDING
    
    # Persist to Redis
    if _session_store_enabled:
        try:
            store = get_session_store()
            await store.save_session(session_id, session.model_dump())
        except Exception as e:
            logger.error(f"Failed to persist session after turn advance: {e}")
    
    # Also persist to disk storage
    try:
        storage = get_session_storage(session_id)
        if storage:
            storage["session_data"] = session.model_dump()
            save_session_storage(session_id, storage)
    except Exception as e:
        logger.error(f"Failed to persist to disk after turn advance: {e}")
    
    logger.info(f"Session {session_id}: Advanced to turn {session.current_turn} "
                f"(history: {len(session.conversation_history)} messages)")
    
    return {
        "success": True,
        "session_id": session_id,
        "current_turn": session.current_turn,
        "conversation_history_length": len(session.conversation_history),
        "turns_completed": len(session.turns),
        "prompt": session.notebook.prompt,
        "response_reference": session.notebook.response_reference,
    }


@app.post("/api/mark-breaking/{session_id}")
async def mark_breaking(session_id: str):
    """
    Mark the current turn as the breaking turn.
    
    This enters the standard review/selection flow.
    The trainer will then do blind human review of the 
    worst responses from this turn.
    """
    session = await hunt_engine.get_session_async(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    
    current_turn = session.current_turn
    
    # Save current turn data with "breaking" status
    turn_data = TurnData(
        turn_number=current_turn,
        prompt=session.notebook.prompt,
        response_reference=session.notebook.response_reference,
        judge_system_prompt=session.config.custom_judge_system_prompt or session.notebook.judge_system_prompt,
        status="breaking",
        results=[r.model_dump() for r in session.results if r.status == HuntStatus.COMPLETED]
    )
    session.turns.append(turn_data)
    session.notebook.is_multi_turn = len(session.turns) > 1
    
    # Persist
    if _session_store_enabled:
        try:
            store = get_session_store()
            await store.save_session(session_id, session.model_dump())
        except Exception as e:
            logger.error(f"Failed to persist session after mark-breaking: {e}")
    
    logger.info(f"Session {session_id}: Turn {current_turn} marked as breaking "
                f"(total turns: {len(session.turns)})")
    
    return {
        "success": True,
        "session_id": session_id,
        "breaking_turn": current_turn,
        "total_turns": len(session.turns),
        "is_multi_turn": session.notebook.is_multi_turn,
    }


@app.get("/api/turn-status/{session_id}")
async def get_turn_status(session_id: str):
    """
    Get current turn status, conversation history, and all past turns.
    """
    session = await hunt_engine.get_session_async(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    
    return {
        "session_id": session_id,
        "current_turn": session.current_turn,
        "is_multi_turn": session.notebook.is_multi_turn if session.notebook else False,
        "conversation_history": session.conversation_history,
        "turns": [t.model_dump() for t in session.turns],
        "current_prompt": session.notebook.prompt if session.notebook else "",
        "current_criteria": session.notebook.response_reference if session.notebook else "",
        "current_judge_prompt": session.notebook.judge_system_prompt if session.notebook else "",
        "status": session.status.value,
    }


@app.get("/api/admin/active-hunts")
async def get_active_hunts():
    """
    Return count of sessions with status RUNNING.
    Used by deploy script to wait for active hunts to finish.
    """
    active_count = 0
    active_sessions = []
    
    for sid, session in hunt_engine.sessions.items():
        if session.status == HuntStatus.RUNNING:
            active_count += 1
            active_sessions.append({
                "session_id": sid,
                "current_turn": session.current_turn,
                "completed_hunts": session.completed_hunts,
                "total_hunts": session.total_hunts,
            })
    
    return {
        "count": active_count,
        "sessions": active_sessions,
    }


# ============== Static Files & Frontend ==============

from starlette.types import Receive, Scope, Send

class NoCacheStaticFiles(StaticFiles):
    """StaticFiles with no-cache headers to prevent browser caching.
    
    This ensures users always get the latest version with a regular reload,
    without needing to hard reload (Cmd+Shift+R).
    """
    
    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        async def send_wrapper(message: dict) -> None:
            if message["type"] == "http.response.start":
                # Add no-cache headers to prevent browser caching
                headers = dict(message.get("headers", []))
                headers[b"cache-control"] = b"no-cache, no-store, must-revalidate"
                headers[b"pragma"] = b"no-cache"
                headers[b"expires"] = b"0"
                message["headers"] = list(headers.items())
            await send(message)
        
        await super().__call__(scope, receive, send_wrapper)


# Mount static files with no-cache headers
app.mount("/static", NoCacheStaticFiles(directory="static"), name="static")


# ============== Maintenance Mode ==============

# Maintenance mode flag (can be toggled via environment variable or API)
MAINTENANCE_MODE = os.getenv("MAINTENANCE_MODE", "false").lower() == "true"
_maintenance_file = os.path.join(os.getcwd(), ".maintenance")

def is_maintenance_mode() -> bool:
    """Check if maintenance mode is enabled."""
    # Check environment variable first
    if os.getenv("MAINTENANCE_MODE", "").lower() == "true":
        return True
    # Check for maintenance file (easier to toggle)
    return os.path.exists(_maintenance_file)


@app.get("/maintenance")
async def maintenance_page():
    """Serve the maintenance/downtime page."""
    return FileResponse("static/maintenance.html")


@app.post("/api/toggle-maintenance")
async def toggle_maintenance():
    """Toggle maintenance mode on/off (simple toggle, no auth needed)."""
    global MAINTENANCE_MODE
    
    if is_maintenance_mode():
        # Disable maintenance mode
        if os.path.exists(_maintenance_file):
            os.remove(_maintenance_file)
        return {"maintenance_mode": False, "message": "Maintenance mode disabled. Door is open!"}
    else:
        # Enable maintenance mode
        with open(_maintenance_file, 'w') as f:
            f.write("maintenance")
        return {"maintenance_mode": True, "message": "Maintenance mode enabled. Door is closed!"}


@app.get("/")
async def root(request: Request):
    """Serve the main frontend page or redirect to maintenance."""
    # If maintenance mode is enabled, show maintenance page
    # Users can bypass by adding ?door=open (handled by maintenance page)
    if is_maintenance_mode():
        return FileResponse("static/maintenance.html")
    
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
