"""
Resilience utilities — shared module for graceful degradation.

Provides:
    safe_notify     — fire-and-forget notification wrapper (never raises)
    retry_async     — async retry with exponential backoff
    get_resilience_config — config-driven defaults from global.yaml

Both trainer and reviewer apps import these to keep error handling
consistent and non-blocking for non-critical operations.
"""
import asyncio
import logging
from typing import Any, Awaitable, Callable, Optional, Tuple, Type

logger = logging.getLogger(__name__)

_DEFAULT_RETRY_ATTEMPTS = 3
_DEFAULT_RETRY_BASE_DELAY = 1.0
_DEFAULT_RETRY_MAX_DELAY = 30.0
_DEFAULT_RETRY_BACKOFF_FACTOR = 2.0


def get_resilience_config() -> dict:
    """Read resilience settings from global.yaml. Returns defaults if missing."""
    try:
        from agentic_reviewer.config_loader import get_config_value
        return {
            "retry_attempts": get_config_value("resilience.retry_attempts") or _DEFAULT_RETRY_ATTEMPTS,
            "retry_base_delay": get_config_value("resilience.retry_base_delay") or _DEFAULT_RETRY_BASE_DELAY,
            "retry_max_delay": get_config_value("resilience.retry_max_delay") or _DEFAULT_RETRY_MAX_DELAY,
            "retry_backoff_factor": get_config_value("resilience.retry_backoff_factor") or _DEFAULT_RETRY_BACKOFF_FACTOR,
        }
    except Exception:
        return {
            "retry_attempts": _DEFAULT_RETRY_ATTEMPTS,
            "retry_base_delay": _DEFAULT_RETRY_BASE_DELAY,
            "retry_max_delay": _DEFAULT_RETRY_MAX_DELAY,
            "retry_backoff_factor": _DEFAULT_RETRY_BACKOFF_FACTOR,
        }


async def safe_notify(
    coro: Awaitable,
    *,
    context: str = "",
) -> None:
    """Await a notification coroutine without propagating exceptions.

    Use this to wrap fire-and-forget operations (notifications, audit writes)
    so a Redis blip doesn't fail the parent action (submit, approve, etc.).
    """
    try:
        await coro
    except Exception:
        label = f" ({context})" if context else ""
        logger.warning("Non-critical notification failed%s — swallowed", label, exc_info=True)


async def retry_async(
    fn: Callable[..., Awaitable],
    *args: Any,
    attempts: Optional[int] = None,
    base_delay: Optional[float] = None,
    max_delay: Optional[float] = None,
    backoff_factor: Optional[float] = None,
    retryable: Tuple[Type[BaseException], ...] = (Exception,),
    context: str = "",
    **kwargs: Any,
) -> Any:
    """Call an async function with exponential-backoff retries.

    Args:
        fn: Async callable to invoke.
        *args, **kwargs: Forwarded to fn.
        attempts: Total tries (1 = no retry). Falls back to config.
        base_delay: Initial delay in seconds between retries.
        max_delay: Cap on delay between retries.
        backoff_factor: Multiplier applied to delay after each attempt.
        retryable: Exception types that trigger a retry.
        context: Label for log messages.

    Returns:
        The return value of fn on success.

    Raises:
        The last exception if all attempts fail.
    """
    cfg = get_resilience_config()
    _attempts = attempts or cfg["retry_attempts"]
    _base_delay = base_delay or cfg["retry_base_delay"]
    _max_delay = max_delay or cfg["retry_max_delay"]
    _backoff = backoff_factor or cfg["retry_backoff_factor"]

    label = f" [{context}]" if context else ""
    last_exc: Optional[BaseException] = None
    delay = _base_delay

    for attempt in range(1, _attempts + 1):
        try:
            return await fn(*args, **kwargs)
        except retryable as exc:
            last_exc = exc
            if attempt == _attempts:
                logger.error(
                    "All %d attempts failed%s: %s", _attempts, label, exc,
                )
                raise
            logger.warning(
                "Attempt %d/%d failed%s: %s — retrying in %.1fs",
                attempt, _attempts, label, exc, delay,
            )
            await asyncio.sleep(delay)
            delay = min(delay * _backoff, _max_delay)

    raise last_exc  # unreachable, but satisfies type checkers


def retry_sync(
    fn: Callable[..., Any],
    *args: Any,
    attempts: Optional[int] = None,
    base_delay: Optional[float] = None,
    max_delay: Optional[float] = None,
    backoff_factor: Optional[float] = None,
    retryable: Tuple[Type[BaseException], ...] = (Exception,),
    context: str = "",
    **kwargs: Any,
) -> Any:
    """Synchronous version of retry_async. Same semantics, uses time.sleep."""
    import time

    cfg = get_resilience_config()
    _attempts = attempts or cfg["retry_attempts"]
    _base_delay = base_delay or cfg["retry_base_delay"]
    _max_delay = max_delay or cfg["retry_max_delay"]
    _backoff = backoff_factor or cfg["retry_backoff_factor"]

    label = f" [{context}]" if context else ""
    last_exc: Optional[BaseException] = None
    delay = _base_delay

    for attempt in range(1, _attempts + 1):
        try:
            return fn(*args, **kwargs)
        except retryable as exc:
            last_exc = exc
            if attempt == _attempts:
                logger.error(
                    "All %d attempts failed%s: %s", _attempts, label, exc,
                )
                raise
            logger.warning(
                "Attempt %d/%d failed%s: %s — retrying in %.1fs",
                attempt, _attempts, label, exc, delay,
            )
            time.sleep(delay)
            delay = min(delay * _backoff, _max_delay)

    raise last_exc  # unreachable, but satisfies type checkers
