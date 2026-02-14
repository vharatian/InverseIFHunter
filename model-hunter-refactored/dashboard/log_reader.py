"""
Log Reader for Admin Dashboard

Reads telemetry events from JSONL with incremental reading support.
Maps sessions to trainers using email (from trainers.json) with character-name fallback.
"""
import json
import os
import re
import hashlib
from datetime import datetime, timedelta
from typing import Dict, List, Any, Optional, Tuple
from pathlib import Path
from collections import defaultdict
import threading


class LogReader:
    """
    Log reader with incremental reading and email-based trainer resolution.
    """

    # Model pricing (per 1M tokens)
    MODEL_PRICING = {
        "nvidia/nemotron-3-nano-30b-a3b": {"input": 0.06, "output": 0.24},
        "qwen/qwen3-235b-a22b-thinking-2507": {"input": 0.11, "output": 0.60},
        "accounts/fireworks/models/qwen3-235b-a22b-thinking-2507": {"input": 0.22, "output": 0.88},
        "gpt-5": {"input": 1.25, "output": 10.00},
        "gpt-4o": {"input": 2.50, "output": 10.00},
        "default": {"input": 0.50, "output": 1.00}
    }

    def __init__(self, log_path: Optional[str] = None, storage_path: Optional[str] = None):
        env_path = os.environ.get("TELEMETRY_LOG_PATH")
        if log_path:
            self.log_path = Path(log_path)
        elif env_path:
            self.log_path = Path(env_path)
        else:
            self.log_path = Path(__file__).parent.parent / ".telemetry" / "events.jsonl"

        env_storage = os.environ.get("SESSION_STORAGE_PATH")
        if storage_path:
            self.storage_path = Path(storage_path)
        elif env_storage:
            self.storage_path = Path(env_storage)
        else:
            self.storage_path = Path("/app/.storage")

        self._lock = threading.Lock()

        # Incremental reading state
        self._file_position = 0
        self._all_events: List[Dict] = []

        # Trainer caches
        self._trainer_registry: Dict[str, Dict] = {}  # email -> trainer data
        self._session_to_email: Dict[str, str] = {}  # session_id -> email
        self._session_to_trainer_id: Dict[str, str] = {}  # session_id -> character name (fallback)
        self._trainer_cache_mtime: float = 0
        self._storage_mtimes: Dict[str, float] = {}

    # ============== Incremental Reading ==============

    def read_new_events(self) -> List[Dict]:
        """Read only NEW events since last read. Returns the new events."""
        new_events = []
        if not self.log_path.exists():
            return new_events

        try:
            file_size = self.log_path.stat().st_size
            if file_size < self._file_position:
                # File was truncated/rotated — re-read from start
                self._file_position = 0
                self._all_events = []

            with open(self.log_path, "r") as f:
                f.seek(self._file_position)
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                        ts_str = event.get("ts", "")
                        if ts_str:
                            event["_ts"] = datetime.fromisoformat(ts_str.rstrip("Z"))
                        new_events.append(event)
                    except (json.JSONDecodeError, ValueError):
                        continue
                self._file_position = f.tell()

            self._all_events.extend(new_events)
        except Exception as e:
            print(f"Error reading log file: {e}")

        return new_events

    def get_all_events(self) -> List[Dict]:
        """Get all events read so far (including incremental)."""
        return self._all_events

    def get_events_since(self, since: datetime) -> List[Dict]:
        """Get events since a given datetime."""
        return [e for e in self._all_events if e.get("_ts", datetime.min) >= since]

    # ============== Trainer Resolution ==============

    def refresh_trainer_data(self):
        """Reload trainer registry and session storage. Only re-reads changed files."""
        # Load trainers.json if changed
        trainers_file = self.storage_path / "trainers.json"
        if trainers_file.exists():
            mtime = trainers_file.stat().st_mtime
            if mtime != self._trainer_cache_mtime:
                try:
                    with open(trainers_file, "r") as f:
                        self._trainer_registry = json.load(f)
                    self._trainer_cache_mtime = mtime
                except Exception:
                    pass

        # Scan session storage files for session -> email mapping
        if self.storage_path.exists():
            for session_file in self.storage_path.glob("*.json"):
                if session_file.name == "trainers.json":
                    continue
                session_id = session_file.stem
                mtime = session_file.stat().st_mtime
                if mtime == self._storage_mtimes.get(session_id):
                    continue
                try:
                    with open(session_file, "r") as f:
                        data = json.load(f)
                    email = data.get("trainer_email", "")
                    if email:
                        self._session_to_email[session_id] = email
                    trainer_id = data.get("trainer_id", "")
                    if trainer_id and trainer_id != "unknown":
                        self._session_to_trainer_id[session_id] = trainer_id
                    self._storage_mtimes[session_id] = mtime
                except Exception:
                    continue

    def resolve_trainer(self, session_id: Optional[str] = None, event: Optional[Dict] = None) -> Dict[str, str]:
        """
        Resolve trainer identity for a session or event.
        Returns: {"email": "...", "name": "...", "display": "..."} 
        Prefers email from telemetry event > session storage > character name fallback.
        """
        email = ""
        name = ""

        # 1. Check if event itself has trainer_email (heartbeat, new-style events)
        if event:
            data = event.get("data", {})
            email = data.get("trainer_email", "")
            name = data.get("trainer_name", "")
            if not session_id:
                session_id = data.get("session_id")

        # 2. Check session -> email mapping
        if not email and session_id:
            email = self._session_to_email.get(session_id, "")

        # 3. If we have email, get name from registry
        if email and not name:
            trainer_data = self._trainer_registry.get(email, {})
            name = trainer_data.get("name", "")

        # 4. Fallback to character name
        if not email and session_id:
            char_name = self._session_to_trainer_id.get(session_id, "")
            if char_name:
                return {"email": "", "name": char_name, "display": char_name}

        if email:
            display = f"{name} ({email})" if name else email
            return {"email": email, "name": name, "display": display}

        return {"email": "", "name": "Unknown", "display": "Unknown"}

    # ============== Pricing ==============

    def get_model_pricing(self, model: str) -> Dict[str, float]:
        for known_model, pricing in self.MODEL_PRICING.items():
            if known_model in model or model in known_model:
                return pricing
        return self.MODEL_PRICING["default"]

    def calculate_cost(self, model: str, tokens_in: int, tokens_out: int) -> float:
        pricing = self.get_model_pricing(model)
        cost = (tokens_in * pricing["input"] / 1_000_000) + (tokens_out * pricing["output"] / 1_000_000)
        return round(cost, 6)

    # ============== Aggregation Helpers ==============

    def get_events_by_type(self, event_type: str, since: Optional[datetime] = None) -> List[Dict]:
        events = self.get_events_since(since) if since else self._all_events
        return [e for e in events if e.get("type") == event_type]

    def get_trainer_events(self, trainer_email: str) -> List[Dict]:
        """Get all events for a specific trainer (by email)."""
        result = []
        for event in self._all_events:
            data = event.get("data", {})
            # Direct email match
            if data.get("trainer_email") == trainer_email:
                result.append(event)
                continue
            # Session-based match
            sid = data.get("session_id")
            if sid and self._session_to_email.get(sid) == trainer_email:
                result.append(event)
        return result

    def get_active_sessions(self, minutes: int = 10) -> List[str]:
        """Get session IDs with activity in the last N minutes."""
        cutoff = datetime.utcnow() - timedelta(minutes=minutes)
        active = set()
        for event in self._all_events:
            ts = event.get("_ts")
            if ts and ts >= cutoff:
                sid = event.get("data", {}).get("session_id")
                if sid:
                    active.add(sid)
        return list(active)

    def get_trainer_registry(self) -> Dict[str, Dict]:
        """Return the loaded trainer registry (email -> profile)."""
        return self._trainer_registry.copy()
