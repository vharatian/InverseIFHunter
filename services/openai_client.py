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
import asyncio
from typing import Dict, Any, Optional, List
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
        max_tokens: int = 32768,  # GPT-5 max: 32k tokens for reasoning + response
        temperature: float = 0.1,
        independent_judging: bool = False
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
        # STRICT JSON VALIDATION: Validate response_reference before any LLM calls
        # This ensures invalid JSON always raises an error, regardless of independent_judging flag
        if not response_reference or not response_reference.strip():
            error_msg = "CRITICAL: Reference Answer must be VALID JSON. Error: response_reference is empty or missing"
            print(error_msg)
            raise ValueError(error_msg)
        
        try:
            # Try to parse as JSON to validate
            parsed = json.loads(response_reference.strip())
            # If it's a dict with "criteria" key, validate that too
            if isinstance(parsed, dict) and "criteria" in parsed:
                if not isinstance(parsed["criteria"], list):
                    raise ValueError("Reference JSON 'criteria' must be a list")
            # If it's not a dict or list, it's not a valid criteria structure
            if not isinstance(parsed, (dict, list)):
                raise ValueError(f"Reference JSON must be a JSON object or array, got {type(parsed).__name__}")
        except json.JSONDecodeError as e:
            error_msg = f"CRITICAL: Reference Answer must be VALID JSON. Parse Error: {e}"
            print(error_msg)
            raise ValueError(error_msg)
        except ValueError as e:
            # Re-raise ValueError as-is (it's already a CRITICAL message)
            if "CRITICAL" in str(e):
                raise
            # Otherwise, wrap it
            error_msg = f"CRITICAL: Failed to process Reference JSON: {e}"
            print(error_msg)
            raise ValueError(error_msg)
        except Exception as e:
            error_msg = f"CRITICAL: Failed to process Reference JSON: {e}"
            print(error_msg)
            raise ValueError(error_msg)
        
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
            user_prompt = f"""<original_prompt>
{prompt}
</original_prompt>

<ground_truth_reference>
{response_reference}
</ground_truth_reference>

<student_model_response>
{student_response}
</student_model_response>"""
        
        # Dispatch to independent judging if enabled
        if independent_judging:
            return await self._judge_independently(
                prompt, student_response, response_reference, 
                judge_system_prompt, model
            )

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

    async def _judge_independently(
        self,
        prompt: str,
        student_response: str,
        reference: str,
        system_prompt: str,
        model: str
    ) -> Dict[str, Any]:
        """
        Judge response by splitting criteria into independent API calls.
        """
        print(f"DEBUG: Starting INDEPENDENT judging mode.")
        
        # Step 1: Extract criteria
        criteria_list = await self._extract_criteria(reference, model)
        
        if not criteria_list:
            print("WARNING: Could not extract independent criteria. Falling back to single-pass.")
            # Recursive call with flag=False to avoid infinite loop
            return await self.judge_response(
                prompt, student_response, reference, system_prompt, 
                model=model, independent_judging=False
            )
            
        print(f"DEBUG: Extracted {len(criteria_list)} criteria: {[c.get('id') for c in criteria_list]}")
        
        # Step 2: Evaluate each criterion independently
        tasks = []
        for criterion in criteria_list:
            tasks.append(self._evaluate_single_criterion(
                prompt, student_response, criterion, model
            ))
            
        # Run in parallel
        results = await asyncio.gather(*tasks)
        
        # Step 3: Aggregate results
        final_criteria = {}
        failed_criteria = []
        pass_count = 0
        
        for res in results:
            c_id = res['id']
            status = res['status']
            reason = res['reason']
            final_criteria[c_id] = status
            
            if status == 'PASS':
                pass_count += 1
            else:
                failed_criteria.append(f"{c_id}: {reason}")
        
        # Calculate scores
        # Calculate scores based on Fail Rate
        # "75% fail" example -> If Fail Rate >= 50%, Score is 0.
        fail_count = len(failed_criteria)
        total_count = len(criteria_list) if criteria_list else 1
        fail_rate = fail_count / total_count
        
        # Threshold: If more than or equal to 50% fail, it's a Fail.
        score = 1 if fail_rate < 0.5 else 0
        
        explanation = (
            f"Independent Judging Results:\n"
            f"- Passing Criteria: {pass_count}/{len(criteria_list)}\n"
        )
        if failed_criteria:
            explanation += "\nFailed Criteria Details:\n" + "\n".join(failed_criteria)
        else:
            explanation += "\nAll criteria passed."
            
        return {
            "score": score,
            "criteria": final_criteria,
            "explanation": explanation,
            "raw_output": "Generated via Independent Criteria Judging"
        }

    async def _extract_criteria(self, reference: str, model: str) -> List[Dict[str, str]]:
        """
        Extract criteria list from reference text.
        STRICT MODE: Reference MUST be valid JSON.
        """
        
        # 1. Try to parse directly as JSON
        try:
            parsed = json.loads(reference)
            
            # Handle {"criteria": [...]} case
            if isinstance(parsed, dict) and "criteria" in parsed:
                parsed = parsed["criteria"]
                
            if isinstance(parsed, list) and len(parsed) > 0:
                normalized = []
                for idx, item in enumerate(parsed):
                    # Handle [{"id": "...", "description": "..."}] setup
                    if isinstance(item, dict):
                        c_id = item.get("id", f"C{idx+1}")
                        desc = item.get("description", item.get("criteria", str(item)))
                        normalized.append({"id": c_id, "description": desc})
                    # Handle ["Criterion 1", "Criterion 2"] setup
                    elif isinstance(item, str):
                        normalized.append({"id": f"C{idx+1}", "description": item})
                
                if normalized:
                    print(f"DEBUG: Optimization - Parsed {len(normalized)} criteria directly from JSON reference.")
                    return normalized
            else:
                 # It's valid JSON but not a list (e.g. empty dict, number, bool)
                 raise ValueError("Reference JSON must be a list of criteria or object with 'criteria' key.")

        except json.JSONDecodeError as e:
            # STRICT MODE ENACTED: Do not fallback. Warn the user.
            error_msg = f"CRITICAL: Reference Answer must be VALID JSON. Parse Error: {e}"
            print(error_msg)
            # We raise an exception that will bubble up and stop the hunt (or just the judge)
            # In hunt_engine, this will likely be caught and mark the hunt as FAILED with error.
            raise ValueError(error_msg)
        except Exception as e:
             raise ValueError(f"CRITICAL: Failed to process Reference JSON: {e}")

    async def _evaluate_single_criterion(
        self, 
        prompt: str, 
        student_response: str, 
        criterion: Dict[str, str], 
        model: str
    ) -> Dict[str, str]:
        """Evaluate a single criterion."""
        c_id = criterion.get('id', 'Unknown')
        desc = criterion.get('description', '')
        
        eval_prompt = f"""
        TASK: Evaluate if the Student Answer meets this SINGLE criterion.
        
        Criterion ({c_id}): {desc}
        
        Original Question:
        {prompt}
        
        Student Answer:
        {student_response}
        
        Output JSON:
        {{
            "status": "PASS" or "FAIL",
            "reason": "Brief explanation"
        }}
        """
        
        try:
            # print(f"DEBUG: Evaluating criterion {c_id}...")
            response = await self.client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": eval_prompt}],
                response_format={"type": "json_object"}
            )
            content = response.choices[0].message.content
            data = json.loads(content)
            return {
                "id": c_id,
                "status": data.get("status", "FAIL").upper(),
                "reason": data.get("reason", "No reason")
            }
        except Exception as e:
            print(f"ERROR evaluating criterion {c_id}: {e}")
            return {"id": c_id, "status": "FAIL", "reason": f"Eval Error: {e}"}


# Singleton instance
openai_judge_client = None

def get_openai_judge_client(api_key: Optional[str] = None) -> OpenAIJudgeClient:
    """Get or create OpenAI judge client instance."""
    global openai_judge_client
    if openai_judge_client is None or api_key:
        openai_judge_client = OpenAIJudgeClient(api_key)
    return openai_judge_client
