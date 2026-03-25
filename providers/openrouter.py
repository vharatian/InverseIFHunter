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
import re
import httpx
import logging
from typing import Tuple, Optional, Dict, Any

from providers.base import BaseAPIClient

# Fast JSON parsing (orjson if available, stdlib fallback)
from services.fast_json import json_loads, json_dumps, JSONDecodeError

logger = logging.getLogger(__name__)


class OpenRouterClient(BaseAPIClient):
    """Async client for OpenRouter API with streaming, retry support, and connection pooling."""
    
    BASE_URL = "https://openrouter.ai/api/v1/chat/completions"
    PROVIDER_NAME = "openrouter"
    
    # Model configurations - Exact model names from OpenRouter
    MODELS = {
        "nemotron": "nvidia/nemotron-3-nano-30b-a3b",
        "qwen3": "qwen/qwen3-235b-a22b-thinking-2507",
    }
    
    # Default max tokens per model
    # Actual caps: GPT-5.2 128K, Sonnet 4.6 64K, Gemini 3.1 65K
    # Capped at 32K for cost/speed in hunt use case (trainer can override)
    MAX_TOKENS = {
        "nvidia/nemotron-3-nano-30b-a3b": 32768,
        "qwen/qwen3-235b-a22b-thinking-2507": 131072,
        "anthropic/claude-opus-4.5": 32768,
        "anthropic/claude-opus-4.6": 32768,
        "anthropic/claude-sonnet-4.5": 16384,
        "anthropic/claude-sonnet-4.6": 32768,
        "openai/gpt-5.2": 32768,
        "openai/gpt-5.2-pro": 32768,
        "openai/gpt-5.4": 32768,
        "openai/gpt-5.4-pro": 32768,
        "google/gemini-3.1-pro-preview": 65536,
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
        temperature: Optional[float] = None,
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
        is_gemini = 'gemini' in model_lower or model_lower.startswith('google/')
        is_sonnet_46 = 'sonnet-4.6' in model_lower
        # Reasoning: GPT-5, Qwen, Opus, Sonnet 4.6, Gemini. NOT Nemotron, NOT Sonnet 4.5.
        is_reasoning_model = (not is_nemotron and (not is_claude or is_opus or is_sonnet_46)) or is_gemini
        
        if messages:
            messages = list(messages)
            if prompt:
                messages = messages + [{"role": "user", "content": prompt}]
        else:
            if not prompt or not prompt.strip():
                raise ValueError("No prompt provided. Please provide a prompt before calling the model.")
            messages = [{"role": "user", "content": prompt}]
        
        # temperature: default 1 for generation; judge passes 0 explicitly
        temp = temperature if temperature is not None else 1.0
        payload = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "stream": stream,
            "temperature": temp
        }
        
        # Provider routing per Opus version:
        # Opus 4.5: Force Anthropic (Bedrock content filtering causes empty responses)
        # Opus 4.6: Force Bedrock (Anthropic + reasoning returns empty, Bedrock works)
        if is_opus:
            if '4.6' in model_lower:
                payload["provider"] = {
                    "order": ["Amazon Bedrock"],
                    "allow_fallbacks": False
                }
            else:
                payload["provider"] = {
                    "order": ["Anthropic"],
                    "allow_fallbacks": False
                }
        
        # Reasoning: Qwen, GPT-5, Opus, Sonnet 4.6, Gemini
        # Nemotron: not a reasoning model, causes empty responses
        # Sonnet 4.5: no reasoning support
        # Gemini: uses max_tokens (mapped to thinkingBudget/thinkingLevel by OpenRouter)
        if is_reasoning_model and reasoning_budget_percent > 0:
            if is_gemini:
                reasoning_tokens = int(max_tokens * reasoning_budget_percent)
                payload["reasoning"] = {
                    "exclude": False,
                    "max_tokens": reasoning_tokens
                }
            else:
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
                                                detail_text = detail.get("text", "") or detail.get("summary", "")
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
                        if isinstance(detail, dict):
                            part = detail.get("text", "") or detail.get("summary", "")
                            if part:
                                reasoning_parts.append(part)
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
        
        # Check for reasoning_details array (handles text, summary, and encrypted types)
        if "reasoning_details" in message and message["reasoning_details"]:
            logger.debug(f"OpenRouter: Found reasoning_details array with {len(message['reasoning_details'])} items")
            for detail in message["reasoning_details"]:
                if isinstance(detail, dict):
                    part = detail.get("text", "") or detail.get("summary", "")
                    if part:
                        reasoning_trace += part
        
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
    
    def _build_payload(
        self,
        prompt: str,
        model: str,
        max_tokens: Optional[int] = None,
        reasoning_budget_percent: float = 0.9,
        messages: Optional[list] = None,
        temperature: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Build the API payload (shared by call_model and stream_model_chunks)."""
        if model.lower() in self.MODELS:
            model = self.MODELS[model.lower()]

        if max_tokens is None:
            max_tokens = self._get_max_tokens(model)

        model_lower = model.lower()
        is_nemotron = 'nemotron' in model_lower
        is_claude = 'claude' in model_lower or 'anthropic' in model_lower
        is_opus = 'opus' in model_lower
        is_gemini = 'gemini' in model_lower or model_lower.startswith('google/')
        is_sonnet_46 = 'sonnet-4.6' in model_lower
        is_reasoning_model = (not is_nemotron and (not is_claude or is_opus or is_sonnet_46)) or is_gemini

        if messages:
            msgs = list(messages)
            if prompt:
                msgs = msgs + [{"role": "user", "content": prompt}]
        else:
            if not prompt or not prompt.strip():
                raise ValueError("No prompt provided. Please provide a prompt before calling the model.")
            msgs = [{"role": "user", "content": prompt}]

        temp = temperature if temperature is not None else 1.0
        payload: Dict[str, Any] = {
            "model": model,
            "messages": msgs,
            "max_tokens": max_tokens,
            "stream": True,
            "temperature": temp,
        }

        if is_opus:
            if '4.6' in model_lower:
                payload["provider"] = {"order": ["Amazon Bedrock"], "allow_fallbacks": False}
            else:
                payload["provider"] = {"order": ["Anthropic"], "allow_fallbacks": False}

        if is_reasoning_model and reasoning_budget_percent > 0:
            if is_gemini:
                reasoning_tokens = int(max_tokens * reasoning_budget_percent)
                payload["reasoning"] = {"exclude": False, "max_tokens": reasoning_tokens}
            else:
                payload["reasoning"] = {"exclude": False, "effort": "high"}
        elif is_reasoning_model:
            payload["reasoning"] = {"exclude": True}

        return payload

    async def stream_model_chunks(
        self,
        prompt: str,
        model: str,
        max_tokens: Optional[int] = None,
        reasoning_budget_percent: float = 0.9,
        timeout: float = 180.0,
        messages: Optional[list] = None,
        temperature: Optional[float] = None,
    ):
        """
        Async generator that yields SSE-friendly dicts as chunks arrive.

        Yields dicts with keys:
            type: "content" | "reasoning" | "done" | "error"
            text: the chunk text (for content/reasoning)
            response / reasoning: full accumulated text (for done)
        """
        payload = self._build_payload(
            prompt, model, max_tokens, reasoning_budget_percent, messages, temperature,
        )
        resolved_model = payload["model"]
        client = await self._get_client()

        response_text = ""
        reasoning_trace = ""

        try:
            async with client.stream(
                "POST", self.BASE_URL,
                headers=self._get_headers(),
                json=payload,
                timeout=timeout,
            ) as response:
                if response.status_code >= 400:
                    await response.aread()
                    yield {"type": "error", "text": f"HTTP {response.status_code}"}
                    return

                async for line in response.aiter_lines():
                    if not line or not line.startswith("data: "):
                        continue
                    data = line[6:]
                    if data == "[DONE]":
                        break

                    try:
                        chunk = json_loads(data)
                        if "error" in chunk:
                            yield {"type": "error", "text": chunk["error"].get("message", str(chunk["error"]))}
                            return

                        choices = chunk.get("choices", [])
                        if not choices:
                            continue
                        delta = choices[0].get("delta", {})

                        # Reasoning chunks
                        reasoning_chunk = ""
                        if delta:
                            if "reasoning" in delta and delta["reasoning"]:
                                reasoning_chunk = delta["reasoning"]
                            elif "thinking" in delta and delta["thinking"]:
                                reasoning_chunk = delta["thinking"]
                        if reasoning_chunk:
                            reasoning_trace += reasoning_chunk
                            yield {"type": "reasoning", "text": reasoning_chunk}

                        # Content chunks
                        if delta and "content" in delta and delta["content"]:
                            content_chunk = delta["content"]
                            response_text += content_chunk
                            yield {"type": "content", "text": content_chunk}

                    except (JSONDecodeError, KeyError):
                        continue

        except Exception as e:
            yield {"type": "error", "text": str(e)}
            return

        # Post-process: parse <think> tags from accumulated content
        clean_response, extracted = self.parse_think_tags(response_text.strip())
        if extracted and (not reasoning_trace or len(extracted) > len(reasoning_trace)):
            reasoning_trace = extracted

        yield {
            "type": "done",
            "response": clean_response.strip(),
            "reasoning": reasoning_trace.strip(),
            "model": resolved_model,
        }

    # Note: Uses BaseAPIClient.call_with_retry which passes **kwargs to call_model
    # This allows reasoning_budget_percent to be passed through


# Singleton instance
_openrouter_client = None

def get_openrouter_client(api_key: Optional[str] = None) -> OpenRouterClient:
    """Get or create OpenRouter client instance."""
    global _openrouter_client
    if _openrouter_client is None or api_key:
        _openrouter_client = OpenRouterClient(api_key)
    return _openrouter_client


# --- Agentic reviewer sync API (consolidated from legacy standalone LLM helper) ---

OPENROUTER_URL = OpenRouterClient.BASE_URL


def _agentic_openrouter_api_key() -> str:
    key = os.getenv("OPENROUTER_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not key:
        raise ValueError(
            "OPENROUTER_API_KEY or OPENAI_API_KEY required for council. "
            "Set in .env (agentic-reviewer or model-hunter-refactored)."
        )
    return key


def call_model_sync(
    prompt: str,
    model: str,
    *,
    max_tokens: int = 512,
    timeout: float = 60.0,
) -> Tuple[str, Optional[str]]:
    """
    Call OpenRouter model synchronously. Returns (response_text, error).

    Uses simple non-streaming request. Temperature 0 for deterministic pass/fail.
    """
    api_key = _agentic_openrouter_api_key()
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:8000",
        "X-Title": "Agentic Reviewer",
    }
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(OPENROUTER_URL, headers=headers, json=payload)
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as e:
        err = e.response.text if e.response else str(e)
        logger.warning("OpenRouter HTTP error for %s: %s", model, err)
        return "", err
    except Exception as e:
        logger.warning("OpenRouter call failed for %s: %s", model, e)
        return "", str(e)

    choice = data.get("choices", [{}])[0]
    content = (choice.get("message", {}).get("content") or "").strip()
    return content, None


def call_model_streaming(
    prompt: str,
    model: str,
    *,
    max_tokens: int = 512,
    timeout: float = 120.0,
):
    """
    Call OpenRouter model with streaming. Yields (chunk, error) — chunk is text, error is str or None.
    When done, yields (full_text, None) then stops. On error, yields ("", error_msg).
    """
    import json as _json

    api_key = _agentic_openrouter_api_key()
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0,
        "stream": True,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:8000",
        "X-Title": "Agentic Reviewer",
    }
    try:
        with httpx.Client(timeout=timeout) as client:
            with client.stream("POST", OPENROUTER_URL, headers=headers, json=payload) as resp:
                resp.raise_for_status()
                for line in resp.iter_lines():
                    if not line or not line.strip().startswith("data: "):
                        continue
                    data = line.strip()[6:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        parsed = _json.loads(data)
                        if parsed.get("error"):
                            err = parsed["error"].get("message", str(parsed["error"]))
                            yield ("", err)
                            return
                        content = (parsed.get("choices") or [{}])[0].get("delta", {}).get("content")
                        if content:
                            yield (content, None)
                    except _json.JSONDecodeError:
                        pass
    except httpx.HTTPStatusError as e:
        err = e.response.text if e.response else str(e)
        logger.warning("OpenRouter HTTP error for %s: %s", model, err)
        yield ("", err)
    except Exception as e:
        logger.warning("OpenRouter stream failed for %s: %s", model, e)
        yield ("", str(e))


def parse_pass_fail(text: str) -> Optional[bool]:
    """
    Parse PASS/FAIL from model response. Returns True=pass, False=fail, None=unclear.
    Models are instructed to conclude with PASS or FAIL; we parse flexibly to reduce unclear.
    Handles Gemini and other models that may use varied formats.
    """
    if not text:
        return None
    t = text.upper().strip()

    lines = [ln.strip() for ln in t.splitlines() if ln.strip()]
    if lines:
        last_line = lines[-1]
        last_clean = re.sub(r"[^\w\s]", " ", last_line)
        last_words = set(re.findall(r"\b[A-Z]+\b", last_clean))
        if "PASS" in last_words and "FAIL" not in last_words:
            return True
        if "FAIL" in last_words and "PASS" not in last_words:
            return False

    for line in reversed(lines[-3:]):
        line_clean = re.sub(r"[^\w\s]", " ", line)
        if re.search(r"\bPASS\b", line_clean) and not re.search(r"\bFAIL\b", line_clean):
            return True
        if re.search(r"\bFAIL\b", line_clean) and not re.search(r"\bPASS\b", line_clean):
            return False
        if re.search(r"\bYES\b", line_clean) and not re.search(r"\bNO\b", line_clean):
            return True
        if re.search(r"\bNO\b", line_clean) and not re.search(r"\bYES\b", line_clean):
            return False

    if re.search(r"\bPASS\b", t) and not re.search(r"\bFAIL\b", t):
        return True
    if re.search(r"\bFAIL\b", t) and not re.search(r"\bPASS\b", t):
        return False
    if re.search(r"\bYES\b", t) and not re.search(r"\bNO\b", t):
        return True
    if re.search(r"\bNO\b", t) and not re.search(r"\bYES\b", t):
        return False

    verdict_match = re.search(
        r"(?:VERDICT|CONCLUSION|ANSWER|RESULT|FINAL|OUTCOME|DECISION|JUDGMENT)\s*:?\s*(PASS|FAIL|YES|NO)",
        t,
        re.IGNORECASE,
    )
    if verdict_match:
        v = verdict_match.group(1).upper()
        if v in ("PASS", "YES"):
            return True
        if v in ("FAIL", "NO"):
            return False

    conclude_match = re.search(
        r"(?:I\s+)?(?:CONCLUDE|THUS|THEREFORE|HENCE)\s*:?\s*(PASS|FAIL|YES|NO)",
        t,
        re.IGNORECASE,
    )
    if conclude_match:
        v = conclude_match.group(1).upper()
        if v in ("PASS", "YES"):
            return True
        if v in ("FAIL", "NO"):
            return False

    words = re.findall(r"\b[A-Z0-9]+\b", t)
    if words:
        first, last = words[0], words[-1]
        if first in ("PASS", "YES", "TRUE", "1") or last in ("PASS", "YES", "TRUE", "1"):
            return True
        if first in ("FAIL", "NO", "FALSE", "0") or last in ("FAIL", "NO", "FALSE", "0"):
            return False

    return None
