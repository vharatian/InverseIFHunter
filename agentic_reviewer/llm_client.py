"""
Minimal OpenRouter client for Agentic Reviewer council.

Standalone — no imports from model-hunter. Uses OPENROUTER_API_KEY from env.
"""
import os
import re
import logging
from pathlib import Path
from typing import Optional, Tuple

try:
    from dotenv import load_dotenv
    _agentic_root = Path(__file__).resolve().parent.parent
    load_dotenv(_agentic_root / ".env")
    load_dotenv(_agentic_root / "app" / "model-hunter-refactored" / ".env")
except Exception:
    pass

import httpx

logger = logging.getLogger(__name__)

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


def _get_api_key() -> str:
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
    api_key = _get_api_key()
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

    api_key = _get_api_key()
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
    full_text = []
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
                            full_text.append(content)
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

    # 0. Last line only (strongest signal — many models put verdict there)
    lines = [ln.strip() for ln in t.splitlines() if ln.strip()]
    if lines:
        last_line = lines[-1]
        last_clean = re.sub(r"[^\w\s]", " ", last_line)
        last_words = set(re.findall(r"\b[A-Z]+\b", last_clean))
        if "PASS" in last_words and "FAIL" not in last_words:
            return True
        if "FAIL" in last_words and "PASS" not in last_words:
            return False

    # 1. Check last 3 lines (models often put verdict there)
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

    # 2. Full-text explicit PASS/FAIL (no conflicting word)
    if re.search(r"\bPASS\b", t) and not re.search(r"\bFAIL\b", t):
        return True
    if re.search(r"\bFAIL\b", t) and not re.search(r"\bPASS\b", t):
        return False
    if re.search(r"\bYES\b", t) and not re.search(r"\bNO\b", t):
        return True
    if re.search(r"\bNO\b", t) and not re.search(r"\bYES\b", t):
        return False

    # 3. Verdict-style patterns (e.g. "Verdict: pass", "Conclusion: FAIL", "My answer: PASS")
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

    # 4. "I conclude PASS" / "Therefore FAIL" / "Thus: PASS"
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

    # 5. First/last significant word
    words = re.findall(r"\b[A-Z0-9]+\b", t)
    if words:
        first, last = words[0], words[-1]
        if first in ("PASS", "YES", "TRUE", "1") or last in ("PASS", "YES", "TRUE", "1"):
            return True
        if first in ("FAIL", "NO", "FALSE", "0") or last in ("FAIL", "NO", "FALSE", "0"):
            return False

    return None
