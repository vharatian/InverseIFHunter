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
import time

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
        independent_judging: bool = True,  # Always use independent judging
        standard_response: Optional[str] = None  # Standard/expected response from [response] cell
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
            standard_response: Standard/expected response from [response] cell (for {standard_response} placeholder)
        
        Returns:
            Dict with: score, criteria, explanation, raw_output
        """
        # STRICT JSON VALIDATION: Validate response_reference before any LLM calls
        # This ensures invalid JSON always raises an error (independent judging is always enabled)
        if not response_reference or not response_reference.strip():
            error_msg = "CRITICAL: Reference Answer must be VALID JSON. Error: response_reference is empty or missing"
            print(error_msg)
            raise ValueError(error_msg)
        
        try:
            # Extract only the JSON array between [ and ], ignoring any text outside
            array_match = re.search(r'\[.*?\]', response_reference, re.DOTALL)
            
            if not array_match:
                raise ValueError("Reference Answer must contain a JSON array between [ and ] brackets")
            
            json_array_str = array_match.group(0)
            
            # Try to parse as JSON to validate
            parsed = json.loads(json_array_str)
            
            # Must be a list/array
            if not isinstance(parsed, list):
                raise ValueError(f"Reference JSON must be a JSON array (list), got {type(parsed).__name__}")
            
            if len(parsed) == 0:
                raise ValueError("Reference JSON array cannot be empty")
                
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
        # Use standard_response if provided, otherwise empty string
        standard_resp = standard_response or ""
        
        if judge_prompt_template:
            # Support both old and new template placeholders
            user_prompt = judge_prompt_template.replace(
                "{prompt}", prompt
            ).replace(
                "{model_resposne}", student_response  # Note: using exact typo from user's template
            ).replace(
                "{model_response}", student_response  # Also support correct spelling
            ).replace(
                "{response}", student_response  # Legacy support
            ).replace(
                "{standard_response}", standard_resp
            ).replace(
                "{criteria}", response_reference
            ).replace(
                "{response_reference}", response_reference  # Legacy support
            )
        else:
            # Default template using new format
            user_prompt = f"""## Question
{prompt}

---
## Student Response
{student_response}

---
## Standard Responses
{standard_resp}

---
## Evaluation Criteria
{response_reference}

