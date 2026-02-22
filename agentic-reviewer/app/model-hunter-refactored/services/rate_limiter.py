"""
Rate Limiter Service

Provides semaphore-based rate limiting for API calls.
Guarantees no more than N concurrent requests per provider.

Features:
- Per-provider concurrency limits
- Request queuing (automatic via semaphore)
- Connection pooling for httpx clients
- Metrics tracking for dashboard
"""
import os
import asyncio
import time
from typing import Dict, Any, Optional, Callable, TypeVar
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime
import logging
import httpx

logger = logging.getLogger(__name__)

# Shared HTTP config
from services.http_config import POOL_LIMITS, TIMEOUTS, is_http2_available


def _get_concurrency_limits():
    """Load from global config with env override fallback."""
    from agentic_reviewer.config_loader import get_config_value
    rl = get_config_value("rate_limits") or {}
    return {
        "openrouter": int(os.getenv("OPENROUTER_CONCURRENCY") or rl.get("openrouter") or 10),
        "fireworks": int(os.getenv("FIREWORKS_CONCURRENCY") or rl.get("fireworks") or 8),
        "openai": int(os.getenv("OPENAI_CONCURRENCY") or rl.get("openai") or 12),
        "default": rl.get("default") or 6,
    }


CONCURRENCY_LIMITS = _get_concurrency_limits()


@dataclass
class ProviderMetrics:
    """Tracks metrics for a single provider."""
    total_requests: int = 0
    active_requests: int = 0
    queued_requests: int = 0
    total_latency_ms: int = 0
    errors: int = 0
    last_request_time: Optional[datetime] = None
    
    @property
    def avg_latency_ms(self) -> float:
        if self.total_requests == 0:
            return 0.0
        return self.total_latency_ms / self.total_requests


