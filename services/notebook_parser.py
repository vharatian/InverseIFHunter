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
    
    def __init__(self):
        self.notebook_data: Optional[Dict[str, Any]] = None
    
    async def load_from_url(self, url: str) -> Tuple[ParsedNotebook, str]:
        """Load notebook from a URL.
        
        Supports:
        - Direct .ipynb file URLs
        - Google Colab URLs (using Colab's internal download API)
        - GitHub raw URLs
        """
        file_id = self._extract_drive_file_id(url)
        
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
            content = None
            
            # If it's a Colab/Drive URL, try multiple download methods
            if file_id:
                download_methods = [
                    # Method 1: Colab's internal download API (best for Colab notebooks)
                    f"https://colab.research.google.com/drive/{file_id}#download",
                    # Method 2: Direct Colab download endpoint
                    f"https://colab.research.google.com/download/ipynb?fileId={file_id}",
                    # Method 3: Google Drive export with confirm
                    f"https://drive.google.com/uc?export=download&confirm=1&id={file_id}",
                    # Method 4: Google Drive usercontent
                    f"https://drive.usercontent.google.com/download?id={file_id}&export=download&confirm=t",
                    # Method 5: Alternative Drive API
                    f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media&key=AIzaSyC1qbk75NzWBvSaDh6KnsjjA9pIrP4lYIE",
                ]
                
                for method_url in download_methods:
                    try:
                        response = await client.get(method_url, headers={
                            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
                        })
                        
                        if response.status_code == 200:
                            test_content = response.text
                            # Check if it's valid JSON notebook
                            if test_content.strip().startswith('{') and '"cells"' in test_content:
                                content = test_content
                                break
                    except Exception:
                        continue
                
                if not content:
                    # Last resort: Try with cookies simulation
                    raise ValueError(
                        f"Could not download notebook (File ID: {file_id}). "
                        "This usually means the notebook is not shared publicly. "
                        "In Colab, click Share → Change 'Restricted' to 'Anyone with the link' → Copy link and try again."
                    )
            else:
                # Direct URL (GitHub, raw URLs, etc.)
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
        """Validate response_reference is valid JSON with expected structure."""
        errors = []
        
        if not response_reference or not response_reference.strip():
            errors.append("response_reference is missing or empty")
            return errors
        
        # Try to parse as JSON
        try:
            data = json.loads(response_reference.strip())
        except json.JSONDecodeError as e:
            # If it doesn't look like JSON (doesn't start with {), treat as plain text and allow it
            stripped = response_reference.strip()
            if not stripped.startswith('{'):
                # It's likely just plain text instructions, which is allowed
                return []
            
            # If it starts with {, it was intended as JSON but is invalid
            snippet = stripped[:20] + "..." if len(stripped) > 20 else stripped
            errors.append(f"response_reference appears to be invalid JSON. Error: {e}. Content: '{snippet}'")
            return errors
        
        # Check for expected structure - should be a dict with criteria
        if not isinstance(data, dict):
            errors.append("response_reference should be a JSON object (dict), not " + type(data).__name__)
            return errors
        
        # Check for criteria fields (C1, C2, etc. or descriptive keys)
        if len(data) == 0:
            errors.append("response_reference appears to be empty - should contain scoring criteria")
        
        # Validate each criterion has expected fields
        for key, value in data.items():
            if isinstance(value, dict):
                # Check for common expected fields
                if 'description' not in value and 'criteria' not in value and 'pass' not in value.get('', '').lower():
                    # Allow flexible structure but log warning
                    pass
            elif not isinstance(value, (str, int, float, bool)):
                errors.append(f"Criterion '{key}' has unexpected value type: {type(value).__name__}")
        
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
        if heading == 'prompt':
            result.prompt = content
        elif heading == 'response':
            result.response = content
        elif heading == 'response_reference':
            result.response_reference = content
        elif heading == 'judge_prompt_template':
            result.judge_prompt_template = content
        elif heading == 'judge_system_prompt':
            result.judge_system_prompt = content
        elif heading == 'number_of_attempts_made':
            try:
                result.attempts_made = int(re.search(r'\d+', content).group())
            except (AttributeError, ValueError):
                result.attempts_made = 0
        
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
        """Parse metadata section into key-value pairs."""
        metadata = {}
        lines = content.split('\n')
        
        for line in lines:
            # Match pattern: **Key:** - Value or **Key:** Value
            match = re.match(r'\*\*([^*]+)\*\*:?\s*-?\s*(.+)?', line.strip())
            if match:
                key = match.group(1).strip()
                value = match.group(2).strip() if match.group(2) else ''
                if key and value:
                    metadata[key] = value
        
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
        human_reviews: Dict[str, Any] = None
    ) -> str:
        """
        Export modified notebook with hunt results.
        
        Args:
            original_content: Original notebook JSON string
            parsed: Parsed notebook data
            results: List of hunt results to add
            include_reasoning: Whether to append reasoning traces
            human_reviews: Dict of human reviews keyed by hunt_id
        
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
                heading = match.group(1).lower()
                
                # Update model response slots (qwen_1, qwen_2, etc.)
                model_match = self.MODEL_PATTERN.match(heading)
                if model_match:
                    slot_num = int(model_match.group(2))
                    if slot_num in slot_to_result:
                        result = slot_to_result[slot_num]
                        new_content = f"**[{heading}]**\n\n{result.get('response', '')}"
                        cell['source'] = [new_content]
                        updated_slots.add(f"model_{slot_num}")
                
                # Update LLM judge slots
                judge_match = self.LLM_JUDGE_PATTERN.match(heading)
                if judge_match:
                    slot_num = int(judge_match.group(1))
                    if slot_num in slot_to_result:
                        result = slot_to_result[slot_num]
                        new_content = f"**[{heading}]**\n\n{result.get('judge_output', '')}"
                        cell['source'] = [new_content]
                        updated_slots.add(f"judge_{slot_num}")
                
                # Update human judge slots
                human_match = self.HUMAN_JUDGE_PATTERN.match(heading) if hasattr(self, 'HUMAN_JUDGE_PATTERN') else re.match(r'human_judge_(\d+)', heading)
                if human_match:
                    slot_num = int(human_match.group(1))
                    if slot_num in huntid_to_review:
                        review = huntid_to_review[slot_num]
                        judgment = review.get('judgment', 'unknown').upper()
                        notes = review.get('notes', '')
                        human_content = f"**Judgment:** {judgment}\n\n**Notes:** {notes}" if notes else f"**Judgment:** {judgment}"
                        new_content = f"**[{heading}]**\n\n{human_content}"
                        cell['source'] = [new_content]
                        updated_slots.add(f"human_{slot_num}")
                
                # Update attempts counter
                if heading == 'number_of_attempts_made':
                    new_attempts = parsed.attempts_made + len(results)
                    cell['source'] = [f"**[number_of_attempts_made]**:\n\n{new_attempts}"]
        
        # Add new cells for results that don't have slots
        new_cells = []
        for result in results:
            slot_num = result.get('hunt_id')
            
            # Add model response if not updated
            if f"model_{slot_num}" not in updated_slots:
                new_cells.append({
                    "cell_type": "markdown",
                    "id": f"auto_model_{slot_num}",
                    "metadata": {},
                    "source": [f"**[{model_prefix}_{slot_num}]**\n\n{result.get('response', '')}"]
                })
            
            # Add judge output if not updated
            if f"judge_{slot_num}" not in updated_slots:
                new_cells.append({
                    "cell_type": "markdown",
                    "id": f"auto_judge_{slot_num}",
                    "metadata": {},
                    "source": [f"**[llm_judge_{slot_num}]**\n\n{result.get('judge_output', '')}"]
                })
        
        # Add reasoning traces at the end if requested
        if include_reasoning:
            reasoning_content = ["**[reasoning_traces]**\n\n"]
            for result in results:
                if result.get('reasoning_trace'):
                    reasoning_content.append(f"### Hunt {result.get('hunt_id')} - {result.get('model', 'unknown')}\n\n")
                    reasoning_content.append(f"```\n{result.get('reasoning_trace')}\n```\n\n")
            
            if len(reasoning_content) > 1:
                new_cells.append({
                    "cell_type": "markdown",
                    "id": "auto_reasoning_traces",
                    "metadata": {},
                    "source": reasoning_content
                })
        
        # Insert new cells before the last cell or at the end
        if new_cells:
            cells.extend(new_cells)
        
        notebook['cells'] = cells
        return json.dumps(notebook, indent=2)


# Singleton instance
notebook_parser = NotebookParser()
