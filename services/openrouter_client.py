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
"""
import os
import json
import asyncio
import httpx
from typing import Tuple, Optional, AsyncGenerator, Dict, Any
from dotenv import load_dotenv

load_dotenv()


class OpenRouterClient:
    """Async client for OpenRouter API with streaming and retry support."""
    
    BASE_URL = "https://openrouter.ai/api/v1/chat/completions"
    
    # Model configurations - Exact model names from OpenRouter
    MODELS = {
        "nemotron": "nvidia/nemotron-3-nano-30b-a3b:free",
        "qwen3": "qwen/qwen3-235b-a22b-thinking-2507",
    }
    
    # Default max tokens per model (approximate)
    MAX_TOKENS = {
        "nvidia/nemotron-3-nano-30b-a3b:free": 8192,
        "qwen/qwen3-235b-a22b-thinking-2507": 16384,
    }
    
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.getenv("OPENROUTER_API_KEY")
        if not self.api_key:
            raise ValueError("OpenRouter API key not found. Set OPENROUTER_API_KEY in .env")
    
    def _get_headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:8000",
            "X-Title": "Model Hunter"
        }
    
    def _get_max_tokens(self, model: str) -> int:
        return self.MAX_TOKENS.get(model, 8192)
    
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
        
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "stream": stream,
            "temperature": 0.8
        }
        
        # Note: For thinking models, reasoning is returned automatically
        # We don't need to configure it explicitly - it's part of the model behavior
        
        async with httpx.AsyncClient(timeout=timeout) as client:
            if stream:
                return await self._stream_response(client, payload)
            else:
                return await self._simple_response(client, payload)
    
    async def _stream_response(
        self, 
        client: httpx.AsyncClient, 
        payload: Dict[str, Any]
    ) -> Tuple[str, str]:
        """Handle streaming response and collect chunks."""
        response_text = ""
        reasoning_trace = ""
        
        try:
            async with client.stream(
                "POST",
                self.BASE_URL,
                headers=self._get_headers(),
                json=payload
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
                                
                                # Handle content
                                if "content" in delta and delta["content"]:
                                    response_text += delta["content"]
                                
                                # Handle reasoning/thinking tokens (model-specific)
                                if "reasoning" in delta and delta["reasoning"]:
                                    reasoning_trace += delta["reasoning"]
                                elif "thinking" in delta and delta["thinking"]:
                                    reasoning_trace += delta["thinking"]
                            
                        except json.JSONDecodeError:
                            continue
        except httpx.HTTPStatusError as e:
            # Re-raise with more context
            raise
        
        response_text = response_text.strip()
        reasoning_trace = reasoning_trace.strip()
        
        # Deduplicate: If trace is identical to response OR contained within, clear it
        if response_text == reasoning_trace:
            reasoning_trace = ""
        elif reasoning_trace and reasoning_trace in response_text and len(reasoning_trace) > 50:
            reasoning_trace = ""
            
        return response_text, reasoning_trace
    
    async def _simple_response(
        self, 
        client: httpx.AsyncClient, 
        payload: Dict[str, Any]
    ) -> Tuple[str, str]:
        """Handle non-streaming response."""
        payload["stream"] = False
        
        response = await client.post(
            self.BASE_URL,
            headers=self._get_headers(),
            json=payload
        )
        response.raise_for_status()
        
        data = response.json()
        
        # Check for API errors
        if "error" in data:
            error_msg = data["error"].get("message", str(data["error"]))
            raise ValueError(f"API Error: {error_msg}")
        
        choice = data.get("choices", [{}])[0]
        message = choice.get("message", {})
        
        response_text = message.get("content", "") or ""
        reasoning_trace = message.get("reasoning", "") or message.get("thinking", "") or ""
        
        # Deduplicate: If trace is identical to response (some models do this), clear it
        if response_text.strip() == reasoning_trace.strip():
            reasoning_trace = ""
        
        # Also clean up if reasoning is just a subset of response
        if reasoning_trace and reasoning_trace in response_text and len(reasoning_trace) > 50:
             # It's likely the model just outputted the thought as part of the content
             # We can try to strip it from content if we want, or just hide the trace
             reasoning_trace = ""

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
                    return response, accumulated_reasoning.strip(), None
                
                # For thinking models: if content is empty but we have reasoning,
                # the reasoning IS the response - use it
                if reasoning.strip() and not response.strip():
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
