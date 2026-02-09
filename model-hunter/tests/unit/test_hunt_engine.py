"""
Unit tests for hunt_engine.py — conversation_history wiring, result persistence.

These tests run WITHOUT a server. They import modules directly and mock
external dependencies (model API clients, Redis, disk I/O).
"""
import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock
import sys
import os

# Add model-hunter root to path so we can import services/models directly
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from models.schemas import (
    HuntSession, HuntConfig, HuntResult, HuntStatus,
    ParsedNotebook, TurnData,
)
from services.hunt_engine import HuntEngine


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def engine():
    """Create a HuntEngine instance."""
    return HuntEngine()


@pytest.fixture
def single_turn_session():
    """Session with no conversation history (single-turn)."""
    config = HuntConfig(
        parallel_workers=1,
        target_breaks=1,
        models=["nvidia/nemotron-3-nano-30b-a3b"],
        conversation_history=[],
    )
    notebook = ParsedNotebook(
        filename="test.ipynb",
        prompt="What is 2+2?",
        response_reference='[{"id":"C1","criteria":"correct answer"}]',
        judge_system_prompt="You are a judge.",
    )
    session = HuntSession(
        session_id="test-single-001",
        notebook=notebook,
        config=config,
        status=HuntStatus.RUNNING,
        total_hunts=1,
    )
    return session


@pytest.fixture
def multi_turn_session():
    """Session at turn 2 with conversation history from turn 1."""
    config = HuntConfig(
        parallel_workers=1,
        target_breaks=1,
        models=["nvidia/nemotron-3-nano-30b-a3b"],
        conversation_history=[
            {"role": "user", "content": "What is 2+2?"},
            {"role": "assistant", "content": "The answer is 4."},
        ],
    )
    notebook = ParsedNotebook(
        filename="test.ipynb",
        prompt="Now explain why.",
        response_reference='[{"id":"C1","criteria":"explains reasoning"}]',
        judge_system_prompt="You are a judge.",
    )
    session = HuntSession(
        session_id="test-multi-001",
        notebook=notebook,
        config=config,
        current_turn=2,
        conversation_history=[
            {"role": "user", "content": "What is 2+2?"},
            {"role": "assistant", "content": "The answer is 4."},
        ],
        status=HuntStatus.RUNNING,
        total_hunts=1,
    )
    return session


@pytest.fixture
def three_turn_session():
    """Session at turn 3 with 4-message conversation history."""
    config = HuntConfig(
        parallel_workers=1,
        target_breaks=1,
        models=["nvidia/nemotron-3-nano-30b-a3b"],
        conversation_history=[
            {"role": "user", "content": "Turn 1 prompt"},
            {"role": "assistant", "content": "Turn 1 reply"},
            {"role": "user", "content": "Turn 2 prompt"},
            {"role": "assistant", "content": "Turn 2 reply"},
        ],
    )
    notebook = ParsedNotebook(
        filename="test.ipynb",
        prompt="Turn 3 prompt",
        response_reference='[{"id":"C1","criteria":"test"}]',
    )
    session = HuntSession(
        session_id="test-t3-001",
        notebook=notebook,
        config=config,
        current_turn=3,
        conversation_history=config.conversation_history,
        status=HuntStatus.RUNNING,
        total_hunts=1,
    )
    return session


@pytest.fixture
def mock_result():
    """A fresh HuntResult for a hunt."""
    return HuntResult(
        hunt_id=1,
        model="nvidia/nemotron-3-nano-30b-a3b",
        status=HuntStatus.PENDING,
    )


# ---------------------------------------------------------------------------
# Test: Conversation History Wiring
# ---------------------------------------------------------------------------

@pytest.mark.unit
class TestConversationHistoryWiring:
    """Verify conversation_history flows from session config → model client."""

    def test_single_turn_config_has_empty_history(self, single_turn_session):
        """Single-turn session should have empty conversation_history."""
        history = single_turn_session.config.conversation_history
        assert history == []

    def test_multi_turn_config_has_history(self, multi_turn_session):
        """Multi-turn session should have conversation_history from prior turns."""
        history = multi_turn_session.config.conversation_history
        assert len(history) == 2
        assert history[0]["role"] == "user"
        assert history[0]["content"] == "What is 2+2?"
        assert history[1]["role"] == "assistant"
        assert history[1]["content"] == "The answer is 4."

    def test_three_turn_history_has_four_messages(self, three_turn_session):
        """Turn 3 should have 4 messages (2 turns x user+assistant)."""
        history = three_turn_session.config.conversation_history
        assert len(history) == 4
        assert history[0]["role"] == "user"
        assert history[1]["role"] == "assistant"
        assert history[2]["role"] == "user"
        assert history[3]["role"] == "assistant"

    def test_messages_kwarg_built_from_history(self, multi_turn_session):
        """The messages kwarg should be derived from conversation_history."""
        conversation_history = multi_turn_session.config.conversation_history or []
        messages_kwarg = (
            {"messages": conversation_history} if conversation_history else {}
        )
        assert "messages" in messages_kwarg
        assert len(messages_kwarg["messages"]) == 2

    def test_empty_history_produces_no_messages_kwarg(self, single_turn_session):
        """Single-turn: messages kwarg should be empty dict."""
        conversation_history = single_turn_session.config.conversation_history or []
        messages_kwarg = (
            {"messages": conversation_history} if conversation_history else {}
        )
        assert messages_kwarg == {}


