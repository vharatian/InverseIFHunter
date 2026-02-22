"""
Model Hunter — Pre-Deployment Test Dashboard Server

A standalone FastAPI app (port 8001) that:
- Discovers all pytest tests grouped by category
- Runs tests via subprocess with JSON reporting
- Streams results in real-time via SSE (including raw output)
- Provides clickable test detail with file/line/docstring
- AI-assisted test creation via GPT
- Stores run history for trend analysis

Usage:
    python test_dashboard_server.py
    # Open http://localhost:8001
"""
import ast
import asyncio
import json
import os
import re
import signal
import subprocess
import sys
import textwrap
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

load_dotenv()

app = FastAPI(title="Model Hunter Test Dashboard")

# Paths
BASE_DIR = Path(__file__).parent
TESTS_DIR = BASE_DIR / "tests"
RESULTS_DIR = BASE_DIR / "test_results"
HISTORY_FILE = RESULTS_DIR / "test_history.json"
STATIC_DIR = BASE_DIR / "static"
JSON_REPORT_FILE = BASE_DIR / ".test_report.json"

# Ensure results dir exists
RESULTS_DIR.mkdir(exist_ok=True)

# Current running process
_current_process: Optional[subprocess.Popen] = None
_current_cancel = asyncio.Event()

# Category → pytest path mapping
CATEGORY_PATHS = {
    "unit": "tests/unit/",
    "api": "tests/api/",
    "e2e": "tests/e2e/",
    "security": "tests/security/",
    "stress": "tests/stress/",
    "integration": "tests/api/test_multi_turn.py::TestMultiTurnWorkflowChain",
}


@app.get("/")
async def serve_dashboard():
    """Serve the dashboard HTML."""
    return FileResponse(STATIC_DIR / "test-dashboard.html")


@app.get("/api/list-tests")
async def list_tests(category: str = Query(default="all")):
    """Discover all tests using pytest --collect-only."""
    cmd = [sys.executable, "-m", "pytest", "--collect-only", "-q", "--no-header"]

    if category != "all" and category in CATEGORY_PATHS:
        cmd.append(CATEGORY_PATHS[category])

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=30, cwd=str(BASE_DIR)
        )
        lines = result.stdout.strip().split("\n")
        tests = []
        for line in lines:
            line = line.strip()
            if "::" in line and not line.startswith("="):
                # Parse: tests/unit/test_hunt_engine.py::TestClass::test_method
                parts = line.split("::")
                file_path = parts[0] if parts else ""
                test_name = parts[-1] if len(parts) > 1 else line

                # Determine category from path
                cat = "other"
                for cat_name, cat_path in CATEGORY_PATHS.items():
                    if cat_path.rstrip("/") in file_path:
                        cat = cat_name
                        break

                tests.append({
                    "nodeid": line,
                    "name": test_name,
                    "file": file_path,
                    "category": cat,
                })

        # Group by category
        grouped = {}
        for t in tests:
            cat = t["category"]
            if cat not in grouped:
                grouped[cat] = []
            grouped[cat].append(t)

        return {
            "total": len(tests),
            "categories": grouped,
            "category_counts": {k: len(v) for k, v in grouped.items()},
        }
    except subprocess.TimeoutExpired:
        return JSONResponse({"error": "Test discovery timed out"}, status_code=500)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/run-tests")
