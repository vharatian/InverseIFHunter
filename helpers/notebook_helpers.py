"""
Notebook Cell Helpers

Constants and utility functions for manipulating Jupyter notebook cell structures.
"""
import re
from typing import List
from models.schemas import HuntSession


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


# ============== Turn-Aware Heading Helpers ==============

def _get_turn_heading(cell_type: str, turn: int) -> str:
    """
    Get the cell heading for a specific turn.
    Turn 1 uses original headings: **[prompt]**
    Turn 2+ uses turn-specific headings: **[Turn 2 - prompt]**
    """
    base = HEADING_MAP.get(cell_type, f"**[{cell_type}]**")
    if turn <= 1:
        return base
    # e.g. **[Turn 2 - prompt]**
    inner = base.strip("*[]")  # "prompt"
    return f"**[Turn {turn} - {inner}]**"


def _normalize_heading_line(line: str) -> str:
    """Normalize a heading line for comparison: strip markdown and punctuation, lowercase."""
    if not line:
        return ""
    return re.sub(r"[\s_\W]+", "", line.lower())


def _cell_first_line_matches_type(source: str, cell_type: str, turn: int) -> bool:
    """
    Return True if the cell's first line looks like the given cell type heading.
    Handles variants like "## Prompt", "[prompt]", "**[prompt]**", "### response reference".
    """
    first_line = (source.split("\n")[0] or "").strip()
    normalized = _normalize_heading_line(first_line)
    # Turn 1: match canonical key e.g. "prompt", "responsereference"
    key = cell_type.replace("_", "")
    if turn <= 1:
        return normalized == key
    # Turn 2+: match "turn2prompt" or "turn 2 prompt" style
    turn_prefix = f"turn{turn}"
    return normalized.startswith(turn_prefix) and key in normalized


def _find_or_create_turn_cell(notebook_data: dict, cell_type: str, content: str, turn: int) -> bool:
    """
    Find an existing turn-specific cell and update it, or create a new one.
    For Turn 1, updates the original cell. For Turn 2+, creates/updates turn-specific cells.
    Matches both canonical headings (e.g. **[prompt]**) and variants (e.g. ## Prompt, [prompt]).
    Returns True if the notebook_data was modified.
    """
    heading = _get_turn_heading(cell_type, turn)
    heading_lower = heading.lower()

    for cell in notebook_data.get("cells", []):
        if cell.get("cell_type") != "markdown":
            continue
        source = "".join(cell.get("source", []))
        source_lower = source.lower()
        # Match canonical heading first
        if heading_lower in source_lower:
            _update_cell_source(cell, source, heading, content)
            return True
        # Turn 1 only: match alternative heading formats so we overwrite in place
        if turn <= 1 and _cell_first_line_matches_type(source, cell_type, turn):
            heading_line = source.split("\n")[0]
            _update_cell_source(cell, source, heading_line, content)
            return True

    # Cell not found — create it
    if "cells" not in notebook_data:
        notebook_data["cells"] = []
    new_cell = _create_notebook_cell(heading, content)
    notebook_data["cells"].append(new_cell)
    return True


def _update_cell_source(cell: dict, source: str, heading_line: str, content: str) -> None:
    """Set cell source to heading_line + content, preserving notebook line format."""
    full_content = heading_line + "\n\n" + content
    content_lines = full_content.split("\n")
    cell["source"] = (
        [line + "\n" for line in content_lines[:-1]] + [content_lines[-1]]
        if content_lines
        else [""]
    )


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
