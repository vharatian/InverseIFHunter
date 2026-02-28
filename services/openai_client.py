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
import logging
from typing import Dict, Any, Optional, List
from openai import AsyncOpenAI
from dotenv import load_dotenv
import time

logger = logging.getLogger(__name__)

# Telemetry import - wrapped to never fail
try:
    from services.telemetry_logger import get_telemetry
    _telemetry_enabled = True
except ImportError:
    _telemetry_enabled = False

load_dotenv()


def _extract_criteria_list(reference: str) -> List[Dict[str, str]]:
    """Extract criteria list from reference (JSON array or plain C1: ... format). Used by OpenRouter judge."""
    array_match = re.search(r'\[.*?\]', reference, re.DOTALL)
    if array_match:
        try:
            parsed = json.loads(array_match.group(0))
            if not isinstance(parsed, list) or len(parsed) == 0:
                raise ValueError("Reference JSON must be a non-empty array")
            normalized = []
            for idx, item in enumerate(parsed):
                if isinstance(item, dict):
                    c_id = item.get("id", f"C{idx+1}")
                    criteria_text = None
                    for key in item.keys():
                        if key.startswith("criteria") and key != "id":
                            criteria_text = item[key]
                            break
                    if not criteria_text:
                        criteria_text = item.get("description", item.get("criteria", str(item)))
                    normalized.append({"id": c_id, "description": criteria_text})
                elif isinstance(item, str):
                    normalized.append({"id": f"C{idx+1}", "description": item})
            return normalized if normalized else []
        except json.JSONDecodeError:
            pass
    plain_text_pattern = re.compile(r'^(C\d+)\s*[:：]\s*(.+)$', re.MULTILINE | re.IGNORECASE)
    matches = plain_text_pattern.findall(reference)
    if matches:
        return [{"id": m[0].upper(), "description": m[1].strip()} for m in matches]
    return []


