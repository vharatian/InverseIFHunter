"""
Notebook Routes

POST /api/upload-notebook                  — upload .ipynb file
POST /api/fetch-notebook                   — fetch notebook from URL
POST /api/warmup-connections               — pre-warm API connections
POST /api/update-response/{session_id}     — update [response] cell
POST /api/update-notebook-cell/{session_id} — update single cell
POST /api/update-notebook-cells/{session_id} — update multiple cells
GET  /api/get-original-notebook/{session_id} — get original notebook JSON
GET  /api/export-notebook/{session_id}       — export modified notebook
POST /api/save-reviews/{session_id}          — save human reviews
POST /api/save-snapshot                      — WYSIWYG save to Colab
POST /api/save-to-drive/{session_id}         — save selected results to Drive
"""
import asyncio
import json
import logging
from typing import Optional, List


from fastapi import APIRouter, File, UploadFile, HTTPException, Request, BackgroundTasks
from fastapi.responses import Response
from pydantic import BaseModel

from models.schemas import HuntConfig, HuntSession, HuntStatus, ParsedNotebook
from services.notebook_parser import notebook_parser
from services.hunt_engine import hunt_engine
from services.snapshot_service import snapshot_service, NotebookSnapshot
from storage.session_storage import save_session_storage, get_session_storage
from storage.trainer_registry import register_or_update_trainer
from helpers.notebook_helpers import HEADING_MAP, _update_session_notebook_field
from helpers.shared import (
    _get_validated_session,
    _get_storage_with_url,
    _persist_session,
    _save_turn_cells_to_drive,
    _format_judge_result,
    _extract_trainer_info_from_request,
    _log_telemetry_safe,
    count_valid_responses,
    _telemetry_enabled,
)
import services.redis_session as redis_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["notebook"])


# ============== Request/Response Models ==============

class NotebookURLRequest(BaseModel):
    url: str
    trainer_email: Optional[str] = None
    trainer_name: Optional[str] = None


class UpdateResponseRequest(BaseModel):
    response: str
    session_only: Optional[bool] = False  # If True, skip Colab sync (auto-save)


class UpdateNotebookCellRequest(BaseModel):
    cell_type: str  # prompt, response, response_reference, judge_system_prompt
    content: str
    session_only: Optional[bool] = False  # If True, skip Colab sync (auto-save)


class UpdateNotebookCellsRequest(BaseModel):
    cells: List[UpdateNotebookCellRequest]
    session_only: Optional[bool] = False  # If True, skip Colab sync (auto-save)


# ============== Upload / Fetch ==============

@router.post("/upload-notebook")
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
        session = await hunt_engine.create_session(parsed, config)
        
        # Get trainer identity
        trainer_email = request.headers.get("X-Trainer-Email", request.query_params.get("trainer_email", ""))
        trainer_name = request.headers.get("X-Trainer-Name", request.query_params.get("trainer_name", ""))
        trainer_info = _extract_trainer_info_from_request(request, trainer_email, trainer_name)
        
        # Register trainer session linkage if email provided
        if trainer_email:
            register_or_update_trainer(trainer_email, trainer_name or "Unknown", session.session_id)
        
        # Telemetry
        _log_telemetry_safe("session_created", {
            "session_id": session.session_id,
            "notebook": file.filename,
            "source": "upload",
            "trainer_email": trainer_email or None,
            "trainer_name": trainer_name or None
        })
        
        # Store original content and session data for export
        save_session_storage(session.session_id, {
            "original_content": content_str,
            "filename": file.filename,
            "url": None,
            "session_data": session.model_dump(),
            **trainer_info
        })
        
        # Extract model prefix from metadata or model slots
        model_prefix = notebook_parser.extract_model_prefix(parsed)
        logger.debug(f" Extracted model_prefix: '{model_prefix}'")
        
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
                "model_prefix": model_prefix,
                "attempts_made": parsed.attempts_made,
                "validation_warnings": parsed.validation_warnings
            },
            "original_notebook_json": content_str
        }
    except Exception as e:
        raise HTTPException(400, f"Failed to parse notebook: {str(e)}")


