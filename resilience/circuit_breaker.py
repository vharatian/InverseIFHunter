"""
Per-provider circuit breaker (design spec §9.3).

States: CLOSED (normal) → OPEN (fast-fail) → HALF_OPEN (test one request)
"""
import asyncio
import logging
import time
from enum import Enum

logger = logging.getLogger(__name__)


class CircuitState(str, Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


class CircuitBreaker:
    def __init__(
        self,
        name: str,
        failure_threshold: int = 5,
        success_threshold: int = 2,
        half_open_timeout: float = 30.0,
        reset_timeout: float = 120.0,
    ):
        self.name = name
        self.failure_threshold = failure_threshold
        self.success_threshold = success_threshold
        self.half_open_timeout = half_open_timeout
        self.reset_timeout = reset_timeout

        self._state = CircuitState.CLOSED
        self._failure_count = 0
        self._success_count = 0
        self._last_failure_time: float = 0
        self._lock = asyncio.Lock()

    @property
    def state(self) -> CircuitState:
        if self._state == CircuitState.OPEN:
            if time.monotonic() - self._last_failure_time > self.half_open_timeout:
                return CircuitState.HALF_OPEN
        return self._state

    async def record_success(self):
        async with self._lock:
            if self._state == CircuitState.HALF_OPEN:
                self._success_count += 1
                if self._success_count >= self.success_threshold:
                    self._state = CircuitState.CLOSED
                    self._failure_count = 0
                    self._success_count = 0
                    logger.info(f"Circuit breaker {self.name}: CLOSED (recovered)")
            elif self._state == CircuitState.CLOSED:
                self._failure_count = max(0, self._failure_count - 1)

    async def record_failure(self):
        async with self._lock:
            self._failure_count += 1
            self._last_failure_time = time.monotonic()
            if self._state == CircuitState.HALF_OPEN:
                self._state = CircuitState.OPEN
                self._success_count = 0
                logger.warning(f"Circuit breaker {self.name}: OPEN (half-open test failed)")
            elif self._failure_count >= self.failure_threshold:
                self._state = CircuitState.OPEN
                logger.warning(f"Circuit breaker {self.name}: OPEN ({self._failure_count} failures)")

    def is_call_allowed(self) -> bool:
        state = self.state
        if state == CircuitState.CLOSED:
            return True
        if state == CircuitState.HALF_OPEN:
            return True
        return False

    def get_status(self) -> dict:
        return {
            "name": self.name,
            "state": self.state.value,
            "failure_count": self._failure_count,
            "success_count": self._success_count,
        }


_breakers: dict[str, CircuitBreaker] = {}


def get_circuit_breaker(provider: str) -> CircuitBreaker:
    if provider not in _breakers:
        _breakers[provider] = CircuitBreaker(name=provider)
    return _breakers[provider]


def get_all_circuit_status() -> dict[str, dict]:
    return {name: cb.get_status() for name, cb in _breakers.items()}
