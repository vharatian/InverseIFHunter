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
from typing import Dict, Any, Optional, List, AsyncGenerator
from openai import AsyncOpenAI
import time

logger = logging.getLogger(__name__)

# Telemetry import - wrapped to never fail
try:
    from services.telemetry_logger import get_telemetry
    _telemetry_enabled = True
except ImportError:
    _telemetry_enabled = False


JUDGE_PROMPT_TEMPLATE = """## Question
{prompt}

---
## Student Response
{student_response}

---
## Standard Responses
{standard_response}

---
## Evaluation Criteria
{response_reference}

---"""


def _build_criterion_prompt(
    prompt: str,
    student_response: str,
    standard_response: str,
    criterion_id: str,
    criterion_description: str,
) -> str:
    """Build the user message for a single criterion using the standard template."""
    return JUDGE_PROMPT_TEMPLATE.format(
        prompt=prompt,
        student_response=student_response,
        standard_response=standard_response,
        response_reference=f"{criterion_id}: {criterion_description}",
    )


def _find_json_array(text: str) -> Optional[str]:
    """Find the outermost JSON array in text using balanced bracket matching."""
    start = text.find('[')
    if start == -1:
        return None
    depth = 0
    in_string = False
    escape_next = False
    for i in range(start, len(text)):
        ch = text[i]
        if escape_next:
            escape_next = False
            continue
        if ch == '\\' and in_string:
            escape_next = True
            continue
        if ch == '"' and not escape_next:
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == '[':
            depth += 1
        elif ch == ']':
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def _extract_criteria_list(reference: str) -> List[Dict[str, str]]:
    """Extract criteria list from reference (JSON array or plain C1: ... format). Used by OpenRouter judge."""
    array_str = _find_json_array(reference)
    if array_str:
        try:
            parsed = json.loads(array_str)
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


def _parse_judge_json(text: str) -> dict:
    """Parse judge response text into a dict.

    Handles markdown fences and multiple JSON objects.  When a model
    "reconsiders" mid-response it may emit a first-draft JSON followed by
    a corrected one.  We return the **last** valid JSON object so the
    model's final answer wins.
    """
    if not text:
        return {}
    text = text.strip()

    # Strip markdown code fences (keep all inner content — there may be
    # multiple fenced blocks).
    stripped = re.sub(r'```(?:json)?\s*', '', text)
    stripped = re.sub(r'```', '', stripped)

    # Collect every top-level { … } via balanced-brace scan.
    candidates = []
    i = 0
    while i < len(stripped):
        if stripped[i] == '{':
            depth = 0
            in_string = False
            escape_next = False
            for j in range(i, len(stripped)):
                ch = stripped[j]
                if escape_next:
                    escape_next = False
                    continue
                if ch == '\\' and in_string:
                    escape_next = True
                    continue
                if ch == '"' and not escape_next:
                    in_string = not in_string
                    continue
                if in_string:
                    continue
                if ch == '{':
                    depth += 1
                elif ch == '}':
                    depth -= 1
                    if depth == 0:
                        try:
                            candidates.append(json.loads(stripped[i:j + 1]))
                        except json.JSONDecodeError:
                            pass
                        i = j + 1
                        break
            else:
                break
        else:
            i += 1

    if candidates:
        return candidates[-1]
    return {}


def _compute_judge_score(results: List[Dict], total: int, pass_threshold: float) -> Dict[str, Any]:
    """Compute final score and explanation from a list of criterion results.

    MISSING criteria are counted separately — they are NOT lumped into fail_count.
    pass_rate is still computed against the full total (conservative: unevaluated
    criteria don't automatically pass).
    """
    pass_count = sum(1 for r in results if r["status"] == "PASS")
    fail_count = sum(1 for r in results if r["status"] == "FAIL")
    missing_count = sum(1 for r in results if r["status"] not in ("PASS", "FAIL"))
    pass_rate = pass_count / (total or 1)
    # Use >= for non-zero thresholds (boundary fix: exactly at threshold = PASS, not BREAK).
    # All Breaking (pass_threshold=0): any passing = score 1, so keep strict >.
    if pass_threshold > 0:
        score = 1 if pass_rate >= pass_threshold else 0
    else:
        score = 1 if pass_rate > 0 else 0
    sorted_results = sorted(results, key=lambda r: r["id"])
    def _icon(s):
        if s == "PASS": return "[PASS]"
        if s == "MISSING": return "[MISSING]"
        return "[FAIL]"
    criteria_lines = [
        f"{_icon(r['status'])} {r['id']} ({r['status']}): {r['reason']}"
        for r in sorted_results
    ]
    explanation = (
        f"Independent Judging Results:\n"
        f"- Passing Criteria: {pass_count}/{total}\n\n"
        + "\n".join(criteria_lines)
    )
    final_criteria = {r["id"]: r["status"] for r in results}
    return {"score": score, "pass_count": pass_count, "fail_count": fail_count,
            "missing_count": missing_count, "criteria": final_criteria,
            "explanation": explanation}


