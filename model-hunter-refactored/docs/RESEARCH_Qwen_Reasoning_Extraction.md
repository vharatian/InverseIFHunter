# Research Document: Qwen Model Reasoning Extraction
## OpenRouter vs Fireworks AI

**Date:** January 22, 2026  
**Author:** Engineering Team  
**Status:** Investigation in Progress

---

## Executive Summary

When using the Qwen3-235B-A22B-Thinking model through different API providers, the reasoning trace (chain-of-thought) is returned in **different formats**:

| Provider | Reasoning Delivery | Extraction Method |
|----------|-------------------|-------------------|
| **OpenRouter** | Separate `reasoning_details` field | Direct field access ✅ |
| **Fireworks AI** | Embedded in `content` with `</think>` tag | String parsing required ⚠️ |

**Current Issue:** The Fireworks extraction works in isolated tests but fails in the full application flow.

---

## 1. OpenRouter Implementation

### 1.1 API Request Format

```python
# File: services/openrouter_client.py (lines 97-115)

payload = {
    "model": "qwen/qwen3-235b-a22b-thinking-2507",
    "messages": [{"role": "user", "content": prompt}],
    "max_tokens": 131072,  # 128k for Qwen
    "stream": True,        # Streaming enabled
    "temperature": 0.8,
    "reasoning": {         # ⬅️ KEY DIFFERENCE: Explicit reasoning parameter
        "exclude": False,  # Include reasoning traces
        "effort": "high"   # Use high effort for reasoning
    }
}
```

### 1.2 API Response Format (Streaming)

OpenRouter returns reasoning in a **separate field** during streaming:

```json
// SSE chunk example
{
  "choices": [{
    "delta": {
      "content": "The answer is...",
      "reasoning_details": [
        {
          "id": "reasoning_0",
          "text": "Let me think about this step by step..."
        }
      ]
    }
  }]
}
```

### 1.3 Extraction Code

```python
# File: services/openrouter_client.py (lines 177-229)

# During streaming, collect reasoning from delta
if "reasoning_details" in delta and delta["reasoning_details"]:
    for detail in delta["reasoning_details"]:
        if isinstance(detail, dict):
            detail_id = detail.get("id", None)
            detail_text = detail.get("text", "")
            
            if detail_id and detail_text:
                # Track by ID to avoid duplicates
                reasoning_by_id[detail_id] = detail_text

# Build final reasoning trace
if final_message_reasoning:
    reasoning_parts = []
    for detail in final_message_reasoning:
        if isinstance(detail, dict) and "text" in detail:
            reasoning_parts.append(detail["text"])
    reasoning_trace = "".join(reasoning_parts)
```

### 1.4 Why OpenRouter Works

1. **Explicit reasoning request** via `reasoning.exclude: false` parameter
2. **Structured response** with `reasoning_details` array
3. **No string parsing needed** - just iterate over the array

---

## 2. Fireworks AI Implementation

### 2.1 API Request Format

```python
# File: services/fireworks_client.py (lines 157-163)

payload = {
    "model": "accounts/fireworks/models/qwen3-235b-a22b-thinking-2507",
    "messages": [{"role": "user", "content": prompt}],
    "max_tokens": 4096,
    "temperature": 0.7,
    "stream": False  # Non-streaming
    # ⚠️ NO reasoning parameter - Fireworks doesn't support it
}
```

### 2.2 API Response Format

Fireworks returns reasoning **embedded in the content** with a `</think>` tag:

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "Let me think about this step by step. First, I need to consider...\n\n</think>\n\nThe answer is 42."
    }
  }]
}
```

**Important observations:**
- There is NO opening `<think>` tag
- Only a closing `</think>` tag separates reasoning from answer
- Everything BEFORE `</think>` is reasoning
- Everything AFTER `</think>` is the final answer

### 2.3 Extraction Code

```python
# File: services/fireworks_client.py (lines 213-227)

# Priority 4: Check if content contains </think> tag
print(f"DEBUG Fireworks: Checking for </think> tag in response...")
print(f"DEBUG Fireworks: '</think>' in response_text: {'</think>' in response_text}")

if not reasoning_trace and '</think>' in response_text:
    parts = response_text.split('</think>', 1)
    extracted_reasoning = parts[0].strip()
    extracted_answer = parts[1].strip() if len(parts) > 1 else ""
    
    if extracted_reasoning:
        reasoning_trace = extracted_reasoning
        response_text = extracted_answer
        print(f"DEBUG Fireworks: Extracted reasoning by splitting on </think>")
        print(f"DEBUG Fireworks: Reasoning: {len(reasoning_trace)} chars, Answer: {len(response_text)} chars")
```

---

## 3. Test Results

### 3.1 Isolated Test (test_fireworks_fix.py) - ✅ PASSES

```
================================================================================
📝 TEST: Math
   Prompt: What is 15 * 23?
================================================================================
DEBUG Fireworks: Checking for </think> tag in response...
DEBUG Fireworks: '</think>' in response_text: True
DEBUG Fireworks: Extracted reasoning by splitting on </think>
DEBUG Fireworks: Reasoning: 928 chars, Answer: 740 chars

✅ SUCCESS!