async def run_tests(category: str = Query(default="all")):
    """Run tests and stream results via SSE."""
    global _current_process, _current_cancel
    _current_cancel.clear()

    async def event_generator():
        global _current_process

        # Build pytest command
        cmd = [
            sys.executable, "-m", "pytest",
            "--json-report",
            f"--json-report-file={JSON_REPORT_FILE}",
            "--json-report-indent=2",
            "-v",
            "--tb=short",
            "--no-header",
        ]

        # Skip E2E tests by default (need running server)
        if category == "all":
            cmd.extend(["--ignore=tests/e2e/", "--ignore=tests/security/zap_scan.py"])
        elif category in CATEGORY_PATHS:
            cmd.append(CATEGORY_PATHS[category])

        # Remove old report
        if JSON_REPORT_FILE.exists():
            JSON_REPORT_FILE.unlink()

        yield {"event": "run_start", "data": json.dumps({
            "category": category,
            "timestamp": datetime.now().isoformat(),
        })}

        # Start subprocess
        try:
            _current_process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                cwd=str(BASE_DIR),
                bufsize=1,
            )
        except Exception as e:
            yield {"event": "error", "data": json.dumps({"error": str(e)})}
            return

        # Stream stdout line by line
        test_count = 0
        passed = 0
        failed = 0
        errored = 0
        start_time = time.time()

        while True:
            if _current_cancel.is_set():
                _current_process.terminate()
                yield {"event": "cancelled", "data": json.dumps({"message": "Run cancelled"})}
                return

            line = _current_process.stdout.readline()
            if not line and _current_process.poll() is not None:
                break

            line = line.strip()
            if not line:
                continue

            # Stream every raw line to the live terminal
            yield {"event": "raw_output", "data": json.dumps({
                "line": line,
                "elapsed": round(time.time() - start_time, 2),
            })}

            # Parse pytest -v output: "tests/path.py::test_name PASSED"
            if " PASSED" in line or " FAILED" in line or " ERROR" in line or " SKIPPED" in line:
                test_count += 1
                status = "unknown"
                if " PASSED" in line:
                    status = "passed"
                    passed += 1
                elif " FAILED" in line:
                    status = "failed"
                    failed += 1
                elif " ERROR" in line:
                    status = "error"
                    errored += 1
                elif " SKIPPED" in line:
                    status = "skipped"

                # Extract test name
                test_id = line.split(" ")[0] if " " in line else line

                # Determine category
                cat = "other"
                for cat_name, cat_path in CATEGORY_PATHS.items():
                    if cat_path.rstrip("/") in test_id:
                        cat = cat_name
                        break

                yield {"event": "test_result", "data": json.dumps({
                    "nodeid": test_id,
                    "status": status,
                    "category": cat,
                    "index": test_count,
                    "elapsed": round(time.time() - start_time, 2),
                })}

        # Wait for process to finish
        _current_process.wait()
        exit_code = _current_process.returncode
        total_time = round(time.time() - start_time, 2)

        # Parse JSON report for detailed data
        report_data = {}
        if JSON_REPORT_FILE.exists():
            try:
                with open(JSON_REPORT_FILE) as f:
                    report_data = json.load(f)
            except Exception:
                pass

        # Extract failure details and per-test details from report
        failures = []
        test_details = {}
        if "tests" in report_data:
            for t in report_data["tests"]:
                nodeid = t.get("nodeid", "")
                # Build per-test detail
                error_msg = ""
                if t.get("outcome") in ("failed", "error"):
                    if "call" in t and "longrepr" in t["call"]:
                        error_msg = t["call"]["longrepr"]
                    elif "call" in t and "crash" in t["call"]:
                        crash = t["call"]["crash"]
                        error_msg = f"{crash.get('path', '')}:{crash.get('lineno', '')}: {crash.get('message', '')}"
                    failures.append({
                        "nodeid": nodeid,
                        "outcome": t.get("outcome", ""),
                        "duration": t.get("duration", 0),
                        "error": error_msg[:2000],
                    })

                test_details[nodeid] = {
                    "outcome": t.get("outcome", ""),
                    "duration": round(t.get("duration", 0), 4),
                    "error": error_msg[:2000] if error_msg else "",
                    "setup_duration": round(t.get("setup", {}).get("duration", 0), 4) if isinstance(t.get("setup"), dict) else 0,
                    "teardown_duration": round(t.get("teardown", {}).get("duration", 0), 4) if isinstance(t.get("teardown"), dict) else 0,
                }

        summary = {
            "total": test_count,
            "passed": passed,
            "failed": failed,
            "error": errored,
            "skipped": test_count - passed - failed - errored,
            "duration": total_time,
            "exit_code": exit_code,
            "failures": failures,
            "test_details": test_details,
            "timestamp": datetime.now().isoformat(),
            "category": category,
        }

        # Save to history
        _save_run_history(summary)

        yield {"event": "run_complete", "data": json.dumps(summary)}

        _current_process = None

    return EventSourceResponse(event_generator())


