"""
OpenAI Client Service

Handles API calls to OpenAI for GPT-5 judge.

Features:
- Structured judge output parsing
- Extracts: Grading Basis, Score, JSON, Explanation
- Error handling for malformed responses
"""
import os
import re
import json
from typing import Dict, Any, Optional
from openai import AsyncOpenAI
from dotenv import load_dotenv

load_dotenv()


class OpenAIJudgeClient:
    """Client for OpenAI GPT-5 judge with structured output parsing."""
    
    DEFAULT_MODEL = "gpt-5"
    
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.getenv("OPENAI_API_KEY")
        if not self.api_key:
            raise ValueError("OpenAI API key not found. Set OPENAI_API_KEY in .env")
        
        self.client = AsyncOpenAI(api_key=self.api_key)
    
    async def judge_response(
        self,
        prompt: str,
        student_response: str,
        response_reference: str,
        judge_system_prompt: str,
        judge_prompt_template: Optional[str] = None,
        model: str = DEFAULT_MODEL,
        max_tokens: int = 8192,  # GPT-5 needs more tokens for reasoning + response
        temperature: float = 0.1
    ) -> Dict[str, Any]:
        """
        Judge a model response using GPT-5.
        
        Args:
            prompt: Original prompt given to the model
            student_response: The model's response to judge
            response_reference: Reference criteria for judging
            judge_system_prompt: System prompt for the judge
            judge_prompt_template: Optional template for judge prompt
            model: Model to use for judging
            max_tokens: Maximum tokens for judge response
            temperature: Sampling temperature
        
        Returns:
            Dict with: score, criteria, explanation, raw_output
        """
        # Build the judge prompt
        if judge_prompt_template:
            user_prompt = judge_prompt_template.replace(
                "{prompt}", prompt
            ).replace(
                "{response_reference}", response_reference
            ).replace(
                "{response}", student_response
            )
        else:
            user_prompt = f"""<Question>:{prompt}

<Standard Answer>:{response_reference}

<Student Answer>:{student_response}"""
        
        try:
            # GPT-5 and newer models use 'max_completion_tokens' instead of 'max_tokens'
            # GPT-5 also only supports default temperature (1), so we don't pass it
            print(f"DEBUG: Calling judge model '{model}' with prompt length {len(user_prompt)}...")
            print(f"DEBUG: System prompt length: {len(judge_system_prompt)}")
            
            response = await self.client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": judge_system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                max_completion_tokens=max_tokens
                # Note: temperature not supported by GPT-5, using default (1)
            )
            
            # Debug: Print response structure
            print(f"DEBUG: Response object type: {type(response)}")
            print(f"DEBUG: Response choices count: {len(response.choices) if response.choices else 0}")
            
            if not response.choices or len(response.choices) == 0:
                print("WARNING: No choices in response!")
                return {
                    "score": None,
                    "criteria": {},
                    "explanation": "No choices returned from GPT-5",
                    "raw_output": f"Response object: {response}",
                    "error": "No choices"
                }
            
            choice = response.choices[0]
            print(f"DEBUG: Choice finish_reason: {choice.finish_reason}")
            print(f"DEBUG: Choice message: {choice.message}")
            
            raw_output = choice.message.content
            if raw_output is None:
                # Check if there's a refusal
                if hasattr(choice.message, 'refusal') and choice.message.refusal:
                    print(f"WARNING: GPT-5 refused: {choice.message.refusal}")
                    return {
                        "score": None,
                        "criteria": {},
                        "explanation": f"GPT-5 refused: {choice.message.refusal}",
                        "raw_output": f"REFUSAL: {choice.message.refusal}",
                        "error": "Refusal"
                    }
                print(f"WARNING: Judge returned None content! Choice: {choice}")
                return {
                    "score": None,
                    "criteria": {},
                    "explanation": f"GPT-5 returned None. Finish reason: {choice.finish_reason}",
                    "raw_output": f"Finish: {choice.finish_reason}, Message: {choice.message}",
                    "error": "None content"
                }
            
            print(f"DEBUG: Got judge response of length {len(raw_output)}")
            return self._parse_judge_output(raw_output)
            
        except Exception as e:
            error_msg = f"API Error: {str(e)}"
            print(f"ERROR: Judge API failed: {error_msg}")
            return {
                "score": None,
                "criteria": {},
                "explanation": f"Judge failed: {error_msg}",
                "raw_output": error_msg,
                "error": error_msg
            }
    
    def _parse_judge_output(self, text: str) -> Dict[str, Any]:
        """
        Parse structured judge output.
        
        Expected format:
            [Grading Basis]:
            {"C1": "PASS or FAIL", ...}
            [Score]: X point(s)
            [JSON]: {"answer_score": X}
            [Explanation]: ...
        """
        result = {
            "score": None,
            "criteria": {},
            "explanation": "",
            "raw_output": text,
            "error": None
        }
        
        try:
            # Log raw output for debugging
            print(f"DEBUG: Parsing judge output (first 500 chars): {text[:500]}...")
            
            # Extract grading basis (criteria) - try multiple patterns
            criteria_parsed = False
            
            # Pattern 1: [Grading Basis]: {JSON}
            grading_match = re.search(
                r'\[Grading Basis\]:\s*(\{[^}]+\})',
                text,
                re.IGNORECASE | re.DOTALL
            )
            if grading_match:
                try:
                    criteria_str = grading_match.group(1)
                    criteria_str = re.sub(r'\s+', ' ', criteria_str)
                    result["criteria"] = json.loads(criteria_str)
                    criteria_parsed = True
                except json.JSONDecodeError:
                    result["criteria"] = self._parse_criteria_fallback(grading_match.group(1))
                    criteria_parsed = len(result["criteria"]) > 0
            
            # Pattern 2: Look for "C1": "PASS" or "C1: PASS" anywhere
            if not criteria_parsed:
                c_pattern = re.findall(r'["\']?(C\d+)["\']?\s*[:=]\s*["\']?(PASS|FAIL)["\']?', text, re.IGNORECASE)
                if c_pattern:
                    result["criteria"] = {k: v.upper() for k, v in c_pattern}
                    criteria_parsed = True
                    print(f"DEBUG: Parsed criteria from C-pattern: {result['criteria']}")
            
            # Pattern 3: Look for criterion names like "Correctness: PASS"
            if not criteria_parsed:
                named_pattern = re.findall(r'([A-Za-z_]+)\s*[:=]\s*(PASS|FAIL)', text, re.IGNORECASE)
                if named_pattern:
                    # Filter out common non-criteria words
                    exclude = {'score', 'answer', 'answer_score', 'result', 'verdict', 'status'}
                    result["criteria"] = {k: v.upper() for k, v in named_pattern if k.lower() not in exclude}
                    if result["criteria"]:
                        criteria_parsed = True
                        print(f"DEBUG: Parsed criteria from named pattern: {result['criteria']}")
            
            print(f"DEBUG: Final parsed criteria: {result['criteria']}")
            
            # Extract score from [Score]: X point(s)
            score_match = re.search(r'\[Score\]:\s*(\d+)\s*point', text, re.IGNORECASE)
            if score_match:
                result["score"] = int(score_match.group(1))
            
            # Extract score from [JSON]: {"answer_score": X}
            json_match = re.search(r'\[JSON\]:\s*(\{[^}]+\})', text, re.IGNORECASE)
            if json_match:
                try:
                    json_data = json.loads(json_match.group(1))
                    if "answer_score" in json_data:
                        result["score"] = json_data["answer_score"]
                except json.JSONDecodeError:
                    pass
            
            # Extract explanation
            explanation_match = re.search(
                r'\[Explanation\]:\s*(.+?)(?=\[|$)',
                text,
                re.IGNORECASE | re.DOTALL
            )
            if explanation_match:
                result["explanation"] = explanation_match.group(1).strip()
            
            # Fallback: if no score found, count PASS/FAIL
            if result["score"] is None and result["criteria"]:
                pass_count = sum(1 for v in result["criteria"].values() if str(v).upper() == "PASS")
                total = len(result["criteria"])
                result["score"] = 1 if pass_count > total / 2 else 0
            
            # Final fallback: look for any score pattern like "score: 0" or "Score: 1"
            if result["score"] is None:
                any_score = re.search(r'(?:score|answer_score)[:\s]+(\d+)', text, re.IGNORECASE)
                if any_score:
                    result["score"] = int(any_score.group(1))
            
            # Very final fallback: Check the last 100 chars for a verdict
            if result["score"] is None:
                text_len = len(text)
                end_slice = text[max(0, text_len - 200):].upper()
                
                # Check for explicit verdict statements at the end
                if "FAIL" in end_slice or "BREAK" in end_slice or "BROKEN" in end_slice:
                    result["score"] = 0
                elif "PASS" in end_slice or "SAFE" in end_slice:
                    result["score"] = 1
                    
            # Absolute final fallback if we still have ?
            if result["score"] is None:
                # If we have criteria but no score, assume FAIL if any criteria failed
                if result["criteria"]:
                    # Already handled above, but double check logic
                    pass
                else:
                    # If completely unparseable, we might default to 0 (Fail) if it looks negative?
                    # For now, let's look for ANY occurrence of "Fail" as a strong signal
                    if "FAIL" in text.upper():
                        result["score"] = 0
                    elif "PASS" in text.upper():
                        result["score"] = 1
            
        except Exception as e:
            result["error"] = f"Parse error: {str(e)}"
        
        return result
    
    def _parse_criteria_fallback(self, text: str) -> Dict[str, str]:
        """Fallback parser for criteria when JSON parsing fails."""
        criteria = {}
        matches = re.findall(r'"?(C\d+)"?\s*:\s*"?(PASS|FAIL)"?', text, re.IGNORECASE)
        for key, value in matches:
            criteria[key.upper()] = value.upper()
        return criteria
    
    async def test_connection(self) -> bool:
        """Test API connection."""
        try:
            response = await self.client.chat.completions.create(
                model="gpt-4o",  # Use gpt-4o for testing
                messages=[{"role": "user", "content": "test"}],
                max_completion_tokens=5
            )
            return True
        except Exception:
            return False


# Singleton instance
openai_judge_client = None

def get_openai_judge_client(api_key: Optional[str] = None) -> OpenAIJudgeClient:
    """Get or create OpenAI judge client instance."""
    global openai_judge_client
    if openai_judge_client is None or api_key:
        openai_judge_client = OpenAIJudgeClient(api_key)
    return openai_judge_client
