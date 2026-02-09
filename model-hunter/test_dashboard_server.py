"""
Model Hunter — Pre-Deployment Test Dashboard Server

A standalone FastAPI app (port 8001) that:
- Discovers all pytest tests grouped by category
- Runs tests via subprocess with JSON reporting
- Streams results in real-time via SSE
- Stores run history for trend analysis

Usage:
    python test_dashboard_server.py
    # Open http://localhost:8001
"""
import asyncio
import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sse_starlette.sse import EventSourceResponse

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

        # Extract failure details from report
        failures = []
        if "tests" in report_data:
            for t in report_data["tests"]:
                if t.get("outcome") in ("failed", "error"):
                    error_msg = ""
                    if "call" in t and "longrepr" in t["call"]:
                        error_msg = t["call"]["longrepr"]
                    elif "call" in t and "crash" in t["call"]:
                        crash = t["call"]["crash"]
                        error_msg = f"{crash.get('path', '')}:{crash.get('lineno', '')}: {crash.get('message', '')}"
                    failures.append({
                        "nodeid": t.get("nodeid", ""),
                        "outcome": t.get("outcome", ""),
                        "duration": t.get("duration", 0),
                        "error": error_msg[:2000],  # Cap error message
                    })

        summary = {
            "total": test_count,
            "passed": passed,
            "failed": failed,
            "error": errored,
            "skipped": test_count - passed - failed - errored,
            "duration": total_time,
            "exit_code": exit_code,
            "failures": failures,
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