@router.post("/fetch-notebook")
async def fetch_notebook(http_request: Request, request: NotebookURLRequest):
    """Fetch a notebook from a URL."""
    try:
        parsed, content_str = await notebook_parser.load_from_url(request.url)
        
        # Create session
        config = HuntConfig()
        session = await hunt_engine.create_session(parsed, config)
        
        # Get trainer identity
        trainer_email = request.trainer_email or ""
        trainer_name = request.trainer_name or ""
        trainer_info = _extract_trainer_info_from_request(http_request, trainer_email, trainer_name)
        
        # Register trainer session linkage if email provided
        if trainer_email:
            register_or_update_trainer(trainer_email, trainer_name or "Unknown", session.session_id)
        
        # Telemetry
        _log_telemetry_safe("session_created", {
            "session_id": session.session_id,
            "notebook": parsed.filename,
            "source": "url",
            "trainer_email": trainer_email or None,
            "trainer_name": trainer_name or None
        })
        
        # Store with trainer info
        save_session_storage(session.session_id, {
            "original_content": content_str,
            "filename": parsed.filename,
            "url": request.url,
            "session_data": session.model_dump(),
            **trainer_info
        })
        
        # Extract model prefix from metadata or model slots
        model_prefix = notebook_parser.extract_model_prefix(parsed)
        logger.debug(f" Extracted model_prefix: '{model_prefix}'")
        
        return {
            "success": True,
            "session_id": session.session_id,
            "notebook": {
                "filename": parsed.filename,
                "metadata": parsed.metadata,
                "prompt": parsed.prompt,
                "prompt_length": len(parsed.prompt),
                "response": parsed.response,
                "response_reference": parsed.response_reference,
                "judge_system_prompt": parsed.judge_system_prompt,
                "judge_prompt_template": parsed.judge_prompt_template,
                "has_judge_prompt": bool(parsed.judge_system_prompt),
                "model_slots": list(parsed.model_slots.keys()),
                "model_prefix": model_prefix,
                "attempts_made": parsed.attempts_made
            },
            "original_notebook_json": content_str
        }
    except Exception as e:
        raise HTTPException(400, f"Failed to fetch notebook: {str(e)}")


@router.post("/warmup-connections")
async def warmup_connections(background_tasks: BackgroundTasks):
    """
    Warm up API connections for faster hunt execution.
    Call this when notebook is loaded to pre-establish TCP/TLS connections.
    Returns immediately, warm-up happens in background.
    """
    from services.http_config import warmup_all_connections
    
    async def do_warmup():
        try:
            results = await warmup_all_connections()
            logger.info(f"Connection warm-up completed: {results}")
        except Exception as e:
            logger.error(f"Connection warm-up failed: {e}")
    
    asyncio.create_task(do_warmup())
    
    return {"status": "warming_up", "message": "Connection warm-up started in background"}


# ============== Cell Updates ==============

@router.post("/update-response/{session_id}")
async def update_response(session_id: str, request: UpdateResponseRequest):
    """Update the [response] section in the notebook and save to Colab (if URL available)."""
    session = await _get_validated_session(session_id)
    storage, has_url = _get_storage_with_url(session_id)
    
    try:
        session.notebook.response = request.response
        saved_to_colab = False
        if not getattr(request, 'session_only', False):
            saved_to_colab = _save_turn_cells_to_drive(
                session, storage, has_url, [("response", request.response)]
            )
        await _persist_session(session_id, session, storage)
        msg = "Response saved to Colab notebook" if saved_to_colab else "Response saved to session"
        return {"success": True, "message": msg}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Error saving response: {str(e)}")


