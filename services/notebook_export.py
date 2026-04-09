"""Notebook export (single- and multi-turn) — mixin for NotebookParser."""
import json
import logging
import re
from typing import Any, Dict, List, Optional

from models.schemas import ParsedNotebook

logger = logging.getLogger(__name__)


class NotebookExportMixin:
    """Export parsed notebooks with hunt results back to .ipynb JSON."""

    def _merge_alignment_metadata(self, notebook: Dict[str, Any], alignment: Optional[Dict[str, Any]]) -> None:
        """Attach alignment export payload under notebook.metadata.model_hunter.alignment."""
        if alignment is None:
            return
        if not isinstance(notebook.get("metadata"), dict):
            notebook["metadata"] = {}
        mh = notebook["metadata"].setdefault("model_hunter", {})
        mh["alignment"] = alignment

    def export_notebook(
        self, 
        original_content: str,
        parsed: ParsedNotebook,
        results: List[Dict[str, Any]],
        include_reasoning: bool = True,
        human_reviews: Dict[str, Any] = None,
        total_hunts_ran: int = 0,
        alignment: Optional[Dict[str, Any]] = None,
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
                review_copy = {
                    'judgment': review.get('judgment'),
                    'grading_basis': dict(review.get('grading_basis', {})),
                    'explanation': review.get('explanation'),
                    'slotNum': review.get('slotNum'),
                    'timestamp': review.get('timestamp')
                }
                slot_to_review[slot_num] = review_copy
                if ':' in key_str:
                    hunt_id = int(key_str.split(':')[0]) if key_str.split(':')[0].isdigit() else None
                else:
                    hunt_id = int(key_str) if key_str.isdigit() else None
                logger.debug("Mapped review for key %s (hunt_id %s) -> slot %d (from review.slotNum)", key_str, hunt_id, slot_num)
                logger.debug("Review judgment: %s, explanation preview: %s", review_copy.get('judgment'), review_copy.get('explanation', '')[:50])
            else:
                logger.warning("Review for key %s missing slotNum field", key_str)
    
        # Build slot_to_result mapping using array index (results order determines slots 1-4)
        # Frontend sends results in the exact order they should appear in slots
        num_results = len(results)
        slot_to_result = {}
        logger.debug("Building slot_to_result using array index (order preserved from frontend)")
        for idx, result in enumerate(results, start=1):
            slot_to_result[idx] = result
            logger.debug("Mapped slot %d -> hunt_id %s (by array index)", idx, result.get('hunt_id'))
    
        logger.debug("Final slot_to_review mapping: slots %s", list(slot_to_review.keys()))
        for slot_num, review in slot_to_review.items():
            result_hunt_id = int(slot_to_result.get(slot_num, {}).get('hunt_id', 0)) if slot_num in slot_to_result else None
            logger.debug("Slot %d: judgment=%s, result hunt_id=%s, review explanation preview=%s", slot_num, review.get('judgment'), result_hunt_id, review.get('explanation', '')[:50])
    
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
        
            # Calculate score based on 50% rule: if MORE than 50% criteria are PASS, overall is PASS (score 1)
            # If 50% or less pass, it's FAIL (score 0, breaking) - matches LLM judge logic
            total_criteria = len(grading_basis)
            pass_count = sum(1 for v in grading_basis.values() if str(v).upper() == 'PASS')
            score = 1 if pass_count > total_criteria / 2 else 0
        
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
                    # Use correct model prefix from results, not original heading
                    correct_heading = f"{model_prefix_capitalized}_{slot_num}"
                    cell['source'] = [f"**[{correct_heading}]**\n\n{response_text}"]
                    updated_slots.add(f"model_{slot_num}")
                    slot_cells_dict[(slot_num, 'model')] = cell
                    logger.debug("Updated model_%d cell with heading %s", slot_num, correct_heading)
            
                elif cell_type == 'llm_judge':
                    result = slot_to_result.get(slot_num)
                    if not result and slot_num <= len(results):
                        result = results[slot_num - 1]
                    llm_content = format_llm_judge_content(result)
                    cell['source'] = [f"**[{heading_original}]**\n\n{llm_content}"]
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
                    cell['source'] = [f"**[{heading_original}]**\n\n{human_content}"]
                    updated_slots.add(f"human_{slot_num}")
                    slot_cells_dict[(slot_num, 'human_judge')] = cell
                    logger.debug("Updated human_judge_%d cell (review present: %s, has_grading_basis: %s)", slot_num, review is not None, bool(review.get('grading_basis') if review else False))
            
                elif cell_type == 'reasoning_trace':
                    if include_reasoning:
                        result = slot_to_result.get(slot_num)
                        if not result and slot_num <= len(results):
                            result = results[slot_num - 1]
                        reasoning_trace = result.get('reasoning_trace', '') if result else ''
                        cell['source'] = [f"**[{heading_original}]**\n\n{reasoning_trace}"]
                        updated_slots.add(f"reasoning_{slot_num}")
                        slot_cells_dict[(slot_num, 'reasoning_trace')] = cell
                        logger.debug("Updated reasoning_trace_%d cell", slot_num)
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
                    logger.debug("Updated number_of_attempts_made cell to %d (total completed hunts)", new_attempts)
                # Keep all non-slot cells in their original order (for now)
                non_slot_cells.append(cell)
    
        # Step 2: Create missing slot cells (variable count based on results)
        total_slots = max(num_results, len(slot_to_result)) if (num_results or slot_to_result) else 4
        for slot_num in range(1, total_slots + 1):
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
                logger.debug("Created model_%d cell", slot_num)
        
            # Create llm_judge cell if missing
            if (slot_num, 'llm_judge') not in slot_cells_dict:
                llm_content = format_llm_judge_content(slot_result)
                slot_cells_dict[(slot_num, 'llm_judge')] = {
                    "cell_type": "markdown",
                    "id": f"auto_llm_judge_{slot_num}",
                    "metadata": {},
                    "source": [f"**[llm_judge_{slot_num}]**\n\n{llm_content}"]
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
                    "source": [f"**[human_judge_{slot_num}]**\n\n{human_content}"]
                }
                logger.debug("Created human_judge_%d cell (review present: %s, has_grading_basis: %s)", slot_num, review is not None, bool(review.get('grading_basis') if review else False))
        
            # Create reasoning_trace cell if missing and include_reasoning is True
            if include_reasoning and (slot_num, 'reasoning_trace') not in slot_cells_dict:
                reasoning_trace = slot_result.get('reasoning_trace', '') if slot_result else ''
                slot_cells_dict[(slot_num, 'reasoning_trace')] = {
                    "cell_type": "markdown",
                    "id": f"auto_reasoning_trace_{slot_num}",
                    "metadata": {},
                    "source": [f"**[reasoning_trace_{slot_num}]**\n\n{reasoning_trace}"]
                }
                logger.debug("Created reasoning_trace_%d cell", slot_num)
    
        # Step 3: Build ordered slot cells list (model_1, llm_judge_1, human_judge_1, reasoning_trace_1, model_2, ...)
        ordered_slot_cells = []
        cell_type_order = ['model', 'llm_judge', 'human_judge', 'reasoning_trace']
        for slot_num in range(1, total_slots + 1):
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
            logger.debug("Created number_of_attempts_made cell with count=%d (total completed hunts)", new_attempts)
    
        notebook['cells'] = final_cells
        logger.debug("Final notebook has %d cells", len(final_cells))
        self._merge_alignment_metadata(notebook, alignment)
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
        alignment: Optional[Dict[str, Any]] = None,
    ) -> str:
        """
        Export multi-turn notebook with all turns' data.
    
        Non-breaking turns get: prompt_K, response_reference_K, selected_response_K, selected_judge_K
        Breaking turn gets: full 4-response treatment (same as single-turn)
        Turn 1 uses original field names (no _1 suffix) for backward compat.
    
        Args:
            original_content: Original notebook JSON string
            parsed: Parsed notebook data
            turns: List of TurnData dicts (all turns including breaking)
            breaking_turn_results: List of hunt results for the breaking turn
            include_reasoning: Whether to include reasoning traces
            human_reviews: Dict of human reviews for breaking turn
            total_hunts_ran: Total hunts across all turns
            conversation_history: Full conversation history
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
            # No turns data, fall back to single-turn export
            return self.export_notebook(
                original_content=original_content,
                parsed=parsed,
                results=breaking_turn_results,
                include_reasoning=include_reasoning,
                human_reviews=human_reviews,
                total_hunts_ran=total_hunts_ran,
                alignment=alignment,
            )
    
        total_turns = len(turns)
        breaking_turn_num = turns[-1].get('turn_number', total_turns) if turns else 1
    
        # If only 1 turn (single-turn case), use standard export for backward compat
        if total_turns == 1:
            return self.export_notebook(
                original_content=original_content,
                parsed=parsed,
                results=breaking_turn_results,
                include_reasoning=include_reasoning,
                human_reviews=human_reviews,
                total_hunts_ran=total_hunts_ran,
                alignment=alignment,
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
    
        # Step 2: Helper to create a markdown cell
        def make_cell(heading, content, cell_id=None):
            return {
                "cell_type": "markdown",
                "id": cell_id or f"auto_{heading.lower().replace(' ', '_')}",
                "metadata": {},
                "source": [f"**[{heading}]**\n\n{content}"]
            }
    
        # Step 3: Build multi-turn cells for non-breaking turns
        multi_turn_cells = []
    
        for turn in turns[:-1]:  # All turns except the last (breaking) one
            turn_num = turn.get('turn_number', 1)
            prompt = turn.get('prompt', '')
            criteria = turn.get('response_reference', '')
            selected = turn.get('selected_response', '')
            judge_result = turn.get('judge_result', {})
        
            if turn_num == 1:
                # Turn 1: Use original field names (backward compat — prompt, response_reference already exist)
                # Add selected response and judge for turn 1
                multi_turn_cells.append(make_cell(
                    'selected_response_1', selected, f'auto_selected_response_1'))
                if judge_result:
                    judge_text = self._format_turn_judge(judge_result)
                    multi_turn_cells.append(make_cell(
                        'selected_judge_1', judge_text, f'auto_selected_judge_1'))
            else:
                # Turn 2+: Use _K suffix
                multi_turn_cells.append(make_cell(
                    f'prompt_{turn_num}', prompt, f'auto_prompt_{turn_num}'))
                multi_turn_cells.append(make_cell(
                    f'response_reference_{turn_num}', criteria, f'auto_response_reference_{turn_num}'))
                multi_turn_cells.append(make_cell(
                    f'selected_response_{turn_num}', selected, f'auto_selected_response_{turn_num}'))
                if judge_result:
                    judge_text = self._format_turn_judge(judge_result)
                    multi_turn_cells.append(make_cell(
                        f'selected_judge_{turn_num}', judge_text, f'auto_selected_judge_{turn_num}'))
    
        # Step 4: Build breaking turn cells (full 4-response treatment)
        # Use the standard export logic but as cells
        breaking_turn = turns[-1]
        bt_num = breaking_turn.get('turn_number', total_turns)
        bt_prompt = breaking_turn.get('prompt', '')
        bt_criteria = breaking_turn.get('response_reference', '')
    
        # Breaking turn prompt and criteria
        if bt_num > 1:
            multi_turn_cells.append(make_cell(
                f'prompt_{bt_num}', bt_prompt, f'auto_prompt_{bt_num}'))
            multi_turn_cells.append(make_cell(
                f'response_reference_{bt_num}', bt_criteria, f'auto_response_reference_{bt_num}'))
    
        # Breaking turn: 4 model responses + judges + human reviews + reasoning
        # Determine model prefix
        model_prefix = "model"
        if breaking_turn_results:
            first_model = breaking_turn_results[0].get('model', '')
            if 'nemotron' in first_model.lower():
                model_prefix = 'nemotron'
            elif 'qwen' in first_model.lower():
                model_prefix = 'qwen'
        model_prefix_cap = model_prefix.capitalize()
    
        # Build slot_to_review mapping
        slot_to_review = {}
        for key_str, review in human_reviews.items():
            slot_num = review.get('slotNum')
            if slot_num is not None:
                slot_num = int(slot_num)
                slot_to_review[slot_num] = review
    
        num_slots = len(breaking_turn_results) if breaking_turn_results else 4
        for slot_num in range(1, num_slots + 1):
            result = breaking_turn_results[slot_num - 1] if slot_num <= len(breaking_turn_results) else None
        
            # Model response
            response_text = result.get('response', '') if result else ''
            multi_turn_cells.append(make_cell(
                f'{model_prefix_cap}_{slot_num}', response_text, f'auto_bt_model_{slot_num}'))
        
            # LLM judge
            if result:
                judge_criteria = result.get('judge_criteria', {})
                judge_score = result.get('judge_score', result.get('score', 0))
                judge_explanation = result.get('judge_explanation', '')
                grading_json = json.dumps({k: v.upper() for k, v in judge_criteria.items()}, indent=2) if judge_criteria else '{}'
                llm_content = f"[Grading Basis]:\n\n{grading_json}\n\n[Score]: {judge_score} point(s)\n\n[JSON]: {{\"answer_score\": {judge_score}}}\n\n[Explanation]:\n\n{judge_explanation}"
            else:
                llm_content = ''
            multi_turn_cells.append(make_cell(
                f'llm_judge_{slot_num}', llm_content, f'auto_bt_llm_judge_{slot_num}'))
        
            # Human judge
            review = slot_to_review.get(slot_num)
            if review:
                grading_basis = review.get('grading_basis', {})
                grading_json = json.dumps({k: v.upper() for k, v in grading_basis.items()}, indent=2) if grading_basis else '{}'
                total_criteria = len(grading_basis)
                pass_count = sum(1 for v in grading_basis.values() if str(v).upper() == 'PASS')
                score = 1 if pass_count > total_criteria / 2 else 0
                explanation = review.get('explanation', '') or review.get('notes', '')
                human_content = f"[Grading Basis]:\n\n{grading_json}\n\n[Score]: {score} point(s)\n\n[JSON]: {{\"answer_score\": {score}}}\n\n[Explanation]:\n\n{explanation}"
            else:
                human_content = ''
            multi_turn_cells.append(make_cell(
                f'human_judge_{slot_num}', human_content, f'auto_bt_human_judge_{slot_num}'))
        
            # Reasoning trace
            if include_reasoning:
                reasoning = result.get('reasoning_trace', '') if result else ''
                multi_turn_cells.append(make_cell(
                    f'reasoning_trace_{slot_num}', reasoning, f'auto_bt_reasoning_{slot_num}'))
    
        # Step 5: Add metadata cells
        # Conversation history
        history_json = json.dumps(conversation_history, indent=2) if conversation_history else '[]'
        multi_turn_cells.append(make_cell(
            'conversation_history', history_json, 'auto_conversation_history'))
    
        # Number of turns
        multi_turn_cells.append(make_cell(
            'number_of_turns', str(total_turns), 'auto_number_of_turns'))
    
        # Breaking turn number
        multi_turn_cells.append(make_cell(
            'breaking_turn', str(bt_num), 'auto_breaking_turn'))
    
        # Number of attempts made
        multi_turn_cells.append(make_cell(
            'number_of_attempts_made', str(total_hunts_ran), 'auto_attempts_counter'))
    
        # Step 6: Combine: non-slot cells + multi-turn cells
        notebook['cells'] = non_slot_cells + multi_turn_cells
    
        logger.debug("Multi-turn export: %d turns, breaking at turn %d, %d total cells", total_turns, bt_num, len(notebook['cells']))
        self._merge_alignment_metadata(notebook, alignment)
        return json.dumps(notebook, indent=2)
    
    def _format_turn_judge(self, judge_result: dict) -> str:
        """Format judge result for a non-breaking turn's selected response."""
        score = judge_result.get('score', 0)
        criteria = judge_result.get('criteria', {})
        explanation = judge_result.get('explanation', '')
    
        grading_json = json.dumps({k: v.upper() for k, v in criteria.items()}, indent=2) if criteria else '{}'
    
        return f"""[Grading Basis]:

    {grading_json}

    [Score]: {score} point(s)

    [JSON]: {{"answer_score": {score}}}

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
