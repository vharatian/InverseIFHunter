"""
Fireworks AI Client Service

Handles API calls to Fireworks AI for models:
- Qwen 3 235B (thinking model)

Features:
- Inherits connection pooling from BaseAPIClient
- Prompt engineering for reasoning separation (system message + <think> tags)
- Standard OpenAI-compatible format
"""
import os
import re
import logging
from typing import Tuple, Optional, Dict, Any
from dotenv import load_dotenv

from services.base_client import BaseAPIClient

logger = logging.getLogger(__name__)

load_dotenv()


class FireworksClient(BaseAPIClient):
    """Async client for Fireworks AI API with connection pooling."""
    
    BASE_URL = "https://api.fireworks.ai/inference/v1/chat/completions"
    PROVIDER_NAME = "fireworks"
    
    # Model configurations
    MODELS = {
        "qwen3": "accounts/fireworks/models/qwen3-235b-a22b-thinking-2507",
    }
    
    def __init__(self, api_key: Optional[str] = None):
        super().__init__(api_key, env_var_name="FIREWORKS_API_KEY")
        # Fireworks allows startup even without key (checked in _get_headers)
            
    def _get_headers(self) -> Dict[str, str]:
        if not self.api_key:
            raise ValueError("Fireworks API key not found. Set FIREWORKS_API_KEY in .env")
            
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
    
    async def call_model(
        self,
        prompt: str,
        model: str,
        timeout: float = 120.0,
        messages: Optional[list] = None,
        **kwargs
    ) -> Tuple[str, str]:
        """
        Call Fireworks API and return (response_text, reasoning_trace).
        
        Uses prompt engineering with system message to get structured reasoning
        in <think>...</think> tags.
        
        Args:
            prompt: The input prompt
            model: Model identifier
            timeout: Request timeout in seconds
            messages: Optional conversation history for multi-turn
                      (list of {role, content} dicts). The current prompt
                      is appended as the final user message.
        """
        # System message prompts model to use <think> tags for reasoning
        system_message = """You MUST format your response in exactly this structure:

<think>
[Your step-by-step reasoning, analysis, and thought process goes here]
</think>

[Your final answer goes here - concise and direct]

CRITICAL: Always use <think> and </think> tags to wrap your reasoning. Your final answer must come AFTER the </think> tag."""

        user_message = f"""Question: {prompt}

Remember: Put ALL your thinking inside <think>...</think> tags, then give your final answer after.</s>"""
        
        # Build messages list: system + optional conversation history + current user message
        api_messages = [{"role": "system", "content": system_message}]
        if messages:
            # Multi-turn: insert conversation history between system and current prompt
            api_messages.extend(messages)
        api_messages.append({"role": "user", "content": user_message})
        
        payload = {
            "model": model,
            "messages": api_messages,
            "max_tokens": 8192,
            "temperature": 0.6,
            "stream": False
        }
        
        logger.debug(f"Fireworks: Using system message + prompt engineering for reasoning separation")
        logger.debug(f"Fireworks: Model: {model}")
        
        # Use pooled client
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
        
        logger.debug(f"Fireworks: Raw response keys: {list(data.keys())}")
        
        # Check for API errors
        if "error" in data:
            error_msg = data["error"].get("message", str(data["error"]))
            raise ValueError(f"API Error: {error_msg}")
        
        choices = data.get("choices", [])
        if not choices:
            return "", ""
        
        message = choices[0].get("message", {})
        response_text = message.get("content", "") or ""
        reasoning_trace = ""
        
        # Priority 1: Check reasoning_content field (Fireworks-specific)
        if "reasoning_content" in message and message["reasoning_content"]:
            reasoning_trace = message["reasoning_content"]
            logger.debug(f"Fireworks: Found reasoning in 'reasoning_content' field")
        
        # Priority 2: Check reasoning_details array
        if not reasoning_trace and "reasoning_details" in message and message["reasoning_details"]:
            logger.debug(f"Fireworks: Found reasoning_details array with {len(message['reasoning_details'])} items")
            for detail in message["reasoning_details"]:
                if isinstance(detail, dict) and "text" in detail:
                    reasoning_trace += detail["text"]
        
        # Priority 3: Check direct reasoning/thinking fields
        if not reasoning_trace:
            reasoning_trace = message.get("reasoning", "") or message.get("thinking", "") or ""
        
        # Priority 4: Parse <think>...</think> tags from response
        if not reasoning_trace:
            response_text, reasoning_trace = self.parse_think_tags(response_text)
        elif '<think>' in response_text and '</think>' in response_text:
            # Also clean response if it has think tags even though we got reasoning elsewhere
            response_text, _ = self.parse_think_tags(response_text)
        
        # Priority 5: Fallback - Split on </think> only (no opening tag)
        if not reasoning_trace and '</think>' in response_text:
            parts = response_text.split('</think>', 1)
            extracted_reasoning = parts[0].strip()
            if extracted_reasoning.startswith('<think>'):
                extracted_reasoning = extracted_reasoning[7:].strip()
            extracted_answer = parts[1].strip() if len(parts) > 1 else ""
            
            if extracted_reasoning:
                reasoning_trace = extracted_reasoning
                response_text = extracted_answer
                logger.debug(f"Fireworks: Extracted reasoning by splitting on </think>")
        
        # Debug logging
        logger.debug(f"Fireworks: response_text length: {len(response_text)}")
        logger.debug(f"Fireworks: reasoning_trace length: {len(reasoning_trace)}")
        
        return response_text.strip(), reasoning_trace.strip()


# Singleton
_fireworks_client = None

def get_fireworks_client(api_key: Optional[str] = None) -> FireworksClient:
    """Get or create Fireworks client instance."""
    global _fireworks_client
    if _fireworks_client is None or api_key:
        _fireworks_client = FireworksClient(api_key)
    return _fireworks_client