@router.post("/update-notebook-cell/{session_id}")
async def update_notebook_cell(session_id: str, request: UpdateNotebookCellRequest):
    """Update a specific cell in the notebook and save to Colab (if URL available)."""
    session = await _get_validated_session(session_id)
    if request.cell_type not in HEADING_MAP:
        raise HTTPException(400, f"Invalid cell_type: {request.cell_type}")
    
    storage, has_url = _get_storage_with_url(session_id)
    
    try:
        _update_session_notebook_field(session, request.cell_type, request.content)
        saved_to_colab = False
        if not getattr(request, 'session_only', False):
            saved_to_colab = _save_turn_cells_to_drive(
                session, storage, has_url, [(request.cell_type, request.content)]
            )
        await _persist_session(session_id, session, storage)
        msg = f"{request.cell_type} saved to Colab notebook" if saved_to_colab else f"{request.cell_type} saved to session"
        return {"success": True, "message": msg}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Error saving cell: {str(e)}")


@router.post("/update-notebook-cells/{session_id}")
async def update_notebook_cells(session_id: str, request: UpdateNotebookCellsRequest):
    """Update multiple cells in the notebook and save to Colab (if URL available)."""
    session = await _get_validated_session(session_id)
    storage, has_url = _get_storage_with_url(session_id)
    
    try:
        cells = [(c.cell_type, c.content) for c in request.cells if c.cell_type in HEADING_MAP]
        if not cells:
            raise HTTPException(400, "No valid cell types provided")
        
        for cell_type, content in cells:
            _update_session_notebook_field(session, cell_type, content)
        
        saved_to_colab = False
        if not getattr(request, 'session_only', False):
            saved_to_colab = _save_turn_cells_to_drive(session, storage, has_url, cells)
        await _persist_session(session_id, session, storage)
        
        cell_names = [c[0] for c in cells]
        msg = f"Saved {len(cells)} cell(s) to Colab notebook" if saved_to_colab else f"Saved {len(cells)} cell(s) to session"
        return {"success": True, "message": msg, "updated_cells": cell_names}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Error saving cells: {str(e)}")


# ============== Original / Export ==============

@router.get("/get-original-notebook/{session_id}")
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


@router.get("/export-notebook/{session_id}")
async def export_notebook(session_id: str, include_reasoning: bool = True):
    """Export modified notebook with hunt results."""
    try:
        session = await _get_validated_session(session_id)
        
        storage = get_session_storage(session_id)
        if not storage:
            raise HTTPException(400, "Original notebook content not available")
        
        original_content = storage.get("original_content")
        if not original_content:
            raise HTTPException(400, "Original notebook content not stored (URL fetch)")
        
        results = hunt_engine.export_results(session_id)
        human_reviews = getattr(session, 'human_reviews', {})
        total_hunts_ran = len(results)
        
        modified_content = notebook_parser.export_notebook(
            original_content=original_content,
            parsed=session.notebook,
            results=results,
            include_reasoning=include_reasoning,
            human_reviews=human_reviews,
            total_hunts_ran=total_hunts_ran
        )
        
        filename = storage.get("filename", "notebook.ipynb")
        if not filename.endswith('.ipynb'):
            filename += '.ipynb'
        
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
        logger.error(f"Export error trace:")
        import traceback
        traceback.print_exc()
        raise HTTPException(500, f"Export failed: {str(e)}")


# ============== Reviews ==============

@router.post("/save-reviews/{session_id}")
async def save_reviews(session_id: str, request: Request):
    """Save human reviews for notebook export."""
    session = await _get_validated_session(session_id)
    
    data = await request.json()
    reviews = data.get("reviews", {})
    
    if not hasattr(session, 'human_reviews'):
        session.human_reviews = {}
    session.human_reviews = reviews
    
    _log_telemetry_safe("human_review_submitted", {
        "session_id": session_id,
        "total_reviews": len(reviews),
        "reviews_with_judgment": sum(
            1 for r in reviews.values()
            if isinstance(r, dict) and r.get("judgment")
        )
    })
    
    return {"success": True, "saved_count": len(reviews)}


# ============== Snapshot Save ==============

