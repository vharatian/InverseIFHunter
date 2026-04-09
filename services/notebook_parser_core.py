"""
Notebook Parser Service — core parsing (load, parse, metadata).

Heading registry: notebook_headings.py
"""
import json
import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from models.schemas import NotebookCell, ParsedNotebook
from services.notebook_drive import load_notebook_content_from_url

logger = logging.getLogger(__name__)


class NotebookParserCore:
    """Parser for Colab/Jupyter notebook files (parse pipeline only)."""

    # Heading pattern: **[heading_name]**
    HEADING_PATTERN = re.compile(r'\*\*\[([^\]]+)\]\*\*')

    # Known cell types
    METADATA_HEADINGS = {'prompt', 'response', 'model_reasoning', 'response_reference',
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
        """Load notebook from a URL using service account (no public sharing needed)."""
        content = await load_notebook_content_from_url(url)
        filename = url.split('/')[-1]
        if not filename.endswith('.ipynb'):
            filename = 'notebook.ipynb'
        return self.parse(content, filename=filename), content

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
        
        # Colab "Save to Colab" format: [Turn-1: Prompt], [Turn-1: Ideal Response], [Turn-1: Criteria], [Turn-1: Judge System Prompt]
        # heading is already lowercased, e.g. "turn-1: prompt", "turn-1: ideal response"
        turn_heading_match = re.match(r'^turn-\d+:\s*(.+)$', heading)
        if turn_heading_match:
            section = turn_heading_match.group(1).strip().lower()
            section = re.sub(r'[\s_]+', ' ', section)
            if section == 'prompt' and not result.prompt:
                result.prompt = content
                logger.debug("Parsed Turn-N: Prompt -> prompt")
                return
            if section == 'ideal response' and not result.response:
                result.response = content
                logger.debug("Parsed Turn-N: Ideal Response -> response")
                return
            if section == 'criteria' and not result.response_reference:
                result.response_reference = content
                logger.debug("Parsed Turn-N: Criteria -> response_reference")
                return
            if section == 'judge system prompt' and not result.judge_system_prompt:
                result.judge_system_prompt = content
                logger.debug("Parsed Turn-N: Judge System Prompt -> judge_system_prompt")
                return
            if section in ('model reasoning', 'model_reasoning') and not result.model_reasoning:
                result.model_reasoning = content
                logger.debug("Parsed Turn-N: Model Reasoning -> model_reasoning")
                return
            if section == 'judge_prompt_template' or section == 'judge prompt template':
                result.judge_prompt_template = content
                logger.debug("Parsed Turn-N: judge_prompt_template")
                return
            # Other Turn-N sections (e.g. Number of Attempts Made, Selected Response) are not testbed fields; fall through
        
        # Standard fields (**[prompt]**, **[response_reference]**, etc.)
        # Use first occurrence only (don't overwrite if already set)
        # This ensures we get the original content, not later edits
        if heading == 'prompt':
            if not result.prompt:  # Only set if not already set
                result.prompt = content
        elif heading == 'response':
            if not result.response:  # Only set if not already set
                result.response = content
        elif heading == 'model_reasoning':
            if not result.model_reasoning:
                result.model_reasoning = content
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
