"""
Telemetry Logger Service

Fire-and-forget JSON logging for monitoring dashboard.
All operations are wrapped in try/except - NEVER raises exceptions.
If logging fails, the main app continues normally.

Writes JSON lines to a log file for the dashboard to read.
"""
import os
import json
import time
from datetime import datetime, timedelta
from typing import Dict, Any, Optional
from pathlib import Path
import threading
import fcntl


class TelemetryLogger:
    """
    Non-blocking JSON line logger for telemetry events.
    
    Design principles:
    - NEVER raises exceptions
    - NEVER blocks the main application
    - All writes are fire-and-forget
    - Automatic log rotation (keeps last 7 days)
    """
    
    def __init__(self, log_dir: Optional[str] = None):
        """
        Initialize telemetry logger.
        
        Args:
            log_dir: Directory for log files. Defaults to .telemetry/ in project root.
        """
        try:
            if log_dir:
                self.log_dir = Path(log_dir)
            else:
                # Check environment variable first (for Docker deployment)
                env_path = os.environ.get("TELEMETRY_LOG_PATH")
                if env_path:
                    self.log_dir = Path(env_path).parent
                else:
                    # Default to .telemetry/ in the model-hunter directory
                    self.log_dir = Path(__file__).parent.parent / ".telemetry"
            
            self.log_dir.mkdir(parents=True, exist_ok=True)
            self.log_file = self.log_dir / "events.jsonl"
            self._lock = threading.Lock()
            self._enabled = True
            
            # Rotate logs on startup (async to not block)
            threading.Thread(target=self._rotate_logs, daemon=True).start()
            
        except Exception:
            # If initialization fails, disable logging silently
            self._enabled = False
    
    def log_event(self, event_type: str, data: Optional[Dict[str, Any]] = None) -> None:
        """
        Log a telemetry event. Fire-and-forget - never raises.
        
        Args:
            event_type: Type of event (e.g., "api_call_start", "hunt_complete")
            data: Optional dict of event data
        """
        if not self._enabled:
            return
            
        try:
            entry = {
                "ts": datetime.utcnow().isoformat() + "Z",
                "type": event_type,
                "data": data or {}
            }
            
            line = json.dumps(entry, default=str) + "\n"
            
            # Thread-safe write with file locking
            with self._lock:
                with open(self.log_file, "a") as f:
                    fcntl.flock(f.fileno(), fcntl.LOCK_EX)
                    try:
                        f.write(line)
                    finally:
                        fcntl.flock(f.fileno(), fcntl.LOCK_UN)
                        
        except Exception:
            # Silent fail - dashboard is optional
            pass
    
    def log_api_call_start(
        self,
        provider: str,
        model: str,
        session_id: Optional[str] = None
    ) -> float:
        """
        Log API call start. Returns start time for latency calculation.
        
        Args:
            provider: API provider (openrouter, fireworks, openai)
            model: Model name/ID
            session_id: Optional session ID
            
        Returns:
            Start timestamp for calculating latency
        """
        start_time = time.time()
        self.log_event("api_call_start", {
            "provider": provider,
            "model": model,
            "session_id": session_id
        })
        return start_time
    
    def log_api_call_end(
        self,
        provider: str,
        model: str,
        start_time: float,
        success: bool = True,
        error: Optional[str] = None,
        tokens_in: Optional[int] = None,
        tokens_out: Optional[int] = None,
        session_id: Optional[str] = None
    ) -> None:
        """
        Log API call completion with latency.
        
        Args:
            provider: API provider
            model: Model name/ID
            start_time: Start timestamp from log_api_call_start
            success: Whether the call succeeded
            error: Error message if failed
            tokens_in: Input tokens (if available)
            tokens_out: Output tokens (if available)
            session_id: Optional session ID
        """
        latency_ms = int((time.time() - start_time) * 1000)
        self.log_event("api_call_end", {
            "provider": provider,
            "model": model,
            "latency_ms": latency_ms,
            "success": success,
            "error": error,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "session_id": session_id
        })
    
    def log_session_created(
        self,
        session_id: str,
        notebook: str,
        source: str = "upload"
    ) -> None:
        """Log session creation."""
        self.log_event("session_created", {
            "session_id": session_id,
            "notebook": notebook,
            "source": source
        })
    
    def log_hunt_start(
        self,
        session_id: str,
        workers: int,
        models: list,
        target_breaks: int
    ) -> None:
        """Log hunt start."""
        self.log_event("hunt_start", {
            "session_id": session_id,
            "workers": workers,
            "models": models,
            "target_breaks": target_breaks
        })
    
    def log_hunt_complete(
        self,
        session_id: str,
        completed_hunts: int,
        breaks_found: int,
        success: bool
    ) -> None:
        """Log hunt completion."""
        self.log_event("hunt_complete", {
            "session_id": session_id,
            "completed_hunts": completed_hunts,
            "breaks_found": breaks_found,
            "success": success
        })
    
    def log_hunt_result(
        self,
        session_id: str,
        hunt_id: int,
        model: str,
        score: Optional[int],
        is_breaking: bool,
        error: Optional[str] = None,
        response_preview: Optional[str] = None,
        reasoning_preview: Optional[str] = None,
        criteria: Optional[Dict[str, str]] = None
    ) -> None:
        """Log individual hunt result with searchable content."""
        self.log_event("hunt_result", {
            "session_id": session_id,
            "hunt_id": hunt_id,
            "model": model,
            "score": score,
            "is_breaking": is_breaking,
            "error": error,
            "response_preview": response_preview,
            "reasoning_preview": reasoning_preview,
            "criteria": criteria
        })
    
    def log_judge_call(
        self,
        model: str,
        start_time: float,
        score: Optional[int] = None,
        success: bool = True,
        error: Optional[str] = None
    ) -> None:
        """Log judge API call completion."""
        latency_ms = int((time.time() - start_time) * 1000)
        self.log_event("judge_call", {
            "model": model,
            "latency_ms": latency_ms,
            "score": score,
            "success": success,
            "error": error
        })
    
    def _rotate_logs(self) -> None:
        """
        Rotate logs - keep only last 7 days of data.
        Runs in background thread.
        """
        try:
            if not self.log_file.exists():
                return
                
            cutoff = datetime.utcnow() - timedelta(days=7)
            temp_file = self.log_dir / "events.jsonl.tmp"
            
            lines_kept = 0
            lines_removed = 0
            
            with open(self.log_file, "r") as f_in:
                with open(temp_file, "w") as f_out:
                    for line in f_in:
                        try:
                            entry = json.loads(line)
                            ts = datetime.fromisoformat(entry["ts"].rstrip("Z"))
                            if ts > cutoff:
                                f_out.write(line)
                                lines_kept += 1
                            else:
                                lines_removed += 1
                        except Exception:
                            # Keep malformed lines to not lose data
                            f_out.write(line)
                            lines_kept += 1
            
            # Replace old file with rotated one
            if lines_removed > 0:
                temp_file.replace(self.log_file)
                print(f"Telemetry: Rotated logs - kept {lines_kept}, removed {lines_removed} old entries")
            else:
                temp_file.unlink(missing_ok=True)
                
        except Exception:
            # Silent fail
            pass
    
    def get_log_path(self) -> str:
        """Return the path to the log file (for dashboard)."""
        return str(self.log_file)


# Singleton instance
_telemetry: Optional[TelemetryLogger] = None


def get_telemetry() -> TelemetryLogger:
    """Get or create the telemetry logger singleton."""
    global _telemetry
    if _telemetry is None:
        _telemetry = TelemetryLogger()
    return _telemetry


# Convenience functions for direct import
def log_event(event_type: str, data: Optional[Dict[str, Any]] = None) -> None:
    """Log a telemetry event."""
    get_telemetry().log_event(event_type, data)


def log_api_call_start(provider: str, model: str, session_id: Optional[str] = None) -> float:
    """Log API call start, returns start time."""
    return get_telemetry().log_api_call_start(provider, model, session_id)


def log_api_call_end(
    provider: str,
    model: str,
    start_time: float,
    success: bool = True,
    error: Optional[str] = None,
    tokens_in: Optional[int] = None,
    tokens_out: Optional[int] = None,
    session_id: Optional[str] = None
) -> None:
    """Log API call end with latency."""
    get_telemetry().log_api_call_end(
        provider, model, start_time, success, error, tokens_in, tokens_out, session_id
    )
