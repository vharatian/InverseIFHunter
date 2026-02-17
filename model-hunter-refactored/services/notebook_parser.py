"""
Notebook Parser Service

Parses .ipynb files and extracts structured data including:
- Metadata (Task ID, Domain, Use Case, etc.)
- Prompt and response reference
- Judge prompts and system prompts
- Model/judge result slots
"""
import asyncio
import json
import logging
import re
import httpx

# Service account timeout: fail fast and use fallback if Drive API doesn't respond in time
SERVICE_ACCOUNT_TIMEOUT = 10.0
from typing import Dict, Any, Optional, List, Tuple
from models.schemas import ParsedNotebook, NotebookCell

logger = logging.getLogger(__name__)

# Display names for known models (mirrors config.js PROVIDER_MODELS). Use version/numbers for same-model variants.
PROVIDER_MODELS = {
    'openrouter': [
        {'id': 'nvidia/nemotron-3-nano-30b-a3b', 'name': 'Nemotron-3-Nano (Fast)'},
        {'id': 'qwen/qwen3-235b-a22b-thinking-2507', 'name': 'Qwen3-235B (Thinking)'},
        {'id': 'anthropic/claude-sonnet-4.5', 'name': 'Claude Sonnet 4.5'},
        {'id': 'anthropic/claude-opus-4.5', 'name': 'Claude Opus 4.5'},
        {'id': 'anthropic/claude-opus-4.6', 'name': 'Claude Opus 4.6'},
    ],
    'fireworks': [
        {'id': 'accounts/fireworks/models/qwen3-235b-a22b-thinking-2507', 'name': 'Qwen3-235B (Thinking)'},
    ],
}


def get_model_display_name(model_id: str) -> str:
    """Get display name for a model ID. Uses version names/numbers for same-model variants."""
    if not model_id:
        return 'Unknown'
    for models in PROVIDER_MODELS.values():
        for m in models:
            if m['id'] == model_id:
                return m['name']
    last_part = model_id.split('/')[-1] if '/' in model_id else model_id
    if last_part.startswith('claude-'):
        rest = last_part.replace('claude-', '')
        return 'Claude ' + ' '.join(s[:1].upper() + s[1:] for s in rest.split('-'))
    return last_part


def format_number_of_attempts_made(
    per_model_hunts: Optional[Dict[str, int]] = None,
    total_hunts_ran: int = 0
) -> str:
    """Format number_of_attempts_made as markdown list per model with display names."""
    if per_model_hunts and len(per_model_hunts) > 0:
        lines = []
        for model_id, count in sorted(per_model_hunts.items(), key=lambda x: (-x[1], x[0])):
            display = get_model_display_name(model_id)
            lines.append(f"{display}: {count}")
        return '\n'.join(lines)
    return str(total_hunts_ran)


