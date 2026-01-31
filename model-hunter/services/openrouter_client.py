"""
OpenRouter Client Service

Handles API calls to OpenRouter for models:
- NVIDIA Nemotron-3-Nano-30B-A3B-BF16
- Qwen3-235B-A22B-Thinking-2507

Features:
- Streaming support for maximum token handling
- Configurable reasoning budget (90% default)
- Retry logic with fallback (no reasoning on fail)
- Captures thinking tokens separately
- Connection pooling for better performance
"""
import os
import json
import asyncio
import httpx
import time
import logging
from typing import Tuple, Optional, AsyncGenerator, Dict, Any
from dotenv import load_dotenv

logger = logging.getLogger(__name__)

# Telemetry import - wrapped to never fail
try:
    from services.telemetry_logger import log_api_call_start, log_api_call_end
    _telemetry_enabled = True
except ImportError:
    _telemetry_enabled = False

load_dotenv()

# Connection pool settings for better performance
POOL_LIMITS = httpx.Limits(
    max_connections=20,
    max_keepalive_connections=10,
    keepalive_expiry=30.0
)

# Timeout settings (Qwen can be slow)
DEFAULT_TIMEOUT = httpx.Timeout(180.0, connect=10.0)


class OpenRouterClient:
    """Async client for OpenRouter API with streaming, retry support, and connection pooling."""
    
    BASE_URL = "https://openrouter.ai/api/v1/chat/completions"
    
    # Model configurations - Exact model names from OpenRouter
    MODELS = {
        "nemotron": "nvidia/nemotron-3-nano-30b-a3b",
        "qwen3": "qwen/qwen3-235b-a22b-thinking-2507",
    }
    
    # Default max tokens per model (actual model capabilities)
    MAX_TOKENS = {
        "nvidia/nemotron-3-nano-30b-a3b": 32768,  # 32k actual capability
        "qwen/qwen3-235b-a22b-thinking-2507": 131072,  # 128k actual capability
    }
    
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.getenv("OPENROUTER_API_KEY")
        if not self.api_key:
            raise ValueError("OpenRouter API key not found. Set OPENROUTER_API_KEY in .env")
        
        # Pooled HTTP client for better performance
        self._client: Optional[httpx.AsyncClient] = None
        self._client_lock = asyncio.Lock()
    
    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create the pooled HTTP client."""
        if self._client is None or self._client.is_closed:
            async with self._client_lock:
                if self._client is None or self._client.is_closed:
                    self._client = httpx.AsyncClient(
                        limits=POOL_LIMITS,
                        timeout=DEFAULT_TIMEOUT,
                        http2=True
                    )
                    logger.info("Created pooled HTTP client for OpenRouter")
        return self._client
    
    async def close(self):
        """Close the HTTP client."""
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None
    
    def _get_headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:8000",
            "X-Title": "Model Hunter"
        }
    
    def _get_max_tokens(self, model: str) -> int:
        return self.MAX_TOKENS.get(model, 8192)
    
    def _parse_think_tags(self, content: str) -> Tuple[str, str]:
        """
        Parse reasoning tags from content.
        Handles multiple tag variations: <think>, <reasoning>, <REASONING>, etc.
        Returns (cleaned_content, extracted_reasoning).
        """
        import re
        
        if not content:
            return content, ""
        
        # List of tag patterns to try (case-insensitive, handles spaces)
        # Order matters - try most specific first
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
                # Remove the entire tag block from content
                cleaned_content = re.sub(pattern, '', content, flags=re.DOTALL | re.IGNORECASE).strip()
                logger.debug(f"OpenRouter: Extracted reasoning from <{tag_name}> tags: {len(extracted_reasoning)} chars")
                return cleaned_content, extracted_reasoning
        
        # Fallback: Try splitting on closing tags only (handles malformed opening tags)
        closing_tags = ['</think>', '</thinking>', '</reasoning>', '</reason>']
        content_lower = content.lower()
        
        for closing_tag in closing_tags:
            if closing_tag in content_lower:
                # Find the actual position (case-insensitive)
                idx = content_lower.find(closing_tag)
                extracted_reasoning = content[:idx].strip()
                cleaned_content = content[idx + len(closing_tag):].strip()
                
                # Remove any opening tag variations from reasoning
                opening_patterns = [r'^<\s*think\s*>', r'^<\s*thinking\s*>', r'^<\s*reasoning\s*>', r'^<\s*reason\s*>']
                for op in opening_patterns:
                    extracted_reasoning = re.sub(op, '', extracted_reasoning, flags=re.IGNORECASE).strip()
                
                if extracted_reasoning and cleaned_content:
                    logger.debug(f"OpenRouter: Extracted reasoning via closing tag fallback: {len(extracted_reasoning)} chars")
                    return cleaned_content, extracted_reasoning
        
        return content, ""
    
    async def call_model(
        self,
        prompt: str,
        model: str,
        max_tokens: Optional[int] = None,
        reasoning_budget_percent: float = 0.9,
        stream: bool = True,
        timeout: float = 180.0  # Increased for large prompts with thinking models
    ) -> Tuple[str, str]:
        """
        Call model and return (response, reasoning_trace).
        
        Args:
            prompt: The input prompt
            model: Model identifier (full name or short name like "nemotron")
            max_tokens: Maximum tokens for response
            reasoning_budget_percent: Fraction of max_tokens for reasoning (0.9 = 90%)
            stream: Whether to stream the response
            timeout: Request timeout in seconds
        
        Returns:
            Tuple of (response_text, reasoning_trace)
        """
        # Resolve short model names
        if model.lower() in self.MODELS:
            model = self.MODELS[model.lower()]
        
        if max_tokens is None:
            max_tokens = self._get_max_tokens(model)
        
        reasoning_budget = int(max_tokens * reasoning_budget_percent)
        
        # Build messages - add system prompt only for Nemotron to separate reasoning from answer
        is_nemotron = 'nemotron' in model.lower()
        
        if is_nemotron:
            system_message = """Always put your reasoning inside <think></think> tags first, then give your final answer after the closing tag. Do not include any reasoning outside the tags."""
            
            messages = [
                {"role": "system", "content": system_message},
                {"role": "user", "content": prompt}  # Original prompt as-is
            ]
            logger.debug(f"OpenRouter: Using system prompt for Nemotron to separate reasoning")
        else:
            # Qwen and other models - no system prompt, just user message
            messages = [{"role": "user", "content": prompt}]
        
        payload = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "stream": stream,
            "temperature": 0.8 if not is_nemotron else 0.6  # Lower temp for Nemotron for consistent formatting
        }
        
        # Add reasoning parameter to control reasoning trace output
        # If reasoning_budget_percent is 0, exclude reasoning; otherwise include it
        if reasoning_budget_percent > 0:
            payload["reasoning"] = {
                "exclude": False,  # Include reasoning traces in response
                "effort": "high"  # Use high effort for reasoning
            }
        else:
            payload["reasoning"] = {
                "exclude": True  # Exclude reasoning when budget is 0
            }
        
        # Note: For thinking models, reasoning is enabled by default, but we need to
        # explicitly set exclude: false to ensure reasoning traces are included in the response
        
        # Use pooled client for better performance
        client = await self._get_client()
        if stream:
            return await self._stream_response(client, payload, timeout)
        else:
            return await self._simple_response(client, payload, timeout)
    
    async def _stream_response(
        self, 
        client: httpx.AsyncClient, 
        payload: Dict[str, Any],
        timeout: float = 180.0
    ) -> Tuple[str, str]:
        """Handle streaming response and collect chunks."""
        response_text = ""
        reasoning_trace = ""
        reasoning_by_id = {}  # Track reasoning by ID to avoid duplicates
        final_message_reasoning = None  # Store final message reasoning if present
        
        # Debug: Log payload (use logger instead of print)
        logger.debug(f"OpenRouter: Payload includes reasoning: {payload.get('reasoning', 'NOT FOUND')}")
        
        try:
            async with client.stream(
                "POST",
                self.BASE_URL,
                headers=self._get_headers(),
                json=payload,
                timeout=timeout
            ) as response:
                # Check for HTTP errors first
                if response.status_code >= 400:
                    error_body = await response.aread()
                    raise httpx.HTTPStatusError(
                        f"HTTP {response.status_code}",
                        request=response.request,
                        response=response
                    )
                
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    if line.startswith("data: "):
                        data = line[6:]
                        if data == "[DONE]":
                            break
                        
                        try:
                            chunk = json.loads(data)
                            
                            # Check for API error in response
                            if "error" in chunk:
                                error_msg = chunk["error"].get("message", str(chunk["error"]))
                                raise ValueError(f"API Error: {error_msg}")
                            
                            choices = chunk.get("choices", [])
                            if choices:
                                delta = choices[0].get("delta", {})
                                message = choices[0].get("message", {})
                                
                                # Check for final message with reasoning_details (authoritative source)
                                if message and "reasoning_details" in message and message["reasoning_details"]:
                                    # Final message has complete reasoning - store it and use at the end
                                    final_message_reasoning = message["reasoning_details"]
                                    logger.debug(f"OpenRouter: Found final reasoning_details in message: {len(final_message_reasoning)} items")
                                
                                # During streaming, collect incremental reasoning from delta
                                # But only if we haven't seen the final message yet
                                if delta and not final_message_reasoning:
                                    # Check for reasoning_details array (OpenRouter streaming format)
                                    if "reasoning_details" in delta and delta["reasoning_details"]:
                                        for detail in delta["reasoning_details"]:
                                            if isinstance(detail, dict):
                                                detail_id = detail.get("id", None)
                                                detail_text = detail.get("text", "")
                                                
                                                if detail_id and detail_text:
                                                    # Track by ID - only keep the LONGEST version (most complete)
                                                    # This handles cumulative text where each chunk contains full text so far
                                                    current_text = reasoning_by_id.get(detail_id, "")
                                                    if len(detail_text) > len(current_text):
                                                        reasoning_by_id[detail_id] = detail_text
                                                        logger.debug(f"OpenRouter: Updated reasoning detail {detail_id}: {len(detail_text)} chars")
                                    
                                    # Also check for direct reasoning/thinking fields (fallback - incremental)
                                    if "reasoning" in delta and delta["reasoning"]:
                                        reasoning_trace += delta["reasoning"]
                                    if "thinking" in delta and delta["thinking"]:
                                        reasoning_trace += delta["thinking"]
                                
                                # Handle content
                                if delta and "content" in delta and delta["content"]:
                                    response_text += delta["content"]
                                
                                # Check for direct reasoning/thinking in final message (fallback)
                                if message and not final_message_reasoning:
                                    if "reasoning" in message and message["reasoning"]:
                                        reasoning_trace += message["reasoning"]
                                    elif "thinking" in message and message["thinking"]:
                                        reasoning_trace += message["thinking"]
                            
                        except json.JSONDecodeError:
                            continue
                
                # Build final reasoning trace
                if final_message_reasoning:
                    # Use final message reasoning (authoritative, no duplicates)
                    reasoning_parts = []
                    for detail in final_message_reasoning:
                        if isinstance(detail, dict) and "text" in detail:
                            reasoning_parts.append(detail["text"])
                    reasoning_trace = "".join(reasoning_parts)
                    logger.debug(f"OpenRouter: Using final message reasoning: {len(reasoning_trace)} chars")
                elif reasoning_by_id:
                    # Use reasoning collected from deltas (deduplicated by ID)
                    sorted_ids = sorted(reasoning_by_id.keys())
                    reasoning_trace = "".join([reasoning_by_id[id] for id in sorted_ids])
                    logger.debug(f"OpenRouter: Using delta reasoning (deduplicated): {len(reasoning_trace)} chars from {len(reasoning_by_id)} details")
        except httpx.HTTPStatusError as e:
            # Re-raise with more context
            raise
        
        response_text = response_text.strip()
        reasoning_trace = reasoning_trace.strip()
        
        # Parse <think>...</think> tags from content (for Nemotron with system prompt)
        # This extracts reasoning from content and cleans the response
        response_text, extracted_reasoning = self._parse_think_tags(response_text)
        if extracted_reasoning and not reasoning_trace:
            reasoning_trace = extracted_reasoning
            logger.debug(f"OpenRouter: Extracted reasoning from <think> tags: {len(reasoning_trace)} chars")
        elif extracted_reasoning and reasoning_trace:
            # Prefer extracted reasoning if API reasoning is empty or much shorter
            if len(extracted_reasoning) > len(reasoning_trace):
                reasoning_trace = extracted_reasoning
                logger.debug(f"OpenRouter: Using <think> tag reasoning (longer than API reasoning)")
        
        # No backend deduplication - frontend handles UI display
        # Export gets the full original trace
            
        return response_text, reasoning_trace
    
    async def _simple_response(
        self, 
        client: httpx.AsyncClient, 
        payload: Dict[str, Any],
        timeout: float = 180.0
    ) -> Tuple[str, str]:
        """Handle non-streaming response."""
        payload["stream"] = False
        
        # Debug: Log payload
        logger.debug(f"OpenRouter: Payload includes reasoning: {payload.get('reasoning', 'NOT FOUND')}")
        
        response = await client.post(
            self.BASE_URL,
            headers=self._get_headers(),
            json=payload,
            timeout=timeout
        )
        response.raise_for_status()
        
        data = response.json()
        
        # Debug: Print response structure
        logger.debug(f"OpenRouter: Response keys: {list(data.keys())}")
        if "choices" in data and data["choices"]:
            choice = data["choices"][0]
            logger.debug(f"OpenRouter: Choice keys: {list(choice.keys())}")
            message = choice.get("message", {})
            logger.debug(f"OpenRouter: Message keys: {list(message.keys())}")
            if "reasoning" in message:
                logger.debug(f"OpenRouter: Found reasoning in message: {len(str(message['reasoning']))} chars")
            if "thinking" in message:
                logger.debug(f"OpenRouter: Found thinking in message: {len(str(message['thinking']))} chars")
        
        # Check for API errors
        if "error" in data:
            error_msg = data["error"].get("message", str(data["error"]))
            raise ValueError(f"API Error: {error_msg}")
        
        choice = data.get("choices", [{}])[0]
        message = choice.get("message", {})
        
        response_text = message.get("content", "") or ""
        
        # Extract reasoning - check multiple possible formats
        reasoning_trace = ""
        
        # Check for reasoning_details array (OpenRouter format)
        if "reasoning_details" in message and message["reasoning_details"]:
            logger.debug(f"OpenRouter: Found reasoning_details array with {len(message['reasoning_details'])} items")
            for detail in message["reasoning_details"]:
                if isinstance(detail, dict) and "text" in detail:
                    reasoning_trace += detail["text"]
        
        # Fallback to direct reasoning/thinking fields
        if not reasoning_trace:
            reasoning_trace = message.get("reasoning", "") or message.get("thinking", "") or ""
        
        # Debug: Print what we extracted
        logger.debug(f"OpenRouter: Extracted response_text: {len(response_text)} chars")
        logger.debug(f"OpenRouter: Extracted reasoning_trace: {len(reasoning_trace)} chars")
        
        # Parse <think>...</think> tags from content (for Nemotron with system prompt)
        response_text, extracted_reasoning = self._parse_think_tags(response_text)
        if extracted_reasoning and not reasoning_trace:
            reasoning_trace = extracted_reasoning
            logger.debug(f"OpenRouter: Extracted reasoning from <think> tags: {len(reasoning_trace)} chars")
        elif extracted_reasoning and reasoning_trace:
            # Prefer extracted reasoning if API reasoning is empty or much shorter
            if len(extracted_reasoning) > len(reasoning_trace):
                reasoning_trace = extracted_reasoning
                logger.debug(f"OpenRouter: Using <think> tag reasoning (longer than API reasoning)")
        
        # No backend deduplication - frontend handles UI display
        # Export gets the full original trace

        return response_text.strip(), reasoning_trace.strip()
    
    async def call_with_retry(
        self,
        prompt: str,
        model: str,
        max_retries: int = 3,
        reasoning_budget_percent: float = 0.9,
        timeout: float = 120.0
    ) -> Tuple[str, str, Optional[str]]:
        """
        Call model with retry logic.
        
        On empty or error response:
        1. First retries with same settings
        2. If still failing, retry without reasoning tokens
        3. Capture all reasoning and resend asking for response only
        
        Returns:
            Tuple of (response_text, reasoning_trace, error_message)
        """
        last_error = None
        accumulated_reasoning = ""
        
        # Telemetry: Log API call start
        _start_time = time.time()
        if _telemetry_enabled:
            try:
                log_api_call_start("openrouter", model)
            except Exception:
                pass
        
        for attempt in range(max_retries):
            try:
                response, reasoning = await self.call_model(
                    prompt=prompt,
                    model=model,
                    reasoning_budget_percent=reasoning_budget_percent if attempt < max_retries - 1 else 0,
                    timeout=timeout
                )
                
                if reasoning:
                    accumulated_reasoning += reasoning + "\n"
                
                # Check for valid response
                if response.strip():
                    # Telemetry: Log successful API call
                    if _telemetry_enabled:
                        try:
                            # Estimate tokens (rough: 1 token ≈ 4 chars)
                            tokens_in = len(prompt) // 4
                            tokens_out = len(response) // 4
                            log_api_call_end("openrouter", model, _start_time, success=True,
                                           tokens_in=tokens_in, tokens_out=tokens_out)
                        except Exception:
                            pass
                    return response, accumulated_reasoning.strip(), None
                
                # For thinking models: if content is empty but we have reasoning,
                # the reasoning IS the response - use it
                if reasoning.strip() and not response.strip():
                    # Telemetry: Log successful API call (reasoning as response)
                    if _telemetry_enabled:
                        try:
                            tokens_in = len(prompt) // 4
                            tokens_out = len(reasoning) // 4
                            log_api_call_end("openrouter", model, _start_time, success=True,
                                           tokens_in=tokens_in, tokens_out=tokens_out)
                        except Exception:
                            pass
                    return reasoning, accumulated_reasoning.strip(), None
                
                # Empty response - if we have reasoning, try to get response from it
                if accumulated_reasoning and attempt < max_retries - 1:
                    # Send accumulated reasoning back and ask for final response
                    retry_prompt = (
                        f"Based on your previous reasoning:\n\n{accumulated_reasoning}\n\n"
                        f"Please provide your final response to this question:\n\n{prompt}\n\n"
                        f"Give only the final answer, no additional reasoning."
                    )
                    
                    response, _ = await self.call_model(
                        prompt=retry_prompt,
                        model=model,
                        reasoning_budget_percent=0,
                        timeout=timeout
                    )
                    
                    if response.strip():
                        # Telemetry: Log successful API call (after retry with reasoning)
                        if _telemetry_enabled:
                            try:
                                log_api_call_end("openrouter", model, _start_time, success=True)
                            except Exception:
                                pass
                        return response, accumulated_reasoning, None
                
            except httpx.HTTPStatusError as e:
                try:
                    error_body = e.response.text if hasattr(e.response, 'text') else str(e)
                    last_error = f"HTTP {e.response.status_code}: {error_body}"
                except:
                    last_error = f"HTTP Error: {str(e)}"
            except httpx.TimeoutException:
                last_error = f"Request timed out after {timeout}s"
            except ValueError as e:
                # API errors from streaming
                last_error = str(e)
            except Exception as e:
                last_error = f"Error: {str(e)}"
            
            # Wait before retry with exponential backoff
            if attempt < max_retries - 1:
                await asyncio.sleep(2 ** attempt)
        
        # Telemetry: Log failed API call
        if _telemetry_enabled:
            try:
                log_api_call_end("openrouter", model, _start_time, success=False, 
                                error=last_error or "Empty response after all retries")
            except Exception:
                pass
        
        return "", accumulated_reasoning, last_error or "Empty response after all retries"
    
    def get_available_models(self) -> Dict[str, str]:
        """Return available models."""
        return self.MODELS.copy()


# Singleton instance
openrouter_client = None

def get_openrouter_client(api_key: Optional[str] = None) -> OpenRouterClient:
    """Get or create OpenRouter client instance."""
    global openrouter_client
    if openrouter_client is None or api_key:
        openrouter_client = OpenRouterClient(api_key)
    return openrouter_client
