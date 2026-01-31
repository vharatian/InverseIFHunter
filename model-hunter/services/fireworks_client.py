"""
Fireworks AI Client Service

Handles API calls to Fireworks AI for models:
- Llama 3 70B Instruct
- Mixtral 8x7B Instruct
- Qwen 2.5 72B Instruct

Features:
- Streaming support
- Standard OpenAI-compatible format
- Connection pooling for better performance
"""
import os
import json
import asyncio
import httpx
import time
import logging
from typing import Tuple, Optional, Dict, Any
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

# Timeout settings
DEFAULT_TIMEOUT = httpx.Timeout(120.0, connect=10.0)


class FireworksClient:
    """Async client for Fireworks AI API with connection pooling."""
    
    BASE_URL = "https://api.fireworks.ai/inference/v1/chat/completions"
    
    # Model configurations
    MODELS = {
        "qwen3": "accounts/fireworks/models/qwen3-235b-a22b-thinking-2507",  # Qwen3-235B (same as OpenRouter)
        # Note: Nemotron not available on Fireworks serverless
    }
    
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.getenv("FIREWORKS_API_KEY")
        if not self.api_key:
            # Don't raise error on init to allow app startup even if key missing
            pass
        
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
                    logger.info("Created pooled HTTP client for Fireworks")
        return self._client
    
    async def close(self):
        """Close the HTTP client."""
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None
            
    def _get_headers(self) -> Dict[str, str]:
        if not self.api_key:
            raise ValueError("Fireworks API key not found. Set FIREWORKS_API_KEY in .env")
            
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        
    async def call_with_retry(
        self,
        prompt: str,
        model: str,
        max_retries: int = 3,
        reasoning_budget_percent: float = 0.9, # Ignored for Fireworks
        timeout: float = 120.0
    ) -> Tuple[str, str, Optional[str]]:
        """
        Call model with retry logic.
        Returns: (response_text, reasoning_trace, error_message)
        """
        last_error = None
        accumulated_reasoning = ""
        
        # Telemetry: Log API call start
        _start_time = time.time()
        if _telemetry_enabled:
            try:
                log_api_call_start("fireworks", model)
            except Exception:
                pass
        
        # Resolve short model names if needed
        # But we expect full IDs from frontend mostly
        
        for attempt in range(max_retries):
            try:
                response_text, reasoning = await self.call_model(
                    prompt=prompt,
                    model=model,
                    timeout=timeout
                )
                
                # Accumulate reasoning only if we don't have a response yet (to avoid duplicates across retries)
                # If we get a response, use the reasoning from this attempt only
                if reasoning and reasoning.strip():
                    if not accumulated_reasoning:
                        accumulated_reasoning = reasoning
                    else:
                        # Only append if it's different (avoid duplicates)
                        if reasoning not in accumulated_reasoning:
                            accumulated_reasoning += "\n" + reasoning
                
                if response_text and response_text.strip():
                    # Telemetry: Log successful API call with token estimates
                    if _telemetry_enabled:
                        try:
                            tokens_in = len(prompt) // 4
                            tokens_out = len(response_text) // 4
                            log_api_call_end("fireworks", model, _start_time, success=True,
                                           tokens_in=tokens_in, tokens_out=tokens_out)
                        except Exception:
                            pass
                    # Return response with reasoning from this attempt (most recent)
                    return response_text, (reasoning.strip() if reasoning else accumulated_reasoning.strip()), None
                
                # For thinking models: if content is empty but we have reasoning,
                # the reasoning IS the response - use it
                if reasoning and reasoning.strip() and not response_text.strip():
                    # Telemetry: Log successful API call (reasoning as response)
                    if _telemetry_enabled:
                        try:
                            log_api_call_end("fireworks", model, _start_time, success=True)
                        except Exception:
                            pass
                    return reasoning, reasoning.strip(), None
                    
            except Exception as e:
                last_error = f"Error: {str(e)}"
                
            # Wait before retry
            if attempt < max_retries - 1:
                import asyncio
                await asyncio.sleep(2 ** attempt)
        
        # Telemetry: Log failed API call
        if _telemetry_enabled:
            try:
                log_api_call_end("fireworks", model, _start_time, success=False,
                                error=last_error or "Empty response")
            except Exception:
                pass
                
        return "", accumulated_reasoning.strip(), last_error or "Empty response"

    async def call_model(
        self,
        prompt: str,
        model: str,
        timeout: float = 120.0
    ) -> Tuple[str, str]:
        """
        Call Fireworks API and return (response_text, reasoning_trace).
        
        With reasoning_effort="high", Fireworks returns:
        - message.reasoning_content: The reasoning/thinking trace
        - message.content: The final answer
        
        Fallback: If reasoning_content is empty, we try parsing </think> tags from content.
        """
        # Fireworks doesn't support reasoning_effort parameter (causes 400 error)
        # Instead, we use prompt engineering with system message + explicit format instructions
        
        system_message = """You MUST format your response in exactly this structure:

<think>
[Your step-by-step reasoning, analysis, and thought process goes here]
</think>

[Your final answer goes here - concise and direct]

CRITICAL: Always use <think> and </think> tags to wrap your reasoning. Your final answer must come AFTER the </think> tag."""

        user_message = f"""Question: {prompt}

Remember: Put ALL your thinking inside <think>...</think> tags, then give your final answer after.</s>"""
        
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_message},
                {"role": "user", "content": user_message}
            ],
            "max_tokens": 8192,  # Increased for thinking + answer
            "temperature": 0.6,  # Slightly lower for more consistent formatting
            "stream": False
        }
        
        # Debug: Log the payload being sent
        logger.debug(f"Fireworks: Using system message + prompt engineering for reasoning separation")
        logger.debug(f"Fireworks: Model: {model}")
        
        # Use pooled client for better performance
        client = await self._get_client()
        response = await client.post(
            self.BASE_URL,
            headers=self._get_headers(),
            json=payload,
            timeout=timeout
        )
            
            if response.status_code != 200:
                raise ValueError(f"Fireworks API Error {response.status_code}: {response.text}")
                
            data = response.json()
            
            # Debug: Log the raw response structure
            logger.debug(f"Fireworks: Raw response keys: {list(data.keys())}")
            if "choices" in data and data["choices"]:
                logger.debug(f"Fireworks: First choice keys: {list(data['choices'][0].keys())}")
            
            # Check for API errors
            if "error" in data:
                error_msg = data["error"].get("message", str(data["error"]))
                raise ValueError(f"API Error: {error_msg}")
            
            choices = data.get("choices", [])
            if not choices:
                return "", ""
            
            message = choices[0].get("message", {})
            response_text = message.get("content", "") or ""
            
            # Extract reasoning trace - check multiple possible formats
            # Fireworks AI may use different fields depending on the model/API version
            reasoning_trace = ""
            
            # Priority 1: Check reasoning_content field (Fireworks-specific)
            if "reasoning_content" in message and message["reasoning_content"]:
                reasoning_trace = message["reasoning_content"]
                logger.debug(f"Fireworks: Found reasoning in 'reasoning_content' field")
            
            # Priority 2: Check reasoning_details array (similar to OpenRouter format)
            if not reasoning_trace and "reasoning_details" in message and message["reasoning_details"]:
                logger.debug(f"Fireworks: Found reasoning_details array with {len(message['reasoning_details'])} items")
                for detail in message["reasoning_details"]:
                    if isinstance(detail, dict) and "text" in detail:
                        reasoning_trace += detail["text"]
                if reasoning_trace:
                    logger.debug(f"Fireworks: Extracted reasoning from 'reasoning_details' array")
            
            # Priority 3: Check direct reasoning/thinking fields (fallback, like OpenRouter)
            if not reasoning_trace:
                reasoning_trace = message.get("reasoning", "") or message.get("thinking", "") or ""
                if reasoning_trace:
                    logger.debug(f"Fireworks: Found reasoning in 'reasoning' or 'thinking' field")
            
            # Priority 4: Check for <think>...</think> pattern (both tags) - PREFERRED
            # We now explicitly prompt the model to use this format
            import re
            logger.debug(f"Fireworks: Checking for <think>...</think> tags in response...")
            logger.debug(f"Fireworks: '<think>' in response_text: {'<think>' in response_text}")
            logger.debug(f"Fireworks: '</think>' in response_text: {'</think>' in response_text}")
            
            if not reasoning_trace and '<think>' in response_text and '</think>' in response_text:
                # Use regex with DOTALL to match across newlines
                think_pattern = r'<think>(.*?)</think>'
                think_match = re.search(think_pattern, response_text, re.DOTALL)
                if think_match:
                    reasoning_trace = think_match.group(1).strip()
                    # Remove the entire <think>...</think> block from response
                    response_text = re.sub(think_pattern, '', response_text, flags=re.DOTALL).strip()
                    logger.debug(f"Fireworks: Extracted reasoning from <think>...</think> tags")
                    logger.debug(f"Fireworks: Reasoning: {len(reasoning_trace)} chars, Answer: {len(response_text)} chars")
            
            # Priority 5: Fallback - Split on </think> only (no opening tag)
            # Some Qwen responses have: "Reasoning here...</think>\n\nAnswer here"
            if not reasoning_trace and '</think>' in response_text:
                parts = response_text.split('</think>', 1)
                extracted_reasoning = parts[0].strip()
                # Remove leading <think> if present
                if extracted_reasoning.startswith('<think>'):
                    extracted_reasoning = extracted_reasoning[7:].strip()
                extracted_answer = parts[1].strip() if len(parts) > 1 else ""
                
                if extracted_reasoning:
                    reasoning_trace = extracted_reasoning
                    response_text = extracted_answer
                    logger.debug(f"Fireworks: Extracted reasoning by splitting on </think>")
                    logger.debug(f"Fireworks: Reasoning: {len(reasoning_trace)} chars, Answer: {len(response_text)} chars")
            
            # Priority 6: Legacy fallback - Check for additional <think>...</think> patterns
            if not reasoning_trace:
                think_pattern = r'<think>(.*?)</think>'
                think_matches = re.findall(think_pattern, response_text, re.DOTALL)
                if think_matches:
                    # Extract reasoning from <think> tags
                    extracted_reasoning = "\n".join(think_matches)
                    reasoning_trace = extracted_reasoning
                    logger.debug(f"Fireworks: Extracted reasoning from <think>...</think> tags")
                    # Remove <think> tags from response_text to get clean final answer
                    response_text = re.sub(think_pattern, '', response_text, flags=re.DOTALL).strip()
            
            # Priority 6: If we still don't have reasoning but response_text is very long,
            # it might be that the entire content is reasoning (some thinking models do this)
            # This is handled in call_with_retry where if content is empty but reasoning exists,
            # we use reasoning as the response.
            
            # Debug: Log what we're extracting
            logger.debug(f"Fireworks: message keys: {list(message.keys())}")
            logger.debug(f"Fireworks: response_text length: {len(response_text)}")
            logger.debug(f"Fireworks: reasoning_trace length: {len(reasoning_trace)}")
            logger.debug(f"Fireworks: has 'reasoning_content' key: {'reasoning_content' in message}")
            logger.debug(f"Fireworks: has 'reasoning' key: {'reasoning' in message}")
            logger.debug(f"Fireworks: has 'thinking' key: {'thinking' in message}")
            logger.debug(f"Fireworks: has 'reasoning_details' key: {'reasoning_details' in message}")
            if response_text:
                logger.debug(f"Fireworks: response_text preview (first 200 chars): {response_text[:200]}")
                logger.debug(f"Fireworks: response_text END (last 300 chars): {response_text[-300:]}")
            if reasoning_trace:
                logger.debug(f"Fireworks: reasoning_trace preview (first 200 chars): {reasoning_trace[:200]}")
            else:
                logger.debug(f"Fireworks: ⚠️ No reasoning trace extracted from any field!")
            
            return response_text.strip(), reasoning_trace.strip()


# Singleton
fireworks_client = None

def get_fireworks_client(api_key: Optional[str] = None) -> FireworksClient:
    global fireworks_client
    if fireworks_client is None or api_key:
        fireworks_client = FireworksClient(api_key)
    return fireworks_client
