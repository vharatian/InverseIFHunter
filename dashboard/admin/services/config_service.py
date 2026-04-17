"""
Config management service — read/write config/global.yaml at runtime.

Uses agentic_reviewer/config_loader for reading (no duplication).
Writes back to YAML and reloads the cache on mutations.
"""
import copy
import fcntl
import logging
import sys
from pathlib import Path
from typing import Any, Dict

import yaml

logger = logging.getLogger(__name__)

_CONFIG_DIR = Path(__file__).resolve().parent.parent.parent.parent / "config"
_GLOBAL_FILE = _CONFIG_DIR / "global.yaml"

BLOCKED_PREFIXES = ("secrets.",)

# Editable dotted-key prefixes for global.yaml. Anything outside this set
# is rejected to prevent mass assignment into arbitrary config surfaces.
ALLOWED_EDIT_PREFIXES = (
    "alignment.",
    "models.",
    "hunting.",
    "reviewer.",
    "scoring.",
    "rate_limits.",
    "judges.",
    "providers.",
    "runtime.",
    "features.",
    "notifications.",
    "teams.",
    "ui.",
    "analytics.",
)


def _load_raw() -> Dict[str, Any]:
    """Load raw global.yaml."""
    with open(_GLOBAL_FILE, "r") as f:
        return yaml.safe_load(f) or {}


def _ensure_agentic_path():
    """Make the repo root importable so agentic_reviewer can be loaded."""
    root = str(Path(__file__).resolve().parent.parent.parent.parent)
    if root not in sys.path:
        sys.path.insert(0, root)


def _save(data: Dict[str, Any]) -> None:
    """Write global.yaml atomically with exclusive lock, then reload cache."""
    tmp = _GLOBAL_FILE.with_suffix(".yaml.tmp")
    with open(tmp, "w") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        yaml.dump(data, f, default_flow_style=False, sort_keys=False, allow_unicode=True)
        f.flush()
    tmp.replace(_GLOBAL_FILE)
    try:
        _ensure_agentic_path()
        from agentic_reviewer.config_loader import reload_config
        reload_config()
    except Exception as e:
        logger.warning("config_loader.reload_config() failed: %s", e)
    # No need to notify other apps — config_loader auto-detects file changes via mtime


def _set_nested(d: dict, dotted_key: str, value: Any) -> None:
    """Set a value in a nested dict by dotted path.

    Raises ValueError if an intermediate path segment is a non-dict, because
    silently clobbering scalar config nodes risks data loss.
    """
    keys = dotted_key.split(".")
    node = d
    for i, k in enumerate(keys[:-1]):
        nxt = node.get(k)
        if nxt is None:
            nxt = {}
            node[k] = nxt
        elif not isinstance(nxt, dict):
            path_so_far = ".".join(keys[: i + 1])
            raise ValueError(
                f"Cannot set '{dotted_key}': '{path_so_far}' exists as {type(nxt).__name__}, expected mapping"
            )
        node = nxt
    node[keys[-1]] = value


def _get_nested(d: dict, dotted_key: str, default: Any = None) -> Any:
    """Get a value from a nested dict by dotted path."""
    keys = dotted_key.split(".")
    for k in keys:
        if not isinstance(d, dict):
            return default
        d = d.get(k, default)
    return d


def get_config_redacted() -> Dict[str, Any]:
    """Return full config with 'secrets' key stripped out."""
    data = _load_raw()
    redacted = copy.deepcopy(data)
    redacted.pop("secrets", None)
    return redacted


def update_config(updates: Dict[str, Any]) -> Dict[str, str]:
    """
    Apply partial updates to global.yaml. Everything is editable except secrets.

    Args:
        updates: Dict of dotted-path keys to new values.

    Returns:
        Dict of {key: "updated"} for each applied key.

    Raises:
        ValueError: If any key is in a blocked prefix (secrets).
    """
    blocked = [k for k in updates if any(k.startswith(p) for p in BLOCKED_PREFIXES) or k == "secrets"]
    if blocked:
        raise ValueError(f"Cannot edit protected keys: {', '.join(blocked)}")

    disallowed = [
        k for k in updates
        if not any(k.startswith(p) for p in ALLOWED_EDIT_PREFIXES)
    ]
    if disallowed:
        raise ValueError(
            "Disallowed keys (not in editable allowlist): " + ", ".join(disallowed)
        )

    data = _load_raw()
    applied = {}
    for key, value in updates.items():
        _set_nested(data, key, value)
        applied[key] = "updated"

    _save(data)
    _publish_change("config", list(applied.keys()))
    return applied


def _publish_change(channel_key: str, keys: list) -> None:
    """Best-effort publish of a config-change event to Redis pub/sub."""
    try:
        from events_bus import publish_sync  # lazy import to avoid cycles
        publish_sync(channel_key, {"keys": keys})
    except Exception as exc:
        logger.debug("config publish skipped: %s", exc)


def reload_config() -> None:
    """Force reload the config cache without writing anything."""
    _ensure_agentic_path()
    from agentic_reviewer.config_loader import reload_config as _reload
    _reload()