async def _judge_via_openrouter(
    prompt: str,
    student_response: str,
    response_reference: str,
    judge_system_prompt: str,
    judge_prompt_template: Optional[str],
    model: str,
    standard_response: str,
    pass_threshold: float = 0.5,
) -> Dict[str, Any]:
    """Run independent judging via OpenRouter when model ID is OpenRouter-style (e.g. openai/gpt-5.2)."""
    from services.openrouter_client import get_openrouter_client
    criteria_list = _extract_criteria_list(response_reference)
    if not criteria_list:
        raise ValueError("CRITICAL: Could not extract criteria for judging. Reference must contain a valid JSON array or C1: ... format.")
    client = get_openrouter_client()
    standard_section = ""
    if standard_response and standard_response.strip():
        standard_section = f"""
Standard/Expected Answer (for reference context):
{standard_response}

Note: Use the standard answer as context to understand the expected format, but evaluate the student answer strictly against the criterion below."""
    results = []
    for criterion in criteria_list:
        c_id = criterion.get("id", "?")
        desc = criterion.get("description", "")
        eval_prompt = f"""
TASK: Evaluate if the Student Answer meets this SINGLE criterion.

IMPORTANT: You are evaluating ONLY this one criterion. Do NOT consider other criteria.

Criterion ({c_id}): {desc}

Original Question:
{prompt}

Student Answer:
{student_response}{standard_section}

Evaluate ONLY whether the Student Answer meets the specific requirement stated in Criterion ({c_id}) above.
Output valid JSON only:
{{"status": "PASS" or "FAIL", "reason": "Brief explanation focusing on this criterion"}}
"""
        # Pass messages as system + user (eval_prompt) for format stability; prompt="" so client does not append
        judge_system = judge_system_prompt or "You are a precise evaluator. Output only valid JSON."
        messages = [{"role": "system", "content": judge_system}, {"role": "user", "content": eval_prompt}]
        status = "MISSING"
        reason = "after retries"
        for attempt in range(3):
            try:
                response_text, _ = await client.call_model(
                    prompt="",
                    model=model,
                    max_tokens=2048,
                    stream=False,
                    messages=messages,
                    reasoning_budget_percent=0,
                    temperature=0,
                )
                data = {}
                if response_text:
                    text = response_text.strip()
                    import re as _re
                    fence_match = _re.search(r'```(?:json)?\s*(\{.*?\})\s*```', text, _re.DOTALL)
                    if fence_match:
                        text = fence_match.group(1)
                    try:
                        data = json.loads(text)
                    except json.JSONDecodeError:
                        brace = text.find("{")
                        if brace != -1:
                            depth = 0
                            for i in range(brace, len(text)):
                                if text[i] == "{": depth += 1
                                elif text[i] == "}": depth -= 1
                                if depth == 0:
                                    try:
                                        data = json.loads(text[brace : i + 1])
                                    except json.JSONDecodeError:
                                        pass
                                    break
                raw_status = (data.get("status") or data.get("result") or "").strip()
                if not raw_status:
                    logger.warning(
                        "Judge JSON missing status/result for criterion %s (attempt %s). Keys: %s",
                        c_id, attempt + 1, list(data.keys()) if data else "empty"
                    )
                    reason = "JSON missing 'status' or 'result'" + (f" (attempt {attempt + 1}/3)" if attempt < 2 else " after retries")
                    continue
                raw_status_upper = raw_status.upper()
                if raw_status_upper not in ("PASS", "FAIL"):
                    logger.warning(
                        "Judge status not PASS/FAIL for criterion %s: %r (attempt %s)",
                        c_id, raw_status, attempt + 1
                    )
                    reason = f"status value '{raw_status}' not in {{PASS, FAIL}}" + (f" (attempt {attempt + 1}/3)" if attempt < 2 else " after retries")
                    continue
                status = raw_status_upper
                reason = data.get("reason") or data.get("explanation") or data.get("message") or "No reason"
                break
            except Exception as e:
                logger.warning("Judge criterion %s attempt %s failed: %s", c_id, attempt + 1, e)
                reason = f"Eval error: {str(e)}" + (f" (attempt {attempt + 1}/3)" if attempt < 2 else " after retries")
        if status == "MISSING":
            reason = f"⚠️ {reason}"
        results.append({"id": c_id, "status": status, "reason": reason})
    final_criteria = {r["id"]: r["status"] for r in results}
    pass_count = sum(1 for r in results if r["status"] == "PASS")
    total = len(criteria_list) or 1
    pass_rate = pass_count / total
    # pass_threshold 0.5: >0.5 = pass (current). pass_threshold 1.0: >=1.0 = pass (all-or-nothing)
    score = 1 if (pass_rate >= 1.0) or (pass_threshold < 1.0 and pass_rate > pass_threshold) else 0
    sorted_results = sorted(results, key=lambda r: r["id"])
    def _status_icon(s):
        if s == "PASS": return "✅"
        if s == "MISSING": return "⚠️"
        return "❌"
    criteria_lines = [
        f"{_status_icon(r['status'])} {r['id']} ({r['status']}): {r['reason']}"
        for r in sorted_results
    ]
    explanation = (
        f"Independent Judging Results:\n"
        f"- Passing Criteria: {pass_count}/{len(criteria_list)}\n\n"
        + "\n".join(criteria_lines)
    )
    return {"score": score, "criteria": final_criteria, "explanation": explanation, "raw_output": "Generated via OpenRouter (independent criteria judging)"}