@router.post("/save-snapshot")
async def save_snapshot(request: Request):
    """
    Save notebook snapshot to Colab (WYSIWYG approach).
    
    Frontend sends complete notebook JSON snapshot.
    Backend validates, normalizes, queues, and writes.
    """
    try:
        from services.google_drive_client import drive_client
        from datetime import datetime
        
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
            original_content = snapshot.original_notebook_json
            
            if snapshot.metadata and 'parsed_notebook' in snapshot.metadata:
                parsed_data = snapshot.metadata['parsed_notebook'].copy()
                
                if 'model_slots' in parsed_data and isinstance(parsed_data['model_slots'], list):
                    parsed_data['model_slots'] = {slot_name: "" for slot_name in parsed_data['model_slots']}
                
                if 'judge_slots' in parsed_data and isinstance(parsed_data['judge_slots'], list):
                    parsed_data['judge_slots'] = {slot_name: "" for slot_name in parsed_data['judge_slots']}
                
                if 'human_judge_slots' in parsed_data and isinstance(parsed_data['human_judge_slots'], list):
                    parsed_data['human_judge_slots'] = {slot_name: "" for slot_name in parsed_data['human_judge_slots']}
                
                parsed = ParsedNotebook(**parsed_data)
            else:
                parsed = notebook_parser.load_from_file(original_content, "notebook.ipynb")
            
            results = snapshot.selected_results
            
            selected_valid_count = count_valid_responses(results)
            total_hunts_ran = snapshot.total_hunts_ran
            logger.info(f"📊 Total hunts ran: {total_hunts_ran} (selected: {selected_valid_count} valid of {len(results)} sent)")
            
            is_multi_turn = (
                snapshot.metadata and 
                snapshot.metadata.get('is_multi_turn', False) and
                snapshot.metadata.get('turns')
            )
            
            if is_multi_turn:
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
                    conversation_history=conversation_history,
                    per_model_hunts=getattr(snapshot, 'per_model_hunts', None)
                )
            else:
                modified_content = notebook_parser.export_notebook(
                    original_content=original_content,
                    parsed=parsed,
                    results=results,
                    include_reasoning=snapshot.include_reasoning,
                    human_reviews=snapshot.human_reviews,
                    total_hunts_ran=total_hunts_ran,
                    per_model_hunts=getattr(snapshot, 'per_model_hunts', None)
                )
            
            success = drive_client.update_file_content(file_id, modified_content)
            if not success:
                raise Exception("Failed to update file on Google Drive")
            
            notebook_json = json.loads(modified_content)
            return {"file_id": file_id, "cells_updated": len(notebook_json.get('cells', []))}
        
        # Queue the write
        queued = await snapshot_service.queue_write(file_id, snapshot)
        if not queued:
            raise HTTPException(503, "Write queue is full. Please try again in a moment.")
        
        result = await snapshot_service.process_write_queue(file_id, write_to_colab)
        
        if not result.get("success"):
            raise HTTPException(500, result.get("error", "Write failed"))
        
        logger.info(f"✅ Successfully saved snapshot to file_id {file_id}")
        
        _log_telemetry_safe("task_completed", {
            "session_id": snapshot.session_id if hasattr(snapshot, 'session_id') else None,
            "file_id": file_id,
            "save_method": "save_snapshot"
        })
        
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


# ============== Save to Drive ==============

