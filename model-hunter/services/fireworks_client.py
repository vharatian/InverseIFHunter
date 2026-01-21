"""
Fireworks AI Client Service

Handles API calls to Fireworks AI for models:
- Llama 3 70B Instruct
- Mixtral 8x7B Instruct
- Qwen 2.5 72B Instruct

Features:
- Streaming support
- Standard OpenAI-compatible format
"""
import os
import json
import httpx
from typing import Tuple, Optional, Dict, Any
from dotenv import load_dotenv

load_dotenv()


class FireworksClient:
    """Async client for Fireworks AI API."""
    
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
                    # Return response with reasoning from this attempt (most recent)
                    return response_text, (reasoning.strip() if reasoning else accumulated_reasoning.strip()), None
                
                # For thinking models: if content is empty but we have reasoning,
                # the reasoning IS the response - use it
                if reasoning and reasoning.strip() and not response_text.strip():
                    return reasoning, reasoning.strip(), None
                    
            except Exception as e:
                last_error = f"Error: {str(e)}"
                
            # Wait before retry
            if attempt < max_retries - 1:
                import asyncio
                await asyncio.sleep(2 ** attempt)
                
        return "", accumulated_reasoning.strip(), last_error or "Empty response"

    async def call_model(
        self,
        prompt: str,
        model: str,
        timeout: float = 120.0
    ) -> Tuple[str, str]:
        """
        Call Fireworks API and return (response_text, reasoning_trace).
        
        Fireworks AI returns reasoning traces in the same format as OpenRouter:
        - For thinking models, reasoning may be in message.reasoning or message.thinking
        - For streaming, reasoning may be in delta.reasoning or delta.thinking
        """
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 4096, # Default max
            "temperature": 0.7,
            "stream": False # Simple non-streaming for now
        }
        
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                self.BASE_URL,
                headers=self._get_headers(),
                json=payload
            )
            
            if response.status_code != 200:
                raise ValueError(f"Fireworks API Error {response.status_code}: {response.text}")
                
            data = response.json()
            
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
                print(f"DEBUG Fireworks: Found reasoning in 'reasoning_content' field")
            
            # Priority 2: Check reasoning_details array (similar to OpenRouter format)
            if not reasoning_trace and "reasoning_details" in message and message["reasoning_details"]:
                print(f"DEBUG Fireworks: Found reasoning_details array with {len(message['reasoning_details'])} items")
                for detail in message["reasoning_details"]:
                    if isinstance(detail, dict) and "text" in detail:
                        reasoning_trace += detail["text"]
                if reasoning_trace:
                    print(f"DEBUG Fireworks: Extracted reasoning from 'reasoning_details' array")
            
            # Priority 3: Check direct reasoning/thinking fields (fallback, like OpenRouter)
            if not reasoning_trace:
                reasoning_trace = message.get("reasoning", "") or message.get("thinking", "") or ""
                if reasoning_trace:
                    print(f"DEBUG Fireworks: Found reasoning in 'reasoning' or 'thinking' field")
            
            # Priority 4: Check if content contains <think> tags and extract reasoning from there
            # Sometimes reasoning is embedded in content as <think>...</think>
            import re
            think_pattern = r'<think>(.*?)</think>'
            think_matches = re.findall(think_pattern, response_text, re.DOTALL)
            if think_matches:
                # Extract reasoning from <think> tags
                extracted_reasoning = "\n".join(think_matches)
                if not reasoning_trace:
                    reasoning_trace = extracted_reasoning
                    print(f"DEBUG Fireworks: Extracted reasoning from <think> tags in content")
                # Remove <think> tags from response_text to get clean final answer
                response_text = re.sub(think_pattern, '', response_text, flags=re.DOTALL).strip()
            
            # Priority 5: If we still don't have reasoning but response_text is very long,
            # it might be that the entire content is reasoning (some thinking models do this)
            # This is handled in call_with_retry where if content is empty but reasoning exists,
            # we use reasoning as the response. But we should still try to separate if possible.
            
            # Debug: Log what we're extracting
            print(f"DEBUG Fireworks: message keys: {list(message.keys())}")
            print(f"DEBUG Fireworks: response_text length: {len(response_text)}")
            print(f"DEBUG Fireworks: reasoning_trace length: {len(reasoning_trace)}")
            print(f"DEBUG Fireworks: has 'reasoning_content' key: {'reasoning_content' in message}")
            print(f"DEBUG Fireworks: has 'reasoning' key: {'reasoning' in message}")
            print(f"DEBUG Fireworks: has 'thinking' key: {'thinking' in message}")
            print(f"DEBUG Fireworks: has 'reasoning_details' key: {'reasoning_details' in message}")
            if response_text:
                print(f"DEBUG Fireworks: response_text preview (first 200 chars): {response_text[:200]}")
            if reasoning_trace:
                print(f"DEBUG Fireworks: reasoning_trace preview (first 200 chars): {reasoning_trace[:200]}")
            else:
                print(f"DEBUG Fireworks: ⚠️ No reasoning trace extracted from any field!")
            
            return response_text.strip(), reasoning_trace.strip()


# Singleton
fireworks_client = None

def get_fireworks_client(api_key: Optional[str] = None) -> FireworksClient:
    global fireworks_client
    if fireworks_client is None or api_key:
        fireworks_client = FireworksClient(api_key)
    return fireworks_client
