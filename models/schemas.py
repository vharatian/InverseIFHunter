"""Pydantic models for request/response schemas."""
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any, Literal
from enum import Enum


# Proceed policy: optional patterns for (breaking, passing) counts; proceed if any matches and errors==0
class ProceedPattern(BaseModel):
    breaking: int = 0
    passing: int = 0


class ProceedPolicy(BaseModel):
    patterns: List[ProceedPattern] = []


class ModelProvider(str, Enum):
    NEMOTRON = "nvidia/nemotron-3-nano-30b-a3b"
    QWEN3 = "qwen/qwen3-235b-a22b-thinking-2507"


class HuntStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    STOPPED_BUDGET = "stopped_budget"   # max batches/samples/wall time reached
    NEEDS_ATTENTION = "needs_attention"  # persistent errors after max_error_batches


class NotebookCell(BaseModel):
    """Represents a parsed notebook cell."""
    cell_id: str
    cell_type: str
    heading: Optional[str] = None
    content: str


class ParsedNotebook(BaseModel):
    """Structured representation of a parsed .ipynb file."""
    filename: str
    metadata: Dict[str, Any] = {}
    prompt: str = ""
    response: str = ""
    model_reasoning: str = ""
    response_reference: str = ""
    judge_prompt_template: str = ""
    judge_system_prompt: str = ""
    model_slots: Dict[str, str] = {}  # e.g., {"nemotron_1": "", "nemotron_2": ""}
    judge_slots: Dict[str, str] = {}  # e.g., {"llm_judge_1": "", "llm_judge_2": ""}
    human_judge_slots: Dict[str, str] = {}
    attempts_made: int = 0
    raw_cells: List[NotebookCell] = []
    validation_warnings: List[str] = []  # JSON validation warnings
    # Multi-turn fields
    is_multi_turn: bool = False
    turns: List[Any] = []  # List of TurnData dicts


class TurnData(BaseModel):
    """Data for a single turn in a multi-turn conversation."""
    turn_number: int
    prompt: str
    response_reference: str          # Criteria/rubrics for this turn
    judge_system_prompt: str = ""    # Judge prompt (defaults to previous turn's)
    selected_response: Optional[str] = None  # The "good" response trainer picked
    selected_hunt_id: Optional[int] = None
    judge_result: Optional[Dict[str, Any]] = None  # Judge output for selected response
    status: str = "pending"          # pending, hunting, reviewing, completed
    results: List[Any] = []          # HuntResult dicts for this turn


class HuntConfig(BaseModel):
    """Configuration for a hunt session. Defaults from global config when available."""
    parallel_workers: int = Field(default=4, ge=1, le=16)
    target_breaks: int = Field(default=4, ge=1)
    models: List[str] = Field(default=["nvidia/nemotron-3-nano-30b-a3b"])
    reasoning_budget_percent: float = Field(default=0.9, ge=0.0, le=1.0)
    max_retries: int = Field(default=3, ge=1)
    judge_model: str = Field(default="openai/gpt-5.2")
    custom_judge_system_prompt: Optional[str] = None
    provider: str = Field(default="openrouter")
    independent_judging: bool = Field(default=True)
    hunt_offset: int = Field(default=0, ge=0)  # Starting hunt_id offset (from frontend's hunt count)
    conversation_history: List[Dict[str, str]] = []  # Multi-turn conversation history
    # Pass threshold: 0.5 = 50% rule (current), 1.0 = all criteria must pass (model breaking)
    pass_threshold: float = Field(default=0.5, ge=0.0, le=1.0)
    # Passing mode: hunt for passes (success = all pass), not breaks
    passing_mode: bool = Field(default=False)
    # Raw hunt mode string from UI — drives selection-stage rules
    hunt_mode: str = Field(default="break_50")
    # Minimum breaking responses required in selection (from "Min Breaking" dropdown)
    min_breaking_required: int = Field(default=0, ge=0)
    # InverseIF episode: batch and proceed policy
    batch_size: int = Field(default=4, ge=1, le=16)
    break_mode: Literal["ratio", "any_break", "no_break"] = "ratio"
    proceed_policy: Optional[ProceedPolicy] = None
    max_batches_per_turn: int = Field(default=4, ge=1)
    max_total_samples: int = Field(default=64, ge=1)
    max_wall_time_seconds: int = Field(default=900, ge=1)
    max_error_batches: int = Field(default=2, ge=0)  # rehunt on errors up to this many batches


# Sample label for aggregation: PASS, BREAK, or ERROR (e.g. any criterion MISSING)
SampleLabel = Literal["PASS", "BREAK", "ERROR"]


class HuntResult(BaseModel):
    """Result of a single hunt attempt."""
    hunt_id: int
    model: str
    provider: str = "openrouter"
    prompt: Optional[str] = None
    status: HuntStatus = HuntStatus.PENDING
    response: str = ""
    reasoning_trace: str = ""
    judge_score: Optional[int] = None
    judge_output: str = ""
    judge_criteria: Dict[str, str] = {}
    judge_explanation: str = ""
    scores: Dict[str, Any] = {}
    error: Optional[str] = None
    is_breaking: bool = False
    duration_ms: Optional[int] = None
    # InverseIF aggregation
    sample_label: Optional[SampleLabel] = None  # PASS | BREAK | ERROR
    pass_rate: Optional[float] = None
    pass_count: Optional[int] = None
    fail_count: Optional[int] = None
    missing_count: Optional[int] = None


class HuntSession(BaseModel):
    """Overall hunt session state."""
    session_id: str
    notebook: Optional[ParsedNotebook] = None
    config: HuntConfig = Field(default_factory=HuntConfig)
    results: List[HuntResult] = []
    all_results: List[HuntResult] = []  # Accumulated results across ALL runs
    total_hunts: int = 0
    completed_hunts: int = 0
    breaks_found: int = 0
    passes_found: int = 0  # When passing_mode: count of responses that pass all criteria
    accumulated_hunt_count: int = 0  # Total hunts ever run (for unique IDs)
    status: HuntStatus = HuntStatus.PENDING
    human_reviews: Dict[str, Any] = {}  # Store human review data
    # Multi-turn fields
    current_turn: int = 1
    conversation_history: List[Dict[str, str]] = []  # [{role: "user", content: ...}, ...]
    turns: List[TurnData] = []  # All turn data for this session


class HuntEvent(BaseModel):
    """SSE event for real-time updates."""
    event_type: str  # "progress", "result", "complete", "error"
    hunt_id: Optional[int] = None
    data: Dict[str, Any] = {}


class ExportRequest(BaseModel):
    """Request to export modified notebook."""
    session_id: str
    include_reasoning: bool = True