class NotebookParser:
    """Parser for Colab/Jupyter notebook files."""
    
    # Heading pattern: **[heading_name]**
    HEADING_PATTERN = re.compile(r'\*\*\[([^\]]+)\]\*\*')
    
    # Known cell types
    METADATA_HEADINGS = {'prompt', 'response', 'response_reference', 
                         'judge_prompt_template', 'judge_system_prompt',
                         'number_of_attempts_made'}
    MODEL_PATTERN = re.compile(r'^(nemotron|qwen|model)_(\d+)$', re.IGNORECASE)
    LLM_JUDGE_PATTERN = re.compile(r'^llm_judge_(\d+)$', re.IGNORECASE)
    HUMAN_JUDGE_PATTERN = re.compile(r'^human_judge_(\d+)$', re.IGNORECASE)
    REASONING_TRACE_PATTERN = re.compile(r'^reasoning_trace_(\d+)$', re.IGNORECASE)
    
    # Multi-turn patterns
    MULTI_TURN_PROMPT_PATTERN = re.compile(r'^prompt_(\d+)$', re.IGNORECASE)
    MULTI_TURN_CRITERIA_PATTERN = re.compile(r'^response_reference_(\d+)$', re.IGNORECASE)
    MULTI_TURN_SELECTED_RESPONSE_PATTERN = re.compile(r'^selected_response_(\d+)$', re.IGNORECASE)
    MULTI_TURN_SELECTED_JUDGE_PATTERN = re.compile(r'^selected_judge_(\d+)$', re.IGNORECASE)
    
    def __init__(self):
        self.notebook_data: Optional[Dict[str, Any]] = None
    
    async def load_from_url(self, url: str) -> Tuple[ParsedNotebook, str]:
        """Load notebook from a URL using service account (no public sharing needed).
        
        Supports:
        - Google Colab/Drive URLs (using service account)
        - Direct .ipynb file URLs
        - GitHub raw URLs
        """
        file_id = self._extract_drive_file_id(url)
        
        content = None
        
        # If it's a Colab/Drive URL, use service account to read (SECURE)
        if file_id:
            sa_error = None
            try:
                # Run sync Drive API call in thread to avoid blocking; 10s timeout then fallback
                content = await asyncio.wait_for(
                    asyncio.to_thread(self._read_with_service_account, file_id),
                    timeout=SERVICE_ACCOUNT_TIMEOUT,
                )
            except (asyncio.TimeoutError, Exception) as e:
                sa_error = e
                content = None
                logger.info(f"Service account fetch failed or timed out ({SERVICE_ACCOUNT_TIMEOUT}s): {e}. Using fallback.")
            if content is None:
                # Fallback to public URL methods if service account fails
                async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
                    download_methods = [
                        f"https://colab.research.google.com/download/ipynb?fileId={file_id}",
                        f"https://drive.google.com/uc?export=download&confirm=1&id={file_id}",
                    ]
                    
                    for method_url in download_methods:
                        try:
                            response = await client.get(method_url, headers={
                                'User-Agent': 'Mozilla/5.0'
                            })
                            if response.status_code == 200:
                                test_content = response.text
                                if test_content.strip().startswith('{') and '"cells"' in test_content:
                                    content = test_content
                                    break
                        except:
                            continue
                
                if not content:
                    # Get service account email for helpful error message
                    sa_email = self._get_service_account_email()
                    raise ValueError(
                        f"Could not access notebook (File ID: {file_id}). "
                        f"Please share the notebook with: {sa_email} (Editor access). "
                        f"Original error: {str(sa_error)}"
                    )
        else:
            # Direct URL (GitHub, raw URLs, etc.)
            async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
                download_url = self._convert_to_download_url(url)
                response = await client.get(download_url)
                response.raise_for_status()
                content = response.text
                
                if content.strip().startswith('<!') or content.strip().startswith('<html'):
                    raise ValueError(
                        "URL returned HTML instead of notebook JSON. "
                        "Please provide a direct link to the .ipynb file."
                    )
        
        # Extract filename from URL
        filename = url.split('/')[-1]
        if not filename.endswith('.ipynb'):
            filename = 'notebook.ipynb'
        
        return self.parse(content, filename=filename), content
    
    def _extract_drive_file_id(self, url: str) -> str:
        """Extract Google Drive file ID from various URL formats."""
        import re
        
        # Colab URL
        if 'colab.research.google.com/drive/' in url:
            return url.split('/drive/')[-1].split('?')[0].split('#')[0]
        
        # Drive file URL
        if 'drive.google.com/file/d/' in url:
            return url.split('/file/d/')[-1].split('/')[0]
        
        # Drive open URL
        match = re.search(r'[?&]id=([a-zA-Z0-9_-]+)', url)
        if match:
            return match.group(1)
        
        return None
    
    def _convert_to_download_url(self, url: str) -> str:
        """Convert various notebook URLs to direct download URLs."""
        
        # Google Colab URL pattern
        # https://colab.research.google.com/drive/FILE_ID
        if 'colab.research.google.com/drive/' in url:
            # Extract file ID
            file_id = url.split('/drive/')[-1].split('?')[0].split('#')[0]
            # Use Google Drive export with confirm parameter
            return f"https://drive.google.com/uc?export=download&confirm=1&id={file_id}"
        
        # Google Drive share link
        # https://drive.google.com/file/d/FILE_ID/view
        if 'drive.google.com/file/d/' in url:
            file_id = url.split('/file/d/')[-1].split('/')[0]
            return f"https://drive.google.com/uc?export=download&confirm=1&id={file_id}"
        
        # GitHub URL - convert to raw
        # https://github.com/user/repo/blob/main/file.ipynb
        if 'github.com' in url and '/blob/' in url:
            return url.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/')
        
        # Already a raw/direct URL
        return url
    
    def _read_with_service_account(self, file_id: str) -> str:
        """Read notebook content using service account (secure, no public sharing needed)."""
        try:
            from google.oauth2 import service_account
            from googleapiclient.discovery import build
            from googleapiclient.http import MediaIoBaseDownload
            import io
            import os
            
            SCOPES = ['https://www.googleapis.com/auth/drive.readonly']
            
            # Try multiple possible paths for service_account.json
            service_account_paths = [
                'service_account.json',  # Current directory
                '../service_account.json',  # Parent directory (for VM)
                os.path.join(os.path.dirname(__file__), '..', '..', 'service_account.json'),  # Relative to this file
                os.getenv('GOOGLE_SERVICE_ACCOUNT_JSON_PATH', ''),  # From environment variable
            ]
            
            service_account_path = None
            for path in service_account_paths:
                if path and os.path.exists(path):
                    service_account_path = path
                    break
            
            if not service_account_path:
                raise FileNotFoundError(
                    "service_account.json not found. Tried: " + ", ".join([p for p in service_account_paths if p])
                )
            
            credentials = service_account.Credentials.from_service_account_file(
                service_account_path, scopes=SCOPES
            )
            service = build('drive', 'v3', credentials=credentials)
            
            # Download file content
            request = service.files().get_media(fileId=file_id)
            buffer = io.BytesIO()
            downloader = MediaIoBaseDownload(buffer, request)
            
            done = False
            while not done:
                status, done = downloader.next_chunk()
            
            buffer.seek(0)
            content = buffer.read().decode('utf-8')
            
            # Validate it's a notebook
            if not (content.strip().startswith('{') and '"cells"' in content):
                raise ValueError("Downloaded content is not a valid notebook")
            
            return content
            
        except Exception as e:
            raise Exception(f"Service account read failed: {str(e)}")
    
    def _get_service_account_email(self) -> str:
        """Get service account email for error messages."""
        import os
        service_account_paths = [
            'service_account.json',
            '../service_account.json',
            os.path.join(os.path.dirname(__file__), '..', '..', 'service_account.json'),
            os.getenv('GOOGLE_SERVICE_ACCOUNT_JSON_PATH', ''),
        ]
        
        for path in service_account_paths:
            if path and os.path.exists(path):
                try:
                    with open(path, 'r') as f:
                        sa_info = json.load(f)
                        return sa_info.get('client_email', 'unknown')
                except:
                    continue
        return 'unknown (service_account.json not found)'
    
    def load_from_file(self, content: str, filename: str = "notebook.ipynb") -> ParsedNotebook:
        """Load notebook from file content."""
        return self.parse(content, filename)
    
    def parse(self, content: str, filename: str = "notebook.ipynb") -> ParsedNotebook:
        """Parse notebook JSON content into structured data."""
        try:
            self.notebook_data = json.loads(content)
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid notebook JSON: {e}")
        
        cells = self.notebook_data.get('cells', [])
        
        result = ParsedNotebook(
            filename=filename,
            raw_cells=[]
        )
        
        for cell in cells:
            parsed_cell = self._parse_cell(cell)
            result.raw_cells.append(parsed_cell)
            
            # Always check for metadata first (even without heading pattern)
            # Metadata cells use # Metadata header, not **[metadata]** pattern
            if '# Metadata' in parsed_cell.content or parsed_cell.content.startswith('# Metadata'):
                self._assign_cell_content(result, parsed_cell)
            elif parsed_cell.heading:
                self._assign_cell_content(result, parsed_cell)
        
        # Validate response_reference JSON format
        validation_errors = self._validate_response_reference(result.response_reference)
        if validation_errors:
            result.validation_warnings = validation_errors
        
        return result
    
    def _validate_response_reference(self, response_reference: str) -> list:
        """Validate response_reference is valid JSON with expected structure.
        Only validates the JSON array between [ and ], ignoring any text outside.
        """
        errors = []
        
        if not response_reference or not response_reference.strip():
            errors.append("response_reference is missing or empty")
            return errors
        
        # Extract only the JSON array between [ and ]
        array_match = re.search(r'\[.*?\]', response_reference, re.DOTALL)
        
        if not array_match:
            errors.append("response_reference must contain a JSON array between [ and ] brackets")
            return errors
        
        json_array_str = array_match.group(0)
        
        # Try to parse as JSON
        try:
            data = json.loads(json_array_str)
        except json.JSONDecodeError as e:
            snippet = json_array_str[:50] + "..." if len(json_array_str) > 50 else json_array_str
            errors.append(f"response_reference contains invalid JSON array. Error: {e}. Content: '{snippet}'")
            return errors
        
        # Check for expected structure - should be a list/array
        if not isinstance(data, list):
            errors.append(f"response_reference should be a JSON array (list), not {type(data).__name__}")
            return errors
        
        # Check for criteria fields
        if len(data) == 0:
            errors.append("response_reference appears to be empty - should contain scoring criteria")
            return errors
        
        # Validate each criterion has expected fields (id and criteria1/criteria2/etc.)
        for idx, item in enumerate(data):
            if not isinstance(item, dict):
                errors.append(f"Criterion at index {idx} should be a JSON object, not {type(item).__name__}")
                continue
            
            # Check for id field
            if 'id' not in item:
                errors.append(f"Criterion at index {idx} is missing 'id' field")
            
            # Check for at least one criteria field (criteria1, criteria2, etc.)
            has_criteria = any(key.startswith('criteria') for key in item.keys() if key != 'id')
            if not has_criteria:
                errors.append(f"Criterion at index {idx} (id: {item.get('id', 'unknown')}) is missing a 'criteria' field")
        
        return errors
    
    def _parse_cell(self, cell: Dict[str, Any]) -> NotebookCell:
        """Parse a single cell and extract heading if present."""
        cell_id = cell.get('id', '')
        cell_type = cell.get('cell_type', 'unknown')
        source = cell.get('source', [])
        
        # Join source lines
        if isinstance(source, list):
            content = ''.join(source)
        else:
            content = str(source)
        
        # Extract heading
        heading = None
        match = self.HEADING_PATTERN.search(content)
        if match:
            heading = match.group(1).lower()
            # Remove heading from content
            content_after_heading = content[match.end():].strip()
            content = content_after_heading
        
        return NotebookCell(
            cell_id=cell_id,
            cell_type=cell_type,
            heading=heading,
            content=content
        )
    
    def _assign_cell_content(self, result: ParsedNotebook, cell: NotebookCell):
        """Assign cell content to appropriate field based on heading."""
        heading = cell.heading
        content = cell.content.strip()
        
        # Check for Metadata header - try multiple patterns
        # 1. Check if heading is 'metadata'
        # 2. Check if content starts with '# Metadata' or contains it
        # 3. Check if it contains metadata-like content (Task ID, Domain, etc.)
        is_metadata_cell = (
            heading == 'metadata' or 
            content.startswith('# Metadata') or
            '# Metadata' in content or
            ('Task ID' in content and ('Domain' in content or 'Use Case' in content))
        )
        
        if is_metadata_cell:
            # Use the full cell content (including the # Metadata header) for parsing
            # The parser will handle the header line
            parsed_metadata = self._parse_metadata(cell.content)
            if parsed_metadata:  # Only set if we actually parsed something
                result.metadata = parsed_metadata
                logger.debug("Parsed metadata with %d fields: %s", len(parsed_metadata), list(parsed_metadata.keys()))
            else:
                logger.debug("Metadata cell detected but parsing returned empty dict. Content preview: %s", cell.content[:200])
            return
        
        # Standard fields
        # Use first occurrence only (don't overwrite if already set)
        # This ensures we get the original content, not later edits
        if heading == 'prompt':
            if not result.prompt:  # Only set if not already set
                result.prompt = content
        elif heading == 'response':
            if not result.response:  # Only set if not already set
                result.response = content
        elif heading == 'response_reference':
            if not result.response_reference:  # Only set if not already set - use FIRST occurrence
                result.response_reference = content
        elif heading == 'judge_prompt_template':
            result.judge_prompt_template = content
        elif heading == 'judge_system_prompt':
            result.judge_system_prompt = content
        elif heading == 'number_of_attempts_made':
            try:
                attempts = int(re.search(r'\d+', content).group())
                # Clamp attempts to valid range: min 1, max 8
                result.attempts_made = max(1, min(8, attempts))
            except (AttributeError, ValueError):
                result.attempts_made = 1  # Default to 1 instead of 0
        
        # Model slots (nemotron_1, qwen_1, model_1, etc.)
        elif self.MODEL_PATTERN.match(heading):
            result.model_slots[heading] = content
        
        # LLM judge slots
        elif self.LLM_JUDGE_PATTERN.match(heading):
            result.judge_slots[heading] = content
        
        # Human judge slots
        elif self.HUMAN_JUDGE_PATTERN.match(heading):
            result.human_judge_slots[heading] = content
    
    def _parse_metadata(self, content: str) -> Dict[str, str]:
        """Parse metadata section into key-value pairs.
        Handles formats like:
        - **Key:** Value
        - **Key:** - Value
        - Key: Value
        - Key: - Value
        - Domain: - Education & Research
        """
        metadata = {}
        lines = content.split('\n')
        
        for line in lines:
            line = line.strip()
            if not line:
                continue
            
            # Skip the # Metadata header line
            if line.startswith('# Metadata'):
                continue
            
            # Pattern 1: **Key:** Value or **Key:** - Value (with bold markers)
            # Match key before closing **, then optional colon
            match = re.match(r'\*\*([^*]+?)\*\*:?\s*-?\s*(.+)', line)
            if match:
                key = match.group(1).strip().rstrip(':')  # Remove trailing colon if present
                value = match.group(2).strip()
                if key and value:
                    metadata[key] = value
                    logger.debug("Parsed metadata field: %s = %s", key, value)
                    continue
            
            # Pattern 2: Key: Value or Key: - Value (without bold markers)
            match = re.match(r'^([^:]+):\s*-?\s*(.+)', line)
            if match:
                key = match.group(1).strip()
                value = match.group(2).strip()
                if key and value:
                    metadata[key] = value
                    logger.debug("Parsed metadata field (no bold): %s = %s", key, value)
                    continue
        
        logger.debug("Total metadata fields parsed: %d", len(metadata))
        return metadata
    
    def get_model_slot_prefix(self, parsed: ParsedNotebook) -> str:
        """Determine the model slot prefix used in this notebook (nemotron, qwen, etc.)"""
        for slot_name in parsed.model_slots.keys():
            match = self.MODEL_PATTERN.match(slot_name)
            if match:
                return match.group(1).lower()
        return "model"  # Default prefix
    
    def extract_model_prefix(self, parsed: ParsedNotebook) -> str:
        """
        Extract model prefix from metadata or model slots.
        
        Priority:
        1. Metadata 'Model' field (if present)
        2. Model slot prefix (nemotron, qwen, etc.)
        
        Args:
            parsed: ParsedNotebook instance
            
        Returns:
            Model prefix string (lowercase)
        """
        import re
        
        # Check metadata first (has priority)
        if parsed.metadata:
            metadata_model = parsed.metadata.get('Model') or parsed.metadata.get('model')
            if metadata_model:
                # Clean the value (remove leading dashes, spaces)
                metadata_model = re.sub(r'^[-:\s]+', '', str(metadata_model).strip()).strip()
                if metadata_model:
                    return metadata_model.lower()
        
        # Fallback to model slot prefix
        return self.get_model_slot_prefix(parsed)
    
    def get_next_slot_number(self, parsed: ParsedNotebook) -> int:
        """Get the next available slot number."""
        max_slot = 0
        for slot_name in parsed.model_slots.keys():
            match = self.MODEL_PATTERN.match(slot_name)
            if match:
                slot_num = int(match.group(2))
                max_slot = max(max_slot, slot_num)
        return max_slot + 1
    
    def export_notebook(
        self, 
        original_content: str,
        parsed: ParsedNotebook,
        results: List[Dict[str, Any]],
        include_reasoning: bool = True,
        human_reviews: Dict[str, Any] = None,
        total_hunts_ran: int = 0,
        per_model_hunts: Optional[Dict[str, int]] = None
    ) -> str:
        """
        Export modified notebook with hunt results.
        
        Uses **[Turn 1 - prompt]**, **[Turn 1 - response]**, etc. for n=1.
        number_of_attempts_made: per-model markdown list with display names.
        
        Args:
            original_content: Original notebook JSON string
            parsed: Parsed notebook data
            results: List of hunt results to add
            include_reasoning: Whether to append reasoning traces
            human_reviews: Dict of human reviews keyed by hunt_id
            total_hunts_ran: Total number of hunts ran across all attempts
            per_model_hunts: Optional model_id -> count for number_of_attempts_made
        
        Returns:
            Modified notebook JSON string
        """
        if isinstance(original_content, str):
            notebook = json.loads(original_content)
        else:
            notebook = original_content
            
        # Ensure nbformat keys exist (required by Colab)
        if 'nbformat' not in notebook:
            notebook['nbformat'] = 4
        if 'nbformat_minor' not in notebook:
            notebook['nbformat_minor'] = 5
            
        cells = notebook.get('cells', [])
        human_reviews = human_reviews or {}
        
        # Determine model prefix from results first (source of truth)
        # This ensures we use the correct prefix even if notebook has old/wrong prefix
        model_prefix = "model"  # Default
        if results:
            # Extract model name from first result (e.g., "nvidia/nemotron-3-nano-30b-a3b" -> "nemotron")
            first_model = results[0].get('model', '')
            if 'nemotron' in first_model.lower():
                model_prefix = 'nemotron'
            elif 'qwen' in first_model.lower():
                model_prefix = 'qwen'
        
        # If no results, fall back to existing notebook prefix
        if model_prefix == "model":
            model_prefix = self.get_model_slot_prefix(parsed)
        
        # Capitalize model prefix for heading (Nemotron, Qwen, Model)
        model_prefix_capitalized = model_prefix.capitalize()
        
        # Build slot_to_review mapping: {slot_num: review}
        # IMPORTANT: Use slotNum from the review itself, NOT hunt_id matching
        # The frontend sends reviews with slotNum field indicating which slot they belong to
        # NOTE: Keys may be "hunt_id:slotNum" format to handle duplicate hunt_ids
        slot_to_review = {}  # {slot_num: review}
        logger.debug("Building slot_to_review mapping from human_reviews")
        logger.debug("human_reviews received: %s", human_reviews)
        logger.debug("human_reviews keys: %s", list(human_reviews.keys()))
        
        for key_str, review in human_reviews.items():
            # Get slotNum from the review (this is the source of truth)
            slot_num = review.get('slotNum')
            if slot_num is not None:
                slot_num = int(slot_num)
                if 1 <= slot_num <= 4:
                    # Create a deep copy of the review to avoid reference issues
                    review_copy = {
                        'judgment': review.get('judgment'),
                        'grading_basis': dict(review.get('grading_basis', {})),  # Deep copy dict
                        'explanation': review.get('explanation'),
                        'slotNum': review.get('slotNum'),
                        'timestamp': review.get('timestamp')
                    }
                    slot_to_review[slot_num] = review_copy
                    # Extract hunt_id from key (may be "hunt_id:slotNum" or just "hunt_id")
                    if ':' in key_str:
                        hunt_id = int(key_str.split(':')[0]) if key_str.split(':')[0].isdigit() else None
                    else:
                        hunt_id = int(key_str) if key_str.isdigit() else None
                    logger.debug("Mapped review for key %s (hunt_id %s) -> slot %d (from review.slotNum)", key_str, hunt_id, slot_num)
                    logger.debug("Review judgment: %s, explanation preview: %s", review_copy.get('judgment'), review_copy.get('explanation', '')[:50])
                else:
                    logger.warning("Invalid slotNum %d in review for key %s (must be 1-4)", slot_num, key_str)
            else:
                logger.warning("Review for key %s missing slotNum field", key_str)
        
        # Build slot_to_result mapping using array index (results order determines slots 1-4)
        # Frontend sends results in the exact order they should appear in slots
        slot_to_result = {}
        logger.debug("Building slot_to_result using array index (order preserved from frontend)")
        for idx, result in enumerate(results[:4], start=1):
            slot_to_result[idx] = result
            logger.debug("Mapped slot %d -> hunt_id %s (by array index)", idx, result.get('hunt_id'))
        
        logger.debug("Final slot_to_review mapping: slots %s", list(slot_to_review.keys()))
        for slot_num, review in slot_to_review.items():
            result_hunt_id = int(slot_to_result.get(slot_num, {}).get('hunt_id', 0)) if slot_num in slot_to_result else None
            logger.debug("Slot %d: judgment=%s, result hunt_id=%s, review explanation preview=%s", slot_num, review.get('judgment'), result_hunt_id, review.get('explanation', '')[:50])
        
        if len(slot_to_result) < 4:
            logger.warning("Only %d slots mapped, but creating 4 slots. Empty slots: %s", len(slot_to_result), [s for s in range(1, 5) if s not in slot_to_result])
        
        # Helper function to get cell heading
        def get_cell_heading(cell):
            source = cell.get('source', [])
            if isinstance(source, list):
                content = ''.join(source)
            else:
                content = str(source)
            match = self.HEADING_PATTERN.search(content)
            if match:
                return match.group(1).lower(), match.group(1)
            return None, None
        
        # Helper function to determine cell type and slot
        def get_cell_type_and_slot(heading_lower):
            if not heading_lower:
                return None, None
            model_match = self.MODEL_PATTERN.match(heading_lower)
            if model_match:
                return 'model', int(model_match.group(2))
            judge_match = self.LLM_JUDGE_PATTERN.match(heading_lower)
            if judge_match:
                return 'llm_judge', int(judge_match.group(1))
            human_match = self.HUMAN_JUDGE_PATTERN.match(heading_lower)
            if human_match:
                return 'human_judge', int(human_match.group(1))
            reasoning_match = self.REASONING_TRACE_PATTERN.match(heading_lower)
            if reasoning_match:
                return 'reasoning_trace', int(reasoning_match.group(1))
            return None, None
        
        # Helper function to format LLM judge content
        def format_llm_judge_content(result):
            judge_criteria = result.get('judge_criteria', {}) if result else {}
            judge_score = (result.get('judge_score') or result.get('score', 0)) if result else 0
            judge_explanation = result.get('judge_explanation', '') if result else ''
            judge_output_raw = result.get('judge_output', '') if result else ''
            
            # If judge_criteria is empty, try to parse from judge_output
            if not judge_criteria and judge_output_raw:
                import json as json_module
                try:
                    json_match = re.search(r'\{[^{}]*"criteria"[^{}]*\}', judge_output_raw, re.DOTALL)
                    if json_match:
                        parsed = json_module.loads(json_match.group(0))
                        judge_criteria = parsed.get('criteria', {})
                except:
                    pass
            
            if not judge_criteria:
                judge_criteria = {}
            
            # Calculate pass rate
            total_criteria = len(judge_criteria)
            pass_count = sum(1 for v in judge_criteria.values() if str(v).upper() == 'PASS')
            pass_rate_text = f"The pass rate is {pass_count}/{total_criteria}" if total_criteria > 0 else "No criteria evaluated"
            
            # Extract per-criterion explanations from judge_explanation or judge_output_raw
            explanation_text = judge_explanation or judge_output_raw or ""
            criteria_explanations = {}
            
            if explanation_text:
                # First, try to extract from "Passing Criteria:" or "Passing Criteria Details:" section (before "Failed Criteria Details:")
                passing_section_match = re.search(r'Passing\s+Criteria(?:\s+Details?)?(?:\s*:\s*\d+/\d+)?\s*(.*?)(?=Failed\s+Criteria\s+Details|$)', explanation_text, re.IGNORECASE | re.DOTALL)
                if passing_section_match:
                    passing_section = passing_section_match.group(1)
                    # Check if there's actual content in the passing section (not just empty)
                    if passing_section.strip():
                        # Look for criteria in the passing section
                        for criterion_id in judge_criteria.keys():
                            if judge_criteria.get(criterion_id, '').upper() == 'PASS':
                                # Try to find this criterion in the passing section
                                pass_patterns = [
                                    re.compile(rf'{re.escape(criterion_id)}[:\s\-]+\s*(.+?)(?=\s*C\d|$)', re.IGNORECASE | re.DOTALL),
                                    re.compile(rf'{re.escape(criterion_id)}\s+PASS[:\s\-]?\s*(.+?)(?=\s*C\d|$)', re.IGNORECASE | re.DOTALL),
                                ]
                                for pattern in pass_patterns:
                                    match = pattern.search(passing_section)
                                    if match and match.group(1):
                                        explanation = match.group(1).strip()
                                        explanation = re.sub(r'^[•\-\*]\s*', '', explanation)
                                        explanation = re.sub(r'\s+', ' ', explanation).strip()
                                        if explanation and len(explanation) > 5:
                                            criteria_explanations[criterion_id] = explanation
                                            break
                    else:
                        # "Passing Criteria: X/Y" found but no details section - try to find passing criteria by process of elimination
                        # Get all failing criteria mentioned in "Failed Criteria Details:"
                        failed_criteria_mentioned = set()
                        failed_section_match = re.search(r'Failed\s+Criteria\s+Details?:\s*(.*?)(?=Passing\s+Criteria|$)', explanation_text, re.IGNORECASE | re.DOTALL)
                        if failed_section_match:
                            failed_section = failed_section_match.group(1)
                            # Extract all criterion IDs mentioned in failed section
                            for criterion_id in judge_criteria.keys():
                                if re.search(rf'\b{re.escape(criterion_id)}\b', failed_section, re.IGNORECASE):
                                    failed_criteria_mentioned.add(criterion_id.upper())
                        
                        # Now, for each passing criterion, try to find it anywhere in the explanation
                        for criterion_id in judge_criteria.keys():
                            if (judge_criteria.get(criterion_id, '').upper() == 'PASS' and 
                                criterion_id.upper() not in failed_criteria_mentioned and
                                criterion_id not in criteria_explanations):
                                # Look for this passing criterion anywhere in the explanation text
                                # Try patterns that might indicate why it passed
                                pass_inference_patterns = [
                                    # Look for criterion mentioned with positive context
                                    re.compile(rf'{re.escape(criterion_id)}[^.]*?(?:correctly|properly|adequately|satisfies?|meets?|fulfills?|addresses?|identifies?|states?|clarifies?)[^.]*?\.', re.IGNORECASE),
                                    # Look for positive context before the criterion
                                    re.compile(rf'(?:correctly|properly|adequately|satisfies?|meets?|fulfills?|addresses?|identifies?|states?|clarifies?)[^.]*?{re.escape(criterion_id)}[^.]*?\.', re.IGNORECASE),
                                ]
                                for pattern in pass_inference_patterns:
                                    match = pattern.search(explanation_text)
                                    if match:
                                        explanation = match.group(0).strip()
                                        explanation = re.sub(r'^[•\-\*]\s*', '', explanation)
                                        explanation = re.sub(r'\s+', ' ', explanation).strip()
                                        if explanation and len(explanation) > 10:
                                            criteria_explanations[criterion_id] = explanation
                                            break
                
                # Then, try to extract from "Failed Criteria Details:" section
                failed_section_match = re.search(r'Failed\s+Criteria\s+Details?:\s*(.*?)(?=Passing\s+Criteria|$)', explanation_text, re.IGNORECASE | re.DOTALL)
                if failed_section_match:
                    failed_section = failed_section_match.group(1)
                    # Look for criteria in the failed section
                    for criterion_id in judge_criteria.keys():
                        if criterion_id not in criteria_explanations:  # Only if not already found
                            if judge_criteria.get(criterion_id, '').upper() == 'FAIL':
                                fail_patterns = [
                                    re.compile(rf'{re.escape(criterion_id)}[:\s\-]+\s*(.+?)(?=\s*C\d|$)', re.IGNORECASE | re.DOTALL),
                                    re.compile(rf'{re.escape(criterion_id)}\s+FAIL[:\s\-]?\s*(.+?)(?=\s*C\d|$)', re.IGNORECASE | re.DOTALL),
                                ]
                                for pattern in fail_patterns:
                                    match = pattern.search(failed_section)
                                    if match and match.group(1):
                                        explanation = match.group(1).strip()
                                        explanation = re.sub(r'^[•\-\*]\s*', '', explanation)
                                        explanation = re.sub(r'\s+', ' ', explanation).strip()
                                        if explanation and len(explanation) > 5:
                                            criteria_explanations[criterion_id] = explanation
                                            break
                
                # Fallback: look for any criterion ID anywhere in the explanation (for any format)
                for criterion_id in judge_criteria.keys():
                    if criterion_id not in criteria_explanations:
                        patterns = [
                            # Pattern: "C1: explanation..." or "C1 - explanation..." (fix: escape dash or put at end)
                            re.compile(rf'{re.escape(criterion_id)}[:\s\-]+\s*(.+?)(?=\s*C\d|$)', re.IGNORECASE | re.DOTALL),
                            # Pattern: "C1 PASS: explanation..." or "C1 FAIL: explanation..."
                            re.compile(rf'{re.escape(criterion_id)}\s+(?:PASS|FAIL)[:\s\-]?\s*(.+?)(?=\s*C\d|$)', re.IGNORECASE | re.DOTALL),
                        ]
                        for pattern in patterns:
                            match = pattern.search(explanation_text)
                            if match and match.group(1):
                                explanation = match.group(1).strip()
                                explanation = re.sub(r'^[•\-\*]\s*', '', explanation)
                                explanation = re.sub(r'\s+', ' ', explanation).strip()
                                if explanation and len(explanation) > 5:
                                    criteria_explanations[criterion_id] = explanation
                                    break
                        
                        # Final fallback: look line by line
                        if criterion_id not in criteria_explanations:
                            lines = explanation_text.split('\n')
                            for line in lines:
                                if criterion_id.upper() in line.upper() and len(line) > len(criterion_id) + 10:
                                    # Extract text after the criterion ID
                                    match = re.search(rf'{re.escape(criterion_id)}[:\s\-]?\s*(.+)', line, re.IGNORECASE)
                                    if match:
                                        explanation = match.group(1).strip()
                                        explanation = re.sub(r'^[•\-\*]\s*', '', explanation)
                                        if explanation and len(explanation) > 5:
                                            criteria_explanations[criterion_id] = explanation
                                            break
            
            # For passing criteria without explanations, try to infer from overall explanation
            # Look for positive language or mentions of the criterion being satisfied
            for criterion_id in judge_criteria.keys():
                if criterion_id not in criteria_explanations and judge_criteria.get(criterion_id, '').upper() == 'PASS':
                    # Try to find any mention of this criterion in a positive context
                    # Look for patterns like "C2 satisfied", "C2 meets", "C2 correctly", etc.
                    positive_patterns = [
                        re.compile(rf'{re.escape(criterion_id)}[^.]*?(?:satisfies?|meets?|correctly|properly|adequately|fully|completely|successfully)[^.]*?\.', re.IGNORECASE),
                        re.compile(rf'(?:satisfies?|meets?|correctly|properly|adequately|fully|completely|successfully)[^.]*?{re.escape(criterion_id)}[^.]*?\.', re.IGNORECASE),
                    ]
                    for pattern in positive_patterns:
                        match = pattern.search(explanation_text)
                        if match:
                            explanation = match.group(0).strip()
                            explanation = re.sub(r'^[•\-\*]\s*', '', explanation)
                            explanation = re.sub(r'\s+', ' ', explanation).strip()
                            if explanation and len(explanation) > 10:
                                criteria_explanations[criterion_id] = explanation
                                break
            
            # Build criteria details list in format: C1: (FAIL) explanation
            criteria_details = []
            if judge_criteria:
                # Sort criteria by ID (C1, C2, C3, etc.)
                def get_criterion_number(criterion_id):
                    match = re.search(r'(\d+)', str(criterion_id))
                    return int(match.group(1)) if match else 999
                
                sorted_criteria = sorted(judge_criteria.items(), key=lambda x: get_criterion_number(x[0]))
                for criterion_id, status in sorted_criteria:
                    status_upper = str(status).upper()
                    explanation = criteria_explanations.get(criterion_id, "")
                    if explanation:
                        criteria_details.append(f"{criterion_id}: ({status_upper}) {explanation}")
                    else:
                        # If no explanation found for a passing criterion, add a note
                        if status_upper == 'PASS':
                            criteria_details.append(f"{criterion_id}: ({status_upper}) Criterion satisfied - no specific explanation provided in judge output")
                        else:
                            criteria_details.append(f"{criterion_id}: ({status_upper})")
            
            # Combine pass rate summary with criteria details
            criteria_summary = f"{pass_rate_text}, here are the details:\n\n" + "\n".join(criteria_details) if criteria_details else pass_rate_text
            
            grading_json = json.dumps({k: v.upper() for k, v in judge_criteria.items()}, indent=2, ensure_ascii=False)
            answer_json = json.dumps({"answer_score": judge_score}, indent=2, ensure_ascii=False)
            
            return f"""[Grading Basis]:

{grading_json}

[Score]: {judge_score} point(s)

[JSON]:

{answer_json}

[Explanation]:

{criteria_summary}"""
        
        # Helper function to format human judge content
        def format_human_judge_content(review):
            grading_basis = review.get('grading_basis', {}) if review else {}
            if grading_basis:
                grading_json = json.dumps({k: v.upper() for k, v in grading_basis.items()}, indent=2, ensure_ascii=False)
            else:
                grading_json = json.dumps({}, indent=2)
            
            # Calculate score based on 50% rule: if MORE than 50% criteria are PASS, overall is PASS (score 1)
            # If 50% or less pass, it's FAIL (score 0, breaking) - matches LLM judge logic
            total_criteria = len(grading_basis)
            pass_count = sum(1 for v in grading_basis.values() if str(v).upper() == 'PASS')
            score = 1 if pass_count > total_criteria / 2 else 0
            
            explanation = (review.get('explanation', '') or review.get('notes', '')) if review else ''
            answer_json = json.dumps({"answer_score": score}, indent=2, ensure_ascii=False)
            
            return f"""[Grading Basis]:

{grading_json}

[Score]: {score} point(s)

[JSON]:

{answer_json}

[Explanation]:

{explanation}"""
        
        # Step 1: Update existing cells with new content and separate slot cells from non-slot cells
        slot_cells_dict = {}  # {(slot_num, cell_type): cell}
        non_slot_cells = []  # All other cells (metadata, prompt, response_reference, etc.)
        updated_slots = set()
        
        for cell in cells:
            heading_lower, heading_original = get_cell_heading(cell)
            
            if not heading_lower:
                # Cell has no heading, keep as-is in non-slot cells
                non_slot_cells.append(cell)
                continue
            
            # PRESERVE original response_reference and judge_system_prompt - DO NOT OVERWRITE
            if heading_lower == 'response_reference' or heading_lower == 'judge_system_prompt':
                non_slot_cells.append(cell)
                continue
            
            # Check if this is a slot cell
            cell_type, slot_num = get_cell_type_and_slot(heading_lower)
            
            if cell_type and slot_num:
                # This is a slot cell - update it and track it
                if cell_type == 'model':
                    result = slot_to_result.get(slot_num)
                    if not result and slot_num <= len(results):
                        result = results[slot_num - 1]
                    response_text = result.get('response', '') if result else ''
                    # Use correct model prefix from results; Turn 1 heading
                    correct_heading = f"Turn 1 - {model_prefix_capitalized}_{slot_num}"
                    cell['source'] = [f"**[{correct_heading}]**\n\n{response_text}"]
                    updated_slots.add(f"model_{slot_num}")
                    slot_cells_dict[(slot_num, 'model')] = cell
                    logger.debug("Updated model_%d cell with heading %s", slot_num, correct_heading)
                
                elif cell_type == 'llm_judge':
                    result = slot_to_result.get(slot_num)
                    if not result and slot_num <= len(results):
                        result = results[slot_num - 1]
                    llm_content = format_llm_judge_content(result)
                    cell['source'] = [f"**[Turn 1 - {heading_original}]**\n\n{llm_content}"]
                    updated_slots.add(f"judge_{slot_num}")
                    slot_cells_dict[(slot_num, 'llm_judge')] = cell
                    logger.debug("Updated llm_judge_%d cell", slot_num)
                
                elif cell_type == 'human_judge':
                    # Get review for this slot using slot_to_review mapping
                    review = slot_to_review.get(slot_num)
                    if review is None:
                        logger.warning("No review found for slot %d. Available slots in slot_to_review: %s", slot_num, list(slot_to_review.keys()))
                    else:
                        # Get the result for this slot to verify hunt_id match
                        slot_result = slot_to_result.get(slot_num)
                        expected_hunt_id = int(slot_result.get('hunt_id', 0)) if slot_result else None
                        logger.debug("Updating human_judge_%d cell - expected hunt_id: %s, review judgment: %s", slot_num, expected_hunt_id, review.get('judgment') if review else None)
                    human_content = format_human_judge_content(review)
                    cell['source'] = [f"**[Turn 1 - {heading_original}]**\n\n{human_content}"]
                    updated_slots.add(f"human_{slot_num}")
                    slot_cells_dict[(slot_num, 'human_judge')] = cell
                    logger.debug("Updated human_judge_%d cell (review present: %s, has_grading_basis: %s)", slot_num, review is not None, bool(review.get('grading_basis') if review else False))
                
                elif cell_type == 'reasoning_trace':
                    if include_reasoning:
                        result = slot_to_result.get(slot_num)
                        if not result and slot_num <= len(results):
                            result = results[slot_num - 1]
                        reasoning_trace = result.get('reasoning_trace', '') if result else ''
                        cell['source'] = [f"**[Turn 1 - {heading_original}]**\n\n{reasoning_trace}"]
                        updated_slots.add(f"reasoning_{slot_num}")
                        slot_cells_dict[(slot_num, 'reasoning_trace')] = cell
                        logger.debug("Updated reasoning_trace_%d cell", slot_num)
                    else:
                        # Skip reasoning trace if not included
                        continue
            else:
                # Not a slot cell - check if it's number_of_attempts_made
                if heading_lower == 'number_of_attempts_made':
                    attempts_content = format_number_of_attempts_made(per_model_hunts, total_hunts_ran)
                    cell['source'] = [f"**[number_of_attempts_made]**:\n\n{attempts_content}"]
                    updated_slots.add('number_of_attempts_made')
                    logger.debug("Updated number_of_attempts_made cell")
                # Keep all non-slot cells in their original order (for now)
                non_slot_cells.append(cell)
        
        # Step 2: Create missing slot cells
        for slot_num in range(1, 5):  # Always create slots 1-4
            slot_result = slot_to_result.get(slot_num)
            if not slot_result and slot_num <= len(results):
                slot_result = results[slot_num - 1]
            
            # Create model cell if missing
            if (slot_num, 'model') not in slot_cells_dict:
                response_text = slot_result.get('response', '') if slot_result else ''
                slot_cells_dict[(slot_num, 'model')] = {
                    "cell_type": "markdown",
                    "id": f"auto_model_{slot_num}",
                    "metadata": {},
                    "source": [f"**[Turn 1 - {model_prefix_capitalized}_{slot_num}]**\n\n{response_text}"]
                }
                logger.debug("Created model_%d cell", slot_num)
            
            # Create llm_judge cell if missing
            if (slot_num, 'llm_judge') not in slot_cells_dict:
                llm_content = format_llm_judge_content(slot_result)
                slot_cells_dict[(slot_num, 'llm_judge')] = {
                    "cell_type": "markdown",
                    "id": f"auto_llm_judge_{slot_num}",
                    "metadata": {},
                    "source": [f"**[Turn 1 - llm_judge_{slot_num}]**\n\n{llm_content}"]
                }
                logger.debug("Created llm_judge_%d cell", slot_num)
            
            # Create human_judge cell if missing
            if (slot_num, 'human_judge') not in slot_cells_dict:
                # Get review for this slot using slot_to_review mapping
                review = slot_to_review.get(slot_num)
                if review is None:
                    logger.warning("No review found for slot %d when creating cell. Available slots: %s", slot_num, list(slot_to_review.keys()))
                else:
                    # Get the result for this slot to verify hunt_id match
                    expected_hunt_id = int(slot_result.get('hunt_id', 0)) if slot_result else None
                    logger.debug("Creating human_judge_%d cell - expected hunt_id: %s, review judgment: %s", slot_num, expected_hunt_id, review.get('judgment') if review else None)
                human_content = format_human_judge_content(review)
                slot_cells_dict[(slot_num, 'human_judge')] = {
                    "cell_type": "markdown",
                    "id": f"auto_human_{slot_num}",
                    "metadata": {},
                    "source": [f"**[Turn 1 - human_judge_{slot_num}]**\n\n{human_content}"]
                }
                logger.debug("Created human_judge_%d cell (review present: %s, has_grading_basis: %s)", slot_num, review is not None, bool(review.get('grading_basis') if review else False))
            
            # Create reasoning_trace cell if missing and include_reasoning is True
            if include_reasoning and (slot_num, 'reasoning_trace') not in slot_cells_dict:
                reasoning_trace = slot_result.get('reasoning_trace', '') if slot_result else ''
                slot_cells_dict[(slot_num, 'reasoning_trace')] = {
                    "cell_type": "markdown",
                    "id": f"auto_reasoning_trace_{slot_num}",
                    "metadata": {},
                    "source": [f"**[Turn 1 - reasoning_trace_{slot_num}]**\n\n{reasoning_trace}"]
                }
                logger.debug("Created reasoning_trace_%d cell", slot_num)
        
        # Step 3: Build ordered slot cells list (model_1, llm_judge_1, human_judge_1, reasoning_trace_1, model_2, ...)
        ordered_slot_cells = []
        cell_type_order = ['model', 'llm_judge', 'human_judge', 'reasoning_trace']
        for slot_num in range(1, 5):
            for cell_type in cell_type_order:
                if (slot_num, cell_type) in slot_cells_dict:
                    ordered_slot_cells.append(slot_cells_dict[(slot_num, cell_type)])
        
        # Step 4: Find insertion point for slot cells (after last non-slot cell that should come before slots)
        # We want to insert slot cells after metadata cells like prompt, response, response_reference, judge_prompt_template, judge_system_prompt
        # but before number_of_attempts_made
        insertion_index = len(non_slot_cells)
        
        # Find the position of number_of_attempts_made in non_slot_cells
        for i, cell in enumerate(non_slot_cells):
            heading_lower, _ = get_cell_heading(cell)
            if heading_lower == 'number_of_attempts_made':
                insertion_index = i
                break
        
        # Step 5: Insert slot cells at the correct position
        final_cells = non_slot_cells[:insertion_index] + ordered_slot_cells + non_slot_cells[insertion_index:]
        
        # Step 6: Add number_of_attempts_made cell at the end if it doesn't exist
        attempts_cell_found = 'number_of_attempts_made' in updated_slots
        if not attempts_cell_found:
            attempts_content = format_number_of_attempts_made(per_model_hunts, total_hunts_ran)
            final_cells.append({
                "cell_type": "markdown",
                "id": "auto_attempts_counter",
                "metadata": {},
                "source": [f"**[number_of_attempts_made]**:\n\n{attempts_content}"]
            })
            logger.debug("Created number_of_attempts_made cell")
        
        # Step 7: Update base cells (prompt, response, response_reference, judge_system_prompt) to Turn 1 headings
        turn1_base_headings = ('prompt', 'response', 'response_reference', 'judge_system_prompt', 'judge_prompt_template')
        for cell in final_cells:
            source = cell.get('source', [])
            if not source:
                continue
            content = ''.join(s if isinstance(s, str) else str(s) for s in source)
            match = self.HEADING_PATTERN.search(content)
            if match:
                inner = match.group(1).strip()
                inner_lower = inner.lower()
                # Skip if already has "Turn N -" prefix
                if 'turn' in inner_lower and ' - ' in inner:
                    continue
                if inner_lower in turn1_base_headings:
                    new_heading = f"**[Turn 1 - {inner}]**"
                    content = content[:match.start()] + new_heading + content[match.end():]
                    cell['source'] = [content]
        
        notebook['cells'] = final_cells
        logger.debug("Final notebook has %d cells", len(final_cells))
        from helpers.notebook_helpers import pretty_print_json_in_notebook
        pretty_print_json_in_notebook(notebook)
        return json.dumps(notebook, indent=2)

    def export_multi_turn_notebook(
        self,
        original_content,
        parsed: ParsedNotebook,
        turns: list,
        breaking_turn_results: list,
        include_reasoning: bool = True,
        human_reviews: dict = None,
        total_hunts_ran: int = 0,
        conversation_history: list = None,
        per_model_hunts: Optional[Dict[str, int]] = None
    ) -> str:
        """
        Export multi-turn notebook. Latest turn first, then previous turns (newest first).
        
        Latest turn: **[Turn N - prompt]**, response, response_reference, judge_system_prompt,
        model slots, llm_judge, human_judge, reasoning_trace.
        Previous turns: **[Turn K - prompt]**, selected_response, response_reference, selected_judge.
        number_of_attempts_made: per-model markdown list with display names.
        """
        if isinstance(original_content, str):
            notebook = json.loads(original_content)
        else:
            notebook = original_content
        
        # Ensure nbformat keys exist
        if 'nbformat' not in notebook:
            notebook['nbformat'] = 4
        if 'nbformat_minor' not in notebook:
            notebook['nbformat_minor'] = 5
        
        cells = notebook.get('cells', [])
        human_reviews = human_reviews or {}
        conversation_history = conversation_history or []
        
        if not turns:
            return self.export_notebook(
                original_content=original_content,
                parsed=parsed,
                results=breaking_turn_results,
                include_reasoning=include_reasoning,
                human_reviews=human_reviews,
                total_hunts_ran=total_hunts_ran,
                per_model_hunts=per_model_hunts
            )
        
        total_turns = len(turns)
        bt_num = turns[-1].get('turn_number', total_turns) if turns else 1
        
        if total_turns == 1:
            return self.export_notebook(
                original_content=original_content,
                parsed=parsed,
                results=breaking_turn_results,
                include_reasoning=include_reasoning,
                human_reviews=human_reviews,
                total_hunts_ran=total_hunts_ran,
                per_model_hunts=per_model_hunts
            )
        
        # Multi-turn export
        # Step 1: Keep non-slot cells from original notebook
        def get_cell_heading(cell):
            source = cell.get('source', [])
            if isinstance(source, list):
                content = ''.join(source)
            else:
                content = str(source)
            match = self.HEADING_PATTERN.search(content)
            if match:
                return match.group(1).lower(), match.group(1)
            return None, None
        
        non_slot_cells = []
        for cell in cells:
            heading_lower, _ = get_cell_heading(cell)
            if not heading_lower:
                non_slot_cells.append(cell)
                continue
            # Keep metadata cells (prompt, response, response_reference, judge_system_prompt)
            # but NOT model/judge/human slots or attempts counter
            cell_type, _ = self._get_cell_type_and_slot(heading_lower)
            if cell_type:
                continue  # Skip existing slot cells
            if heading_lower == 'number_of_attempts_made':
                continue  # Will recreate
            # Skip multi-turn specific cells that might exist from a previous save
            if any(heading_lower.startswith(p) for p in [
                'prompt_', 'response_reference_', 'selected_response_', 'selected_judge_',
                'conversation_history', 'number_of_turns', 'breaking_turn'
            ]):
                continue
            non_slot_cells.append(cell)
        
        # Step 2: Helper to create a markdown cell with **[heading]** format
        def make_cell(heading, content, cell_id=None):
            return {
                "cell_type": "markdown",
                "id": cell_id or f"auto_{heading.lower().replace(' ', '_').replace('-', '_')}",
                "metadata": {},
                "source": [f"**[{heading}]**\n\n{content}"]
            }
        
        multi_turn_cells = []
        
        # Step 3: LATEST TURN FIRST (breaking turn) - full structure with Turn N headings
        breaking_turn = turns[-1]
        bt_prompt = breaking_turn.get('prompt', '')
        bt_criteria = breaking_turn.get('response_reference', '')
        bt_ref_response = parsed.response  # Reference response judged before hunt
        
        multi_turn_cells.append(make_cell(f'Turn {bt_num} - prompt', bt_prompt, f'auto_turn{bt_num}_prompt'))
        multi_turn_cells.append(make_cell(f'Turn {bt_num} - response', bt_ref_response or '', f'auto_turn{bt_num}_response'))
        multi_turn_cells.append(make_cell(f'Turn {bt_num} - response_reference', bt_criteria, f'auto_turn{bt_num}_response_reference'))
        multi_turn_cells.append(make_cell(f'Turn {bt_num} - judge_system_prompt', parsed.judge_system_prompt or '', f'auto_turn{bt_num}_judge_system_prompt'))
        
        model_prefix = "model"
        if breaking_turn_results:
            first_model = breaking_turn_results[0].get('model', '')
            if 'nemotron' in first_model.lower():
                model_prefix = 'nemotron'
            elif 'qwen' in first_model.lower():
                model_prefix = 'qwen'
        model_prefix_cap = model_prefix.capitalize()
        
        slot_to_review = {}
        for key_str, review in human_reviews.items():
            slot_num = review.get('slotNum')
            if slot_num is not None:
                slot_num = int(slot_num)
                if 1 <= slot_num <= 4:
                    slot_to_review[slot_num] = review
        
        for slot_num in range(1, 5):
            result = breaking_turn_results[slot_num - 1] if slot_num <= len(breaking_turn_results) else None
            response_text = result.get('response', '') if result else ''
            multi_turn_cells.append(make_cell(
                f'Turn {bt_num} - {model_prefix_cap}_{slot_num}', response_text, f'auto_bt_model_{slot_num}'))
            
            if result:
                judge_criteria = result.get('judge_criteria', {})
                judge_score = result.get('judge_score', result.get('score', 0))
                judge_explanation = result.get('judge_explanation', '')
                grading_json = json.dumps({k: v.upper() for k, v in judge_criteria.items()}, indent=2, ensure_ascii=False) if judge_criteria else json.dumps({}, indent=2)
                answer_json = json.dumps({"answer_score": judge_score}, indent=2, ensure_ascii=False)
                llm_content = f"[Grading Basis]:\n\n{grading_json}\n\n[Score]: {judge_score} point(s)\n\n[JSON]:\n\n{answer_json}\n\n[Explanation]:\n\n{judge_explanation}"
            else:
                llm_content = ''
            multi_turn_cells.append(make_cell(
                f'Turn {bt_num} - llm_judge_{slot_num}', llm_content, f'auto_bt_llm_judge_{slot_num}'))
            
            review = slot_to_review.get(slot_num)
            if review:
                grading_basis = review.get('grading_basis', {})
                grading_json = json.dumps({k: v.upper() for k, v in grading_basis.items()}, indent=2, ensure_ascii=False) if grading_basis else json.dumps({}, indent=2)
                total_criteria = len(grading_basis)
                pass_count = sum(1 for v in grading_basis.values() if str(v).upper() == 'PASS')
                score = 1 if pass_count > total_criteria / 2 else 0
                explanation = review.get('explanation', '') or review.get('notes', '')
                answer_json = json.dumps({"answer_score": score}, indent=2, ensure_ascii=False)
                human_content = f"[Grading Basis]:\n\n{grading_json}\n\n[Score]: {score} point(s)\n\n[JSON]:\n\n{answer_json}\n\n[Explanation]:\n\n{explanation}"
            else:
                human_content = ''
            multi_turn_cells.append(make_cell(
                f'Turn {bt_num} - human_judge_{slot_num}', human_content, f'auto_bt_human_judge_{slot_num}'))
            
            if include_reasoning:
                reasoning = result.get('reasoning_trace', '') if result else ''
                multi_turn_cells.append(make_cell(
                    f'Turn {bt_num} - reasoning_trace_{slot_num}', reasoning, f'auto_bt_reasoning_{slot_num}'))
        
        # Step 4: PREVIOUS TURNS (newest first: N-1, N-2, ..., 1)
        prev_turns = list(turns[:-1])
        prev_turns.reverse()  # Newest first
        for turn in prev_turns:
            k = turn.get('turn_number', 1)
            prompt = turn.get('prompt', '')
            criteria = turn.get('response_reference', '')
            selected = turn.get('selected_response', '')
            judge_result = turn.get('judge_result', {})
            multi_turn_cells.append(make_cell(f'Turn {k} - prompt', prompt, f'auto_turn{k}_prompt'))
            multi_turn_cells.append(make_cell(f'Turn {k} - selected_response', selected, f'auto_turn{k}_selected_response'))
            multi_turn_cells.append(make_cell(f'Turn {k} - response_reference', criteria, f'auto_turn{k}_response_reference'))
            if judge_result:
                judge_text = self._format_turn_judge(judge_result)
                multi_turn_cells.append(make_cell(f'Turn {k} - selected_judge', judge_text, f'auto_turn{k}_selected_judge'))
        
        # Step 5: number_of_attempts_made (last) - per-model markdown list
        attempts_content = format_number_of_attempts_made(per_model_hunts, total_hunts_ran)
        multi_turn_cells.append(make_cell(
            'number_of_attempts_made', attempts_content, 'auto_attempts_counter'))
        
        # Step 6: Combine: non-slot cells (metadata only) + multi-turn cells
        notebook['cells'] = non_slot_cells + multi_turn_cells
        
        logger.debug("Multi-turn export: %d turns, breaking at turn %d, %d total cells", total_turns, bt_num, len(notebook['cells']))
        from helpers.notebook_helpers import pretty_print_json_in_notebook
        pretty_print_json_in_notebook(notebook)
        return json.dumps(notebook, indent=2)
    
    def _format_turn_judge(self, judge_result: dict) -> str:
        """Format judge result for a non-breaking turn's selected response."""
        score = judge_result.get('score', 0)
        criteria = judge_result.get('criteria', {})
        explanation = judge_result.get('explanation', '')
        
        grading_json = json.dumps({k: v.upper() for k, v in criteria.items()}, indent=2, ensure_ascii=False) if criteria else json.dumps({}, indent=2)
        answer_json = json.dumps({"answer_score": score}, indent=2, ensure_ascii=False)
        
        return f"""[Grading Basis]:

{grading_json}

[Score]: {score} point(s)

[JSON]:

{answer_json}

[Explanation]:

{explanation}"""
    
    def _get_cell_type_and_slot(self, heading_lower: str):
        """Determine cell type and slot number from heading."""
        if not heading_lower:
            return None, None
        model_match = self.MODEL_PATTERN.match(heading_lower)
        if model_match:
            return 'model', int(model_match.group(2))
        judge_match = self.LLM_JUDGE_PATTERN.match(heading_lower)
        if judge_match:
            return 'llm_judge', int(judge_match.group(1))
        human_match = self.HUMAN_JUDGE_PATTERN.match(heading_lower)
        if human_match:
            return 'human_judge', int(human_match.group(1))
        reasoning_match = self.REASONING_TRACE_PATTERN.match(heading_lower)
        if reasoning_match:
            return 'reasoning_trace', int(reasoning_match.group(1))
        return None, None


# Singleton instance
notebook_parser = NotebookParser()
