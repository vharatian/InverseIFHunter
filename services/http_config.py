"""
HTTP Configuration - Shared settings for HTTP clients.

Centralizes connection pool settings and timeouts to avoid duplication
across fireworks_client, openrouter_client, and rate_limiter.

OPTIMIZED FOR SPEED:
- Larger connection pool for more parallel requests
- Longer keepalive to reuse connections
- HTTP/2 multiplexing enabled
- Fast connect timeout, generous read timeout
"""
import httpx
import logging

logger = logging.getLogger(__name__)

def _get_pool_limits():
    from agentic_reviewer.config_loader import get_config_value
    h = get_config_value("http") or {}
    return httpx.Limits(
        max_connections=h.get("max_connections") or 50,
        max_keepalive_connections=h.get("max_keepalive_connections") or 30,
        keepalive_expiry=float(h.get("keepalive_expiry") or 60.0),
    )


def _get_timeouts():
    def _mk(read: float, connect: float = 5.0):
        return httpx.Timeout(read, connect=connect)

    from agentic_reviewer.config_loader import get_config_value
    t = get_config_value("http") or {}
    timeouts = t.get("timeouts") or {}
    def _t(name: str, r: float, c: float = 5.0):
        to = timeouts.get(name) or {}
        return _mk(float(to.get("read") or r), float(to.get("connect") or c))

    return {
        "openrouter": _t("openrouter", 180),
        "fireworks": _t("fireworks", 120),
        "openai": _t("openai", 60),
        "default": _mk(120.0, 5.0),
    }


POOL_LIMITS = _get_pool_limits()
TIMEOUTS = _get_timeouts()


def check_http2_support() -> bool:
    """Check if h2 package is available for HTTP/2 support."""
    try:
        import h2
        return True
    except ImportError:
        return False


# Cache the HTTP/2 support check
_HTTP2_AVAILABLE = None


def is_http2_available() -> bool:
    """
    HTTP/2 is disabled to avoid ConnectionTerminated errors.
    
    OpenRouter closes HTTP/2 connections after ~500 requests (GOAWAY frame),
    which kills all in-flight requests on that connection. HTTP/1.1 uses
    separate connections per request, avoiding this issue entirely.
    """
    global _HTTP2_AVAILABLE
    if _HTTP2_AVAILABLE is None:
        _HTTP2_AVAILABLE = False  # Force HTTP/1.1 to avoid ConnectionTerminated errors
        logger.info("HTTP/2 disabled - using HTTP/1.1 to avoid connection termination errors")
    return _HTTP2_AVAILABLE


def create_async_client(
    provider: str = "default",
    timeout: httpx.Timeout = None
) -> httpx.AsyncClient:
    """
    Create a configured async HTTP client with pooling and optional HTTP/2.
    
    Args:
        provider: Provider name for timeout lookup ("openrouter", "fireworks", "openai")
        timeout: Optional custom timeout (overrides provider default)
    
    Returns:
        Configured httpx.AsyncClient
    """
    if timeout is None:
        timeout = TIMEOUTS.get(provider, TIMEOUTS["default"])
    
    use_http2 = is_http2_available()
    
    client = httpx.AsyncClient(
        limits=POOL_LIMITS,
        timeout=timeout,
        http2=use_http2
    )
    
    logger.info(f"Created HTTP client for {provider} (HTTP/2: {use_http2})")
    return client


# ============== Connection Warm-up ==============

# Provider endpoints for warm-up (lightweight health/models endpoints)
WARMUP_ENDPOINTS = {
    "openrouter": "https://openrouter.ai/api/v1/models",
    "fireworks": "https://api.fireworks.ai/inference/v1/models",
    "openai": "https://api.openai.com/v1/models",
}


async def warmup_connection(client: httpx.AsyncClient, provider: str, api_key: str) -> bool:
    """
    Warm up a connection by making a lightweight request.
    This pre-establishes TCP + TLS, so actual API calls are faster.
    
    Args:
        client: The httpx client to warm up
        provider: Provider name
        api_key: API key for authentication
    
    Returns:
        True if warm-up successful, False otherwise
    """
    endpoint = WARMUP_ENDPOINTS.get(provider)
    if not endpoint:
        return False
    
    try:
        headers = {"Authorization": f"Bearer {api_key}"}
        # Use a short timeout for warm-up - we just want to establish connection
        response = await client.get(
            endpoint, 
            headers=headers, 
            timeout=httpx.Timeout(10.0, connect=5.0)
        )
        logger.info(f"Connection warm-up for {provider}: {response.status_code}")
        return response.status_code in (200, 401, 403)  # Even auth errors mean connection works
    except Exception as e:
        logger.warning(f"Connection warm-up failed for {provider}: {e}")
        return False


async def warmup_all_connections(providers: list = None) -> dict:
    """
    Warm up connections to all (or specified) providers.
    Call this when notebook is loaded to pre-establish connections.
    
    Args:
        providers: List of provider names, or None for all
    
    Returns:
        Dict of {provider: success_bool}
    """
    import os
    from dotenv import load_dotenv
    load_dotenv()

    def _get_api_key(provider: str) -> str:
        from agentic_reviewer.config_loader import get_config_value
        secrets = get_config_value("secrets") or {}
        key_map = {"openrouter": "openrouter_api_key", "fireworks": "fireworks_api_key", "openai": "openai_api_key"}
        env_map = {"openrouter": "OPENROUTER_API_KEY", "fireworks": "FIREWORKS_API_KEY", "openai": "OPENAI_API_KEY"}
        return (secrets.get(key_map.get(provider, "")) or "") or os.getenv(env_map.get(provider, ""), "")

    if providers is None:
        providers = ["openrouter", "fireworks", "openai"]

    results = {}
    api_keys = {p: _get_api_key(p) for p in providers}
    
    # Create clients and warm up in parallel
    import asyncio
    
    async def warmup_one(provider: str):
        if not api_keys.get(provider):
            return provider, False
        
        client = create_async_client(provider)
        try:
            success = await warmup_connection(client, provider, api_keys[provider])
            return provider, success
        finally:
            await client.aclose()
    
    tasks = [warmup_one(p) for p in providers if p in WARMUP_ENDPOINTS]
    warmup_results = await asyncio.gather(*tasks, return_exceptions=True)
    
    for result in warmup_results:
        if isinstance(result, tuple):
            provider, success = result
            results[provider] = success
        else:
            logger.error(f"Warm-up error: {result}")
    
    logger.info(f"Connection warm-up results: {results}")
    return results
