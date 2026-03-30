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


def _load_raw() -> Dict[str, Any]:
    """Load raw global.yaml."""
    with open(_GLOBAL_FILE, "r") as f:
        return yaml.safe_load(f) or {}


def _ensure_agentic_path():
    root = str(Path(__file__).resolve().parent.parent.parent.parent)
    if root not in sys.path:
        sys.path.append(root)


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
    """Set a value in a nested dict by dotted path (e.g. 'alignment.target_rate')."""
    keys = dotted_key.split(".")
    for k in keys[:-1]:
        d = d.setdefault(k, {})
    d[keys[-1]] = value


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

    data = _load_raw()
    applied = {}
    for key, value in updates.items():
        _set_nested(data, key, value)
        applied[key] = "updated"

    _save(data)
    return applied


def reload_config() -> None:
    """Force reload the config cache without writing anything."""
    _ensure_agentic_path()
    from agentic_reviewer.config_loader import reload_config as _reload
    _reload()