class RateLimiter:
    """
    Semaphore-based rate limiter with connection pooling.
    
    Usage:
        limiter = get_rate_limiter()
        
        async with limiter.acquire("openrouter"):
            # Make API call - guaranteed max N concurrent
            response = await client.post(...)
        
        # Or use the pooled client directly:
        client = limiter.get_client("openrouter")
        async with limiter.acquire("openrouter"):
            response = await client.post(...)
    """
    
    def __init__(self):
        self._semaphores: Dict[str, asyncio.Semaphore] = {}
        self._clients: Dict[str, httpx.AsyncClient] = {}
        self._metrics: Dict[str, ProviderMetrics] = {}
        self._lock = asyncio.Lock()
        self._initialized = False
        
        logger.info(f"Rate limiter initialized with limits: {CONCURRENCY_LIMITS}")
    
    def _get_semaphore(self, provider: str) -> asyncio.Semaphore:
        """Get or create semaphore for provider."""
        if provider not in self._semaphores:
            limit = CONCURRENCY_LIMITS.get(provider, CONCURRENCY_LIMITS["default"])
            self._semaphores[provider] = asyncio.Semaphore(limit)
            logger.info(f"Created semaphore for {provider} with limit {limit}")
        return self._semaphores[provider]
    
    def _get_metrics(self, provider: str) -> ProviderMetrics:
        """Get or create metrics for provider."""
        if provider not in self._metrics:
            self._metrics[provider] = ProviderMetrics()
        return self._metrics[provider]
    
    def get_client(self, provider: str) -> httpx.AsyncClient:
        """
        Get a pooled HTTP client for the provider.
        
        Clients are reused to avoid TCP connection overhead.
        """
        if provider not in self._clients:
            timeout = TIMEOUTS.get(provider, TIMEOUTS["default"])
            # Use shared HTTP/2 availability check
            use_http2 = is_http2_available()
            
            self._clients[provider] = httpx.AsyncClient(
                limits=POOL_LIMITS,
                timeout=timeout,
                http2=use_http2
            )
            logger.info(f"Created pooled HTTP client for {provider} (HTTP/2: {use_http2})")
        return self._clients[provider]
    
    @asynccontextmanager
    async def acquire(self, provider: str):
        """
        Acquire a slot for making an API call.
        
        This is a context manager that:
        1. Waits if at concurrency limit (requests queue automatically)
        2. Tracks metrics
        3. Releases slot when done
        
        Usage:
            async with limiter.acquire("openrouter"):
                # Make your API call here
                response = await client.post(...)
        """
        semaphore = self._get_semaphore(provider)
        metrics = self._get_metrics(provider)
        
        # Track queued state
        metrics.queued_requests += 1
        queue_start = time.time()
        
        try:
            # Wait for available slot
            await semaphore.acquire()
            
            queue_time_ms = int((time.time() - queue_start) * 1000)
            if queue_time_ms > 100:  # Log if waited more than 100ms
                logger.info(f"Request for {provider} waited {queue_time_ms}ms in queue")
            
            # Update metrics
            metrics.queued_requests -= 1
            metrics.active_requests += 1
            metrics.total_requests += 1
            metrics.last_request_time = datetime.utcnow()
            
            request_start = time.time()
            
            try:
                yield
            except Exception as e:
                metrics.errors += 1
                raise
            finally:
                # Track latency
                latency_ms = int((time.time() - request_start) * 1000)
                metrics.total_latency_ms += latency_ms
                metrics.active_requests -= 1
                
        finally:
            semaphore.release()
    
    async def call_with_limit(
        self,
        provider: str,
        coro_func: Callable,
        *args,
        **kwargs
    ):
        """
        Execute an async function with rate limiting.
        
        Usage:
            result = await limiter.call_with_limit(
                "openrouter",
                some_async_function,
                arg1, arg2,
                kwarg1=value1
            )
        """
        async with self.acquire(provider):
            return await coro_func(*args, **kwargs)
    
    def get_stats(self) -> Dict[str, Any]:
        """Get current rate limiter statistics."""
        stats = {
            "providers": {},
            "limits": CONCURRENCY_LIMITS.copy()
        }
        
        for provider, metrics in self._metrics.items():
            semaphore = self._semaphores.get(provider)
            limit = CONCURRENCY_LIMITS.get(provider, CONCURRENCY_LIMITS["default"])
            
            stats["providers"][provider] = {
                "limit": limit,
                "active": metrics.active_requests,
                "queued": metrics.queued_requests,
                "available": semaphore._value if semaphore else limit,
                "total_requests": metrics.total_requests,
                "errors": metrics.errors,
                "avg_latency_ms": round(metrics.avg_latency_ms, 2),
                "last_request": metrics.last_request_time.isoformat() if metrics.last_request_time else None
            }
        
        return stats
    
    def get_provider_status(self, provider: str) -> Dict[str, Any]:
        """Get status for a specific provider."""
        semaphore = self._get_semaphore(provider)
        metrics = self._get_metrics(provider)
        limit = CONCURRENCY_LIMITS.get(provider, CONCURRENCY_LIMITS["default"])
        
        return {
            "provider": provider,
            "limit": limit,
            "available": semaphore._value,
            "active": metrics.active_requests,
            "queued": metrics.queued_requests,
            "utilization_percent": round((limit - semaphore._value) / limit * 100, 1)
        }
    
    async def close(self):
        """Close all HTTP clients."""
        for provider, client in self._clients.items():
            await client.aclose()
            logger.info(f"Closed HTTP client for {provider}")
        self._clients.clear()


# Singleton instance
_rate_limiter: Optional[RateLimiter] = None


def get_rate_limiter() -> RateLimiter:
    """Get or create the rate limiter singleton."""
    global _rate_limiter
    if _rate_limiter is None:
        _rate_limiter = RateLimiter()
    return _rate_limiter


@asynccontextmanager
async def acquire_rate_limit(provider: str):
    """Convenience context manager for rate limiting."""
    async with get_rate_limiter().acquire(provider):
        yield


def get_pooled_client(provider: str) -> httpx.AsyncClient:
    """Convenience function to get a pooled HTTP client."""
    return get_rate_limiter().get_client(provider)
