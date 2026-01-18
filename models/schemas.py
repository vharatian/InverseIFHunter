"""Pydantic models for request/response schemas."""
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from enum import Enum


class ModelProvider(str, Enum):
    NEMOTRON = "nvidia/nemotron-3-nano-30b-a3b"
    QWEN3 = "qwen/qwen3-235b-a22b-thinking-2507"


class HuntStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


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
    response_reference: str = ""
    judge_prompt_template: str = ""
    judge_system_prompt: str = ""
    model_slots: Dict[str, str] = {}  # e.g., {"nemotron_1": "", "nemotron_2": ""}
    judge_slots: Dict[str, str] = {}  # e.g., {"llm_judge_1": "", "llm_judge_2": ""}
    human_judge_slots: Dict[str, str] = {}
    attempts_made: int = 0
    raw_cells: List[NotebookCell] = []
    validation_warnings: List[str] = []  # JSON validation warnings


class HuntConfig(BaseModel):
    """Configuration for a hunt session."""
    parallel_workers: int = Field(default=4, ge=1, le=16)
    target_breaks: int = Field(default=4, ge=1)
    models: List[str] = Field(default=["nvidia/nemotron-3-nano-30b-a3b"])
    reasoning_budget_percent: float = Field(default=0.9, ge=0.0, le=1.0)
    max_retries: int = Field(default=3, ge=1)
    judge_model: str = Field(default="gpt-5")
    custom_judge_system_prompt: Optional[str] = None
    provider: str = Field(default="openrouter")
    independent_judging: bool = Field(default=True)


class HuntResult(BaseModel):
    """Result of a single hunt attempt."""
    hunt_id: int
    model: str
    status: HuntStatus = HuntStatus.PENDING
    response: str = ""
    reasoning_trace: str = ""
    judge_score: Optional[int] = None
    judge_output: str = ""
    judge_criteria: Dict[str, str] = {}
    judge_explanation: str = ""
    error: Optional[str] = None
    is_breaking: bool = False


class HuntSession(BaseModel):
    """Overall hunt session state."""
    session_id: str
    notebook: Optional[ParsedNotebook] = None
    config: HuntConfig = HuntConfig()
    results: List[HuntResult] = []
    total_hunts: int = 0
    completed_hunts: int = 0
    breaks_found: int = 0
    status: HuntStatus = HuntStatus.PENDING
    human_reviews: Dict[str, Any] = {}  # Store human review data


class HuntEvent(BaseModel):
    """SSE event for real-time updates."""
    event_type: str  # "progress", "result", "complete", "error"
    hunt_id: Optional[int] = None
    data: Dict[str, Any] = {}


class ExportRequest(BaseModel):
    """Request to export modified notebook."""
    session_id: str
    include_reasoning: bool = True