class OpenAIJudgeClient:
    """Client for OpenAI GPT-5 judge with structured output parsing.
    Supports OpenRouter models (e.g. openai/gpt-5.2) via OPENROUTER_API_KEY;
    direct OpenAI models require OPENAI_API_KEY."""
    
    DEFAULT_MODEL = "gpt-5"
    
    def __init__(self, api_key: Optional[str] = None):
        self.openai_key = api_key or self._resolve_openai_key()
        self.openrouter_key = self._resolve_openrouter_key()
        if not self.openai_key and not self.openrouter_key:
            raise ValueError(
                "No judge API key found. Set OPENAI_API_KEY (for direct OpenAI) or "
                "OPENROUTER_API_KEY (for OpenRouter models like openai/gpt-5.2) in .env"
            )
        # Only create OpenAI client when we have OpenAI key (for non-OpenRouter models)
        self.client = AsyncOpenAI(api_key=self.openai_key) if self.openai_key else None

    def _resolve_openai_key(self) -> Optional[str]:
        """Resolve OpenAI API key from config or env."""
        try:
            from agentic_reviewer.config_loader import get_config_value
            secrets = get_config_value("secrets") or {}
            val = secrets.get("openai_api_key")
            if val:
                return val
        except Exception:
            pass
        return os.getenv("OPENAI_API_KEY")

    def _resolve_openrouter_key(self) -> Optional[str]:
        """Resolve OpenRouter API key from config or env."""
        try:
            from agentic_reviewer.config_loader import get_config_value
            secrets = get_config_value("secrets") or {}
            val = secrets.get("openrouter_api_key")
            if val:
                return val
        except Exception:
            pass
        return os.getenv("OPENROUTER_API_KEY")
    
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
        standard_response: Optional[str] = None,  # Standard/expected response from [response] cell
        pass_threshold: float = 0.5,  # 0.5 = 50% rule, 1.0 = all criteria must pass
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
            logger.error(error_msg)
            raise ValueError(error_msg)
        
        try:
            # Try to extract JSON array between [ and ]
            array_match = re.search(r'\[.*?\]', response_reference, re.DOTALL)
            
            if array_match:
                json_array_str = array_match.group(0)
                
                # Try to parse as JSON to validate
                parsed = json.loads(json_array_str)
                
                # Must be a list/array
                if not isinstance(parsed, list):
                    raise ValueError(f"Reference JSON must be a JSON array (list), got {type(parsed).__name__}")
                
                if len(parsed) == 0:
                    raise ValueError("Reference JSON array cannot be empty")
                
            else:
                # No JSON array - try plain text format (C1: ..., C2: ...)
                plain_text_pattern = re.compile(r'^(C\d+)\s*[:：]\s*(.+)$', re.MULTILINE | re.IGNORECASE)
                matches = plain_text_pattern.findall(response_reference)
                
                if matches and len(matches) > 0:
                    pass
                else:
                    raise ValueError("Reference Answer must contain either a JSON array or plain text criteria (C1: description, C2: description, etc.)")
                
        except json.JSONDecodeError as e:
            # JSON parse error - check if there's plain text format as fallback
            plain_text_pattern = re.compile(r'^(C\d+)\s*[:：]\s*(.+)$', re.MULTILINE | re.IGNORECASE)
            matches = plain_text_pattern.findall(response_reference)
            
            if matches and len(matches) > 0:
                pass
            else:
                error_msg = f"CRITICAL: Reference Answer must be valid JSON or plain text format. Parse Error: {e}"
                logger.error(error_msg)
                raise ValueError(error_msg)
        except ValueError as e:
            # Re-raise ValueError as-is (it's already a CRITICAL message)
            if "CRITICAL" in str(e):
                raise
            # Otherwise, wrap it
            error_msg = f"CRITICAL: Failed to process Reference: {e}"
            logger.error(error_msg)
            raise ValueError(error_msg)
        except Exception as e:
            error_msg = f"CRITICAL: Failed to process Reference: {e}"
            logger.error(error_msg)
            raise ValueError(error_msg)
        
        # OpenRouter model IDs (e.g. openai/gpt-5.2, anthropic/claude-opus-4.6) must use OpenRouter API
        if "/" in (model or ""):
            if not self.openrouter_key:
                raise ValueError(
                    "OpenRouter model selected but OPENROUTER_API_KEY not set. "
                    "Add OPENROUTER_API_KEY to .env or use a direct OpenAI model with OPENAI_API_KEY."
                )
            return await _judge_via_openrouter(
                prompt=prompt,
                student_response=student_response,
                response_reference=response_reference,
                judge_system_prompt=judge_system_prompt,
                judge_prompt_template=judge_prompt_template,
                model=model,
                standard_response=standard_response or "",
                pass_threshold=pass_threshold,
            )
        
        # Direct OpenAI model — requires OpenAI client
        if not self.client:
            raise ValueError(
                "Direct OpenAI judge model selected but OPENAI_API_KEY not set. "
                "Add OPENAI_API_KEY to .env, or use an OpenRouter model (e.g. openai/gpt-5.2) with OPENROUTER_API_KEY."
            )
        
        # Build the judge prompt
        # Use standard_response if provided, otherwise empty string
        standard_resp = standard_response or ""
        
        if judge_prompt_template:
            # Support both old and new template placeholders
            user_prompt = judge_prompt_template.replace(
                "{prompt}", prompt
            ).replace(
                "{model_response}", student_response
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
        
        return await self._judge_independently(
            prompt, student_response, response_reference,
            judge_system_prompt, model, standard_response=standard_resp,
            pass_threshold=pass_threshold
        )
    

    async def test_connection(self) -> bool:
        """Test API connection."""
        try:
            response = await self.client.chat.completions.create(
                model="gpt-4o",
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
        standard_response: Optional[str] = None,
        pass_threshold: float = 0.5,
    ) -> Dict[str, Any]:
        """
        Judge response by splitting criteria into independent API calls.
        """
        # Telemetry: Start timing judge call
        _judge_start_time = time.time()
        # Step 1: Extract criteria
        criteria_list = await self._extract_criteria(reference, model)
        
        if not criteria_list:
            error_msg = "CRITICAL: Could not extract criteria for independent judging. Reference Answer must contain a valid JSON array of criteria."
            logger.error(error_msg)
            raise ValueError(error_msg)
            
        criteria_ids = [c.get('id') for c in criteria_list]

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
        for res in results:
            c_id = res['id']
            status = res['status']
            reason = res['reason']
            final_criteria[c_id] = status
            evaluated_ids.add(c_id)
            if status == 'PASS':
                pass_count += 1
                passed_criteria.append(f"{c_id}: {reason}")  # Store passing criteria with explanation
            else:
                failed_criteria.append(f"{c_id}: {reason}")
        
        # Check for missing criteria (expected but not evaluated)
        # This happens when a criterion was in the initial criteria but not in the current response_reference
        expected_ids = {c.get('id') for c in criteria_list}
        missing_ids = expected_ids - evaluated_ids
        if missing_ids:
            for c_id in missing_ids:
                missing_criteria.append(c_id)
                # Mark as missing (not a failure, but an error)
                final_criteria[c_id] = "MISSING"
        # Calculate scores
        # pass_threshold 0.5: >0.5 = pass (50% rule). pass_threshold 1.0: >=1.0 = pass (all-or-nothing)
        fail_count = len(failed_criteria)
        total_count = len(criteria_list) if criteria_list else 1
        fail_rate = fail_count / total_count
        pass_rate = 1 - fail_rate
        score = 1 if (pass_rate >= 1.0) or (pass_threshold < 1.0 and pass_rate > pass_threshold) else 0
        
        explanation = (
            f"Independent Judging Results:\n"
            f"- Passing Criteria: {pass_count}/{len(criteria_list)}\n"
        )
        if missing_criteria:
            explanation += f"\n⚠️ Missing Criteria (not evaluated): {', '.join(missing_criteria)}\n"
        # Build ordered per-criterion lines sorted by ID (preserve actual status: PASS, FAIL, MISSING)
        def _icon(s):
            if s == "PASS": return "✅"
            if s == "MISSING": return "⚠️"
            return "❌"
        all_criterion_items = [
            (c_id, "PASS", reason) for c_id, reason in
            [(item.split(": ", 1)[0], item.split(": ", 1)[1] if ": " in item else item) for item in passed_criteria]
        ] + [
            (c_id, final_criteria.get(c_id, "FAIL"), reason) for c_id, reason in
            [(item.split(": ", 1)[0], item.split(": ", 1)[1] if ": " in item else item) for item in failed_criteria]
        ]
        all_criterion_items.sort(key=lambda x: x[0])
        criteria_lines = [
            f"{_icon(status)} {c_id} ({status}): {reason}"
            for c_id, status, reason in all_criterion_items
        ]
        if criteria_lines:
            explanation += "\n" + "\n".join(criteria_lines)
        elif not missing_criteria:
            explanation += "\nAll criteria passed."
        
        # Telemetry: Log judge call completion
        if _telemetry_enabled:
            try:
                get_telemetry().log_judge_call(
                    model=model,
                    start_time=_judge_start_time,
                    score=score,
                    success=True
                )
            except Exception:
                pass
            
        return {
            "score": score,
            "criteria": final_criteria,
            "explanation": explanation,
            "raw_output": "Generated via Independent Criteria Judging"
        }

    async def _extract_criteria(self, reference: str, model: str) -> List[Dict[str, str]]:
        """
        Extract criteria list from reference text.
        Delegates to module-level _extract_criteria_list() and raises ValueError
        when no criteria can be parsed (strict mode for direct OpenAI judging).
        """
        result = _extract_criteria_list(reference)
        if not result:
            error_msg = (
                "CRITICAL: Reference Answer must contain either a JSON array "
                "between [ and ] brackets, or plain text criteria in format "
                "'C1: description'"
            )
            logger.error(error_msg)
            raise ValueError(error_msg)
        return result

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
                response = await self.client.chat.completions.create(
                    model=model,
                    messages=[{"role": "user", "content": eval_prompt}],
                    response_format={"type": "json_object"},
                    temperature=0,
                    timeout=120.0  # 2 minute timeout per criterion
                )
                content = response.choices[0].message.content
                data = json.loads(content)
                # Accept both "status"/"reason" and "result"/"explanation" (default judge system prompt)
                raw_status = (data.get("status") or data.get("result") or "").strip()
                if not raw_status:
                    logger.warning(
                        "Judge JSON missing status/result key for criterion %s. Expected {'status'|'result': 'PASS'|'FAIL'}. "
                        "Raw keys: %s", c_id, list(data.keys()) if data else "empty"
                    )
                    status = "MISSING"
                    raw_reason = (data.get("reason") or data.get("explanation") or data.get("message") or "").strip()
                    reason = f"⚠️ JSON structure missing: expected 'status' or 'result' key" + (f". Judge said: {raw_reason}" if raw_reason else "")
                else:
                    status = raw_status.upper()
                    reason = data.get("reason") or data.get("explanation") or data.get("message") or "No reason"
                return {"id": c_id, "status": status, "reason": reason}
            except (BrokenPipeError, ConnectionError, OSError, IOError) as e:
                if attempt < max_retries - 1:
                    wait_time = retry_delay * (2 ** attempt)  # Exponential backoff
                    logger.warning(f"Connection error evaluating criterion {c_id} (attempt {attempt + 1}/{max_retries}): {str(e)}")
                    logger.info(f"Retrying in {wait_time} seconds...")
                    await asyncio.sleep(wait_time)
                else:
                    # Last attempt failed
                    logger.error(f"Failed to evaluate criterion {c_id} after {max_retries} attempts: {e}")
                    return {"id": c_id, "status": "FAIL", "reason": f"Connection Error: {str(e)}"}
            except json.JSONDecodeError as e:
                logger.error(f"JSON decode error for criterion {c_id}: {e}")
                return {"id": c_id, "status": "FAIL", "reason": f"JSON Error: {str(e)}"}
            except Exception as e:
                # Check if it's a connection-related error by error message
                error_str = str(e).lower()
                if any(keyword in error_str for keyword in ['broken pipe', 'connection', 'timeout', 'network', 'reset', 'errno 32']):
                    if attempt < max_retries - 1:
                        wait_time = retry_delay * (2 ** attempt)
                        logger.warning(f"Connection-related error detected for criterion {c_id} (attempt {attempt + 1}/{max_retries}): {str(e)}")
                        logger.info(f"Retrying in {wait_time} seconds...")
                        await asyncio.sleep(wait_time)
                    else:
                        logger.error(f"Failed to evaluate criterion {c_id} after {max_retries} attempts: {e}")
                        return {"id": c_id, "status": "FAIL", "reason": f"Connection Error: {str(e)}"}
                else:
                    logger.error(f"ERROR evaluating criterion {c_id}: {e}")
                    return {"id": c_id, "status": "FAIL", "reason": f"Eval Error: {str(e)}"}


# Singleton instance
openai_judge_client = None

def get_openai_judge_client(api_key: Optional[str] = None) -> OpenAIJudgeClient:
    """Get or create OpenAI judge client instance."""
    global openai_judge_client
    if openai_judge_client is None or api_key:
        openai_judge_client = OpenAIJudgeClient(api_key)
    return openai_judge_client