---
"""
        
        # Always use independent judging (each criterion evaluated separately)
        if independent_judging:
            return await self._judge_independently(
                prompt, student_response, response_reference, 
                judge_system_prompt, model, standard_response=standard_resp
            )

        # Retry logic for connection errors (broken pipe, timeouts, etc.)
        max_retries = 3
        retry_delay = 2  # seconds
        
        for attempt in range(max_retries):
            try:
                # GPT-5 and newer models use 'max_completion_tokens' instead of 'max_tokens'
                # GPT-5 also only supports default temperature (1), so we don't pass it
                print(f"DEBUG: Calling judge model '{model}' with prompt length {len(user_prompt)}... (attempt {attempt + 1}/{max_retries})")
                print(f"DEBUG: System prompt length: {len(judge_system_prompt)}")
                
                response = await self.client.chat.completions.create(
                    model=model,
                    messages=[
                        {"role": "system", "content": judge_system_prompt},
                        {"role": "user", "content": user_prompt}
                    ],
                    max_completion_tokens=max_tokens,
                    timeout=180.0  # 3 minute timeout
                    # Note: temperature not supported by GPT-5, using default (1)
                )
                break  # Success, exit retry loop
            except (BrokenPipeError, ConnectionError, OSError, IOError) as e:
                if attempt < max_retries - 1:
                    wait_time = retry_delay * (2 ** attempt)  # Exponential backoff
                    print(f"WARNING: Connection error (attempt {attempt + 1}/{max_retries}): {str(e)}")
                    print(f"Retrying in {wait_time} seconds...")
                    await asyncio.sleep(wait_time)
                else:
                    # Last attempt failed
                    raise
            except Exception as e:
                # Check if it's a connection-related error by error message
                error_str = str(e).lower()
                if any(keyword in error_str for keyword in ['broken pipe', 'connection', 'timeout', 'network', 'reset', 'errno 32']):
                    if attempt < max_retries - 1:
                        wait_time = retry_delay * (2 ** attempt)
                        print(f"WARNING: Connection-related error detected (attempt {attempt + 1}/{max_retries}): {str(e)}")
                        print(f"Retrying in {wait_time} seconds...")
                        await asyncio.sleep(wait_time)
                    else:
                        raise
                else:
                    # For other errors, don't retry
                    raise
        
        # Process the response
        try:
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
            return self._parse_judge_output(raw_output, response_reference)
            
        except (BrokenPipeError, ConnectionError, OSError, IOError) as e:
            error_msg = f"Connection Error: {str(e)}"
            print(f"ERROR: Judge API connection failed: {error_msg}")
            return {
                "score": None,
                "criteria": {},
                "explanation": f"Judge connection failed: {error_msg}. Please try again.",
                "raw_output": error_msg,
                "error": error_msg
            }
        except Exception as e:
            # Check if it's a connection-related error by error message
            error_str = str(e).lower()
            if any(keyword in error_str for keyword in ['broken pipe', 'connection', 'timeout', 'network', 'reset', 'errno 32']):
                error_msg = f"Connection Error: {str(e)}"
                print(f"ERROR: Judge API connection failed (detected from message): {error_msg}")
                return {
                    "score": None,
                    "criteria": {},
                    "explanation": f"Judge connection failed: {error_msg}. Please try again.",
                    "raw_output": error_msg,
                    "error": error_msg
                }
            error_msg = f"API Error: {str(e)}"
            print(f"ERROR: Judge API failed: {error_msg}")
            return {
                "score": None,
                "criteria": {},
                "explanation": f"Judge failed: {error_msg}",
                "raw_output": error_msg,
                "error": error_msg
            }
    
    def _parse_judge_output(self, text: str, response_reference: str = None) -> Dict[str, Any]:
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
            
            # First, check if the entire output is a JSON object (new format)
            # The output might have prefixes like "Output:" or be wrapped in markdown code blocks
            print(f"DEBUG: _parse_judge_output - Input text (first 200 chars): {text[:200]}")
            text_stripped = text.strip()
            json_data = None
            
            # Try 1: Remove common prefixes
            # Handle "Output:" prefix
            if text_stripped.startswith("Output:"):
                text_stripped = text_stripped[7:].strip()  # Remove "Output:" prefix
                print(f"DEBUG: Removed 'Output:' prefix, remaining (first 200 chars): {text_stripped[:200]}")
            # Handle markdown code blocks
            if text_stripped.startswith("```"):
                # Remove code block markers
                lines = text_stripped.split('\n')
                if lines[0].startswith("```"):
                    lines = lines[1:]
                if lines and lines[-1].strip() == "```":
                    lines = lines[:-1]
                text_stripped = '\n'.join(lines).strip()
            
            # Try 2: Parse entire text as JSON (after cleaning)
            if text_stripped.startswith('{'):
                try:
                    json_data = json.loads(text_stripped)
                    print(f"DEBUG: Successfully parsed JSON from cleaned text")
                except json.JSONDecodeError as e:
                    print(f"DEBUG: Failed to parse cleaned text as JSON: {e}")
                    pass
            
            # Try 3: Find JSON object in text using a more robust pattern
            if not json_data:
                # Look for JSON object that contains "result" field - use a simpler, more reliable pattern
                # Find the first { and last } that contain "result"
                start_idx = text.find('{')
                if start_idx != -1:
                    # Find matching closing brace
                    brace_count = 0
                    end_idx = start_idx
                    for i in range(start_idx, len(text)):
                        if text[i] == '{':
                            brace_count += 1
                        elif text[i] == '}':
                            brace_count -= 1
                            if brace_count == 0:
                                end_idx = i + 1
                                break
                    
                    if end_idx > start_idx:
                        json_str = text[start_idx:end_idx]
                        try:
                            json_data = json.loads(json_str)
                            print(f"DEBUG: Successfully parsed JSON using brace matching")
                        except json.JSONDecodeError as e:
                            print(f"DEBUG: Failed to parse JSON from brace matching: {e}")
                            pass
            
            if json_data and "result" in json_data:
                    print(f"DEBUG: Detected JSON format output: {list(json_data.keys())}")
                    
                    # Extract score from "result" field
                    if "result" in json_data:
                        result_str = str(json_data["result"]).upper()
                        if result_str == "PASS":
                            result["score"] = 1
                        elif result_str == "FAIL":
                            result["score"] = 0
                        print(f"DEBUG: Extracted score from JSON result field: {result['score']}")
                    
                    # Extract explanation
                    if "explanation" in json_data:
                        result["explanation"] = str(json_data["explanation"]).strip()
                        print(f"DEBUG: Extracted explanation from JSON (length: {len(result['explanation'])})")
                    
                    # Try to extract criteria from explanation text
                    # First, try to get expected criteria from response_reference if available
                    # (We'll need to pass this through, but for now extract from explanation)
                    explanation_text = result.get("explanation", "")
                    
                    # Look for all criterion IDs mentioned in explanation (C1, C2, etc.)
                    criteria_pattern = re.findall(r'(C\d+)', explanation_text, re.IGNORECASE)
                    print(f"DEBUG: Found criterion IDs in explanation: {criteria_pattern}")
                    
                    # Also check if there's a "criteria" field in the JSON
                    if "criteria" in json_data:
                        criteria_data = json_data["criteria"]
                        if isinstance(criteria_data, dict):
                            result["criteria"] = {k.upper(): str(v).upper() for k, v in criteria_data.items()}
                            print(f"DEBUG: Extracted criteria from JSON criteria field: {list(result['criteria'].keys())}")
                        elif isinstance(criteria_data, list):
                            # List format, convert to dict
                            for item in criteria_data:
                                if isinstance(item, dict) and "id" in item:
                                    c_id = item["id"].upper()
                                    status = str(item.get("status", item.get("result", "PASS"))).upper()
                                    result["criteria"][c_id] = status
                            print(f"DEBUG: Extracted criteria from JSON criteria list: {list(result['criteria'].keys())}")
                    
                    # If no criteria field, extract from explanation
                    if not result["criteria"] and criteria_pattern:
                        # Check if explanation mentions PASS/FAIL for each criterion
                        for c_id in set(criteria_pattern):
                            c_id_upper = c_id.upper()
                            # Look for context around this criterion ID in explanation
                            # Pattern: "C1" followed by something that suggests PASS or the explanation is positive
                            # Since result is PASS, assume all mentioned criteria passed
                            if result["score"] == 1:
                                result["criteria"][c_id_upper] = "PASS"
                            else:
                                # For FAIL, check if explanation says it failed
                                # Look for negative words near the criterion
                                c_context = re.search(
                                    rf'{c_id}[^.]*?({"|".join(["failed", "does not", "did not", "lacks", "missing"])})',
                                    explanation_text,
                                    re.IGNORECASE
                                )
                                if c_context:
                                    result["criteria"][c_id_upper] = "FAIL"
                                else:
                                    # If result is PASS overall, assume mentioned criteria passed
                                    result["criteria"][c_id_upper] = "PASS" if result["score"] == 1 else "FAIL"
                        print(f"DEBUG: Extracted criteria from explanation: {list(result['criteria'].keys())}")
                    
                    # Check if explanation suggests all criteria passed
                    explanation_lower = explanation_text.lower()
                    all_passed_indicators = [
                        "all criteria", "all criterion", "all satisfied", "all met",
                        "criteria were satisfied", "criteria satisfied", "all passed"
                    ]
                    all_passed = any(indicator in explanation_lower for indicator in all_passed_indicators)
                    
                    # If we still don't have criteria but have a PASS result, infer from response_reference
                    # This handles cases where the judge says "all criteria satisfied" but doesn't list them
                    # IMPORTANT: Only mark criteria that are ACTUALLY in the response_reference as PASS
                    if not result["criteria"] and result["score"] == 1 and response_reference and all_passed:
                        try:
                            # Extract expected criteria IDs from response_reference (only what's actually there)
                            array_match = re.search(r'\[.*?\]', response_reference, re.DOTALL)
                            if array_match:
                                criteria_list = json.loads(array_match.group(0))
                                if isinstance(criteria_list, list):
                                    for item in criteria_list:
                                        c_id = item.get('id', '').upper() if isinstance(item, dict) else ''
                                        if c_id:
                                            result["criteria"][c_id] = "PASS"
                                    print(f"DEBUG: Inferred criteria as PASS from 'all criteria satisfied' message (only from response_reference): {list(result['criteria'].keys())}")
                        except Exception as e:
                            print(f"DEBUG: Could not infer criteria from response_reference: {e}")
                    
                    # Check for missing criteria by comparing with expected criteria from response_reference
                    # IMPORTANT: Only mark criteria in response_reference as PASS, not missing ones
                    if response_reference:
                        try:
                            # Extract expected criteria IDs from response_reference (only what's actually there)
                            array_match = re.search(r'\[.*?\]', response_reference, re.DOTALL)
                            if array_match:
                                criteria_list = json.loads(array_match.group(0))
                                if isinstance(criteria_list, list):
                                    expected_ids = {item.get('id', f'C{i+1}').upper() if isinstance(item, dict) else f'C{i+1}'.upper() 
                                                   for i, item in enumerate(criteria_list)}
                                    extracted_ids = set(result["criteria"].keys())
                                    missing_ids = expected_ids - extracted_ids
                                    
                                    if missing_ids:
                                        if all_passed and result["score"] == 1:
                                            # If judge says all criteria passed, mark missing ones from response_reference as PASS
                                            # (These are criteria in response_reference but not extracted from explanation)
                                            print(f"DEBUG: Judge says all criteria passed, marking missing ones from response_reference as PASS: {missing_ids}")
                                            for c_id in missing_ids:
                                                result["criteria"][c_id] = "PASS"
                                        else:
                                            # Otherwise mark as MISSING (shouldn't happen if all_passed, but just in case)
                                            print(f"DEBUG: Missing criteria detected in response_reference: {missing_ids}")
                                            for c_id in missing_ids:
                                                result["criteria"][c_id] = "MISSING"
                                        print(f"DEBUG: Updated criteria (from response_reference): {list(result['criteria'].keys())}")
                                    elif all_passed and result["score"] == 1:
                                        # Ensure all criteria in response_reference are marked as PASS
                                        print(f"DEBUG: Judge says all criteria passed, ensuring all in response_reference are marked: {expected_ids}")
                                        for c_id in expected_ids:
                                            if c_id not in result["criteria"]:
                                                result["criteria"][c_id] = "PASS"
                                        print(f"DEBUG: Final criteria from response_reference: {list(result['criteria'].keys())}")
                        except Exception as e:
                            print(f"DEBUG: Could not extract expected criteria from response_reference: {e}")
                    
                    # If we got score and explanation, we're done
                    if result["score"] is not None:
                        print(f"DEBUG: Successfully parsed JSON format output - score: {result['score']}, criteria: {len(result['criteria'])}")
                        return result
            
            # Extract grading basis (criteria) - try multiple patterns
            criteria_parsed = False
            
            # Pattern 1: [Grading Basis]: {JSON} - handle multi-line JSON
            grading_match = re.search(
                r'\[Grading Basis\]:\s*(\{.*?\})',
                text,
                re.IGNORECASE | re.DOTALL
            )
            if grading_match:
                try:
                    criteria_str = grading_match.group(1)
                    # Try parsing as-is first (handles multi-line)
                    result["criteria"] = json.loads(criteria_str)
                    criteria_parsed = True
                    print(f"DEBUG: Parsed criteria from [Grading Basis] JSON: {result['criteria']}")
                except json.JSONDecodeError:
                    # Fallback: try normalizing whitespace
                    try:
                        criteria_str = re.sub(r'\s+', ' ', criteria_str)
                        result["criteria"] = json.loads(criteria_str)
                        criteria_parsed = True
                        print(f"DEBUG: Parsed criteria after whitespace normalization: {result['criteria']}")
                    except json.JSONDecodeError:
                        result["criteria"] = self._parse_criteria_fallback(grading_match.group(1))
                        criteria_parsed = len(result["criteria"]) > 0
                        print(f"DEBUG: Used fallback parser, got {len(result['criteria'])} criteria")
            
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
            print(f"DEBUG: Criteria count: {len(result['criteria'])}")
            if not criteria_parsed:
                print(f"DEBUG: WARNING - No criteria were parsed from judge output!")
                print(f"DEBUG: First 1000 chars of output: {text[:1000]}")
            
            # Extract score from [Score]: X point(s)
            score_match = re.search(r'\[Score\]:\s*(\d+)\s*point', text, re.IGNORECASE)
            if score_match:
                result["score"] = int(score_match.group(1))
            
            # Extract score from [JSON]: {"answer_score": X} - handle multi-line JSON
            json_match = re.search(r'\[JSON\]:\s*(\{.*?\})', text, re.IGNORECASE | re.DOTALL)
            if json_match:
                try:
                    json_str = json_match.group(1)
                    json_data = json.loads(json_str)
                    if "answer_score" in json_data:
                        result["score"] = json_data["answer_score"]
                        print(f"DEBUG: Extracted score from [JSON]: {result['score']}")
                except json.JSONDecodeError:
                    # Try normalizing whitespace
                    try:
                        json_str = re.sub(r'\s+', ' ', json_str)
                        json_data = json.loads(json_str)
                        if "answer_score" in json_data:
                            result["score"] = json_data["answer_score"]
                            print(f"DEBUG: Extracted score after whitespace normalization: {result['score']}")
                    except json.JSONDecodeError:
                        print(f"DEBUG: Failed to parse [JSON] section: {json_match.group(1)[:100]}")
                        pass
            
            # Extract explanation - try multiple patterns
            explanation_match = re.search(
                r'\[Explanation\]:\s*(.+?)(?=\[|$)',
                text,
                re.IGNORECASE | re.DOTALL
            )
            if explanation_match:
                result["explanation"] = explanation_match.group(1).strip()
                print(f"DEBUG: Extracted explanation (length: {len(result['explanation'])})")
            else:
                # Try alternative pattern: [Explanation]: followed by text until next section or end
                explanation_match2 = re.search(
                    r'\[Explanation\][:\s]*(.+?)(?=\n\n\[|\n\[|$)',
                    text,
                    re.IGNORECASE | re.DOTALL
                )
                if explanation_match2:
                    result["explanation"] = explanation_match2.group(1).strip()
                    print(f"DEBUG: Extracted explanation with alternative pattern (length: {len(result['explanation'])})")
            
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
        
        # Final check: Compare extracted criteria with expected criteria from response_reference
        # IMPORTANT: Only mark criteria that are in response_reference
        # Missing criteria (not in response_reference) should be handled by frontend comparing with initial criteria
        if response_reference and result.get("score") is not None:
            try:
                # Extract expected criteria IDs from response_reference (only what's actually there)
                array_match = re.search(r'\[.*?\]', response_reference, re.DOTALL)
                if array_match:
                    criteria_list = json.loads(array_match.group(0))
                    if isinstance(criteria_list, list):
                        expected_ids = {item.get('id', f'C{i+1}').upper() if isinstance(item, dict) else f'C{i+1}'.upper() 
                                       for i, item in enumerate(criteria_list)}
                        extracted_ids = set(result["criteria"].keys())
                        missing_ids = expected_ids - extracted_ids
                        
                        if missing_ids:
                            # Check if "all criteria satisfied" was detected earlier
                            explanation_lower = result.get("explanation", "").lower()
                            all_passed_indicators = [
                                "all criteria", "all criterion", "all satisfied", "all met",
                                "criteria were satisfied", "criteria satisfied", "all passed"
                            ]
                            all_passed = any(indicator in explanation_lower for indicator in all_passed_indicators)
                            
                            if all_passed and result.get("score") == 1:
                                # If judge says all criteria passed, mark missing ones from response_reference as PASS
                                print(f"DEBUG: Final check - Judge says all criteria passed, marking missing from response_reference as PASS: {missing_ids}")
                                for c_id in missing_ids:
                                    result["criteria"][c_id] = "PASS"
                            else:
                                # Otherwise mark as MISSING (shouldn't happen if all_passed, but just in case)
                                print(f"DEBUG: Final check - Missing criteria detected in response_reference: {missing_ids}")
                                for c_id in missing_ids:
                                    result["criteria"][c_id] = "MISSING"
                            print(f"DEBUG: Final criteria (from response_reference only): {list(result['criteria'].keys())}")
            except Exception as e:
                print(f"DEBUG: Could not check for missing criteria: {e}")
        
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
        model: str,
        standard_response: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Judge response by splitting criteria into independent API calls.
        """
        print(f"DEBUG: Starting INDEPENDENT judging mode.")
        
        # Step 1: Extract criteria
        criteria_list = await self._extract_criteria(reference, model)
        
        if not criteria_list:
            error_msg = "CRITICAL: Could not extract criteria for independent judging. Reference Answer must contain a valid JSON array of criteria."
            print(error_msg)
            raise ValueError(error_msg)
            
        criteria_ids = [c.get('id') for c in criteria_list]
        print(f"DEBUG: _judge_independently - Extracted {len(criteria_list)} criteria: {criteria_ids}")
        print(f"DEBUG: _judge_independently - Reference snippet (first 500 chars): {reference[:500]}...")
        print(f"DEBUG: _judge_independently - Full criteria details:")
        for c in criteria_list:
            print(f"  - {c.get('id')}: {c.get('description', '')[:150]}...")
        
        # Step 2: Evaluate each criterion independently
        tasks = []
        for criterion in criteria_list:
            tasks.append(self._evaluate_single_criterion(
                prompt, student_response, criterion, model, standard_response=standard_response
            ))
            
        # Run in parallel
        results = await asyncio.gather(*tasks)
        
        # Step 3: Aggregate results
        final_criteria = {}
        passed_criteria = []  # Store passing criteria with explanations
        failed_criteria = []
        missing_criteria = []  # Criteria that were expected but not evaluated
        pass_count = 0
        
        # Track which criteria were evaluated
        evaluated_ids = set()
        
        print(f"DEBUG: _judge_independently - Got {len(results)} evaluation results")
        for res in results:
            c_id = res['id']
            status = res['status']
            reason = res['reason']
            final_criteria[c_id] = status
            evaluated_ids.add(c_id)
            print(f"DEBUG: _judge_independently - Evaluated {c_id}: {status} (reason: {reason[:100] if reason else 'N/A'}...)")
            
            if status == 'PASS':
                pass_count += 1
                passed_criteria.append(f"{c_id}: {reason}")  # Store passing criteria with explanation
            else:
                failed_criteria.append(f"{c_id}: {reason}")
        
        # Check for missing criteria (expected but not evaluated)
        # This happens when a criterion was in the initial criteria but not in the current response_reference
        expected_ids = {c.get('id') for c in criteria_list}
        missing_ids = expected_ids - evaluated_ids
        print(f"DEBUG: _judge_independently - Expected criteria IDs: {expected_ids}")
        print(f"DEBUG: _judge_independently - Evaluated criteria IDs: {evaluated_ids}")
        print(f"DEBUG: _judge_independently - Missing criteria IDs: {missing_ids}")
        if missing_ids:
            for c_id in missing_ids:
                missing_criteria.append(c_id)
                # Mark as missing (not a failure, but an error)
                final_criteria[c_id] = "MISSING"
                print(f"DEBUG: _judge_independently - Marked {c_id} as MISSING")
        
        # Calculate scores
        # Calculate scores based on Fail Rate (missing criteria don't count as failures)
        # Rule: If 50% or more criteria PASS, overall is PASS (score 1)
        #       If 50% or less criteria PASS (i.e., 50% or more fail), it's BREAKING (score 0)
        fail_count = len(failed_criteria)
        total_count = len(criteria_list) if criteria_list else 1
        fail_rate = fail_count / total_count
        pass_rate = 1 - fail_rate  # Calculate pass rate for clarity
        
        # Threshold: If pass_rate > 50%, it's PASSING (score 1)
        #            If pass_rate <= 50% (including exactly 50%), it's BREAKING (score 0)
        # This means 50% pass rate = BREAKING, not passing
        score = 1 if pass_rate > 0.5 else 0
        
        explanation = (
            f"Independent Judging Results:\n"
            f"- Passing Criteria: {pass_count}/{len(criteria_list)}\n"
        )
        if missing_criteria:
            explanation += f"\n⚠️ Missing Criteria (not evaluated): {', '.join(missing_criteria)}\n"
        if passed_criteria:
            explanation += "\nPassing Criteria Details:\n" + "\n".join(passed_criteria)
        if failed_criteria:
            explanation += "\nFailed Criteria Details:\n" + "\n".join(failed_criteria)
        elif not missing_criteria and not passed_criteria:
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
        STRICT MODE: Only extracts and validates the JSON array between [ and ].
        Ignores any text outside the brackets.
        """
        
        # Extract only the JSON array between [ and ], ignoring any text outside
        array_match = re.search(r'\[.*?\]', reference, re.DOTALL)
        
        if not array_match:
            error_msg = "CRITICAL: Reference Answer must contain a JSON array between [ and ] brackets"
            print(error_msg)
            raise ValueError(error_msg)
        
        json_array_str = array_match.group(0)
        
        # Try to parse as JSON
        try:
            parsed = json.loads(json_array_str)
            
            if not isinstance(parsed, list):
                raise ValueError(f"Reference JSON must be a JSON array (list), got {type(parsed).__name__}")
                
            if len(parsed) == 0:
                raise ValueError("Reference JSON array cannot be empty")
                
            normalized = []
            for idx, item in enumerate(parsed):
                # Handle [{"id": "C1", "criteria1": "..."}] format
                if isinstance(item, dict):
                    c_id = item.get("id", f"C{idx+1}")
                    # Look for criteria1, criteria2, etc. fields
                    criteria_text = None
                    for key in item.keys():
                        if key.startswith("criteria") and key != "id":
                            criteria_text = item[key]
                            break
                    
                    # Fallback to description or other fields
                    if not criteria_text:
                        criteria_text = item.get("description", item.get("criteria", str(item)))
                    
                    normalized.append({"id": c_id, "description": criteria_text})
                # Handle ["Criterion 1", "Criterion 2"] setup
                elif isinstance(item, str):
                    normalized.append({"id": f"C{idx+1}", "description": item})
            
            if normalized:
                criteria_ids = [c.get('id') for c in normalized]
                print(f"DEBUG: _extract_criteria - Parsed {len(normalized)} criteria directly from JSON array: {criteria_ids}")
                print(f"DEBUG: _extract_criteria - Full criteria list:")
                for c in normalized:
                    print(f"  - {c.get('id')}: {c.get('description', '')[:100]}...")
                print(f"DEBUG: _extract_criteria - Reference snippet (first 500 chars): {reference[:500]}...")
                return normalized
            else:
                raise ValueError("Reference JSON array must contain at least one valid criterion")

        except json.JSONDecodeError as e:
            # STRICT MODE ENACTED: Do not fallback. Warn the user.
            error_msg = f"CRITICAL: Reference Answer must be VALID JSON. Parse Error: {e}"
            print(error_msg)
            raise ValueError(error_msg)
        except Exception as e:
             raise ValueError(f"CRITICAL: Failed to process Reference JSON: {e}")

    async def _evaluate_single_criterion(
        self, 
        prompt: str, 
        student_response: str, 
        criterion: Dict[str, str], 
        model: str,
        standard_response: Optional[str] = None
    ) -> Dict[str, str]:
        """Evaluate a single criterion."""
        c_id = criterion.get('id', 'Unknown')
        desc = criterion.get('description', '')
        
        # Build prompt with standard response as reference context if available
        standard_section = ""
        if standard_response and standard_response.strip():
            standard_section = f"""
        
        Standard/Expected Answer (for reference context):
        {standard_response}
        
        Note: Use the standard answer as context to understand the expected format and approach, but evaluate the student answer strictly against the criterion below."""
        
        eval_prompt = f"""
        TASK: Evaluate if the Student Answer meets this SINGLE criterion.
        
        IMPORTANT: You are evaluating ONLY this one criterion. Do NOT consider other criteria. 
        A response can PASS some criteria while FAILING others - evaluate each criterion independently.
        
        Criterion ({c_id}): {desc}
        
        Original Question:
        {prompt}
        
        Student Answer:
        {student_response}{standard_section}
        
        Evaluate ONLY whether the Student Answer meets the specific requirement stated in Criterion ({c_id}) above.
        Do not consider other criteria or make holistic judgments.
        
        Output JSON:
        {{
            "status": "PASS" or "FAIL",
            "reason": "Brief explanation focusing specifically on this criterion"
        }}
        """
        
        # Retry logic for connection errors (broken pipe, timeouts, etc.)
        max_retries = 3
        retry_delay = 1  # seconds
        
        for attempt in range(max_retries):
            try:
                # print(f"DEBUG: Evaluating criterion {c_id}... (attempt {attempt + 1}/{max_retries})")
                response = await self.client.chat.completions.create(
                    model=model,
                    messages=[{"role": "user", "content": eval_prompt}],
                    response_format={"type": "json_object"},
                    timeout=120.0  # 2 minute timeout per criterion
                )
                content = response.choices[0].message.content
                data = json.loads(content)
                return {
                    "id": c_id,
                    "status": data.get("status", "FAIL").upper(),
                    "reason": data.get("reason", "No reason")
                }
            except (BrokenPipeError, ConnectionError, OSError, IOError) as e:
                if attempt < max_retries - 1:
                    wait_time = retry_delay * (2 ** attempt)  # Exponential backoff
                    print(f"WARNING: Connection error evaluating criterion {c_id} (attempt {attempt + 1}/{max_retries}): {str(e)}")
                    print(f"Retrying in {wait_time} seconds...")
                    await asyncio.sleep(wait_time)
                else:
                    # Last attempt failed
                    print(f"ERROR: Failed to evaluate criterion {c_id} after {max_retries} attempts: {e}")
                    return {"id": c_id, "status": "FAIL", "reason": f"Connection Error: {str(e)}"}
            except json.JSONDecodeError as e:
                print(f"ERROR: JSON decode error for criterion {c_id}: {e}")
                return {"id": c_id, "status": "FAIL", "reason": f"JSON Error: {str(e)}"}
            except Exception as e:
                # Check if it's a connection-related error by error message
                error_str = str(e).lower()
                if any(keyword in error_str for keyword in ['broken pipe', 'connection', 'timeout', 'network', 'reset', 'errno 32']):
                    if attempt < max_retries - 1:
                        wait_time = retry_delay * (2 ** attempt)
                        print(f"WARNING: Connection-related error detected for criterion {c_id} (attempt {attempt + 1}/{max_retries}): {str(e)}")
                        print(f"Retrying in {wait_time} seconds...")
                        await asyncio.sleep(wait_time)
                    else:
                        print(f"ERROR: Failed to evaluate criterion {c_id} after {max_retries} attempts: {e}")
                        return {"id": c_id, "status": "FAIL", "reason": f"Connection Error: {str(e)}"}
                else:
                    print(f"ERROR evaluating criterion {c_id}: {e}")
                    return {"id": c_id, "status": "FAIL", "reason": f"Eval Error: {str(e)}"}


# Singleton instance
openai_judge_client = None

def get_openai_judge_client(api_key: Optional[str] = None) -> OpenAIJudgeClient:
    """Get or create OpenAI judge client instance."""
    global openai_judge_client
    if openai_judge_client is None or api_key:
        openai_judge_client = OpenAIJudgeClient(api_key)
    return openai_judge_client
