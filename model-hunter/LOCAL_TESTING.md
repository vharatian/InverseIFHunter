# Local Testing Guide

## Quick Start

### 1. Install Dependencies

```bash
cd model-hunter
pip install -r requirements.txt
```

### 2. Set Up Environment Variables

Create a `.env` file in the `model-hunter` directory (or ensure your existing `.env` has the required keys):

```bash
# Required for judge functionality
OPENAI_API_KEY=your-openai-api-key-here

# Optional (for Google Drive notebook fetching)
GOOGLE_SERVICE_ACCOUNT_JSON_PATH=/path/to/service-account.json
```

### 3. Run the Application

**Option A: Direct Python execution (with auto-reload)**
```bash
cd model-hunter
python main.py
```

**Option B: Using uvicorn directly**
```bash
cd model-hunter
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

The application will start on: **http://localhost:8000**

### 4. Test the Judge Prompt Changes

1. **Open the web interface**: Navigate to `http://localhost:8000` in your browser

2. **Upload a notebook** with:
   - `[prompt]` cell
   - `[response]` cell (standard answer)
   - `[response_reference]` cell (evaluation criteria)
   - Optional: `[judge_prompt_template]` cell (if you want to test custom template)

3. **Test the judge functionality**:
   - Click "Judge Only" button to test the judge prompt
   - Or start a hunt to see the judge in action

4. **Verify the prompt format**:
   - Check the browser's Network tab (F12 → Network)
   - Look for API calls to `/api/judge-reference/...`
   - Or add debug logging (see below)

### 5. Debug the Judge Prompt

To see the exact prompt being sent, you can add temporary debug logging:

**In `services/openai_client.py` around line 147**, you'll see the prompt is built. The code already has some debug prints, but you can add:

```python
print(f"DEBUG: Final judge prompt:\n{user_prompt}")
```

Then check your terminal/console output when you trigger a judge call.

### 6. Test Without Frontend (API Only)

You can also test directly via API:

```bash
# Test judge endpoint (replace SESSION_ID with actual session ID)
curl -X POST http://localhost:8000/api/judge-reference/YOUR_SESSION_ID
```

## Verifying Your Changes

### What to Check:

1. ✅ **Default template format**: When no custom template is provided, the prompt should have:
   - `## Question` section
   - `---` separator (three dashes)
   - `## Student Response` section
   - `---` separator
   - `## Standard Responses` section (with content from `[response]` cell)
   - `---` separator
   - `## Evaluation Criteria` section
   - `---` separator

2. ✅ **Standard response is included**: The `## Standard Responses` section should contain the content from the notebook's `[response]` cell, not be empty.

3. ✅ **Custom templates work**: If you provide a `[judge_prompt_template]` in your notebook, it should still work with all placeholders:
   - `{prompt}`
   - `{model_response}` or `{model_resposne}` (typo variant)
   - `{standard_response}`
   - `{criteria}` or `{response_reference}`

## Troubleshooting

### Issue: "OpenAI API key not found"
- Make sure your `.env` file exists in the `model-hunter` directory
- Ensure `OPENAI_API_KEY=your-key` is set in the `.env` file
- Restart the server after adding/changing `.env`

### Issue: Port 8000 already in use
- Change the port in `main.py` (line 724) or use:
  ```bash
  uvicorn main:app --host 0.0.0.0 --port 8001 --reload
  ```

### Issue: Changes not reflecting
- Make sure you saved the file
- If using `--reload`, the server should auto-reload
- Try restarting the server manually

### Issue: Can't see judge prompt in logs
- Add explicit debug print: `print(f"DEBUG JUDGE PROMPT:\n{user_prompt}")` in `openai_client.py` after line 147
- Check terminal/console where you ran `python main.py` or `uvicorn`

## Quick Test Script

Create a test file `test_judge_prompt.py`:

```python
import asyncio
from services.openai_client import OpenAIJudgeClient

async def test():
    client = OpenAIJudgeClient()
    
    # Test with default template
    result = await client.judge_response(
        prompt="What is 2+2?",
        student_response="4",
        response_reference='[{"id": "C1", "description": "Answer must be 4"}]',
        judge_system_prompt="You are a judge.",
        standard_response="4"
    )
    
    print("Judge result:", result)

if __name__ == "__main__":
    asyncio.run(test())
```

Run it:
```bash
cd model-hunter
python test_judge_prompt.py
```

This will show you the exact prompt format being used (check debug output).
