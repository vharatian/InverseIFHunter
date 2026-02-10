"""
OpenRouter Client Service

Handles API calls to OpenRouter for models:
- NVIDIA Nemotron-3-Nano-30B-A3B-BF16
- Qwen3-235B-A22B-Thinking-2507

Features:
- Inherits connection pooling from BaseAPIClient
- Streaming support for maximum token handling
- Configurable reasoning budget (90% default)
- Retry logic with fallback (no reasoning on fail)
- Captures thinking tokens separately
"""
import os
import httpx
import logging
from typing import Tuple, Optional, Dict, Any
from dotenv import load_dotenv

from services.base_client import BaseAPIClient

# Fast JSON parsing (orjson if available, stdlib fallback)
from services.fast_json import json_loads, json_dumps, JSONDecodeError

logger = logging.getLogger(__name__)

load_dotenv()


class OpenRouterClient(BaseAPIClient):
    """Async client for OpenRouter API with streaming, retry support, and connection pooling."""
    
    BASE_URL = "https://openrouter.ai/api/v1/chat/completions"
    PROVIDER_NAME = "openrouter"
    
    # Model configurations - Exact model names from OpenRouter
    MODELS = {
        "nemotron": "nvidia/nemotron-3-nano-30b-a3b",
        "qwen3": "qwen/qwen3-235b-a22b-thinking-2507",
    }
    
    # Default max tokens per model (actual model capabilities)
    MAX_TOKENS = {
        "nvidia/nemotron-3-nano-30b-a3b": 32768,
        "qwen/qwen3-235b-a22b-thinking-2507": 131072,
        "anthropic/claude-opus-4.5": 32768,
        "anthropic/claude-opus-4.6": 32768,
        "anthropic/claude-sonnet-4.5": 16384,
    }
    
    def __init__(self, api_key: Optional[str] = None):
        super().__init__(api_key, env_var_name="OPENROUTER_API_KEY")
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
        timeout: float = 180.0,
        messages: Optional[list] = None,
        **kwargs
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
            messages: Optional conversation history for multi-turn
                      (list of {role, content} dicts). The current prompt
                      is appended as the final user message.
        
        Returns:
            Tuple of (response_text, reasoning_trace)
        """
        # Resolve short model names
        if model.lower() in self.MODELS:
            model = self.MODELS[model.lower()]
        
        if max_tokens is None:
            max_tokens = self._get_max_tokens(model)
        
        # Build messages - prepend conversation history if provided (multi-turn)
        model_lower = model.lower()
        is_nemotron = 'nemotron' in model_lower
        is_claude = 'claude' in model_lower or 'anthropic' in model_lower
        is_opus = 'opus' in model_lower
        # Opus needs reasoning to handle complex prompts. Sonnet and Nemotron don't.
        is_reasoning_model = not is_nemotron and (not is_claude or is_opus)
        
        if messages:
            # Multi-turn: conversation history + current prompt
            messages = list(messages) + [{"role": "user", "content": prompt}]
        else:
            # Single-turn: just user prompt
            messages = [{"role": "user", "content": prompt}]
        
        payload = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "stream": stream,
            "temperature": 0.7 if is_claude else (0.6 if is_nemotron else 0.8)
        }
        
        # Force Claude Opus through Anthropic directly (not Bedrock)
        # Bedrock has stricter content filtering that causes empty responses
        if 'opus' in model_lower:
            payload["provider"] = {
                "order": ["Anthropic"],
                "allow_fallbacks": False
            }
        
        # Add reasoning parameter ONLY for models that support it (Qwen-type)
        # Nemotron: not a reasoning model, causes empty responses
        # Claude: doesn't use OpenRouter's reasoning param, has its own extended thinking
        if is_reasoning_model and reasoning_budget_percent > 0:
            payload["reasoning"] = {
                "exclude": False,
                "effort": "high"
            }
        elif is_reasoning_model:
            payload["reasoning"] = {"exclude": True}
        
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
        reasoning_by_id = {}
        final_message_reasoning = None
        
        logger.debug(f"OpenRouter: Payload includes reasoning: {payload.get('reasoning', 'NOT FOUND')}")
        
        try:
            async with client.stream(
                "POST",
                self.BASE_URL,
                headers=self._get_headers(),
                json=payload,
                timeout=timeout
            ) as response:
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
                            chunk = json_loads(data)
                            
                            if "error" in chunk:
                                error_msg = chunk["error"].get("message", str(chunk["error"]))
                                raise ValueError(f"API Error: {error_msg}")
                            
                            choices = chunk.get("choices", [])
                            if choices:
                                delta = choices[0].get("delta", {})
                                message = choices[0].get("message", {})
                                
                                # Check for final message with reasoning_details
                                if message and "reasoning_details" in message and message["reasoning_details"]:
                                    final_message_reasoning = message["reasoning_details"]
                                    logger.debug(f"OpenRouter: Found final reasoning_details: {len(final_message_reasoning)} items")
                                
                                # Collect incremental reasoning from delta
                                if delta and not final_message_reasoning:
                                    if "reasoning_details" in delta and delta["reasoning_details"]:
                                        for detail in delta["reasoning_details"]:
                                            if isinstance(detail, dict):
                                                detail_id = detail.get("id")
                                                detail_text = detail.get("text", "")
                                                if detail_id and detail_text:
                                                    current_text = reasoning_by_id.get(detail_id, "")
                                                    if len(detail_text) > len(current_text):
                                                        reasoning_by_id[detail_id] = detail_text
                                    
                                    if "reasoning" in delta and delta["reasoning"]:
                                        reasoning_trace += delta["reasoning"]
                                    if "thinking" in delta and delta["thinking"]:
                                        reasoning_trace += delta["thinking"]
                                
                                # Handle content
                                if delta and "content" in delta and delta["content"]:
                                    response_text += delta["content"]
                                
                                # Check for direct reasoning in final message
                                if message and not final_message_reasoning:
                                    if "reasoning" in message and message["reasoning"]:
                                        reasoning_trace += message["reasoning"]
                                    elif "thinking" in message and message["thinking"]:
                                        reasoning_trace += message["thinking"]
                            
                        except JSONDecodeError:
                            continue
                
                # Build final reasoning trace
                if final_message_reasoning:
                    reasoning_parts = []
                    for detail in final_message_reasoning:
                        if isinstance(detail, dict) and "text" in detail:
                            reasoning_parts.append(detail["text"])
                    reasoning_trace = "".join(reasoning_parts)
                    logger.debug(f"OpenRouter: Using final message reasoning: {len(reasoning_trace)} chars")
                elif reasoning_by_id:
                    sorted_ids = sorted(reasoning_by_id.keys())
                    reasoning_trace = "".join([reasoning_by_id[id] for id in sorted_ids])
                    logger.debug(f"OpenRouter: Using delta reasoning: {len(reasoning_trace)} chars")
                    
        except httpx.HTTPStatusError:
            raise
        
        response_text = response_text.strip()
        reasoning_trace = reasoning_trace.strip()
        
        # Parse <think>...</think> tags from content
        response_text, extracted_reasoning = self.parse_think_tags(response_text)
        if extracted_reasoning and not reasoning_trace:
            reasoning_trace = extracted_reasoning
            logger.debug(f"OpenRouter: Extracted reasoning from <think> tags: {len(reasoning_trace)} chars")
        elif extracted_reasoning and len(extracted_reasoning) > len(reasoning_trace):
            reasoning_trace = extracted_reasoning
            logger.debug(f"OpenRouter: Using <think> tag reasoning (longer than API reasoning)")
        
        return response_text, reasoning_trace
    
    async def _simple_response(
        self, 
        client: httpx.AsyncClient, 
        payload: Dict[str, Any],
        timeout: float = 180.0
    ) -> Tuple[str, str]:
        """Handle non-streaming response."""
        payload["stream"] = False
        
        logger.debug(f"OpenRouter: Payload includes reasoning: {payload.get('reasoning', 'NOT FOUND')}")
        
        response = await client.post(
            self.BASE_URL,
            headers=self._get_headers(),
            json=payload,
            timeout=timeout
        )
        response.raise_for_status()
        
        data = response.json()
        
        logger.debug(f"OpenRouter: Response keys: {list(data.keys())}")
        
        if "error" in data:
            error_msg = data["error"].get("message", str(data["error"]))
            raise ValueError(f"API Error: {error_msg}")
        
        choice = data.get("choices", [{}])[0]
        message = choice.get("message", {})
        
        response_text = message.get("content", "") or ""
        reasoning_trace = ""
        
        # Check for reasoning_details array
        if "reasoning_details" in message and message["reasoning_details"]:
            logger.debug(f"OpenRouter: Found reasoning_details array with {len(message['reasoning_details'])} items")
            for detail in message["reasoning_details"]:
                if isinstance(detail, dict) and "text" in detail:
                    reasoning_trace += detail["text"]
        
        # Fallback to direct reasoning/thinking fields
        if not reasoning_trace:
            reasoning_trace = message.get("reasoning", "") or message.get("thinking", "") or ""
        
        # Parse <think>...</think> tags from content
        response_text, extracted_reasoning = self.parse_think_tags(response_text)
        if extracted_reasoning and not reasoning_trace:
            reasoning_trace = extracted_reasoning
            logger.debug(f"OpenRouter: Extracted reasoning from <think> tags: {len(reasoning_trace)} chars")
        elif extracted_reasoning and len(extracted_reasoning) > len(reasoning_trace):
            reasoning_trace = extracted_reasoning
            logger.debug(f"OpenRouter: Using <think> tag reasoning (longer than API reasoning)")

        return response_text.strip(), reasoning_trace.strip()
    
    # Note: Uses BaseAPIClient.call_with_retry which passes **kwargs to call_model
    # This allows reasoning_budget_percent to be passed through
    
    def get_available_models(self) -> Dict[str, str]:
        """Return available models."""
        return self.MODELS.copy()


# Singleton instance
_openrouter_client = None

def get_openrouter_client(api_key: Optional[str] = None) -> OpenRouterClient:
    """Get or create OpenRouter client instance."""
    global _openrouter_client
    if _openrouter_client is None or api_key:
        _openrouter_client = OpenRouterClient(api_key)
    return _openrouter_client
