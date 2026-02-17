"""
Snapshot Service - WYSIWYG Notebook Writing

Handles:
- Schema validation for notebook snapshots
- ID normalization
- Single-writer queue per file_id
- Logging and audit trail
"""
import json
import asyncio
import logging
from typing import Dict, Any, Optional, List, Union
from datetime import datetime
from pydantic import BaseModel, ValidationError, field_validator

logger = logging.getLogger(__name__)


class NotebookSnapshot(BaseModel):
    """Schema for notebook snapshot from frontend."""
    original_notebook_json: str  # Original notebook JSON string (from when it was loaded)
    file_id: Optional[str] = None  # Google Drive file ID
    url: Optional[str] = None  # Colab/Drive URL (if file_id not provided)
    selected_results: List[Dict[str, Any]]  # Selected hunt results (complete data) - order determines slots 1-4
    human_reviews: Dict[str, Any]  # Human reviews keyed by hunt_id (as string)
    total_hunts_ran: int  # Total hunts across all runs
    include_reasoning: bool = True  # Whether to include reasoning traces
    metadata: Optional[Dict[str, Any]] = None  # Additional metadata (parsed notebook data)
    # Per-model hunt counts for number_of_attempts_made (model_id -> count). Frontend computes from allResponses/turns.
    per_model_hunts: Optional[Dict[str, int]] = None
    
    @field_validator('human_reviews', mode='before')
    @classmethod
    def normalize_human_reviews_keys(cls, v: Any) -> Dict[str, Any]:
        """Convert integer keys to strings in human_reviews."""
        if isinstance(v, dict):
            return {str(k): val for k, val in v.items()}
        return v


