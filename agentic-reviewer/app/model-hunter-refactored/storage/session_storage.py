"""
Session Storage

Disk-based session storage with expiration.
Acts as a backup for Redis — write-on-create + periodic updates.
"""
import os
import json
import logging
from datetime import datetime
from typing import Optional

logger = logging.getLogger(__name__)

# Storage configuration
STORAGE_DIR = os.path.join(os.getcwd(), ".storage")
os.makedirs(STORAGE_DIR, exist_ok=True)

# Session expiration: 2 hours (7200 seconds)
SESSION_EXPIRATION_SECONDS = 2 * 60 * 60  # 2 hours


def save_session_storage(session_id: str, data: dict):
    """Save session data to disk with timestamp."""
    path = os.path.join(STORAGE_DIR, f"{session_id}.json")
    # Add/update timestamp
    data["last_accessed"] = datetime.utcnow().isoformat() + "Z"
    if "created_at" not in data:
        data["created_at"] = datetime.utcnow().isoformat() + "Z"
    with open(path, 'w') as f:
        json.dump(data, f)


def get_session_storage(session_id: str) -> Optional[dict]:
    """Get session data from disk, checking expiration."""
    path = os.path.join(STORAGE_DIR, f"{session_id}.json")
    if os.path.exists(path):
        try:
            with open(path, 'r') as f:
                data = json.load(f)
            
            # Check expiration
            if "last_accessed" in data:
                raw_ts = data["last_accessed"]
                # Strip "Z" suffix to get a naive datetime (all our timestamps are UTC)
                last_accessed = datetime.fromisoformat(raw_ts.replace("Z", ""))
                elapsed = (datetime.utcnow() - last_accessed).total_seconds()
                if elapsed > SESSION_EXPIRATION_SECONDS:
                    # Session expired, delete it
                    logger.info(f"Session {session_id} expired (elapsed: {elapsed:.0f}s, limit: {SESSION_EXPIRATION_SECONDS}s)")
                    try:
                        os.remove(path)
                    except Exception as e:
                        logger.error(f"Error deleting expired session file: {e}")
                    return None
            
            # Update last accessed time
            data["last_accessed"] = datetime.utcnow().isoformat() + "Z"
            with open(path, 'w') as f:
                json.dump(data, f)
            
            return data
        except Exception as e:
            logger.error(f"Error loading session storage {session_id}: {e}")
    return None
