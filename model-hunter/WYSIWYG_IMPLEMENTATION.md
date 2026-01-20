# WYSIWYG Snapshot Implementation

## Overview
Implemented a WYSIWYG (What You See Is What You Get) approach for saving notebooks to Colab. Frontend sends complete snapshot, backend validates, normalizes, queues, and writes.

## Architecture

### Frontend (WYSIWYG)
- Stores original notebook JSON when loaded
- Constructs snapshot with:
  - `original_notebook_json`: Original notebook content
  - `slot_mapping`: {slot_num: hunt_id} - source of truth
  - `selected_results`: Complete hunt results data
  - `human_reviews`: Human reviews keyed by hunt_id
  - `total_hunts_ran`: Total hunts across all runs
  - `url`: Colab/Drive URL
  - `metadata`: Parsed notebook data for backend

### Backend (Gatekeeper)
1. **Schema Validation** (`snapshot_service.validate_snapshot`)
   - Validates Pydantic schema
   - Validates notebook JSON structure
   - Validates slot_mapping (1-4 slots, integer hunt_ids)
   - Validates selected_results match slot_mapping

2. **ID Normalization** (`snapshot_service.normalize_snapshot`)
   - Normalizes hunt_ids to integers
   - Normalizes slot_mapping keys/values
   - Normalizes human_reviews keys

3. **Single-Writer Queue** (`snapshot_service.queue_write` + `process_write_queue`)
   - Per-file_id queue (max 10 items)
   - Per-file_id lock (only one write at a time)
   - Prevents concurrent writes to same notebook

4. **Logging** (Comprehensive)
   - Logs all validation steps
   - Logs queue operations
   - Logs write operations
   - Error logging with stack traces

5. **Notebook Construction** (`export_notebook`)
   - Uses existing proven logic
   - Constructs notebook with selected results
   - Uses slot_mapping as source of truth

6. **Write to Colab** (`drive_client.update_file_content`)
   - Atomic write operation
   - Error handling

## Files Changed

### New Files
- `services/snapshot_service.py` - Snapshot validation, normalization, queue management

### Modified Files
- `main.py`:
  - Added `/api/save-snapshot` endpoint
  - Added logging configuration
  - Updated `/api/upload-notebook` and `/api/fetch-notebook` to return `original_notebook_json`
  
- `static/app.js`:
  - Added `originalNotebookJson` to state
  - Updated `handleNotebookLoaded` to store original notebook
  - Updated `saveToDrive` to send snapshot instead of hunt_ids
  - Moved diversity check to `confirmSelection`
  - Removed diversity check from `saveToDrive`

## API Endpoints

### POST `/api/save-snapshot`
**Request Body:**
```json
{
  "original_notebook_json": "...",
  "url": "https://colab.research.google.com/...",
  "slot_mapping": {1: 5, 2: 3, 3: 1, 4: 2},
  "selected_results": [...],
  "human_reviews": {...},
  "total_hunts_ran": 10,
  "include_reasoning": true,
  "metadata": {
    "parsed_notebook": {...}
  }
}
```

**Response:**
```json
{
  "success": true,
  "file_id": "...",
  "message": "Notebook saved successfully",
  "details": {...}
}
```

## Benefits

1. **WYSIWYG Guarantee**: What trainer sees = what gets written
2. **Data Integrity**: Schema validation prevents corrupted notebooks
3. **Concurrency Safety**: Queue prevents race conditions
4. **Auditability**: Comprehensive logging
5. **Simpler Frontend**: Just constructs and sends snapshot
6. **Backend as Gatekeeper**: Validation and safety checks
7. **No Session Sync Issues**: Snapshot is self-contained
8. **Error Recovery**: Can retry from snapshot if write fails

## Testing Checklist

- [ ] Load notebook from URL
- [ ] Run hunts
- [ ] Select 4 hunts
- [ ] Confirm selection (diversity check should run)
- [ ] Complete human reviews
- [ ] Save to Colab
- [ ] Verify notebook in Colab matches selection
- [ ] Test with concurrent saves (should queue)
- [ ] Test with invalid snapshot (should reject)
- [ ] Check logs for validation/queue operations
