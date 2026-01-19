"""
Notebook Parser Service

Parses .ipynb files and extracts structured data including:
- Metadata (Task ID, Domain, Use Case, etc.)
- Prompt and response reference
- Judge prompts and system prompts
- Model/judge result slots
"""
import json
import re
import httpx
from typing import Dict, Any, Optional, List, Tuple
from models.schemas import ParsedNotebook, NotebookCell


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
            try:
                content = self._read_with_service_account(file_id)
            except Exception as sa_error:
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
            
            SCOPES = ['https://www.googleapis.com/auth/drive.readonly']
            credentials = service_account.Credentials.from_service_account_file(
                'service_account.json', scopes=SCOPES
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
        try:
            with open('service_account.json', 'r') as f:
                sa_info = json.load(f)
                return sa_info.get('client_email', 'unknown')
        except:
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
            
            if parsed_cell.heading:
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
        
        # Check for Metadata header
        if heading == 'metadata' or content.startswith('# Metadata'):
            result.metadata = self._parse_metadata(cell.content)
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
            
            # Pattern 1: **Key:** Value or **Key:** - Value (with bold markers)
            # Match key before closing **, then optional colon
            match = re.match(r'\*\*([^*]+?)\*\*:?\s*-?\s*(.+)', line)
            if match:
                key = match.group(1).strip().rstrip(':')  # Remove trailing colon if present
                value = match.group(2).strip()
                if key and value:
                    metadata[key] = value
                    continue
            
            # Pattern 2: Key: Value or Key: - Value (without bold markers)
            match = re.match(r'^([^:]+):\s*-?\s*(.+)', line)
            if match:
                key = match.group(1).strip()
                value = match.group(2).strip()
                if key and value:
                    metadata[key] = value
                    continue
        
        return metadata
    
    def get_model_slot_prefix(self, parsed: ParsedNotebook) -> str:
        """Determine the model slot prefix used in this notebook (nemotron, qwen, etc.)"""
        for slot_name in parsed.model_slots.keys():
            match = self.MODEL_PATTERN.match(slot_name)
            if match:
                return match.group(1).lower()
        return "model"  # Default prefix
    
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
        total_hunts_ran: int = 0
    ) -> str:
        """
        Export modified notebook with hunt results.
        
        Args:
            original_content: Original notebook JSON string
            parsed: Parsed notebook data
            results: List of hunt results to add
            include_reasoning: Whether to append reasoning traces
            human_reviews: Dict of human reviews keyed by hunt_id
            total_hunts_ran: Total number of hunts ran across all attempts
        
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
        
        # Determine model prefix from existing notebook or from results
        model_prefix = self.get_model_slot_prefix(parsed)
        
        # If notebook is empty, try to get model name from results
        if model_prefix == "model" and results:
            # Extract model name from first result (e.g., "nvidia/nemotron-3-nano-30b-a3b" -> "nemotron")
            first_model = results[0].get('model', '')
            if 'nemotron' in first_model.lower():
                model_prefix = 'nemotron'
            elif 'qwen' in first_model.lower():
                model_prefix = 'qwen'
        
        # Capitalize model prefix for heading (Nemotron, Qwen, Model)
        model_prefix_capitalized = model_prefix.capitalize()
        
        # Build mapping from hunt_id to human review (first, to use for slot mapping)
        huntid_to_review = {}
        huntid_to_slotnum = {}  # Map hunt_id -> slotNum
        print(f"DEBUG: human_reviews received: {human_reviews}")
        print(f"DEBUG: human_reviews keys: {list(human_reviews.keys())}")
        for hunt_id_str, review in human_reviews.items():
            slot_num = review.get('slotNum')
            if slot_num is not None:
                hunt_id = int(hunt_id_str) if hunt_id_str.isdigit() else None
                if hunt_id is not None:
                    slot_num_int = int(slot_num)
                    huntid_to_slotnum[hunt_id] = slot_num_int
                    # Store review by slot_num - if multiple reviews for same slot, keep the last one
                    if slot_num_int in huntid_to_review:
                        print(f"WARNING: Multiple reviews for slot {slot_num_int}, keeping the last one")
                    huntid_to_review[slot_num_int] = review
                    print(f"DEBUG: hunt_id {hunt_id} -> slot {slot_num_int}, judgment: {review.get('judgment')}, has_grading_basis: {bool(review.get('grading_basis'))}, has_explanation: {bool(review.get('explanation') or review.get('notes'))}")
        print(f"DEBUG: Final huntid_to_review mapping: {list(huntid_to_review.keys())}")
        
        # Build a mapping from slot number (1-4) to result
        # Priority: Use slotNum from human_reviews if available, otherwise use index
        slot_to_result = {}
        used_slots = set()
        print(f"DEBUG: Building slot_to_result mapping from {len(results)} results")
        
        # First pass: Map results using slotNum from human_reviews
        for result in results:
            hunt_id = result.get('hunt_id')
            if hunt_id in huntid_to_slotnum:
                slot_num = huntid_to_slotnum[hunt_id]
                if slot_num not in used_slots and 1 <= slot_num <= 4:
                    slot_to_result[slot_num] = result
                    used_slots.add(slot_num)
                    print(f"DEBUG: Mapped hunt_id {hunt_id} -> slot {slot_num} (from human_reviews)")
        
        # Second pass: Fill remaining slots by index
        result_index = 0
        for slot_num in range(1, 5):
            if slot_num not in used_slots and result_index < len(results):
                result = results[result_index]
                slot_to_result[slot_num] = result
                used_slots.add(slot_num)
                print(f"DEBUG: Mapped slot {slot_num} -> hunt_id {result.get('hunt_id')} (by index)")
                result_index += 1
        
        if len(results) < 4:
            print(f"WARNING: Only {len(results)} results provided, but creating 4 slots. Slots {len(results)+1}-4 will be empty.")
        
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
                # Try multiple patterns to extract per-criterion explanations
                for criterion_id in judge_criteria.keys():
                    patterns = [
                        # Pattern: "C1: explanation..." or "C1 - explanation..."
                        re.compile(rf'{re.escape(criterion_id)}[:-\s]+\s*(.+?)(?=\s*C\d|$)', re.IGNORECASE | re.DOTALL),
                        # Pattern: "C1 PASS: explanation..." or "C1 FAIL: explanation..."
                        re.compile(rf'{re.escape(criterion_id)}\s+(?:PASS|FAIL)[:-\s]?\s*(.+?)(?=\s*C\d|$)', re.IGNORECASE | re.DOTALL),
                        # Pattern: "Failed Criteria Details: C1: explanation..." or "Passing Criteria: C1: explanation..."
                        re.compile(rf'(?:Failed|Passing)\s+Criteria\s+Details?:\s*{re.escape(criterion_id)}[:-\s]?\s*(.+?)(?=\s*C\d|$)', re.IGNORECASE | re.DOTALL),
                    ]
                    
                    for pattern in patterns:
                        match = pattern.search(explanation_text)
                        if match and match.group(1):
                            explanation = match.group(1).strip()
                            # Clean up the explanation (remove extra whitespace, bullet points, etc.)
                            explanation = re.sub(r'^[•\-\*]\s*', '', explanation)
                            explanation = re.sub(r'\s+', ' ', explanation).strip()
                            if explanation and len(explanation) > 5:  # Only use if meaningful
                                criteria_explanations[criterion_id] = explanation
                                break
                    
                    # Fallback: look for the criterion ID anywhere in the explanation
                    if criterion_id not in criteria_explanations:
                        lines = explanation_text.split('\n')
                        for line in lines:
                            if criterion_id.upper() in line.upper() and len(line) > len(criterion_id) + 10:
                                # Extract text after the criterion ID
                                match = re.search(rf'{re.escape(criterion_id)}[:-\s]?\s*(.+)', line, re.IGNORECASE)
                                if match:
                                    explanation = match.group(1).strip()
                                    explanation = re.sub(r'^[•\-\*]\s*', '', explanation)
                                    if explanation and len(explanation) > 5:
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
                        criteria_details.append(f"{criterion_id}: ({status_upper})")
            
            # Combine pass rate summary with criteria details
            criteria_summary = f"{pass_rate_text}, here are the details:\n\n" + "\n".join(criteria_details) if criteria_details else pass_rate_text
            
            grading_json = json.dumps({k: v.upper() for k, v in judge_criteria.items()}, indent=2)
            
            return f"""[Grading Basis]:

{grading_json}

[Score]: {judge_score} point(s)

[JSON]: {{"answer_score": {judge_score}}}

[Explanation]:

{criteria_summary}"""
                    
        # Helper function to format human judge content
        def format_human_judge_content(review):
            grading_basis = review.get('grading_basis', {}) if review else {}
            if grading_basis:
                grading_json = json.dumps({k: v.upper() for k, v in grading_basis.items()}, indent=2)
            else:
                grading_json = "{}"
            
            # Calculate score based on 50% rule
            total_criteria = len(grading_basis)
            pass_count = sum(1 for v in grading_basis.values() if str(v).upper() == 'PASS')
            score = 1 if pass_count >= total_criteria / 2 else 0
            
            explanation = (review.get('explanation', '') or review.get('notes', '')) if review else ''
            
            return f"""[Grading Basis]:

{grading_json}

[Score]: {score} point(s)

[JSON]: {{"answer_score": {score}}}

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
                    cell['source'] = [f"**[{heading_original}]**\n\n{response_text}"]
                    updated_slots.add(f"model_{slot_num}")
                    slot_cells_dict[(slot_num, 'model')] = cell
                    print(f"DEBUG: Updated model_{slot_num} cell")
                
                elif cell_type == 'llm_judge':
                    result = slot_to_result.get(slot_num)
                    if not result and slot_num <= len(results):
                        result = results[slot_num - 1]
                    llm_content = format_llm_judge_content(result)
                    cell['source'] = [f"**[{heading_original}]**\n\n{llm_content}"]
                    updated_slots.add(f"judge_{slot_num}")
                    slot_cells_dict[(slot_num, 'llm_judge')] = cell
                    print(f"DEBUG: Updated llm_judge_{slot_num} cell")
                
                elif cell_type == 'human_judge':
                    # Try to get review by slot_num first
                    review = huntid_to_review.get(slot_num)
                    # Fallback: if no review found by slot_num, try to find by hunt_id from slot_to_result
                    if review is None:
                        result = slot_to_result.get(slot_num)
                        if result:
                            hunt_id = result.get('hunt_id')
                            # Try to find review by hunt_id in original human_reviews dict
                            if hunt_id and str(hunt_id) in human_reviews:
                                review = human_reviews[str(hunt_id)]
                                # Update huntid_to_review for future lookups
                                if review.get('slotNum') == slot_num:
                                    huntid_to_review[slot_num] = review
                                    print(f"DEBUG: Found review for slot {slot_num} by hunt_id {hunt_id} (fallback)")
                    if review is None:
                        print(f"WARNING: No review found for slot {slot_num}. Available slots in huntid_to_review: {list(huntid_to_review.keys())}, Available hunt_ids in human_reviews: {list(human_reviews.keys())}")
                    human_content = format_human_judge_content(review)
                    cell['source'] = [f"**[{heading_original}]**\n\n{human_content}"]
                    updated_slots.add(f"human_{slot_num}")
                    slot_cells_dict[(slot_num, 'human_judge')] = cell
                    print(f"DEBUG: Updated human_judge_{slot_num} cell (review present: {review is not None}, has_grading_basis: {bool(review.get('grading_basis') if review else False)})")
                
                elif cell_type == 'reasoning_trace':
                    if include_reasoning:
                        result = slot_to_result.get(slot_num)
                        if not result and slot_num <= len(results):
                            result = results[slot_num - 1]
                        reasoning_trace = result.get('reasoning_trace', '') if result else ''
                        cell['source'] = [f"**[{heading_original}]**\n\n{reasoning_trace}"]
                        updated_slots.add(f"reasoning_{slot_num}")
                        slot_cells_dict[(slot_num, 'reasoning_trace')] = cell
                        print(f"DEBUG: Updated reasoning_trace_{slot_num} cell")
                    else:
                        # Skip reasoning trace if not included
                        continue
            else:
                # Not a slot cell - check if it's number_of_attempts_made
                if heading_lower == 'number_of_attempts_made':
                    # Use total_hunts_ran which should be len(all_results) - total completed hunts
                    new_attempts = total_hunts_ran
                    # Don't clamp - show actual count
                    cell['source'] = [f"**[{heading_original}]**:\n\n{new_attempts}"]
                    updated_slots.add('number_of_attempts_made')
                    print(f"DEBUG: Updated number_of_attempts_made cell to {new_attempts} (total completed hunts)")
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
                    "source": [f"**[{model_prefix_capitalized}_{slot_num}]**\n\n{response_text}"]
                }
                print(f"DEBUG: Created model_{slot_num} cell")
            
            # Create llm_judge cell if missing
            if (slot_num, 'llm_judge') not in slot_cells_dict:
                llm_content = format_llm_judge_content(slot_result)
                slot_cells_dict[(slot_num, 'llm_judge')] = {
                    "cell_type": "markdown",
                    "id": f"auto_llm_judge_{slot_num}",
                    "metadata": {},
                    "source": [f"**[llm_judge_{slot_num}]**\n\n{llm_content}"]
                }
                print(f"DEBUG: Created llm_judge_{slot_num} cell")
            
            # Create human_judge cell if missing
            if (slot_num, 'human_judge') not in slot_cells_dict:
                # Try to get review by slot_num first
                review = huntid_to_review.get(slot_num)
                # Fallback: if no review found by slot_num, try to find by hunt_id from slot_to_result
                if review is None:
                    result = slot_to_result.get(slot_num)
                    if result:
                        hunt_id = result.get('hunt_id')
                        # Try to find review by hunt_id in original human_reviews dict
                        if hunt_id and str(hunt_id) in human_reviews:
                            review = human_reviews[str(hunt_id)]
                            # Update huntid_to_review for future lookups
                            if review.get('slotNum') == slot_num:
                                huntid_to_review[slot_num] = review
                                print(f"DEBUG: Found review for slot {slot_num} by hunt_id {hunt_id} when creating cell (fallback)")
                if review is None:
                    print(f"WARNING: No review found for slot {slot_num} when creating cell. Available slots: {list(huntid_to_review.keys())}, Available hunt_ids: {list(human_reviews.keys())}")
                human_content = format_human_judge_content(review)
                slot_cells_dict[(slot_num, 'human_judge')] = {
                    "cell_type": "markdown",
                    "id": f"auto_human_{slot_num}",
                    "metadata": {},
                    "source": [f"**[human_judge_{slot_num}]**\n\n{human_content}"]
                }
                print(f"DEBUG: Created human_judge_{slot_num} cell (review present: {review is not None}, has_grading_basis: {bool(review.get('grading_basis') if review else False)})")
            
            # Create reasoning_trace cell if missing and include_reasoning is True
            if include_reasoning and (slot_num, 'reasoning_trace') not in slot_cells_dict:
                reasoning_trace = slot_result.get('reasoning_trace', '') if slot_result else ''
                slot_cells_dict[(slot_num, 'reasoning_trace')] = {
                    "cell_type": "markdown",
                    "id": f"auto_reasoning_trace_{slot_num}",
                    "metadata": {},
                    "source": [f"**[reasoning_trace_{slot_num}]**\n\n{reasoning_trace}"]
                }
                print(f"DEBUG: Created reasoning_trace_{slot_num} cell")
        
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
            # Use total_hunts_ran which should be len(all_results) - total completed hunts
            new_attempts = total_hunts_ran
            # Don't clamp - show actual count
            final_cells.append({
                "cell_type": "markdown",
                "id": "auto_attempts_counter",
                "metadata": {},
                "source": [f"**[number_of_attempts_made]**:\n\n{new_attempts}"]
            })
            print(f"DEBUG: Created number_of_attempts_made cell with count={new_attempts} (total completed hunts)")
        
        notebook['cells'] = final_cells
        print(f"DEBUG: Final notebook has {len(final_cells)} cells")
        return json.dumps(notebook, indent=2)


# Singleton instance
notebook_parser = NotebookParser()