🧠 REASONING (928 chars):
Okay, let's see. I need to calculate 15 multiplied by 23...

💬 ANSWER (740 chars):
To calculate $ 15 \times 23 $, we can break it down...
$$\boxed{345}$$

📊 VERIFICATION:
   ✅ Clean separation - reasoning is thinking, answer is formatted
```

### 3.2 Full Application Flow - ❌ FAILS

When using Fireworks through the UI:
- **Model Response section:** Contains full text including reasoning
- **Reasoning Trace section:** Shows "No reasoning trace available"

---

## 4. Key Differences Summary

| Aspect | OpenRouter | Fireworks AI |
|--------|------------|--------------|
| **API Endpoint** | `openrouter.ai/api/v1/chat/completions` | `api.fireworks.ai/inference/v1/chat/completions` |
| **Reasoning Parameter** | `reasoning: {exclude: false, effort: "high"}` | Not supported |
| **Streaming** | Yes (default) | No |
| **Response Format** | Structured `reasoning_details` array | Embedded in `content` with `</think>` tag |
| **Extraction Method** | Iterate array | Parse string |
| **Message Keys** | `role`, `content`, `reasoning_details` | `role`, `content` only |

---

## 5. API Documentation References

### 5.1 OpenRouter

From OpenRouter docs (https://openrouter.ai/docs/requests):

> For thinking models, you can control reasoning output with the `reasoning` parameter:
> - `exclude: false` - Include reasoning in response
> - `effort: "high"` - Use maximum reasoning effort

### 5.2 Fireworks AI

From Fireworks AI docs (https://docs.fireworks.ai/):

> Thinking models like Qwen include chain-of-thought reasoning in the response content.
> The reasoning is terminated with a `</think>` tag, followed by the final answer.

**Note:** Fireworks does NOT provide a separate field for reasoning - it must be parsed from content.

---

## 6. Root Cause Analysis

### Hypothesis 1: Code Path Difference

The test script calls `fireworks_client.call_with_retry()` directly:
```python
response, reasoning, error = await client.call_with_retry(prompt, model)
```

The full app goes through `hunt_engine.py`:
```python
# hunt_engine.py line 236-240
fireworks = get_fireworks_client()
response, reasoning, error = await fireworks.call_with_retry(
    prompt=enhanced_prompt,
    model=result.model,
    max_retries=session.config.max_retries
)
```

**Need to verify:** Are the same parameters being passed? Is the model ID correct?

### Hypothesis 2: Caching Issue

Python's `.pyc` bytecode caching might be serving old code.

**Action:** Delete `__pycache__` directories and restart.

### Hypothesis 3: Different Model ID

Test uses: `accounts/fireworks/models/qwen3-235b-a22b-thinking-2507`
UI might use: Different ID?

**Action:** Add logging to verify exact model ID being used.

---

## 7. Recommended Investigation Steps

1. **Add logging to hunt_engine.py** to verify:
   - Provider being used (`fireworks` vs `openrouter`)
   - Model ID being passed
   - Response and reasoning lengths after Fireworks call

2. **Check server logs** when running a Fireworks hunt:
   ```
   DEBUG Fireworks: Checking for </think> tag in response...
   DEBUG Fireworks: '</think>' in response_text: True/False
   ```

3. **Verify no caching issues:**
   ```bash
   find . -name "__pycache__" -type d -exec rm -rf {} +
   ```

4. **Compare exact API calls** between test and full app

---

## 8. Code Locations

| Component | File | Key Lines |
|-----------|------|-----------|
| OpenRouter Client | `services/openrouter_client.py` | 97-245 |
| Fireworks Client | `services/fireworks_client.py` | 143-264 |
| Hunt Engine | `services/hunt_engine.py` | 227-272 |
| Frontend Config | `static/app.js` | 1230-1247 |
| Provider Models | `static/app.js` | 13-22 |

---

## 9. Appendix: Raw API Response Samples

### A. OpenRouter Qwen Response (Streaming Final Chunk)

```json
{
  "id": "gen-xxx",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "The answer is 345.",
      "reasoning_details": [
        {"id": "r0", "text": "Let me calculate 15 × 23..."},
        {"id": "r1", "text": "Breaking it down: 15 × 20 = 300, 15 × 3 = 45..."},
        {"id": "r2", "text": "Adding: 300 + 45 = 345"}
      ]
    },
    "finish_reason": "stop"
  }],
  "model": "qwen/qwen3-235b-a22b-thinking-2507"
}
```

### B. Fireworks Qwen Response

```json
{
  "id": "xxx",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Let me calculate 15 × 23. Breaking it down: 15 × 20 = 300, 15 × 3 = 45. Adding: 300 + 45 = 345.</think>\n\nThe answer is **345**."
    },
    "finish_reason": "stop"
  }],
  "model": "accounts/fireworks/models/qwen3-235b-a22b-thinking-2507"
}
```

---

## 10. Next Steps

1. [ ] Add detailed logging to hunt_engine.py for Fireworks path
2. [ ] Capture actual API response in production flow
3. [ ] Compare with test script's API response
4. [ ] Identify where the extraction fails
5. [ ] Apply fix and verify

---

*Document will be updated as investigation progresses.*
