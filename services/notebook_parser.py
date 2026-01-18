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
                         'number_of_attempts_made', 'total_hunts_ran'}
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
        
        model_prefix = self.get_model_slot_prefix(parsed)
        
        # Build a mapping from slot number (1-4) to result and review
        slot_to_result = {}
        for i, result in enumerate(results[:4]):  # Max 4 slots
            slot_num = i + 1
            slot_to_result[slot_num] = result
        
        # Build mapping from slot number to human review
        huntid_to_review = {}
        print(f"DEBUG: human_reviews received: {human_reviews}")
        for hunt_id_str, review in human_reviews.items():
            slot_num = review.get('slotNum')
            if slot_num is not None:
                huntid_to_review[int(slot_num)] = review
                print(f"DEBUG: Slot {slot_num} has review: {review.get('judgment')}, notes: {review.get('notes', '')[:30]}...")
        
        # Update existing cells and track which slots we've updated
        updated_slots = set()
        
        for cell in cells:
            source = cell.get('source', [])
            if isinstance(source, list):
                content = ''.join(source)
            else:
                content = str(source)
            
            match = self.HEADING_PATTERN.search(content)
            if match:
                heading_lower = match.group(1).lower()  # For matching
                heading_original = match.group(1)  # Preserve original case for writing
                
                # PRESERVE original response_reference and judge_system_prompt - DO NOT OVERWRITE
                if heading_lower == 'response_reference' or heading_lower == 'judge_system_prompt':
                    # Keep original content intact - these should never be modified
                    continue
                
                # Update model response slots (qwen_1, qwen_2, etc.)
                model_match = self.MODEL_PATTERN.match(heading_lower)
                if model_match:
                    slot_num = int(model_match.group(2))
                    if slot_num in slot_to_result:
                        result = slot_to_result[slot_num]
                        new_content = f"**[{heading_original}]**\n\n{result.get('response', '')}"
                        # Reasoning trace will be saved in separate cell
                        cell['source'] = [new_content]
                        updated_slots.add(f"model_{slot_num}")
                        print(f"DEBUG: Updated model_{slot_num} cell with response")
                
                # Update LLM judge slots
                judge_match = self.LLM_JUDGE_PATTERN.match(heading_lower)
                if judge_match:
                    slot_num = int(judge_match.group(1))
                    if slot_num in slot_to_result:
                        result = slot_to_result[slot_num]
                        
                        # Format LLM judge output in required format
                        # Try judge_score first, then fall back to score for backward compatibility
                        judge_criteria = result.get('judge_criteria', {})
                        judge_score = result.get('judge_score') or result.get('score', 0)
                        judge_explanation = result.get('judge_explanation', '')
                        judge_output_raw = result.get('judge_output', '')
                        
                        # If judge_criteria is empty, try to parse from judge_output
                        if not judge_criteria and judge_output_raw:
                            # Try to extract criteria from raw output
                            import json as json_module
                            try:
                                # Look for JSON in the output
                                json_match = re.search(r'\{[^{}]*"criteria"[^{}]*\}', judge_output_raw, re.DOTALL)
                                if json_match:
                                    parsed = json_module.loads(json_match.group(0))
                                    judge_criteria = parsed.get('criteria', {})
                            except:
                                pass
                        
                        # Format grading basis as JSON (must have at least empty dict)
                        if not judge_criteria:
                            judge_criteria = {}
                        grading_json = json.dumps({k: v.upper() for k, v in judge_criteria.items()}, indent=2)
                        
                        # Format explanation with bullet points if it contains criteria
                        formatted_explanation = judge_explanation or judge_output_raw or "No explanation provided"
                        if formatted_explanation and not formatted_explanation.strip().startswith('•'):
                            # Try to format explanation with bullet points for each criterion
                            lines = formatted_explanation.split('\n')
                            formatted_lines = []
                            for line in lines:
                                line = line.strip()
                                if line:
                                    # Check if line mentions a criterion (C1, C2, etc.)
                                    criterion_match = re.search(r'\b(C\d+)\s+(PASS|FAIL|pass|fail)', line, re.IGNORECASE)
                                    if criterion_match:
                                        criterion_id = criterion_match.group(1)
                                        status = criterion_match.group(2).upper()
                                        # Format as bullet point
                                        formatted_lines.append(f"• {criterion_id} {status}: {line}")
                                    else:
                                        formatted_lines.append(f"• {line}")
                            if formatted_lines:
                                formatted_explanation = '\n'.join(formatted_lines)
                        
                        llm_content = f"""[Grading Basis]:

{grading_json}

[Score]: {judge_score} point(s)

[JSON]: {{"answer_score": {judge_score}}}

[Explanation]:

{formatted_explanation}"""
                        
                        new_content = f"**[{heading_original}]**\n\n{llm_content}"
                        cell['source'] = [new_content]
                        updated_slots.add(f"judge_{slot_num}")
                        print(f"DEBUG: Updated judge_{slot_num} cell with formatted output")
                
                # Update human judge slots
                human_match = self.HUMAN_JUDGE_PATTERN.match(heading_lower) if hasattr(self, 'HUMAN_JUDGE_PATTERN') else re.match(r'human_judge_(\d+)', heading_lower)
                if human_match:
                    slot_num = int(human_match.group(1))
                    if slot_num in huntid_to_review:
                        review = huntid_to_review[slot_num]
                        judgment = review.get('judgment', 'unknown').upper()
                        
                        # Format grading basis as JSON
                        grading_basis = review.get('grading_basis', {})
                        if grading_basis:
                            grading_json = json.dumps({k: v.upper() for k, v in grading_basis.items()}, indent=2)
                        else:
                            grading_json = "{}"
                        
                        # Calculate score (count PASS criteria)
                        pass_count = sum(1 for v in grading_basis.values() if v.upper() == 'PASS')
                        score = 1 if pass_count > len(grading_basis) / 2 else 0
                        
                        # Get explanation
                        explanation = review.get('explanation', '') or review.get('notes', '')
                        
                        # Build human content in required format
                        human_content = f"""[Grading Basis]:

{grading_json}

[Score]: {score} point(s)

[JSON]: {{"answer_score": {score}}}

[Explanation]:

{explanation}"""
                        new_content = f"**[{heading_original}]**\n\n{human_content}"
                        cell['source'] = [new_content]
                        updated_slots.add(f"human_{slot_num}")
                        print(f"DEBUG: Updated human_{slot_num} cell with judgment={judgment}")
                
                # Update reasoning trace slots (ensure all 4 are saved, even if empty)
                reasoning_match = self.REASONING_TRACE_PATTERN.match(heading_lower)
                if reasoning_match:
                    slot_num = int(reasoning_match.group(1))
                    if slot_num in slot_to_result:
                        result = slot_to_result[slot_num]
                        # Update even if empty to ensure cell exists
                        cell['source'] = [f"**[reasoning_trace_{slot_num}]**\n\n{result.get('reasoning_trace', '')}"]
                        updated_slots.add(f"reasoning_{slot_num}")
                        print(f"DEBUG: Updated reasoning_trace_{slot_num} cell")
                
                # Update attempts counter
                if heading_lower == 'number_of_attempts_made':
                    new_attempts = parsed.attempts_made + len(results)
                    # Clamp attempts to valid range: min 1, max 8
                    new_attempts = max(1, min(8, new_attempts))
                    # Preserve original heading format
                    attempts_heading = heading_original if 'number_of_attempts_made' in heading_lower else 'number_of_attempts_made'
                    cell['source'] = [f"**[{attempts_heading}]**:\n\n{new_attempts}"]
                    updated_slots.add('number_of_attempts_made')
                    print(f"DEBUG: Updated existing attempts cell to {new_attempts}")
                
                # Update total hunts ran
                if heading_lower == 'total_hunts_ran':
                    # Preserve original heading format
                    hunts_heading = heading_original if 'total_hunts_ran' in heading_lower else 'total_hunts_ran'
                    cell['source'] = [f"**[{hunts_heading}]**:\n\n{total_hunts_ran}"]
                    updated_slots.add('total_hunts_ran')
                    print(f"DEBUG: Updated existing total_hunts_ran cell to {total_hunts_ran}")
        
        # Add new cells for results that don't have slots
        # Ensure ALL 4 slots are created (even if we have fewer results)
        new_cells = []
        max_slots = max(4, len(results))  # Always create at least 4 slots
        
        for slot_num in range(1, max_slots + 1):
            # Get result for this slot if it exists
            slot_result = None
            if slot_num <= len(results):
                slot_result = results[slot_num - 1]  # 0-indexed
            # Also check slot_to_result mapping
            if not slot_result and slot_num in slot_to_result:
                slot_result = slot_to_result[slot_num]
            
            # Add model response if not updated
            if f"model_{slot_num}" not in updated_slots:
                model_content = f"**[{model_prefix}_{slot_num}]**\n\n{slot_result.get('response', '') if slot_result else ''}"
                # Reasoning trace will be saved in separate cell
                new_cells.append({
                    "cell_type": "markdown",
                    "id": f"auto_model_{slot_num}",
                    "metadata": {},
                    "source": [model_content]
                })
            
            # Add LLM judge if not updated - ALWAYS create for all 4 slots, even if data is missing
            if f"judge_{slot_num}" not in updated_slots:
                # Use slot_result or empty dict
                judge_result = slot_result or {}
                
                # Format LLM judge output in required format
                # Try judge_score first, then fall back to score for backward compatibility
                judge_criteria = judge_result.get('judge_criteria', {})
                judge_score = judge_result.get('judge_score') or judge_result.get('score', 0)
                judge_explanation = judge_result.get('judge_explanation', '')
                judge_output_raw = judge_result.get('judge_output', '')
                
                # If judge_criteria is empty, try to parse from judge_output
                if not judge_criteria and judge_output_raw:
                    # Try to extract criteria from raw output
                    try:
                        # Look for JSON in the output
                        json_match = re.search(r'\{[^{}]*"criteria"[^{}]*\}', judge_output_raw, re.DOTALL)
                        if json_match:
                            parsed = json.loads(json_match.group(0))
                            judge_criteria = parsed.get('criteria', {})
                    except:
                        pass
                
                # Format grading basis as JSON (must have at least empty dict)
                if not judge_criteria:
                    judge_criteria = {}
                grading_json = json.dumps({k: v.upper() for k, v in judge_criteria.items()}, indent=2)
                
                # Format explanation with bullet points
                formatted_explanation = judge_explanation or judge_output_raw or "No explanation provided"
                if formatted_explanation and not formatted_explanation.strip().startswith('•'):
                    lines = formatted_explanation.split('\n')
                    formatted_lines = []
                    for line in lines:
                        line = line.strip()
                        if line:
                            criterion_match = re.search(r'\b(C\d+)\s+(PASS|FAIL|pass|fail)', line, re.IGNORECASE)
                            if criterion_match:
                                criterion_id = criterion_match.group(1)
                                status = criterion_match.group(2).upper()
                                formatted_lines.append(f"• {criterion_id} {status}: {line}")
                            else:
                                formatted_lines.append(f"• {line}")
                    if formatted_lines:
                        formatted_explanation = '\n'.join(formatted_lines)
                
                llm_content = f"""[Grading Basis]:

{grading_json}

[Score]: {judge_score} point(s)

[JSON]: {{"answer_score": {judge_score}}}

[Explanation]:

{formatted_explanation}"""
                
                new_cells.append({
                    "cell_type": "markdown",
                    "id": f"auto_llm_judge_{slot_num}",
                    "metadata": {},
                    "source": [f"**[llm_judge_{slot_num}]**\n\n{llm_content}"]
                })
                print(f"DEBUG: Added LLM judge cell for slot {slot_num}")
            
            # Add human judge if not updated - ALWAYS create for all 4 slots, even if review is missing
            if f"human_{slot_num}" not in updated_slots:
                review = huntid_to_review.get(slot_num, {})  # Get review or empty dict if missing
                judgment = review.get('judgment', 'unknown').upper() if review else 'unknown'
                
                # Format grading basis as JSON
                grading_basis = review.get('grading_basis', {}) if review else {}
                if grading_basis:
                    # Create JSON format for grading
                    grading_json = json.dumps({k: v.upper() for k, v in grading_basis.items()}, indent=2)
                else:
                    grading_json = "{}"
                
                # Calculate score (FAIL = 0, PASS = 1 per criterion)
                pass_count = sum(1 for v in grading_basis.values() if v.upper() == 'PASS')
                total_criteria = len(grading_basis) if grading_basis else 4
                score = 1 if pass_count > total_criteria / 2 else 0
                
                # Get explanation
                explanation = review.get('explanation', '') or review.get('notes', '') if review else ''
                
                # Build human content in required format
                human_content = f"""[Grading Basis]:

{grading_json}

[Score]: {score} point(s)

[JSON]: {{"answer_score": {score}}}

[Explanation]:

{explanation}"""
                    
                new_cells.append({
                    "cell_type": "markdown",
                    "id": f"auto_human_{slot_num}",
                    "metadata": {},
                    "source": [f"**[human_judge_{slot_num}]**\n\n{human_content}"]
                })
                print(f"DEBUG: Added human judge cell for slot {slot_num}")
        
        # Remove any combined reasoning_traces cells (we only want individual cells)
        cells = [cell for cell in cells if not (
            isinstance(cell.get('source'), list) and 
            any('**[reasoning_traces]**' in str(s).lower() for s in cell.get('source', []))
        )]
        
        # Add reasoning traces as separate cells (reasoning_trace_1, reasoning_trace_2, etc.)
        # Ensure ALL 4 reasoning traces are saved, even if some are empty
        if include_reasoning:
            for i, result in enumerate(results):
                slot_num = i + 1
                reasoning_trace = result.get('reasoning_trace', '')
                
                # Skip if already updated in the main loop above
                if f"reasoning_{slot_num}" in updated_slots:
                    continue
                
                # Check if reasoning_trace cell already exists (but wasn't updated)
                reasoning_heading = f"reasoning_trace_{slot_num}"
                reasoning_exists = False
                for cell in cells:
                    source = cell.get('source', [])
                    if isinstance(source, list):
                        content = ''.join(source)
                    else:
                        content = str(source)
                        match = self.HEADING_PATTERN.search(content)
                        if match and match.group(1).lower() == reasoning_heading:
                            # Update existing reasoning trace cell (even if empty)
                            # Preserve original heading format
                            original_heading = match.group(1)
                            cell['source'] = [f"**[{original_heading}]**\n\n{reasoning_trace}"]
                            reasoning_exists = True
                            updated_slots.add(f"reasoning_{slot_num}")
                            print(f"DEBUG: Updated existing reasoning_trace_{slot_num} cell")
                            break
                
                if not reasoning_exists:
                    # Add new reasoning trace cell (even if empty, to ensure all 4 are present)
                    new_cells.append({
                        "cell_type": "markdown",
                        "id": f"auto_reasoning_trace_{slot_num}",
                        "metadata": {},
                        "source": [f"**[reasoning_trace_{slot_num}]**\n\n{reasoning_trace}"]
                    })
                    updated_slots.add(f"reasoning_{slot_num}")
                    print(f"DEBUG: Added new reasoning_trace_{slot_num} cell")
        
        # Find insertion point: after the last slot's human_judge cell, or at the end
        print(f"DEBUG: Updated slots: {updated_slots}")
        print(f"DEBUG: Adding {len(new_cells)} new cells")
        
        # Find the last position where a slot cell exists (model, llm_judge, or human_judge)
        # We want to insert new cells right after the last slot's human_judge
        insertion_index = len(cells)  # Default: append at end
        
        # Search backwards to find the last human_judge cell
        for i in range(len(cells) - 1, -1, -1):
            cell = cells[i]
            source = cell.get('source', [])
            if isinstance(source, list):
                content = ''.join(source)
            else:
                content = str(source)
            
            match = self.HEADING_PATTERN.search(content)
            if match:
                heading_lower = match.group(1).lower()
                # Check if this is a human_judge cell (last cell in a slot's group)
                if self.HUMAN_JUDGE_PATTERN.match(heading_lower):
                    insertion_index = i + 1  # Insert after this cell
                    print(f"DEBUG: Found insertion point after human_judge cell at index {i}")
                    break
                # Also check for model or llm_judge cells (in case human_judge is missing)
                elif self.MODEL_PATTERN.match(heading_lower) or self.LLM_JUDGE_PATTERN.match(heading_lower):
                    # If we haven't found a human_judge yet, use this as insertion point
                    if insertion_index == len(cells):
                        insertion_index = i + 1
                        print(f"DEBUG: Found insertion point after model/llm_judge cell at index {i}")
        
        # Separate slot cells from metadata cells (attempts, total_hunts_ran)
        slot_cells = []  # Model, LLM judge, human judge cells (in order per slot)
        metadata_cells = []  # Attempts, total_hunts_ran cells
        
        for cell in new_cells:
            source = cell.get('source', [])
            if isinstance(source, list):
                content = ''.join(source)
            else:
                content = str(source)
            
            # Check if this is a metadata cell
            if 'number_of_attempts_made' in content or 'total_hunts_ran' in content:
                metadata_cells.append(cell)
            else:
                slot_cells.append(cell)
        
        # Insert slot cells at the correct position (maintaining order: model -> llm_judge -> human_judge per slot)
        if slot_cells:
            cells[insertion_index:insertion_index] = slot_cells
            print(f"DEBUG: Inserted {len(slot_cells)} slot cells at index {insertion_index}")
        
        # Check if attempts cell was updated (found in notebook)
        attempts_cell_found = 'number_of_attempts_made' in updated_slots
        if not attempts_cell_found:
            # Create attempts cell if it doesn't exist
            new_attempts = parsed.attempts_made + len(results)
            # Clamp attempts to valid range: min 1, max 8
            new_attempts = max(1, min(8, new_attempts))
            metadata_cells.append({
                "cell_type": "markdown",
                "id": "auto_attempts_counter",
                "metadata": {},
                "source": [f"**[number_of_attempts_made]**:\n\n{new_attempts}"]
            })
            print(f"DEBUG: Created new attempts cell with count={new_attempts}")
        
        # Add total_hunts_ran cell if it doesn't exist or wasn't updated
        if 'total_hunts_ran' not in updated_slots:
            metadata_cells.append({
                "cell_type": "markdown",
                "id": "auto_total_hunts_ran",
                "metadata": {},
                "source": [f"**[total_hunts_ran]**:\n\n{total_hunts_ran}"]
            })
            print(f"DEBUG: Created total_hunts_ran cell with count={total_hunts_ran}")
        
        # Append metadata cells at the end
        if metadata_cells:
            cells.extend(metadata_cells)
            print(f"DEBUG: Appended {len(metadata_cells)} metadata cells at the end")
        
        notebook['cells'] = cells
        print(f"DEBUG: Final notebook has {len(cells)} cells")
        return json.dumps(notebook, indent=2)


# Singleton instance
notebook_parser = NotebookParser()
