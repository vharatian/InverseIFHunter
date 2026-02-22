"""
Trainer Registry

Manages trainer registration and heartbeat tracking.
Stores trainer data in a JSON file on disk.
"""
import json
import logging
import os
from datetime import datetime
from typing import Optional

from storage.session_storage import STORAGE_DIR

logger = logging.getLogger(__name__)

TRAINERS_FILE = os.path.join(STORAGE_DIR, "trainers.json")


def _load_trainer_registry() -> dict:
    """Load the trainer registry from disk."""
    try:
        if os.path.exists(TRAINERS_FILE):
            with open(TRAINERS_FILE, 'r') as f:
                return json.load(f)
    except Exception as e:
        logger.error(f"Error loading trainer registry: {e}")
    return {}


def _save_trainer_registry(registry: dict):
    """Save the trainer registry to disk."""
    try:
        with open(TRAINERS_FILE, 'w') as f:
            json.dump(registry, f, indent=2)
    except Exception as e:
        logger.error(f"Error saving trainer registry: {e}")


def register_or_update_trainer(email: str, name: str, session_id: Optional[str] = None) -> dict:
    """Register a new trainer or update an existing one. Returns the trainer profile."""
    registry = _load_trainer_registry()
    now = datetime.utcnow().isoformat() + "Z"
    
    if email in registry:
        # Update existing trainer
        trainer = registry[email]
        trainer["name"] = name  # Allow name updates
        trainer["last_seen"] = now
        if session_id and session_id not in trainer.get("sessions", []):
            trainer.setdefault("sessions", []).append(session_id)
    else:
        # New trainer
        trainer = {
            "name": name,
            "email": email,
            "first_seen": now,
            "last_seen": now,
            "sessions": [session_id] if session_id else [],
            "total_hunts": 0,
            "total_breaks": 0
        }
        registry[email] = trainer
    
    _save_trainer_registry(registry)
    return trainer


def update_trainer_last_seen(email: str):
    """Update trainer's last_seen timestamp. Lightweight, for heartbeat."""
    try:
        registry = _load_trainer_registry()
        if email in registry:
            registry[email]["last_seen"] = datetime.utcnow().isoformat() + "Z"
            _save_trainer_registry(registry)
    except Exception:
        pass  # Fire-and-forget