class SnapshotService:
    """Service for handling notebook snapshots with queue and validation."""
    
    def __init__(self):
        # Per-file write queues and locks
        self.write_queues: Dict[str, asyncio.Queue] = {}
        self.write_locks: Dict[str, asyncio.Lock] = {}
        self.max_queue_size = 10  # Prevent queue overflow
        
    def validate_snapshot(self, snapshot_data: Dict[str, Any]) -> tuple[bool, Optional[str], Optional[NotebookSnapshot]]:
        """
        Validate snapshot schema and structure.
        
        Returns:
            (is_valid, error_message, validated_snapshot)
        """
        try:
            # Validate using Pydantic model
            snapshot = NotebookSnapshot(**snapshot_data)
            
            # Validate original notebook JSON structure
            try:
                notebook = json.loads(snapshot.original_notebook_json)
            except json.JSONDecodeError as e:
                return False, f"Invalid original notebook JSON: {str(e)}", None
            
            # Validate notebook structure
            if not isinstance(notebook, dict):
                return False, "Original notebook JSON must be an object", None
            
            if 'cells' not in notebook:
                return False, "Original notebook must have 'cells' field", None
            
            if 'nbformat' not in notebook:
                return False, "Original notebook must have 'nbformat' field", None
            
            # Validate selected_results
            if len(snapshot.selected_results) > 4:
                return False, "selected_results cannot have more than 4 results", None
            
            if len(snapshot.selected_results) == 0:
                return False, "selected_results cannot be empty", None
            
            # Validate each result has required fields
            for idx, result in enumerate(snapshot.selected_results):
                if not isinstance(result, dict):
                    return False, f"selected_results[{idx}] must be a dictionary", None
                if 'hunt_id' not in result:
                    return False, f"selected_results[{idx}] missing 'hunt_id' field", None
                if 'response' not in result:
                    return False, f"selected_results[{idx}] missing 'response' field", None
            
            # Validate file_id or url is provided
            if not snapshot.file_id and not snapshot.url:
                return False, "Either file_id or url must be provided", None
            
            logger.info(f"✅ Snapshot validated successfully: {len(snapshot.selected_results)} results")
            return True, None, snapshot
            
        except ValidationError as e:
            error_msg = f"Schema validation failed: {e}"
            logger.error(error_msg)
            return False, error_msg, None
        except Exception as e:
            error_msg = f"Validation error: {str(e)}"
            logger.error(error_msg)
            return False, error_msg, None
    
    def normalize_snapshot(self, snapshot: NotebookSnapshot) -> NotebookSnapshot:
        """
        Normalize IDs and ensure consistency.
        
        - Normalize hunt_ids to integers
        - Normalize human_reviews keys
        - Preserve selected_results order exactly as sent
        """
        # Normalize selected_results hunt_ids (preserve order)
        normalized_results = []
        for result in snapshot.selected_results:
            normalized_result = result.copy()
            if 'hunt_id' in normalized_result:
                normalized_result['hunt_id'] = int(normalized_result['hunt_id'])
            normalized_results.append(normalized_result)
        
        # Normalize human_reviews keys (hunt_id strings to int)
        normalized_reviews = {}
        for key, review in snapshot.human_reviews.items():
            try:
                # Try to convert key to int if it's a hunt_id
                int_key = int(key)
                normalized_reviews[int_key] = review
            except (ValueError, TypeError):
                # Keep as-is if not a hunt_id
                normalized_reviews[key] = review
        
        # Create normalized snapshot
        normalized = NotebookSnapshot(
            original_notebook_json=snapshot.original_notebook_json,
            file_id=snapshot.file_id,
            url=snapshot.url,
            selected_results=normalized_results,
            human_reviews=normalized_reviews,
            total_hunts_ran=int(snapshot.total_hunts_ran),
            include_reasoning=snapshot.include_reasoning,
            metadata=snapshot.metadata,
            per_model_hunts=snapshot.per_model_hunts
        )
        
        logger.info(f"✅ Snapshot normalized: {len(normalized_results)} results (order preserved)")
        return normalized
    
    async def queue_write(self, file_id: str, snapshot: NotebookSnapshot) -> bool:
        """
        Add snapshot to write queue for file_id.
        Returns True if queued, False if queue is full.
        """
        if file_id not in self.write_queues:
            self.write_queues[file_id] = asyncio.Queue(maxsize=self.max_queue_size)
            self.write_locks[file_id] = asyncio.Lock()
        
        queue = self.write_queues[file_id]
        
        # Check if queue is full
        if queue.full():
            logger.warning(f"⚠️ Write queue for file_id {file_id} is full ({self.max_queue_size} items)")
            return False
        
        # Add to queue
        await queue.put(snapshot)
        logger.info(f"📝 Queued write for file_id {file_id} (queue size: {queue.qsize()})")
        return True
    
    async def process_write_queue(self, file_id: str, write_func: callable) -> Dict[str, Any]:
        """
        Process write queue for a file_id.
        Only one write processes at a time per file_id.
        
        Args:
            file_id: Google Drive file ID
            write_func: Async function that takes (file_id, snapshot) and writes to Colab
        
        Returns:
            Dict with success status and result/error
        """
        if file_id not in self.write_queues:
            return {"success": False, "error": "No queue found for file_id"}
        
        queue = self.write_queues[file_id]
        lock = self.write_locks[file_id]
        
        # Process queue (only one at a time per file)
        async with lock:
            if queue.empty():
                return {"success": False, "error": "Queue is empty"}
            
            snapshot = await queue.get()
            
            try:
                logger.info(f"🔄 Processing write for file_id {file_id} (queue remaining: {queue.qsize()})")
                
                # Log snapshot details
                logger.info(f"   - Results: {len(snapshot.selected_results)} (order preserved)")
                logger.info(f"   - Reviews: {len(snapshot.human_reviews)}")
                logger.info(f"   - Total hunts: {snapshot.total_hunts_ran}")
                
                # Execute write
                result = await write_func(file_id, snapshot)
                
                logger.info(f"✅ Successfully wrote to file_id {file_id}")
                return {"success": True, "result": result}
                
            except Exception as e:
                error_msg = f"Write failed for file_id {file_id}: {str(e)}"
                logger.error(f"❌ {error_msg}", exc_info=True)
                return {"success": False, "error": error_msg}
    
    def get_queue_status(self, file_id: str) -> Dict[str, Any]:
        """Get queue status for a file_id."""
        if file_id not in self.write_queues:
            return {"exists": False, "size": 0}
        
        queue = self.write_queues[file_id]
        return {
            "exists": True,
            "size": queue.qsize(),
            "max_size": self.max_queue_size
        }


# Singleton instance
snapshot_service = SnapshotService()