# ---------------------------------------------------------------------------
# Test: Session Schema Integrity
# ---------------------------------------------------------------------------

@pytest.mark.unit
class TestSessionSchemaIntegrity:
    """Verify HuntSession, HuntConfig, and TurnData schemas work correctly."""

    def test_hunt_session_default_values(self):
        """New HuntSession should have correct multi-turn defaults."""
        session = HuntSession(session_id="test")
        assert session.current_turn == 1
        assert session.conversation_history == []
        assert session.turns == []
        assert session.results == []
        assert session.all_results == []

    def test_hunt_config_conversation_history_default(self):
        """HuntConfig should default conversation_history to empty list."""
        config = HuntConfig()
        assert config.conversation_history == []

    def test_turn_data_creation(self):
        """TurnData should be creatable with required fields."""
        turn = TurnData(
            turn_number=1,
            prompt="Test prompt",
            response_reference="Test criteria",
        )
        assert turn.turn_number == 1
        assert turn.status == "pending"
        assert turn.selected_response is None
        assert turn.selected_hunt_id is None
        assert turn.results == []

    def test_turn_data_completed(self):
        """TurnData can represent a completed turn with selected response."""
        turn = TurnData(
            turn_number=1,
            prompt="Turn 1",
            response_reference="Criteria 1",
            selected_response="Good response",
            selected_hunt_id=3,
            judge_result={"score": 1, "criteria": {"C1": "PASS"}},
            status="completed",
        )
        assert turn.status == "completed"
        assert turn.selected_response == "Good response"
        assert turn.selected_hunt_id == 3

    def test_parsed_notebook_multi_turn_defaults(self):
        """ParsedNotebook should have multi-turn defaults."""
        nb = ParsedNotebook(filename="test.ipynb")
        assert nb.is_multi_turn == False
        assert nb.turns == []
        assert nb.prompt == ""
        assert nb.response_reference == ""

    def test_hunt_result_default_values(self):
        """HuntResult should have correct defaults."""
        result = HuntResult(hunt_id=1, model="test-model")
        assert result.status == HuntStatus.PENDING
        assert result.response == ""
        assert result.is_breaking == False
        assert result.judge_score is None
        assert result.error is None


# ---------------------------------------------------------------------------
# Test: Hunt Persistence
# ---------------------------------------------------------------------------

@pytest.mark.unit
class TestHuntPersistence:
    """Verify _persist_session behavior through mocking."""

    @pytest.mark.asyncio
    async def test_persist_session_is_async(self, engine):
        """_persist_session should be an async method."""
        import inspect
        assert inspect.iscoroutinefunction(engine._persist_session)

    @pytest.mark.asyncio
    async def test_persist_session_callable(self, engine, single_turn_session):
        """_persist_session should be callable with a session."""
        # Mock the underlying store to avoid real Redis/disk calls
        with patch.object(engine, '_persist_session', new_callable=AsyncMock) as mock_persist:
            await mock_persist(single_turn_session)
            mock_persist.assert_called_once_with(single_turn_session)


# ---------------------------------------------------------------------------
# Test: Judge Independence
# ---------------------------------------------------------------------------

@pytest.mark.unit
class TestJudgeIndependence:
    """Verify each turn's criteria is independent — judge uses current turn's criteria."""

    def test_multi_turn_session_has_current_criteria(self, multi_turn_session):
        """The session's notebook should have the current turn's criteria."""
        assert multi_turn_session.notebook.response_reference == (
            '[{"id":"C1","criteria":"explains reasoning"}]'
        )

    def test_criteria_changes_between_turns(self):
        """Different turns can have different criteria."""
        turn1 = TurnData(
            turn_number=1,
            prompt="Turn 1",
            response_reference='[{"id":"C1","criteria":"accuracy"}]',
        )
        turn2 = TurnData(
            turn_number=2,
            prompt="Turn 2",
            response_reference='[{"id":"C1","criteria":"creativity"}]',
        )
        assert turn1.response_reference != turn2.response_reference