async def _eval_criterion_via_openrouter(client, prompt, student_response, standard_response,
                                          judge_system_prompt, model, criterion) -> Dict[str, str]:
    """Evaluate a single criterion via OpenRouter with retries."""
    c_id = criterion.get("id", "?")
    desc = criterion.get("description", "")
    user_prompt = _build_criterion_prompt(
        prompt=prompt, student_response=student_response,
        standard_response=standard_response, criterion_id=c_id, criterion_description=desc,
    )
    messages = [{"role": "system", "content": judge_system_prompt}, {"role": "user", "content": user_prompt}]
    status = "MISSING"
    reason = "after retries"
    for attempt in range(3):
        try:
            response_text, _ = await client.call_model(
                prompt="", model=model, max_tokens=2048, stream=False,
                messages=messages, reasoning_budget_percent=0, temperature=0,
            )
            data = _parse_judge_json(response_text)
            raw_status = (data.get("status") or data.get("result") or "").strip()
            if not raw_status:
                logger.warning("Judge JSON missing status/result for criterion %s (attempt %s). Keys: %s",
                               c_id, attempt + 1, list(data.keys()) if data else "empty")
                reason = "JSON missing 'status' or 'result'" + (f" (attempt {attempt + 1}/3)" if attempt < 2 else " after retries")
                continue
            raw_status_upper = raw_status.upper()
            if raw_status_upper not in ("PASS", "FAIL"):
                logger.warning("Judge status not PASS/FAIL for criterion %s: %r (attempt %s)", c_id, raw_status, attempt + 1)
                reason = f"status value '{raw_status}' not in {{PASS, FAIL}}" + (f" (attempt {attempt + 1}/3)" if attempt < 2 else " after retries")
                continue
            status = raw_status_upper
            reason = data.get("reason") or data.get("explanation") or data.get("message") or "No reason"
            break
        except Exception as e:
            logger.warning("Judge criterion %s attempt %s failed: %s", c_id, attempt + 1, e)
            reason = f"Eval error: {str(e)}" + (f" (attempt {attempt + 1}/3)" if attempt < 2 else " after retries")
    if status == "MISSING":
        reason = f"[MISSING] {reason}"
    return {"id": c_id, "status": status, "reason": reason}


async def _judge_via_openrouter(
    prompt: str, student_response: str, response_reference: str,
    judge_system_prompt: str, judge_prompt_template: Optional[str],
    model: str, standard_response: str, pass_threshold: float = 0.5,
) -> Dict[str, Any]:
    """Run independent judging via OpenRouter (parallel, all criteria at once)."""
    from providers.openrouter import get_openrouter_client
    criteria_list = _extract_criteria_list(response_reference)
    if not criteria_list:
        raise ValueError("CRITICAL: Could not extract criteria for judging. Reference must contain a valid JSON array or C1: ... format.")
    if not judge_system_prompt or not judge_system_prompt.strip():
        raise ValueError("Judge system prompt is empty. Please provide a judge system prompt before running the hunt.")
    client = get_openrouter_client()
    tasks = [
        _eval_criterion_via_openrouter(client, prompt, student_response, standard_response,
                                        judge_system_prompt, model, c)
        for c in criteria_list
    ]
    results = await asyncio.gather(*tasks)
    agg = _compute_judge_score(list(results), len(criteria_list), pass_threshold)
    return {"score": agg["score"], "criteria": agg["criteria"], "explanation": agg["explanation"],
            "raw_output": "Generated via OpenRouter (independent criteria judging)"}


