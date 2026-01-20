# Data Flow Explanation

## Step 1: Parsing Colab Notebook (Initial Load)

**What we get from Colab:**
```python
ParsedNotebook {
    filename: "notebook.ipynb",
    metadata: {
        "Task ID": "083d34cd-bb8d-41e8-8a80-9f9b2fb8906f",
        "Domain": "Education & Research",
        ...
    },
    prompt: "A chemistry question asks...",
    response: "None of the options are correct...",
    response_reference: "[{id: 'C1', criteria1: '...'}, ...]",
    judge_system_prompt: "From now on, your role...",
    judge_prompt_template: "<Question>: {prompt}...",
    
    # Existing slot data (if any)
    model_slots: {
        "nemotron_1": "The correct choice is...",
        "nemotron_2": "...",
    },
    judge_slots: {
        "llm_judge_1": "[Grading Basis]: {...}",
        ...
    },
    human_judge_slots: {
        "human_judge_1": "[Grading Basis]: {...}",
        ...
    },
    attempts_made: 4  # From existing notebook
}
```

## Step 2: Running Hunts (Multiple Runs)

**Example: User runs hunts 3 times**
- Run 1: 4 hunts (hunt_id: 1, 2, 3, 4)
- Run 2: 4 hunts (hunt_id: 1, 2, 3, 4) - resets, new hunt_ids
- Run 3: 4 hunts (hunt_id: 1, 2, 3, 4) - resets again

**After all runs, session.results contains:**
```python
session.results = [
    HuntResult(hunt_id=1, model="nemotron", response="...", judge_score=0, ...),  # Run 3
    HuntResult(hunt_id=2, model="nemotron", response="...", judge_score=1, ...),  # Run 3
    HuntResult(hunt_id=3, model="nemotron", response="...", judge_score=0, ...),  # Run 3
    HuntResult(hunt_id=4, model="nemotron", response="...", judge_score=0, ...),  # Run 3
    # Note: Only LAST run's results are kept (session.results is reset each run)
]

# But export_results() returns ALL completed results:
all_results = [
    {"hunt_id": 1, "model": "nemotron", "response": "...", "judge_score": 0, ...},
    {"hunt_id": 2, "model": "nemotron", "response": "...", "judge_score": 1, ...},
    {"hunt_id": 3, "model": "nemotron", "response": "...", "judge_score": 0, ...},
    {"hunt_id": 4, "model": "nemotron", "response": "...", "judge_score": 0, ...},
    # ... if there were more runs, they'd be here
]
```

**Human Reviews (from trainer input):**
```python
human_reviews = {
    "1": {  # hunt_id as string
        "slotNum": 1,  # Which slot (1-4) this review is for
        "judgment": "FAIL",
        "grading_basis": {"C1": "FAIL", "C2": "FAIL", "C3": "PASS", "C4": "FAIL"},
        "explanation": "The response fails because...",
        "notes": "..."
    },
    "2": {
        "slotNum": 2,
        ...
    }
}
```

## Step 3: User Selects Results to Save

**User selects 4 results from hunt progress table:**
- Selected hunt_ids: [5, 8, 12, 15]  # These are the rows they want to save

**Filtered results:**
```python
results = [
    {"hunt_id": 5, "model": "nemotron", "response": "...", ...},  # Selected
    {"hunt_id": 8, "model": "nemotron", "response": "...", ...},  # Selected
    {"hunt_id": 12, "model": "nemotron", "response": "...", ...}, # Selected
    {"hunt_id": 15, "model": "nemotron", "response": "...", ...}, # Selected
]
```

## Step 4: Before Saving to Colab

**What we have:**
1. `original_content`: Original notebook JSON from Colab
2. `parsed`: ParsedNotebook object (from initial parse)
3. `results`: List of 4 selected hunt results (dicts with hunt_id, response, judge_score, etc.)
4. `human_reviews`: Dict mapping hunt_id -> review data (with slotNum)
5. `total_hunts_ran`: Currently `session.total_hunts` (WRONG - only last run's count)

**What we need to fix:**
1. `number_of_attempts_made` should be `len(all_results)` - total completed hunts across ALL runs
2. Slot mapping should use `slotNum` from human_reviews, not just index
3. Ensure all data is properly populated (no empty fields)

## Step 5: Export to Colab

**We create cells in this order:**
1. Metadata cell
2. [prompt] cell
3. [response] cell
4. [response_reference] cell
5. [judge_prompt_template] cell
6. [judge_system_prompt] cell
7. **Slot cells (for each slot 1-4):**
   - [nemotron_1] → model response
   - [llm_judge_1] → LLM judge output
   - [human_judge_1] → Human review
   - [reasoning_trace_1] → Reasoning trace
   - [nemotron_2] → ...
   - [llm_judge_2] → ...
   - [human_judge_2] → ...
   - [reasoning_trace_2] → ...
   - ... (slots 3 and 4)
8. [number_of_attempts_made] → Total hunts count