@router.post("/save-to-drive/{session_id}")
async def save_to_drive(session_id: str, request: Request):
    """Save ONLY SELECTED results to the Google Drive notebook."""
    try:
        from services.google_drive_client import drive_client
        
        body = await request.json()
        selected_hunt_ids = body.get("selected_hunt_ids", [])
        total_hunts_from_frontend = body.get("total_hunts")
        
        session = await _get_validated_session(session_id)
            
        storage = get_session_storage(session_id)
        if not storage or not storage.get("url"):
            raise HTTPException(400, "No Google Drive URL found for this session")
            
        url = storage.get("url")
        file_id = drive_client.get_file_id_from_url(url)
        
        if not file_id:
            raise HTTPException(400, "Could not extract File ID from URL")
            
        original_content = storage.get("original_content")
        all_results = session.results # Use session.results now that we have full session
        
        # If all_results is empty but session exists, try export_results fallback (shouldn't be needed with _get_validated_session)
        if not all_results:
             all_results = hunt_engine.export_results(session_id)
        
        logger.debug(f" Total results from export_results: {len(all_results)}")
        logger.debug(f" All result hunt_ids: {[r.get('hunt_id') for r in all_results]}")
        
        if selected_hunt_ids:
            normalized_selected = [int(hid) if isinstance(hid, str) else hid for hid in selected_hunt_ids]
            logger.debug(f" Selected hunt_ids (normalized): {normalized_selected}")
            results = [r for r in all_results if int(r.get('hunt_id', 0)) in normalized_selected]
            results = sorted(results, key=lambda r: normalized_selected.index(int(r.get('hunt_id', 0))) if int(r.get('hunt_id', 0)) in normalized_selected else 999)
            logger.debug(f" Filtering to {len(results)} selected results out of {len(all_results)} total")
            
            found_hunt_ids = [int(r.get('hunt_id', 0)) for r in results]
            missing_hunt_ids = [hid for hid in normalized_selected if hid not in found_hunt_ids]
            if missing_hunt_ids:
                logger.error(f"Selected hunt_ids {missing_hunt_ids} not found in all_results!")
                logger.error(f"This will cause empty slots. Available hunt_ids: {[int(r.get('hunt_id', 0)) for r in all_results]}")
                session_check = await hunt_engine.get_session_async(session_id)
                if session_check:
                    all_session_hunt_ids = [r.hunt_id for r in session_check.results]
                    logger.debug(f" All session hunt_ids (including non-completed): {all_session_hunt_ids}")
                    missing_results = [r for r in session_check.results if r.hunt_id in missing_hunt_ids]
                    if missing_results:
                        logger.debug(f" Missing hunt_ids found in session but not completed:")
                        for r in missing_results:
                            logger.debug(f"  - hunt_id {r.hunt_id}: status={r.status.value}, has_response={bool(r.response)}")
                raise HTTPException(400, f"Selected hunt_ids {missing_hunt_ids} not found in results. Available: {[int(r.get('hunt_id', 0)) for r in all_results]}")
            
            if len(results) < 4:
                logger.warning(f"Only {len(results)} results found, but 4 slots will be created. Slots {len(results)+1}-4 will be empty.")
        else:
            results = all_results
            logger.warning(f"No selected_hunt_ids provided, saving all {len(results)} results")
        
        logger.debug(f" Using results in order: {[r.get('hunt_id') for r in results[:4]]}")
        
        human_reviews = getattr(session, 'human_reviews', {})
        valid_response_count = count_valid_responses(all_results)
        logger.debug(f" valid_response_count = {valid_response_count} (frontend sent: {total_hunts_from_frontend}, total results: {len(all_results)})")
        
        modified_content = notebook_parser.export_notebook(
            original_content=original_content,
            parsed=session.notebook,
            results=results,
            include_reasoning=True,
            human_reviews=human_reviews,
            total_hunts_ran=valid_response_count
        )
        
        success = drive_client.update_file_content(file_id, modified_content)
        
        if not success:
            raise HTTPException(500, "Failed to update file on Google Drive (Auth error?)")
        
        _log_telemetry_safe("task_completed", {
            "session_id": session_id,
            "selected_hunts": len(selected_hunt_ids) if selected_hunt_ids else 0,
            "total_results": len(all_results),
            "has_human_reviews": bool(human_reviews),
            "save_method": "save_to_drive"
        })
            
        return {"success": True, "message": f"Successfully updated notebook {file_id}"}
        
    except ImportError:
         raise HTTPException(500, "Google Drive dependencies not installed")
    except Exception as e:
        import traceback
        traceback.print_exc()
        logger.error(f"Drive save error: {str(e)}")
        raise HTTPException(500, f"Drive save failed: {str(e)}")