@app.post("/api/run-tests/cancel")
async def cancel_tests():
    """Cancel the currently running test suite."""
    global _current_process, _current_cancel
    if _current_process and _current_process.poll() is None:
        _current_cancel.set()
        try:
            _current_process.terminate()
            _current_process.wait(timeout=5)
        except Exception:
            _current_process.kill()
        return {"success": True, "message": "Tests cancelled"}
    return {"success": False, "message": "No tests running"}


@app.get("/api/test-history")
async def get_test_history(limit: int = Query(default=20)):
    """Return previous test run results for trend analysis."""
    history = _load_run_history()
    return {
        "runs": history[-limit:],
        "total_runs": len(history),
    }


# ---------------------------------------------------------------------------
# Part 2: Test Detail Endpoint
# ---------------------------------------------------------------------------

def _parse_test_source(file_path: str, class_name: str, method_name: str) -> dict:
    """Use AST to extract line number, docstring, and source for a test method."""
    abs_path = BASE_DIR / file_path
    if not abs_path.exists():
        return {}

    try:
        source_text = abs_path.read_text()
        tree = ast.parse(source_text)
    except Exception:
        return {}

    source_lines = source_text.splitlines()
    result = {}

    for node in ast.walk(tree):
        # Match class
        if class_name and isinstance(node, ast.ClassDef) and node.name == class_name:
            result["class_docstring"] = ast.get_docstring(node) or ""
            result["class_lineno"] = node.lineno
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == method_name:
                    result["lineno"] = item.lineno
                    result["docstring"] = ast.get_docstring(item) or ""
                    # Extract source lines
                    start = item.lineno - 1
                    end = item.end_lineno if hasattr(item, "end_lineno") and item.end_lineno else start + 20
                    result["source"] = "\n".join(source_lines[start:end])
                    return result

        # Top-level function (no class)
        if not class_name and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == method_name:
            result["lineno"] = node.lineno
            result["docstring"] = ast.get_docstring(node) or ""
            start = node.lineno - 1
            end = node.end_lineno if hasattr(node, "end_lineno") and node.end_lineno else start + 20
            result["source"] = "\n".join(source_lines[start:end])
            return result

    return result


@app.get("/api/test-detail")
async def get_test_detail(nodeid: str = Query(...)):
    """Get detailed info for a single test: file, line, docstring, source."""
    # Parse nodeid: tests/unit/test_hunt_engine.py::TestClassName::test_method
    parts = nodeid.split("::")
    file_path = parts[0] if parts else ""
    class_name = parts[1] if len(parts) == 3 else ""
    method_name = parts[-1] if len(parts) >= 2 else ""

    detail = _parse_test_source(file_path, class_name, method_name)

    # Determine category
    cat = "other"
    for cat_name, cat_path in CATEGORY_PATHS.items():
        if cat_path.rstrip("/") in file_path:
            cat = cat_name
            break

    return {
        "nodeid": nodeid,
        "file": file_path,
        "class_name": class_name,
        "method_name": method_name,
        "category": cat,
        "lineno": detail.get("lineno", 0),
        "docstring": detail.get("docstring", ""),
        "class_docstring": detail.get("class_docstring", ""),
        "source": detail.get("source", ""),
    }


# ---------------------------------------------------------------------------
# Part 3: AI-Assisted Test Creation
# ---------------------------------------------------------------------------

class GenerateTestRequest(BaseModel):
    description: str
    category: str = "api"


class SaveTestRequest(BaseModel):
    code: str
    filename: str
    category: str = "api"


def _load_context_for_category(category: str) -> str:
    """Load conftest fixtures + one example test file as context for AI."""
    context_parts = []

    # Always include conftest
    conftest_path = TESTS_DIR / "conftest.py"
    if conftest_path.exists():
        context_parts.append(f"# === tests/conftest.py ===\n{conftest_path.read_text()}")

    # Find one example test from the category
    cat_dir = TESTS_DIR / category
    if cat_dir.exists():
        test_files = sorted(cat_dir.glob("test_*.py"))
        if test_files:
            example = test_files[0]
            content = example.read_text()
            # Truncate if very large
            if len(content) > 6000:
                content = content[:6000] + "\n# ... truncated ..."
            context_parts.append(f"# === {example.relative_to(BASE_DIR)} ===\n{content}")

    return "\n\n".join(context_parts)


