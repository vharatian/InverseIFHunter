"""
Analytics Cache - Background Pre-computation

Runs a 60-second background loop that:
1. Reads new telemetry events incrementally
2. Refreshes trainer data
3. Computes all analytics into an AnalyticsSnapshot
4. Stores in app.state for instant API responses
"""
import asyncio
import time
import traceback
from dataclasses import dataclass, field
from typing import Dict, List, Any, Optional
from datetime import datetime

from log_reader import LogReader
from analytics import (
    compute_trainer_timing,
    compute_criteria_analytics,
    compute_judge_analytics,
    compute_prompt_analytics,
    compute_model_analytics,
    compute_cost_analytics,
    compute_overview,
    detect_anomalies,
)

# Optional ML import
try:
    from ml_inference import MLInference
    _ml_available = True
except ImportError:
    _ml_available = False


@dataclass
class AnalyticsSnapshot:
    """Pre-computed analytics snapshot. Refreshed every 60 seconds."""
    timestamp: str = ""
    compute_time_ms: int = 0

    # Core analytics
    overview: Dict[str, Any] = field(default_factory=dict)
    trainer_timing: Dict[str, Dict] = field(default_factory=dict)
    criteria: Dict[str, Any] = field(default_factory=dict)
    judge: Dict[str, Any] = field(default_factory=dict)
    prompts: Dict[str, Any] = field(default_factory=dict)
    models: List[Dict] = field(default_factory=list)
    costs: Dict[str, Any] = field(default_factory=dict)
    anomalies: List[Dict] = field(default_factory=list)

    # ML predictions (if available)
    ml_predictions: Dict[str, Any] = field(default_factory=dict)

    # Raw data for endpoints that need it
    trainer_registry: Dict[str, Dict] = field(default_factory=dict)
    total_events: int = 0

    # Test account exclusion (for Data Lab export filtering)
    excluded_emails: set = field(default_factory=set)
    excluded_sessions: set = field(default_factory=set)


class AnalyticsCacheManager:
    """Manages the background analytics refresh loop."""

    def __init__(self):
        self.reader = LogReader()
        self.snapshot: Optional[AnalyticsSnapshot] = None
        self._ml: Optional[Any] = None
        self._running = False
        self._session_data_cache: Dict[str, Dict] = {}

    async def start(self, app):
        """Start the background refresh loop. Called on FastAPI startup."""
        self._running = True

        # Load ML model if available
        if _ml_available:
            try:
                self._ml = MLInference()
                print(f"ML model loaded: {self._ml.get_model_info()}")
            except Exception as e:
                print(f"ML model not available: {e}")

        # Initial read
        await self._refresh()

        # Start background loop
        asyncio.create_task(self._loop())

    async def stop(self):
        """Stop the background loop."""
        self._running = False

    async def _loop(self):
        """Background loop that refreshes every 60 seconds."""
        while self._running:
            await asyncio.sleep(60)
            try:
                await self._refresh()
            except Exception as e:
                print(f"Analytics refresh error (will retry): {e}")
                traceback.print_exc()

    async def _refresh(self):
        """Perform one refresh cycle."""
        start = time.time()

        # Run blocking I/O in thread pool
        loop = asyncio.get_event_loop()
        snapshot = await loop.run_in_executor(None, self._compute_snapshot)

        snapshot.compute_time_ms = int((time.time() - start) * 1000)
        snapshot.timestamp = datetime.utcnow().isoformat() + "Z"

        self.snapshot = snapshot

    def _compute_snapshot(self) -> AnalyticsSnapshot:
        """Compute all analytics (runs in thread pool)."""
        snap = AnalyticsSnapshot()

        # 1. Read new events incrementally
        self.reader.read_new_events()
        all_events = self.reader.get_all_events()
        snap.total_events = len(all_events)

        # 2. Refresh trainer data (trainers.json + session storage)
        self.reader.refresh_trainer_data()
        snap.trainer_registry = self.reader.get_trainer_registry()

        # 3. Load test account exclusion list and filter events
        #    Test account data is STORED (for debugging) but EXCLUDED from analytics/ML.
        from auth import get_test_accounts
        excluded_emails = set(get_test_accounts())

        # Build set of session_ids belonging to test accounts
        excluded_sessions = set()
        for sid, email in self.reader._session_to_email.items():
            if email.lower() in excluded_emails:
                excluded_sessions.add(sid)

        # Filter: remove events from test accounts
        if excluded_emails or excluded_sessions:
            filtered_events = []
            for e in all_events:
                data = e.get("data", {})
                # Exclude by direct email match
                if data.get("trainer_email", "").lower() in excluded_emails:
                    continue
                # Exclude by session_id match
                if data.get("session_id", "") in excluded_sessions:
                    continue
                filtered_events.append(e)
            analytics_events = filtered_events
        else:
            analytics_events = all_events

        # Filter trainer registry (remove test accounts)
        filtered_registry = {
            email: data for email, data in snap.trainer_registry.items()
            if email.lower() not in excluded_emails
        }

        # Filter session-to-email mapping
        filtered_s2e = {
            sid: email for sid, email in self.reader._session_to_email.items()
            if email.lower() not in excluded_emails
        }

        # 4. Compute trainer timing (using filtered data)
        snap.trainer_timing = compute_trainer_timing(
            analytics_events,
            filtered_registry,
            filtered_s2e
        )

        # 5. Criteria analytics
        snap.criteria = compute_criteria_analytics(analytics_events)

        # 6. Judge analytics
        snap.judge = compute_judge_analytics(analytics_events)

        # 7. Model analytics
        snap.models = compute_model_analytics(analytics_events)

        # 8. Prompt analytics (needs session data — also filtered)
        self._refresh_session_data()
        filtered_session_data = {
            sid: data for sid, data in self._session_data_cache.items()
            if sid not in excluded_sessions
        }
        snap.prompts = compute_prompt_analytics(filtered_registry, filtered_session_data)

        # 9. Cost analytics
        snap.costs = compute_cost_analytics(analytics_events, snap.trainer_timing, filtered_s2e)

        # 10. Anomaly detection
        snap.anomalies = detect_anomalies(analytics_events)

        # 11. Overview (depends on trainer_timing)
        snap.overview = compute_overview(analytics_events, snap.trainer_timing)

        # Store exclusion info for the Data Lab export filter
        snap.excluded_emails = excluded_emails
        snap.excluded_sessions = excluded_sessions

        return snap

    def _refresh_session_data(self):
        """Load session storage files for prompt analytics."""
        import json
        from pathlib import Path

        storage_path = self.reader.storage_path
        if not storage_path.exists():
            return

        for session_file in storage_path.glob("*.json"):
            if session_file.name == "trainers.json":
                continue
            sid = session_file.stem
            if sid in self._session_data_cache:
                continue
            try:
                with open(session_file, "r") as f:
                    self._session_data_cache[sid] = json.load(f)
            except Exception:
                continue

    def get_snapshot(self) -> Optional[AnalyticsSnapshot]:
        """Get the current snapshot (may be None if not yet computed)."""
        return self.snapshot

    def get_reader(self) -> LogReader:
        """Get the log reader instance."""
        return self.reader
