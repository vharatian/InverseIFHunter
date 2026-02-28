"""
Global Config Loader — Single source of truth for all configuration.

Loads config/global.yaml, resolves ${VAR} and ${VAR:-default} from os.environ.
Exposes get_config() for dotted-key access (e.g. config.session.ttl_seconds).

Usage:
    from agentic_reviewer.config_loader import get_config
    cfg = get_config()
    ttl = cfg.session.ttl_seconds
    api_key = cfg.secrets.openai_api_key
"""
import os
import re
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

logger = logging.getLogger(__name__)

# Path to global config (relative to agentic-reviewer root)
_CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"
DEFAULT_CONFIG_PATH = _CONFIG_DIR / "global.yaml"
FALLBACK_CONFIG_PATH = _CONFIG_DIR / "agentic_rules.yaml"

# Pattern: ${VAR} or ${VAR:-default}
_ENV_PATTERN = re.compile(r"\$\{([^}:]+)(?::-([^}]*))?\}")


def _resolve_env(value: Any) -> Any:
    """Recursively resolve ${VAR} and ${VAR:-default} in strings. Return as-is for non-strings."""
    if isinstance(value, str):
        def replacer(match):
            var_name = match.group(1)
            default = match.group(2)
            return os.environ.get(var_name, default if default is not None else "")
        return _ENV_PATTERN.sub(replacer, value)
    if isinstance(value, dict):
        return {k: _resolve_env(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_resolve_env(item) for item in value]
    return value


class _ConfigNode:
    """Read-only dotted access to nested dict. config.session.ttl_seconds -> config["session"]["ttl_seconds"]"""

    def __init__(self, data: Dict[str, Any]):
        self._data = data if isinstance(data, dict) else {}

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            return object.__getattribute__(self, name)
        val = self._data.get(name)
        if isinstance(val, dict):
            return _ConfigNode(val)
        return val

    def __getitem__(self, key: str) -> Any:
        val = self._data.get(key)
        if isinstance(val, dict):
            return _ConfigNode(val)
        return val

    def get(self, key: str, default: Any = None) -> Any:
        val = self._data.get(key, default)
        if isinstance(val, dict):
            return _ConfigNode(val)
        return val

    def __repr__(self) -> str:
        return f"Config({list(self._data.keys())})"


_config: Optional[_ConfigNode] = None


def _load_raw(path: Path) -> Dict[str, Any]:
    """Load YAML file. Returns empty dict if not found."""
    if not path.exists():
        logger.warning("Config not found: %s", path)
        return {}
    with open(path, "r") as f:
        data = yaml.safe_load(f)
    return data if isinstance(data, dict) else {}


def _merge_agentic_fallback(global_data: Dict[str, Any]) -> Dict[str, Any]:
    """If agentic section is empty, merge from agentic_rules.yaml (council + rules at top level)."""
    agentic = global_data.get("agentic") or {}
    if not agentic.get("rules") and not agentic.get("council"):
        fallback = _load_raw(FALLBACK_CONFIG_PATH)
        if fallback:
            # agentic_rules.yaml has council and rules at top level
            merged = {
                "council": fallback.get("council") or {},
                "rules": fallback.get("rules") or [],
            }
            global_data = {**global_data, "agentic": merged}
            logger.info("Merged agentic config from fallback: %s", FALLBACK_CONFIG_PATH)
    return global_data


def load_config(path: Optional[Path] = None) -> _ConfigNode:
    """
    Load and resolve config. Caches result. Call with path=None to use default.
    """
    global _config
    cfg_path = path or DEFAULT_CONFIG_PATH
    raw = _load_raw(cfg_path)
    raw = _merge_agentic_fallback(raw)
    resolved = _resolve_env(raw)

    # Log missing secrets (optional validation)
    secrets = resolved.get("secrets") or {}
    for key, val in secrets.items():
        if not val and key != "google_service_account_path":
            logger.debug("Secret %s is empty (env var not set)", key)

    _config = _ConfigNode(resolved)
    return _config


def get_config(path: Optional[Path] = None) -> _ConfigNode:
    """
    Get config singleton. Loads on first call, then returns cached.
    Use path= to force reload from a specific file.
    """
    global _config
    if path is not None:
        return load_config(path)
    if _config is None:
        load_config()
    return _config


def reload_config(path: Optional[Path] = None) -> _ConfigNode:
    """Force reload config (e.g. for tests)."""
    global _config
    _config = None
    return load_config(path or DEFAULT_CONFIG_PATH)


def get_agentic_rules(config_path: Optional[Path] = None) -> List[Dict[str, Any]]:
    """Get agentic rules: from global config, or from file if path given. Fallback to agentic_rules.yaml."""
    if config_path is not None and config_path.exists():
        with open(config_path, "r") as f:
            data = yaml.safe_load(f) or {}
        rules = data.get("rules") or []
        return rules if isinstance(rules, list) else []
    cfg = get_config()
    rules = cfg.agentic.get("rules") or []
    if not rules and FALLBACK_CONFIG_PATH.exists():
        with open(FALLBACK_CONFIG_PATH, "r") as f:
            data = yaml.safe_load(f) or {}
        rules = data.get("rules") or []
    return rules if isinstance(rules, list) else []


def get_agentic_council(config_path: Optional[Path] = None) -> Dict[str, Any]:
    """Get agentic council config: from global config, or from file. Fallback to agentic_rules.yaml."""
    if config_path is not None and config_path.exists():
        with open(config_path, "r") as f:
            data = yaml.safe_load(f) or {}
        return data.get("council") or {}
    cfg = get_config()
    c = cfg.agentic.council
    models = c.models if hasattr(c, "models") and c.models else []
    consensus = c.consensus if hasattr(c, "consensus") and c.consensus else "majority"
    chairman_model = getattr(c, "chairman_model", None) or (c.get("chairman_model") if hasattr(c, "get") else None)
    if not models and FALLBACK_CONFIG_PATH.exists():
        with open(FALLBACK_CONFIG_PATH, "r") as f:
            data = yaml.safe_load(f) or {}
        return data.get("council") or {}
    out = {"models": models, "consensus": consensus}
    if chairman_model:
        out["chairman_model"] = chairman_model
    return out


def get_config_value(path: str, default: Any = None) -> Any:
    """
    Get config value by dotted path (e.g. 'session.ttl_seconds', 'secrets.redis_url').
    Returns default on any error or missing key. Use this to avoid duplicate try/except in consumers.
    """
    try:
        cfg = get_config()
        for part in path.split("."):
            val = getattr(cfg, part, None)
            if val is None:
                return default
            cfg = val
        return cfg._data if hasattr(cfg, "_data") else cfg
    except Exception:
        return default
