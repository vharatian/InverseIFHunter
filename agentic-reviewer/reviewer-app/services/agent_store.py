"""
Store reviewer agent run result in Redis.
Key: mh:rev_agent:{session_id} -> JSON. TTL 7 days.
"""
import json
import logging
from typing import Any, Dict, Optional

from .redis_client import get_redis

logger = logging.getLogger(__name__)

KEY_PREFIX = "mh:rev_agent"
TTL_DAYS = 7
TTL_SECONDS = TTL_DAYS * 86400


def _key(session_id: str) -> str:
    return f"{KEY_PREFIX}:{session_id}"


async def get_agent_result(session_id: str) -> Optional[Dict[str, Any]]:
    """Load last agent result for session. None if never run or expired."""
    r = await get_redis()
    raw = await r.get(_key(session_id))
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


async def set_agent_result(session_id: str, result: Dict[str, Any]) -> None:
    """Save agent result for session."""
    r = await get_redis()
    key = _key(session_id)
    await r.set(key, json.dumps(result, default=str))
    await r.expire(key, TTL_SECONDS)
