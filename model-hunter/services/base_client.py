"""
Base API Client

Provides shared functionality for API clients:
- HTTP connection pooling with async client management
- Telemetry wrapper for API call logging
- Reasoning tag parsing (for <think>, <reasoning>, etc.)
- Standard retry logic with exponential backoff

Used by: FireworksClient, OpenRouterClient
"""
import os
import asyncio
import httpx
import time
import logging
import re
from abc import ABC, abstractmethod
from typing import Tuple, Optional, Dict, Any

logger = logging.getLogger(__name__)

# Telemetry import - wrapped to never fail
try:
    from services.telemetry_logger import log_api_call_start, log_api_call_end
    _telemetry_enabled = True
except ImportError:
    _telemetry_enabled = False

# Shared HTTP config
from services.http_config import POOL_LIMITS, TIMEOUTS, is_http2_available


class BaseAPIClient(ABC):
    """
    Abstract base class for API clients with connection pooling and telemetry.
    
    Subclasses must implement:
    - BASE_URL: The API endpoint URL
    - PROVIDER_NAME: Name used for telemetry and logging (e.g., "fireworks", "openrouter")
    - _get_headers(): Returns dict of HTTP headers
    - call_model(): Makes the actual API call
    """
    
    BASE_URL: str = ""
    PROVIDER_NAME: str = ""
    
    def __init__(self, api_key: Optional[str] = None, env_var_name: str = "API_KEY"):
        """
        Initialize the client.
        
        Args:
            api_key: Optional API key (overrides environment variable)
            env_var_name: Name of the environment variable to read API key from
        """
        self.api_key = api_key or os.getenv(env_var_name)
        self._client: Optional[httpx.AsyncClient] = None
        self._client_lock = asyncio.Lock()
        self._default_timeout = TIMEOUTS.get(self.PROVIDER_NAME, TIMEOUTS["default"])
    
    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create the pooled HTTP client (thread-safe)."""
        if self._client is None or self._client.is_closed:
            async with self._client_lock:
                if self._client is None or self._client.is_closed:
                    use_http2 = is_http2_available()
                    self._client = httpx.AsyncClient(
                        limits=POOL_LIMITS,
                        timeout=self._default_timeout,
                        http2=use_http2
                    )
                    logger.info(f"Created pooled HTTP client for {self.PROVIDER_NAME} (HTTP/2: {use_http2})")
        return self._client
    
    async def close(self):
        """Close the HTTP client."""
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None
    
    @abstractmethod
    def _get_headers(self) -> Dict[str, str]:
        """Return HTTP headers for API requests. Must be implemented by subclass."""
        pass
    
    @abstractmethod
    async def call_model(
        self,
        prompt: str,
        model: str,
        **kwargs
    ) -> Tuple[str, str]:
        """
        Make API call to the model.
        
        Args:
            prompt: The input prompt
            model: Model identifier
            **kwargs: Additional provider-specific arguments
        
        Returns:
            Tuple of (response_text, reasoning_trace)
        """
        pass
    
    def parse_think_tags(self, content: str) -> Tuple[str, str]:
        """
        Parse reasoning tags from content.
        Handles multiple tag variations: <think>, <reasoning>, <thinking>, etc.
        
        Args:
            content: The raw response content
        
        Returns:
            Tuple of (cleaned_content, extracted_reasoning)
        """
        if not content:
            return content, ""
        
        # List of tag patterns to try (case-insensitive, handles spaces)
        tag_patterns = [
            (r'<\s*think\s*>(.*?)<\s*/\s*think\s*>', 'think'),
            (r'<\s*thinking\s*>(.*?)<\s*/\s*thinking\s*>', 'thinking'),
            (r'<\s*reasoning\s*>(.*?)<\s*/\s*reasoning\s*>', 'reasoning'),
            (r'<\s*reason\s*>(.*?)<\s*/\s*reason\s*>', 'reason'),
        ]
        
        # Try each pattern (case-insensitive)
        for pattern, tag_name in tag_patterns:
            match = re.search(pattern, content, re.DOTALL | re.IGNORECASE)
            if match:
                extracted_reasoning = match.group(1).strip()
                cleaned_content = re.sub(pattern, '', content, flags=re.DOTALL | re.IGNORECASE).strip()
                logger.debug(f"{self.PROVIDER_NAME}: Extracted reasoning from <{tag_name}> tags: {len(extracted_reasoning)} chars")
                return cleaned_content, extracted_reasoning
        
        # Fallback: Try splitting on closing tags only (handles malformed opening tags)
        closing_tags = ['</think>', '</thinking>', '</reasoning>', '</reason>']
        content_lower = content.lower()
        
        for closing_tag in closing_tags:
            if closing_tag in content_lower:
                idx = content_lower.find(closing_tag)
                extracted_reasoning = content[:idx].strip()
                cleaned_content = content[idx + len(closing_tag):].strip()
                
                # Remove any opening tag variations from reasoning
                opening_patterns = [r'^<\s*think\s*>', r'^<\s*thinking\s*>', r'^<\s*reasoning\s*>', r'^<\s*reason\s*>']
                for op in opening_patterns:
                    extracted_reasoning = re.sub(op, '', extracted_reasoning, flags=re.IGNORECASE).strip()
                
                if extracted_reasoning and cleaned_content:
                    logger.debug(f"{self.PROVIDER_NAME}: Extracted reasoning via closing tag fallback: {len(extracted_reasoning)} chars")
                    return cleaned_content, extracted_reasoning
        
        return content, ""
    
    async def call_with_retry(
        self,
        prompt: str,
        model: str,
        max_retries: int = 3,
        timeout: float = 120.0,
        **kwargs
    ) -> Tuple[str, str, Optional[str]]:
        """
        Call model with retry logic and telemetry.
        
        Args:
            prompt: The input prompt
            model: Model identifier
            max_retries: Number of retry attempts
            timeout: Request timeout in seconds
            **kwargs: Additional arguments passed to call_model
        
        Returns:
            Tuple of (response_text, reasoning_trace, error_message)
        """
        last_error = None
        accumulated_reasoning = ""
        
        # Telemetry: Log API call start
        _start_time = time.time()
        if _telemetry_enabled:
            try:
                log_api_call_start(self.PROVIDER_NAME, model)
            except Exception:
                pass
        
        for attempt in range(max_retries):
            try:
                response_text, reasoning = await self.call_model(
                    prompt=prompt,
                    model=model,
                    timeout=timeout,
                    **kwargs
                )
                
                # Accumulate reasoning
                if reasoning and reasoning.strip():
                    if not accumulated_reasoning:
                        accumulated_reasoning = reasoning
                    elif reasoning not in accumulated_reasoning:
                        accumulated_reasoning += "\n" + reasoning
                
                # Success: got a response
                if response_text and response_text.strip():
                    if _telemetry_enabled:
                        try:
                            tokens_in = len(prompt) // 4
                            tokens_out = len(response_text) // 4
                            log_api_call_end(self.PROVIDER_NAME, model, _start_time, success=True,
                                           tokens_in=tokens_in, tokens_out=tokens_out)
                        except Exception:
                            pass
                    return response_text, (reasoning.strip() if reasoning else accumulated_reasoning.strip()), None
                
                # For thinking models: if content is empty but we have reasoning,
                # the reasoning IS the response
                if reasoning and reasoning.strip() and not response_text.strip():
                    if _telemetry_enabled:
                        try:
                            log_api_call_end(self.PROVIDER_NAME, model, _start_time, success=True)
                        except Exception:
                            pass
                    return reasoning, reasoning.strip(), None
                
            except httpx.HTTPStatusError as e:
                try:
                    error_body = e.response.text if hasattr(e.response, 'text') else str(e)
                    last_error = f"HTTP {e.response.status_code}: {error_body}"
                except:
                    last_error = f"HTTP Error: {str(e)}"
            except httpx.TimeoutException:
                last_error = f"Request timed out after {timeout}s"
            except ValueError as e:
                last_error = str(e)
            except Exception as e:
                last_error = f"Error: {str(e)}"
            
            # Exponential backoff before retry
            if attempt < max_retries - 1:
                await asyncio.sleep(2 ** attempt)
        
        # Telemetry: Log failed API call
        if _telemetry_enabled:
            try:
                log_api_call_end(self.PROVIDER_NAME, model, _start_time, success=False,
                                error=last_error or "Empty response")
            except Exception:
                pass
        
        return "", accumulated_reasoning.strip(), last_error or "Empty response"


# ============== Singleton Helper ==============

def create_singleton_getter(client_class, env_var_name: str):
    """
    Factory to create a singleton getter function for API clients.
    
    Usage:
        get_my_client = create_singleton_getter(MyClient, "MY_API_KEY")
    
    Returns a function that returns a singleton instance of the client.
    """
    _instance = None
    
    def getter(api_key: Optional[str] = None):
        nonlocal _instance
        if _instance is None or api_key:
            _instance = client_class(api_key)
        return _instance
    
    return getter
