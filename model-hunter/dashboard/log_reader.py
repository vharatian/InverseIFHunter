"""
Log Reader and Aggregator

Reads and parses JSONL telemetry logs for the dashboard.
Provides aggregated metrics and filtered event lists.
"""
import json
import os
from datetime import datetime, timedelta
from typing import Dict, List, Any, Optional
from pathlib import Path
from collections import defaultdict
import threading


class LogReader:
    """
    Reads and aggregates telemetry logs for dashboard display.
    """
    
    # Model pricing (per 1M tokens) - verified rates as of Jan 2026
    MODEL_PRICING = {
        # OpenRouter models
        "nvidia/nemotron-3-nano-30b-a3b": {"input": 0.06, "output": 0.24},
        "qwen/qwen3-235b-a22b-thinking-2507": {"input": 0.11, "output": 0.60},
        # Fireworks models (same Qwen model, different pricing)
        "accounts/fireworks/models/qwen3-235b-a22b-thinking-2507": {"input": 0.22, "output": 0.88},
        # OpenAI models (for judge)
        "gpt-5": {"input": 1.25, "output": 10.00},
        "gpt-4o": {"input": 2.50, "output": 10.00},
        "gpt-4-turbo": {"input": 10.00, "output": 30.00},
        # Default fallback
        "default": {"input": 0.50, "output": 1.00}
    }
    
    def __init__(self, log_path: Optional[str] = None):
        """
        Initialize log reader.
        
        Args:
            log_path: Path to the JSONL log file. Defaults to model-hunter/.telemetry/events.jsonl
        """
        if log_path:
            self.log_path = Path(log_path)
        else:
            # Check environment variable first (for Docker deployment)
            env_path = os.environ.get("TELEMETRY_LOG_PATH")
            if env_path:
                self.log_path = Path(env_path)
            else:
                # Default path - relative to model-hunter directory
                self.log_path = Path(__file__).parent.parent / ".telemetry" / "events.jsonl"
        
        self._cache: Dict[str, Any] = {}
        self._cache_time: Optional[datetime] = None
        self._cache_ttl = 5  # seconds
        self._lock = threading.Lock()
    
    def _read_events(self, since: Optional[datetime] = None, limit: Optional[int] = None) -> List[Dict]:
        """
        Read events from log file.
        
        Args:
            since: Only return events after this time
            limit: Maximum number of events to return (most recent first)
        
        Returns:
            List of event dicts
        """
        events = []
        
        if not self.log_path.exists():
            return events
        
        try:
            with open(self.log_path, "r") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                        
                        # Parse timestamp
                        ts_str = event.get("ts", "")
                        if ts_str:
                            ts = datetime.fromisoformat(ts_str.rstrip("Z"))
                            event["_ts"] = ts
                            
                            # Filter by time if specified
                            if since and ts < since:
                                continue
                        
                        events.append(event)
                    except (json.JSONDecodeError, ValueError):
                        continue
            
            # Sort by timestamp (newest first)
            events.sort(key=lambda x: x.get("_ts", datetime.min), reverse=True)
            
            # Apply limit
            if limit:
                events = events[:limit]
            
            return events
            
        except Exception as e:
            print(f"Error reading log file: {e}")
            return []
    
    def get_overview(self, hours: int = 24) -> Dict[str, Any]:
        """
        Get overview statistics for the dashboard.
        
        Args:
            hours: Time window in hours
            
        Returns:
            Dict with overview stats
        """
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        
        # Initialize counters
        stats = {
            "active_sessions": 0,
            "total_sessions": 0,
            "total_hunts": 0,
            "total_api_calls": 0,
            "successful_api_calls": 0,
            "failed_api_calls": 0,
            "total_judge_calls": 0,
            "breaks_found": 0,
            "avg_latency_ms": 0,
            "latencies": [],
            "models_used": defaultdict(int),
            "providers_used": defaultdict(int),
            "errors": [],
            "time_window_hours": hours
        }
        
        # Track active sessions: sessions with hunt_start but no hunt_complete
        # We need to process events in chronological order (oldest first)
        sessions_with_running_hunts = {}  # session_id -> count of running hunts
        
        # Reverse events to process oldest first (events are sorted newest first)
        events_chronological = list(reversed(events))
        
        for event in events_chronological:
            event_type = event.get("type", "")
            data = event.get("data", {})
            ts = event.get("_ts")
            
            if event_type == "session_created":
                stats["total_sessions"] += 1
            
            elif event_type == "hunt_start":
                stats["total_hunts"] += 1
                session_id = data.get("session_id")
                if session_id:
                    # Increment running hunt count for this session
                    sessions_with_running_hunts[session_id] = sessions_with_running_hunts.get(session_id, 0) + 1
            
            elif event_type == "hunt_complete":
                stats["breaks_found"] += data.get("breaks_found", 0)
                session_id = data.get("session_id")
                if session_id and session_id in sessions_with_running_hunts:
                    # Decrement running hunt count
                    sessions_with_running_hunts[session_id] -= 1
                    if sessions_with_running_hunts[session_id] <= 0:
                        del sessions_with_running_hunts[session_id]
            
            elif event_type == "api_call_start":
                stats["total_api_calls"] += 1
                model = data.get("model", "unknown")
                provider = data.get("provider", "unknown")
                stats["models_used"][model] += 1
                stats["providers_used"][provider] += 1
            
            elif event_type == "api_call_end":
                if data.get("success"):
                    stats["successful_api_calls"] += 1
                else:
                    stats["failed_api_calls"] += 1
                    if data.get("error"):
                        stats["errors"].append({
                            "time": event.get("ts"),
                            "error": data.get("error"),
                            "provider": data.get("provider"),
                            "model": data.get("model")
                        })
                
                latency = data.get("latency_ms")
                if latency:
                    stats["latencies"].append(latency)
            
            elif event_type == "judge_call":
                stats["total_judge_calls"] += 1
                latency = data.get("latency_ms")
                if latency:
                    stats["latencies"].append(latency)
        
        # Calculate average latency
        if stats["latencies"]:
            stats["avg_latency_ms"] = int(sum(stats["latencies"]) / len(stats["latencies"]))
        
        # Active sessions = sessions with running hunts (hunt_start without hunt_complete)
        stats["active_sessions"] = len(sessions_with_running_hunts)
        
        # Convert defaultdicts to regular dicts for JSON
        stats["models_used"] = dict(stats["models_used"])
        stats["providers_used"] = dict(stats["providers_used"])
        
        # Limit errors to most recent 10
        stats["errors"] = stats["errors"][:10]
        
        # Remove raw latencies from output
        del stats["latencies"]
        
        return stats
    
    def get_recent_events(self, limit: int = 50, event_type: Optional[str] = None) -> List[Dict]:
        """
        Get recent events for the live feed.
        
        Args:
            limit: Maximum number of events
            event_type: Filter by event type
            
        Returns:
            List of recent events
        """
        events = self._read_events(limit=limit * 2 if event_type else limit)
        
        # Filter by type if specified
        if event_type:
            events = [e for e in events if e.get("type") == event_type][:limit]
        
        # Remove internal fields
        for event in events:
            event.pop("_ts", None)
        
        return events[:limit]
    
    def get_timeline(self, hours: int = 24, bucket_minutes: int = 60) -> Dict[str, List]:
        """
        Get event counts over time for charts.
        
        Args:
            hours: Time window
            bucket_minutes: Size of each time bucket
            
        Returns:
            Dict with timeline data
        """
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        
        # Create buckets
        buckets = defaultdict(lambda: {
            "api_calls": 0,
            "hunts": 0,
            "sessions": 0,
            "errors": 0
        })
        
        for event in events:
            ts = event.get("_ts")
            if not ts:
                continue
            
            # Round to bucket
            bucket_ts = ts.replace(
                minute=(ts.minute // bucket_minutes) * bucket_minutes,
                second=0,
                microsecond=0
            )
            bucket_key = bucket_ts.isoformat() + "Z"
            
            event_type = event.get("type", "")
            
            if event_type == "api_call_start":
                buckets[bucket_key]["api_calls"] += 1
            elif event_type == "api_call_end":
                data = event.get("data", {})
                if not data.get("success"):
                    buckets[bucket_key]["errors"] += 1
            elif event_type == "hunt_start":
                buckets[bucket_key]["hunts"] += 1
            elif event_type == "session_created":
                buckets[bucket_key]["sessions"] += 1
        
        # Sort by time and convert to lists
        sorted_buckets = sorted(buckets.items())
        
        return {
            "timestamps": [b[0] for b in sorted_buckets],
            "api_calls": [b[1]["api_calls"] for b in sorted_buckets],
            "hunts": [b[1]["hunts"] for b in sorted_buckets],
            "sessions": [b[1]["sessions"] for b in sorted_buckets],
            "errors": [b[1]["errors"] for b in sorted_buckets]
        }
    
    def get_model_stats(self, hours: int = 24) -> Dict[str, Any]:
        """
        Get model usage statistics.
        
        Args:
            hours: Time window
            
        Returns:
            Dict with model stats
        """
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        
        model_stats = defaultdict(lambda: {
            "calls": 0,
            "successes": 0,
            "failures": 0,
            "total_latency": 0,
            "latency_count": 0
        })
        
        for event in events:
            event_type = event.get("type", "")
            data = event.get("data", {})
            model = data.get("model", "unknown")
            
            if event_type == "api_call_start":
                model_stats[model]["calls"] += 1
            
            elif event_type == "api_call_end":
                if data.get("success"):
                    model_stats[model]["successes"] += 1
                else:
                    model_stats[model]["failures"] += 1
                
                latency = data.get("latency_ms")
                if latency:
                    model_stats[model]["total_latency"] += latency
                    model_stats[model]["latency_count"] += 1
        
        # Calculate averages
        result = {}
        for model, stats in model_stats.items():
            avg_latency = 0
            if stats["latency_count"] > 0:
                avg_latency = int(stats["total_latency"] / stats["latency_count"])
            
            success_rate = 0
            if stats["calls"] > 0:
                success_rate = round(stats["successes"] / stats["calls"] * 100, 1)
            
            result[model] = {
                "calls": stats["calls"],
                "successes": stats["successes"],
                "failures": stats["failures"],
                "avg_latency_ms": avg_latency,
                "success_rate": success_rate
            }
        
        return result
    
    def search_events(
        self, 
        query: str, 
        hours: int = 168,
        limit: int = 100
    ) -> List[Dict]:
        """
        Search events by text query.
        
        Searches across:
        - Session IDs
        - Notebook names
        - Model names
        - Error messages
        - Response previews
        - Reasoning previews
        - Criteria (keys and values)
        
        Args:
            query: Search query string (case-insensitive)
            hours: Time window to search
            limit: Maximum results
            
        Returns:
            List of matching events
        """
        if not query or not query.strip():
            return []
        
        query_lower = query.lower().strip()
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        
        matches = []
        
        for event in events:
            if len(matches) >= limit:
                break
                
            data = event.get("data", {})
            
            # Build searchable text from all relevant fields
            searchable_parts = [
                str(data.get("session_id", "")),
                str(data.get("notebook", "")),
                str(data.get("model", "")),
                str(data.get("error", "")),
                str(data.get("response_preview", "")),
                str(data.get("reasoning_preview", "")),
                str(data.get("provider", "")),
                str(event.get("type", "")),
            ]
            
            # Add criteria keys and values
            criteria = data.get("criteria", {})
            if isinstance(criteria, dict):
                for k, v in criteria.items():
                    searchable_parts.append(str(k))
                    searchable_parts.append(str(v))
            
            # Combine and search
            searchable_text = " ".join(searchable_parts).lower()
            
            if query_lower in searchable_text:
                # Remove internal fields
                event_copy = event.copy()
                event_copy.pop("_ts", None)
                matches.append(event_copy)
        
        return matches
    
    def _get_model_pricing(self, model: str) -> Dict[str, float]:
        """Get pricing for a model, with fallback to default."""
        if model in self.MODEL_PRICING:
            return self.MODEL_PRICING[model]
        # Try partial match
        for known_model, pricing in self.MODEL_PRICING.items():
            if known_model in model or model in known_model:
                return pricing
        return self.MODEL_PRICING["default"]
    
    def _calculate_cost(self, model: str, tokens_in: int, tokens_out: int) -> float:
        """Calculate cost for a single API call in dollars."""
        pricing = self._get_model_pricing(model)
        cost = (tokens_in * pricing["input"] / 1_000_000) + (tokens_out * pricing["output"] / 1_000_000)
        return round(cost, 6)
    
    def get_cost_summary(self, hours: int = 24) -> Dict[str, Any]:
        """
        Get cost summary for API calls.
        
        Returns:
            Dict with cost breakdown by model and provider
        """
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        
        summary = {
            "total_cost": 0.0,
            "total_tokens_in": 0,
            "total_tokens_out": 0,
            "by_model": defaultdict(lambda: {"cost": 0.0, "tokens_in": 0, "tokens_out": 0, "calls": 0}),
            "by_provider": defaultdict(lambda: {"cost": 0.0, "tokens_in": 0, "tokens_out": 0, "calls": 0}),
            "time_window_hours": hours
        }
        
        for event in events:
            if event.get("type") != "api_call_end":
                continue
            
            data = event.get("data", {})
            model = data.get("model", "unknown")
            provider = data.get("provider", "unknown")
            tokens_in = data.get("tokens_in") or 0
            tokens_out = data.get("tokens_out") or 0
            
            if tokens_in or tokens_out:
                cost = self._calculate_cost(model, tokens_in, tokens_out)
                
                summary["total_cost"] += cost
                summary["total_tokens_in"] += tokens_in
                summary["total_tokens_out"] += tokens_out
                
                summary["by_model"][model]["cost"] += cost
                summary["by_model"][model]["tokens_in"] += tokens_in
                summary["by_model"][model]["tokens_out"] += tokens_out
                summary["by_model"][model]["calls"] += 1
                
                summary["by_provider"][provider]["cost"] += cost
                summary["by_provider"][provider]["tokens_in"] += tokens_in
                summary["by_provider"][provider]["tokens_out"] += tokens_out
                summary["by_provider"][provider]["calls"] += 1
        
        # Round total cost
        summary["total_cost"] = round(summary["total_cost"], 4)
        
        # Convert defaultdicts and round costs
        summary["by_model"] = {k: {**v, "cost": round(v["cost"], 4)} for k, v in summary["by_model"].items()}
        summary["by_provider"] = {k: {**v, "cost": round(v["cost"], 4)} for k, v in summary["by_provider"].items()}
        
        return summary
    
    def get_detailed_hunts(self, hours: int = 24, limit: int = 50) -> List[Dict]:
        """Get detailed list of hunts with results."""
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        
        hunts = []
        for event in events:
            if event.get("type") == "hunt_result":
                data = event.get("data", {})
                hunts.append({
                    "timestamp": event.get("ts"),
                    "session_id": data.get("session_id"),
                    "hunt_id": data.get("hunt_id"),
                    "model": data.get("model"),
                    "score": data.get("score"),
                    "is_breaking": data.get("is_breaking"),
                    "error": data.get("error"),
                    "response_preview": data.get("response_preview"),
                    "reasoning_preview": data.get("reasoning_preview"),
                    "criteria": data.get("criteria")
                })
        
        return hunts[:limit]
    
    def get_detailed_api_calls(self, hours: int = 24, limit: int = 100) -> List[Dict]:
        """Get detailed list of API calls."""
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        
        calls = []
        for event in events:
            if event.get("type") == "api_call_end":
                data = event.get("data", {})
                model = data.get("model", "unknown")
                tokens_in = data.get("tokens_in") or 0
                tokens_out = data.get("tokens_out") or 0
                cost = self._calculate_cost(model, tokens_in, tokens_out) if (tokens_in or tokens_out) else 0
                
                calls.append({
                    "timestamp": event.get("ts"),
                    "provider": data.get("provider"),
                    "model": model,
                    "latency_ms": data.get("latency_ms"),
                    "success": data.get("success"),
                    "error": data.get("error"),
                    "tokens_in": tokens_in,
                    "tokens_out": tokens_out,
                    "cost": cost,
                    "session_id": data.get("session_id")
                })
        
        return calls[:limit]
    
    def get_breaks_list(self, hours: int = 168, limit: int = 50) -> List[Dict]:
        """Get list of breaking responses (score 0)."""
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        
        breaks = []
        for event in events:
            if event.get("type") == "hunt_result":
                data = event.get("data", {})
                if data.get("is_breaking"):
                    breaks.append({
                        "timestamp": event.get("ts"),
                        "session_id": data.get("session_id"),
                        "hunt_id": data.get("hunt_id"),
                        "model": data.get("model"),
                        "score": data.get("score"),
                        "response_preview": data.get("response_preview"),
                        "reasoning_preview": data.get("reasoning_preview"),
                        "criteria": data.get("criteria")
                    })
        
        return breaks[:limit]
    
    def get_failures_list(self, hours: int = 168, limit: int = 50) -> List[Dict]:
        """Get list of failed API calls and hunt errors."""
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        
        failures = []
        for event in events:
            event_type = event.get("type")
            data = event.get("data", {})
            
            # API call failures
            if event_type == "api_call_end" and not data.get("success"):
                failures.append({
                    "timestamp": event.get("ts"),
                    "type": "api_call",
                    "provider": data.get("provider"),
                    "model": data.get("model"),
                    "error": data.get("error"),
                    "session_id": data.get("session_id")
                })
            
            # Hunt errors
            elif event_type == "hunt_result" and data.get("error"):
                failures.append({
                    "timestamp": event.get("ts"),
                    "type": "hunt",
                    "model": data.get("model"),
                    "error": data.get("error"),
                    "session_id": data.get("session_id"),
                    "hunt_id": data.get("hunt_id")
                })
        
        return failures[:limit]
    
    def get_session_list(self, limit: int = 20) -> List[Dict]:
        """
        Get list of recent sessions with their stats.
        
        Args:
            limit: Maximum number of sessions
            
        Returns:
            List of session dicts
        """
        events = self._read_events()
        
        sessions = {}
        
        for event in events:
            event_type = event.get("type", "")
            data = event.get("data", {})
            session_id = data.get("session_id")
            
            if not session_id:
                continue
            
            if session_id not in sessions:
                sessions[session_id] = {
                    "session_id": session_id,
                    "created_at": None,
                    "notebook": None,
                    "source": None,
                    "hunts": 0,
                    "breaks_found": 0,
                    "api_calls": 0,
                    "last_activity": None
                }
            
            session = sessions[session_id]
            ts = event.get("ts")
            
            if event_type == "session_created":
                session["created_at"] = ts
                session["notebook"] = data.get("notebook")
                session["source"] = data.get("source")
            
            elif event_type == "hunt_start":
                session["hunts"] += 1
            
            elif event_type == "hunt_complete":
                session["breaks_found"] += data.get("breaks_found", 0)
            
            elif event_type == "api_call_start":
                session["api_calls"] += 1
            
            # Update last activity
            if ts:
                if session["last_activity"] is None or ts > session["last_activity"]:
                    session["last_activity"] = ts
        
        # Sort by created_at (most recent first)
        sorted_sessions = sorted(
            sessions.values(),
            key=lambda x: x.get("created_at") or "",
            reverse=True
        )
        
        return sorted_sessions[:limit]


# Singleton instance
_log_reader: Optional[LogReader] = None


def get_log_reader(log_path: Optional[str] = None) -> LogReader:
    """Get or create the log reader singleton."""
    global _log_reader
    if _log_reader is None or log_path:
        _log_reader = LogReader(log_path)
    return _log_reader
