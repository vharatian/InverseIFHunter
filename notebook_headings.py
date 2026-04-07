"""
Notebook Cell Headings — Shared Registry
=========================================
Every **[heading]** written to or read from .ipynb notebooks.

Used by:
  WRITERS (save to notebook):
    - services/notebook_parser.py     (export_notebook, export_multi_turn_notebook)
    - static/modules/notebook.js      (_makeCell, _buildTurnCells, submitToColab)
    - helpers/notebook_helpers.py      (find_or_create_cell_by_heading)

  READERS (parse from notebook):
    - reviewer-app/api/routes/notebook_preview.py  (_classify_heading, imports TASK_ALIASES & METADATA_KEYS)

When adding a new heading:
  1. Add the constant here
  2. If it's a task alias, add to TASK_ALIASES
  3. If it's metadata, add to METADATA_KEYS
  4. Update JS notebook.js writer (cannot import Python, uses same strings)
"""

# ── Task sections (per-turn, prefixed with "Turn-N: " in multi-turn) ──
PROMPT = "Prompt"
RESPONSE = "Ideal Response"
RESPONSE_REFERENCE = "Response Reference"
JUDGE_SYSTEM_PROMPT = "Judge System Prompt"

# Aliases recognized by the reviewer parser (not written, but accepted)
TASK_ALIASES = {
    "prompt": "prompt",
    "response": "response",
    "ideal_response": "response",
    "ideal": "response",
    "trainer_response": "response",
    "expected_response": "response",
    "response_reference": "response_reference",
    "reference": "response_reference",
    "rubric": "response_reference",
    "criteria": "response_reference",
    "scoring": "response_reference",
    "response_ref": "response_reference",
    "grading_rubric": "response_reference",
}

# ── Slot results (N = 1..24, per slot) ─────────────────────────────────
# Model response: "{ModelName}_{N}" — model name is dynamic
SLOT_LLM_JUDGE = "llm_judge_{n}"
SLOT_HUMAN_JUDGE = "human_judge_{n}"
SLOT_REASONING_TRACE = "reasoning_trace_{n}"

# ── Multi-turn extras ──────────────────────────────────────────────────
SELECTED_RESPONSE = "selected_response_{n}"
SELECTED_JUDGE = "selected_judge_{n}"
CONVERSATION_HISTORY = "conversation_history"
NUMBER_OF_TURNS = "number_of_turns"
BREAKING_TURN = "breaking_turn"
NUMBER_OF_ATTEMPTS = "number_of_attempts_made"

# ── Summary / metadata (written by progressive save) ──────────────────
TOTAL_HUNTS = "Total_Hunts"
PASS_RATE = "Pass_Rate"
HUNT_MODE = "Hunt_Mode"
HUNT_MODEL = "Hunt_Model"
JUDGE_MODEL = "Judge_Model"

# All metadata keys the reviewer parser should recognize
METADATA_KEYS = frozenset({
    "number_of_attempts_made",
    "total_hunts",
    "pass_rate",
    "hunt_mode",
    "hunt_model",
    "judge_model",
    "judge_system_prompt",
    "number_of_turns",
    "breaking_turn",
    "conversation_history",
    "selected_response",
    "selected_judge",
})
