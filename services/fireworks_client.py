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
        "llama3": "accounts/fireworks/models/llama-v3-70b-instruct",
        "mixtral": "accounts/fireworks/models/mixtral-8x7b-instruct",
        "qwen2.5": "accounts/fireworks/models/qwen2p5-72b-instruct"
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
        
        # Resolve short model names if needed
        # But we expect full IDs from frontend mostly
        
        for attempt in range(max_retries):
            try:
                response = await self.call_model(
                    prompt=prompt,
                    model=model,
                    timeout=timeout
                )
                
                if response and response.strip():
                    # Fireworks models (Llama3) don't have separate reasoning trace typically
                    # unless using DeepSeek R1 on Fireworks (if available)
                    return response, "", None
                    
            except Exception as e:
                last_error = f"Error: {str(e)}"
                
            # Wait before retry
            if attempt < max_retries - 1:
                import asyncio
                await asyncio.sleep(2 ** attempt)
                
        return "", "", last_error or "Empty response"

    async def call_model(
        self,
        prompt: str,
        model: str,
        timeout: float = 120.0
    ) -> str:
        """Call Fireworks API."""
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
            choices = data.get("choices", [])
            if not choices:
                return ""
                
            return choices[0].get("message", {}).get("content", "")


# Singleton
fireworks_client = None

def get_fireworks_client(api_key: Optional[str] = None) -> FireworksClient:
    global fireworks_client
    if fireworks_client is None or api_key:
        fireworks_client = FireworksClient(api_key)
    return fireworks_client
