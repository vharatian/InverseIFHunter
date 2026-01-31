"""
Fast JSON module - Uses orjson for speed with stdlib json fallback.

orjson is 3-10x faster than stdlib json for parsing and serialization.
This module provides a unified interface that works regardless of which is available.

Usage:
    from services.fast_json import json_loads, json_dumps, JSONDecodeError
    
    data = json_loads(json_string)
    json_string = json_dumps(data)
"""
import json as stdlib_json  # Always import for JSONDecodeError fallback
import logging

logger = logging.getLogger(__name__)

# Try to import orjson, fall back to stdlib json
try:
    import orjson
    _ORJSON_AVAILABLE = True
    JSONDecodeError = orjson.JSONDecodeError
    logger.info("orjson available - using fast JSON parsing")
except ImportError:
    orjson = None
    _ORJSON_AVAILABLE = False
    JSONDecodeError = stdlib_json.JSONDecodeError
    logger.warning("orjson not installed - using stdlib json (slower)")


def json_loads(data):
    """
    Parse JSON string/bytes to Python object.
    Uses orjson if available (3-10x faster).
    """
    if _ORJSON_AVAILABLE:
        return orjson.loads(data)
    else:
        if isinstance(data, bytes):
            data = data.decode('utf-8')
        return stdlib_json.loads(data)


def json_dumps(obj, pretty=False) -> str:
    """
    Serialize Python object to JSON string.
    Uses orjson if available (3-10x faster).
    
    Args:
        obj: Python object to serialize
        pretty: If True, format with indentation (slower)
    
    Returns:
        JSON string (not bytes)
    """
    if _ORJSON_AVAILABLE:
        options = orjson.OPT_INDENT_2 if pretty else 0
        # orjson.dumps returns bytes, decode to str for compatibility
        return orjson.dumps(obj, option=options).decode('utf-8')
    else:
        if pretty:
            return stdlib_json.dumps(obj, indent=2, default=str)
        return stdlib_json.dumps(obj, default=str)


def json_dumps_bytes(obj) -> bytes:
    """
    Serialize Python object to JSON bytes.
    Useful for HTTP responses where bytes are preferred.
    """
    if _ORJSON_AVAILABLE:
        return orjson.dumps(obj)
    else:
        return stdlib_json.dumps(obj, default=str).encode('utf-8')


def is_orjson_available() -> bool:
    """Check if orjson is being used."""
    return _ORJSON_AVAILABLE