async def _judge_via_openrouter_streaming(
    prompt: str, student_response: str, response_reference: str,
    judge_system_prompt: str, judge_prompt_template: Optional[str],
    model: str, standard_response: str, pass_threshold: float = 0.5,
) -> AsyncGenerator[Dict[str, Any], None]:
    """Streaming variant: yields per-criterion results as they complete (parallel)."""
    from providers.openrouter import get_openrouter_client
    criteria_list = _extract_criteria_list(response_reference)
    if not criteria_list:
        raise ValueError("CRITICAL: Could not extract criteria for judging. Reference must contain a valid JSON array or C1: ... format.")
    if not judge_system_prompt or not judge_system_prompt.strip():
        raise ValueError("Judge system prompt is empty.")

    total = len(criteria_list)
    yield {"type": "start", "total": total, "criteria_ids": [c.get("id", f"C{i+1}") for i, c in enumerate(criteria_list)]}

    client = get_openrouter_client()
    results = []
    pass_count = 0

    tasks = {
        asyncio.ensure_future(
            _eval_criterion_via_openrouter(client, prompt, student_response, standard_response,
                                            judge_system_prompt, model, c)
        ): c for c in criteria_list
    }
    for future in asyncio.as_completed(tasks.keys()):
        result = await future
        results.append(result)
        if result["status"] == "PASS":
            pass_count += 1
        yield {"type": "criterion", "id": result["id"], "status": result["status"], "reason": result["reason"],
               "passing": pass_count, "evaluated": len(results), "total": total}

    agg = _compute_judge_score(results, total, pass_threshold)
    yield {"type": "done", "score": agg["score"], "passing": agg["pass_count"], "total": total,
           "criteria": agg["criteria"], "explanation": agg["explanation"]}


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
        if not judge_system_prompt or not judge_system_prompt.strip():
            error_msg = "CRITICAL: Judge system prompt is empty. Please provide a judge system prompt before running the hunt."
            logger.error(error_msg)
            raise ValueError(error_msg)
        
        if not response_reference or not response_reference.strip():
            error_msg = "CRITICAL: Reference Answer must be VALID JSON. Error: response_reference is empty or missing"
            logger.error(error_msg)
            raise ValueError(error_msg)

        if not standard_response or not standard_response.strip():
            error_msg = "CRITICAL: No ideal/standard response provided. Please write an ideal response before judging."
            logger.warning(error_msg)
            raise ValueError(error_msg)
        
        try:
            json_array_str = _find_json_array(response_reference)
            
            if json_array_str:
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
                standard_response=standard_response,
                pass_threshold=pass_threshold,
            )
        
        # Direct OpenAI model — requires OpenAI client
        if not self.client:
            raise ValueError(
                "Direct OpenAI judge model selected but OPENAI_API_KEY not set. "
                "Add OPENAI_API_KEY to .env, or use an OpenRouter model (e.g. openai/gpt-5.2) with OPENROUTER_API_KEY."
            )
        
        return await self._judge_independently(
            prompt, student_response, response_reference,
            judge_system_prompt, model, standard_response=standard_response,
            pass_threshold=pass_threshold
        )
    

    async def test_connection(self) -> bool:
        """Test API connection. Tries OpenAI direct if available, otherwise OpenRouter."""
        if self.client:
            try:
                await self.client.chat.completions.create(
                    model="gpt-4o",
                    messages=[{"role": "user", "content": "test"}],
                    max_completion_tokens=5
                )
                return True
            except Exception:
                return False
        if self.openrouter_key:
            try:
                from providers.openrouter import get_openrouter_client
                client = get_openrouter_client()
                response_text, _ = await client.call_model(
                    prompt="test", model="openai/gpt-4o", max_tokens=5,
                    stream=False, reasoning_budget_percent=0,
                )
                return bool(response_text)
            except Exception:
                return False
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
            
        tasks = [
            self._evaluate_single_criterion(
                prompt, student_response, criterion, model,
                standard_response=standard_response, judge_system_prompt=system_prompt
            )
            for criterion in criteria_list
        ]
        results = await asyncio.gather(*tasks)
        agg = _compute_judge_score(list(results), len(criteria_list), pass_threshold)

        if _telemetry_enabled:
            try:
                get_telemetry().log_judge_call(
                    model=model, start_time=_judge_start_time,
                    score=agg["score"], success=True
                )
            except Exception:
                pass

        return {
            "score": agg["score"],
            "criteria": agg["criteria"],
            "explanation": agg["explanation"],
            "raw_output": "Generated via Independent Criteria Judging"
        }

    async def judge_response_streaming(
        self,
        prompt: str,
        student_response: str,
        response_reference: str,
        judge_system_prompt: str,
        judge_prompt_template: Optional[str] = None,
        model: str = "gpt-5",
        standard_response: Optional[str] = None,
        pass_threshold: float = 0.5,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Streaming variant of judge_response — yields per-criterion results via SSE."""
        if not judge_system_prompt or not judge_system_prompt.strip():
            raise ValueError("CRITICAL: Judge system prompt is empty.")
        if not response_reference or not response_reference.strip():
            raise ValueError("CRITICAL: response_reference is empty or missing")
        if not standard_response or not standard_response.strip():
            raise ValueError("CRITICAL: No ideal/standard response provided. Please write an ideal response before judging.")

        if "/" in (model or ""):
            if not self.openrouter_key:
                raise ValueError("OpenRouter model selected but OPENROUTER_API_KEY not set.")
            async for event in _judge_via_openrouter_streaming(
                prompt=prompt, student_response=student_response,
                response_reference=response_reference, judge_system_prompt=judge_system_prompt,
                judge_prompt_template=judge_prompt_template, model=model,
                standard_response=standard_response, pass_threshold=pass_threshold,
            ):
                yield event
            return

        if not self.client:
            raise ValueError("Direct OpenAI judge model selected but OPENAI_API_KEY not set.")

        async for event in self._judge_independently_streaming(
            prompt, student_response, response_reference,
            judge_system_prompt, model, standard_response=standard_response,
            pass_threshold=pass_threshold,
        ):
            yield event

    async def _judge_independently_streaming(
        self,
        prompt: str,
        student_response: str,
        reference: str,
        system_prompt: str,
        model: str,
        standard_response: Optional[str] = None,
        pass_threshold: float = 0.5,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Streaming variant: yields per-criterion results as tasks complete."""
        criteria_list = await self._extract_criteria(reference, model)
        if not criteria_list:
            raise ValueError("CRITICAL: Could not extract criteria for independent judging.")

        total = len(criteria_list)
        yield {"type": "start", "total": total,
               "criteria_ids": [c.get("id", f"C{i+1}") for i, c in enumerate(criteria_list)]}

        tasks = {
            asyncio.ensure_future(
                self._evaluate_single_criterion(
                    prompt, student_response, criterion, model,
                    standard_response=standard_response, judge_system_prompt=system_prompt
                )
            ): criterion
            for criterion in criteria_list
        }

        results = []
        pass_count = 0
        for future in asyncio.as_completed(tasks.keys()):
            result = await future
            results.append(result)
            if result["status"] == "PASS":
                pass_count += 1
            yield {"type": "criterion", "id": result["id"], "status": result["status"],
                   "reason": result["reason"], "passing": pass_count,
                   "evaluated": len(results), "total": total}

        agg = _compute_judge_score(results, total, pass_threshold)
        yield {"type": "done", "score": agg["score"], "passing": agg["pass_count"], "total": total,
               "criteria": agg["criteria"], "explanation": agg["explanation"]}

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
        standard_response: Optional[str] = None,
        judge_system_prompt: Optional[str] = None
    ) -> Dict[str, str]:
        """Evaluate a single criterion."""
        c_id = criterion.get('id', 'Unknown')
        desc = criterion.get('description', '')
        user_prompt = _build_criterion_prompt(
            prompt=prompt,
            student_response=student_response,
            standard_response=standard_response,
            criterion_id=c_id,
            criterion_description=desc,
        )
        
        max_retries = 3
        retry_delay = 1
        
        for attempt in range(max_retries):
            try:
                messages = []
                if judge_system_prompt and judge_system_prompt.strip():
                    messages.append({"role": "system", "content": judge_system_prompt})
                messages.append({"role": "user", "content": user_prompt})
                response = await self.client.chat.completions.create(
                    model=model,
                    messages=messages,
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
                    reason = f"[MISSING] JSON structure missing: expected 'status' or 'result' key" + (f". Judge said: {raw_reason}" if raw_reason else "")
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
                if attempt < max_retries - 1:
                    logger.warning(f"JSON decode error for criterion {c_id} (attempt {attempt + 1}/{max_retries}): {e}")
                    await asyncio.sleep(retry_delay * (2 ** attempt))
                else:
                    logger.error(f"JSON decode error for criterion {c_id} after {max_retries} attempts: {e}")
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