@app.post("/api/generate-test")
async def generate_test(req: GenerateTestRequest):
    """Generate a test using OpenAI GPT from a plain-English description."""
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return JSONResponse({"error": "OPENAI_API_KEY not set"}, status_code=500)

    context = _load_context_for_category(req.category)

    system_prompt = textwrap.dedent(f"""\
    You are a Python test engineer for the Model Hunter project.
    Generate a complete, runnable pytest test file based on the user's description.

    RULES:
    - Use pytest with class-based test organization
    - Add the correct marker: @pytest.mark.{req.category}
    - Include module and class docstrings
    - Use fixtures from conftest.py (client, app, minimal_notebook, create_session, etc.)
    - Add sys.path setup at the top (like the example tests)
    - Return ONLY the Python code, no markdown fences, no explanation
    - Make the test thorough with clear assertions and descriptive names

    AVAILABLE FIXTURES AND EXAMPLE CODE:
    {context}
    """)

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "gpt-4o",
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": f"Generate a {req.category} test for: {req.description}"},
                    ],
                    "temperature": 0.3,
                    "max_tokens": 4000,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            code = data["choices"][0]["message"]["content"]
            # Strip markdown fences if present
            code = re.sub(r'^```(?:python)?\n?', '', code, flags=re.MULTILINE)
            code = re.sub(r'\n?```$', '', code, flags=re.MULTILINE)
            code = code.strip()

            # Suggest a filename
            slug = re.sub(r'[^a-z0-9]+', '_', req.description.lower())[:50].strip('_')
            suggested_filename = f"test_{slug}.py"

            return {
                "code": code,
                "suggested_filename": suggested_filename,
                "category": req.category,
            }
    except httpx.HTTPStatusError as e:
        return JSONResponse({"error": f"OpenAI API error: {e.response.status_code}"}, status_code=502)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/api/save-test")
async def save_test(req: SaveTestRequest):
    """Save a generated test file to the appropriate tests/ directory."""
    # Validate category
    valid_categories = ["unit", "api", "e2e", "security", "stress"]
    if req.category not in valid_categories:
        return JSONResponse({"error": f"Invalid category. Use: {valid_categories}"}, status_code=400)

    # Validate filename
    if not req.filename.startswith("test_") or not req.filename.endswith(".py"):
        return JSONResponse({"error": "Filename must match test_*.py"}, status_code=400)

    # Prevent path traversal
    if ".." in req.filename or "/" in req.filename:
        return JSONResponse({"error": "Invalid filename"}, status_code=400)

    target_dir = TESTS_DIR / req.category
    target_dir.mkdir(parents=True, exist_ok=True)
    target_file = target_dir / req.filename

    if target_file.exists():
        return JSONResponse({"error": f"File already exists: {target_file.relative_to(BASE_DIR)}"}, status_code=409)

    try:
        target_file.write_text(req.code)
        return {
            "success": True,
            "path": str(target_file.relative_to(BASE_DIR)),
            "message": f"Saved to {target_file.relative_to(BASE_DIR)}",
        }
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ---------------------------------------------------------------------------
# History helpers
# ---------------------------------------------------------------------------

def _save_run_history(summary: dict):
    """Append a run summary to the history file."""
    history = _load_run_history()
    history.append(summary)
    # Keep last 100 runs
    history = history[-100:]
    try:
        with open(HISTORY_FILE, "w") as f:
            json.dump(history, f, indent=2)
    except Exception:
        pass

    # Also save individual run file
    try:
        ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        run_file = RESULTS_DIR / f"run_{ts}.json"
        with open(run_file, "w") as f:
            json.dump(summary, f, indent=2)
    except Exception:
        pass


def _load_run_history() -> list:
    """Load run history from disk."""
    if HISTORY_FILE.exists():
        try:
            with open(HISTORY_FILE) as f:
                return json.load(f)
        except Exception:
            return []
    return []


if __name__ == "__main__":
    import uvicorn
    print("\n  Model Hunter — Test Dashboard")
    print("  http://localhost:8001\n")
    uvicorn.run(app, host="0.0.0.0", port=8001, log_level="info")
