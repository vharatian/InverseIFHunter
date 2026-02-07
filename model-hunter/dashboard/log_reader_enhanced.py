"""
Enhanced Log Reader for Model Hunter Dashboard

Adds trainer-centric analytics, criteria analysis, and advanced metrics.
Drop-in replacement for log_reader.py with backward compatibility.
"""
import json
import os
import re
import hashlib
from datetime import datetime, timedelta
from typing import Dict, List, Any, Optional
from pathlib import Path
from collections import defaultdict
import threading


class EnhancedLogReader:
    """
    Enhanced log reader with trainer analytics and ML-ready aggregations.
    """
    
    # Model pricing (per 1M tokens)
    MODEL_PRICING = {
        "nvidia/nemotron-3-nano-30b-a3b": {"input": 0.06, "output": 0.24},
        "qwen/qwen3-235b-a22b-thinking-2507": {"input": 0.11, "output": 0.60},
        "accounts/fireworks/models/qwen3-235b-a22b-thinking-2507": {"input": 0.22, "output": 0.88},
        "gpt-5": {"input": 1.25, "output": 10.00},
        "gpt-4o": {"input": 2.50, "output": 10.00},
        "default": {"input": 0.50, "output": 1.00}
    }
    
    def __init__(self, log_path: Optional[str] = None, storage_path: Optional[str] = None):
        """Initialize enhanced log reader."""
        if log_path:
            self.log_path = Path(log_path)
        else:
            env_path = os.environ.get("TELEMETRY_LOG_PATH")
            if env_path:
                self.log_path = Path(env_path)
            else:
                self.log_path = Path(__file__).parent.parent / ".telemetry" / "events.jsonl"
        
        if storage_path:
            self.storage_path = Path(storage_path)
        else:
            env_storage = os.environ.get("SESSION_STORAGE_PATH")
            if env_storage:
                self.storage_path = Path(env_storage)
            else:
                # In Docker, storage is at /app/.storage
                self.storage_path = Path("/app/.storage")
        
        self._cache: Dict[str, Any] = {}
        self._cache_time: Optional[datetime] = None
        self._cache_ttl = 10  # seconds
        self._lock = threading.Lock()
        
        # Trainer mapping cache
        self._trainer_cache: Dict[str, str] = {}
        self._trainer_cache_time: Optional[datetime] = None
    
    def _extract_trainer_id_legacy(self, url: str, filename: str) -> str:
        """Legacy: Extract trainer identifier from Colab URL (fallback)."""
        if url:
            match = re.search(r'/drive/([a-zA-Z0-9_-]+)', url)
            if match:
                return f"trainer_{match.group(1)[:8]}"
        return f"file_{hashlib.md5(filename.encode()).hexdigest()[:6]}"
    
    def _load_trainer_mapping(self) -> Dict[str, str]:
        """Load session_id -> trainer_id mapping from storage.
        
        Uses the new trainer_id field (fun character names like Gojo_42) 
        if available, falls back to legacy URL-based extraction.
        """
        # Check cache
        now = datetime.utcnow()
        if (self._trainer_cache_time and 
            (now - self._trainer_cache_time).total_seconds() < 60):
            return self._trainer_cache
        
        mapping = {}
        if self.storage_path.exists():
            for session_file in self.storage_path.glob("*.json"):
                try:
                    with open(session_file, "r") as f:
                        data = json.load(f)
                    
                    # Use new trainer_id if available (fun character names)
                    trainer_id = data.get("trainer_id")
                    if trainer_id and trainer_id != "unknown":
                        mapping[session_file.stem] = trainer_id
                    else:
                        # Fallback to legacy URL-based extraction
                        url = data.get("url", "")
                        filename = data.get("filename", "notebook.ipynb")
                        mapping[session_file.stem] = self._extract_trainer_id_legacy(url, filename)
                except:
                    continue
        
        self._trainer_cache = mapping
        self._trainer_cache_time = now
        return mapping
    
    def _read_events(self, since: Optional[datetime] = None, limit: Optional[int] = None) -> List[Dict]:
        """Read events from log file."""
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
                        ts_str = event.get("ts", "")
                        if ts_str:
                            ts = datetime.fromisoformat(ts_str.rstrip("Z"))
                            event["_ts"] = ts
                            if since and ts < since:
                                continue
                        events.append(event)
                    except (json.JSONDecodeError, ValueError):
                        continue
            
            events.sort(key=lambda x: x.get("_ts", datetime.min), reverse=True)
            
            if limit:
                events = events[:limit]
            
            return events
        except Exception as e:
            print(f"Error reading log file: {e}")
            return []
    
    def _get_model_pricing(self, model: str) -> Dict[str, float]:
        """Get pricing for a model."""
        for known_model, pricing in self.MODEL_PRICING.items():
            if known_model in model or model in known_model:
                return pricing
        return self.MODEL_PRICING["default"]
    
    def _calculate_cost(self, model: str, tokens_in: int, tokens_out: int) -> float:
        """Calculate cost for a single API call."""
        pricing = self._get_model_pricing(model)
        cost = (tokens_in * pricing["input"] / 1_000_000) + (tokens_out * pricing["output"] / 1_000_000)
        return round(cost, 6)
    
    # ============== Original Methods (Backward Compatible) ==============
    
    def get_overview(self, hours: int = 24) -> Dict[str, Any]:
        """Get overview statistics."""
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        
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
            "time_window_hours": hours,
            # New metrics
            "unique_trainers": 0,
            "criteria_evaluations": 0,
            "avg_break_rate": 0
        }
        
        trainer_mapping = self._load_trainer_mapping()
        active_trainers = set()
        sessions_with_running = {}
        break_rates = []
        
        events_chrono = list(reversed(events))
        
        for event in events_chrono:
            event_type = event.get("type", "")
            data = event.get("data", {})
            session_id = data.get("session_id")
            
            if event_type == "session_created":
                stats["total_sessions"] += 1
                if session_id and session_id in trainer_mapping:
                    active_trainers.add(trainer_mapping[session_id])
            
            elif event_type == "hunt_start":
                stats["total_hunts"] += 1
                if session_id:
                    sessions_with_running[session_id] = sessions_with_running.get(session_id, 0) + 1
            
            elif event_type == "hunt_complete":
                breaks = data.get("breaks_found", 0)
                completed = data.get("completed_hunts", 0)
                stats["breaks_found"] += breaks
                if completed > 0:
                    break_rates.append(breaks / completed)
                
                if session_id and session_id in sessions_with_running:
                    sessions_with_running[session_id] -= 1
                    if sessions_with_running[session_id] <= 0:
                        del sessions_with_running[session_id]
            
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
            
            elif event_type == "hunt_result":
                criteria = data.get("criteria", {})
                stats["criteria_evaluations"] += len(criteria)
        
        # Calculate aggregates
        if stats["latencies"]:
            stats["avg_latency_ms"] = int(sum(stats["latencies"]) / len(stats["latencies"]))
        
        stats["active_sessions"] = len(sessions_with_running)
        stats["unique_trainers"] = len(active_trainers)
        stats["avg_break_rate"] = sum(break_rates) / len(break_rates) if break_rates else 0
        
        # Cleanup
        stats["models_used"] = dict(stats["models_used"])
        stats["providers_used"] = dict(stats["providers_used"])
        stats["errors"] = stats["errors"][:10]
        del stats["latencies"]
        
        return stats
    
    def get_recent_events(self, limit: int = 50, event_type: Optional[str] = None) -> List[Dict]:
        """Get recent events."""
        events = self._read_events(limit=limit * 2 if event_type else limit)
        
        if event_type:
            events = [e for e in events if e.get("type") == event_type][:limit]
        
        for event in events:
            event.pop("_ts", None)
        
        return events[:limit]
    
    def get_timeline(self, hours: int = 24, bucket_minutes: int = 60) -> Dict[str, List]:
        """Get event counts over time."""
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        
        buckets = defaultdict(lambda: {
            "api_calls": 0, "hunts": 0, "sessions": 0, "errors": 0, "breaks": 0
        })
        
        for event in events:
            ts = event.get("_ts")
            if not ts:
                continue
            
            bucket_ts = ts.replace(
                minute=(ts.minute // bucket_minutes) * bucket_minutes,
                second=0, microsecond=0
            )
            bucket_key = bucket_ts.isoformat() + "Z"
            event_type = event.get("type", "")
            data = event.get("data", {})
            
            if event_type == "api_call_start":
                buckets[bucket_key]["api_calls"] += 1
            elif event_type == "hunt_start":
                buckets[bucket_key]["hunts"] += 1
            elif event_type == "session_created":
                buckets[bucket_key]["sessions"] += 1
            elif event_type == "api_call_end" and not data.get("success"):
                buckets[bucket_key]["errors"] += 1
            elif event_type == "hunt_result" and data.get("is_breaking"):
                buckets[bucket_key]["breaks"] += 1
        
        sorted_keys = sorted(buckets.keys())
        
        return {
            "timestamps": sorted_keys,
            "api_calls": [buckets[k]["api_calls"] for k in sorted_keys],
            "hunts": [buckets[k]["hunts"] for k in sorted_keys],
            "sessions": [buckets[k]["sessions"] for k in sorted_keys],
            "errors": [buckets[k]["errors"] for k in sorted_keys],
            "breaks": [buckets[k]["breaks"] for k in sorted_keys]
        }
    
    def get_model_stats(self, hours: int = 24) -> Dict[str, Any]:
        """Get model usage statistics."""
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        
        models = defaultdict(lambda: {
            "calls": 0, "successes": 0, "failures": 0, 
            "total_latency": 0, "hunts": 0, "breaks": 0
        })
        
        for event in events:
            event_type = event.get("type", "")
            data = event.get("data", {})
            model = data.get("model", "unknown")
            
            if event_type == "api_call_end":
                models[model]["calls"] += 1
                if data.get("success"):
                    models[model]["successes"] += 1
                else:
                    models[model]["failures"] += 1
                models[model]["total_latency"] += data.get("latency_ms", 0)
            
            elif event_type == "hunt_result":
                models[model]["hunts"] += 1
                if data.get("is_breaking"):
                    models[model]["breaks"] += 1
        
        result = {}
        for model, stats in models.items():
            result[model] = {
                "calls": stats["calls"],
                "success_rate": stats["successes"] / stats["calls"] if stats["calls"] else 0,
                "avg_latency_ms": stats["total_latency"] / stats["calls"] if stats["calls"] else 0,
                "failures": stats["failures"],
                "hunts": stats["hunts"],
                "breaks": stats["breaks"],
                "break_rate": stats["breaks"] / stats["hunts"] if stats["hunts"] else 0
            }
        
        return {"models": result, "time_window_hours": hours}
    
    def get_cost_summary(self, hours: int = 24) -> Dict[str, Any]:
        """Get cost summary."""
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
        
        summary["total_cost"] = round(summary["total_cost"], 4)
        summary["by_model"] = {k: {**v, "cost": round(v["cost"], 4)} for k, v in summary["by_model"].items()}
        summary["by_provider"] = {k: {**v, "cost": round(v["cost"], 4)} for k, v in summary["by_provider"].items()}
        
        return summary
    
    def get_session_list(self, limit: int = 20) -> List[Dict]:
        """Get list of recent sessions."""
        events = self._read_events()
        trainer_mapping = self._load_trainer_mapping()
        
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
                    "trainer_id": trainer_mapping.get(session_id, "unknown"),
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
            
            if ts:
                if session["last_activity"] is None or ts > session["last_activity"]:
                    session["last_activity"] = ts
        
        sorted_sessions = sorted(
            sessions.values(),
            key=lambda x: x.get("created_at") or "",
            reverse=True
        )
        
        return sorted_sessions[:limit]
    
    def get_detailed_hunts(self, hours: int = 24, limit: int = 50) -> List[Dict]:
        """Get detailed hunt results."""
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        trainer_mapping = self._load_trainer_mapping()
        
        hunts = []
        for event in events:
            if event.get("type") == "hunt_result":
                data = event.get("data", {})
                session_id = data.get("session_id", "")
                hunts.append({
                    "timestamp": event.get("ts"),
                    "session_id": session_id,
                    "trainer_id": trainer_mapping.get(session_id, "unknown"),
                    "hunt_id": data.get("hunt_id"),
                    "model": data.get("model"),
                    "score": data.get("score"),
                    "is_breaking": data.get("is_breaking"),
                    "error": data.get("error"),
                    "response_preview": data.get("response_preview"),
                    "reasoning_preview": data.get("reasoning_preview"),
                    "criteria": data.get("criteria"),
                    "judge_explanation": data.get("judge_explanation")
                })
        
        return hunts[:limit]
    
    def get_breaks_list(self, hours: int = 168, limit: int = 50) -> List[Dict]:
        """Get list of breaking responses."""
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        trainer_mapping = self._load_trainer_mapping()
        
        breaks = []
        for event in events:
            if event.get("type") == "hunt_result":
                data = event.get("data", {})
                if data.get("is_breaking"):
                    session_id = data.get("session_id", "")
                    breaks.append({
                        "timestamp": event.get("ts"),
                        "session_id": session_id,
                        "trainer_id": trainer_mapping.get(session_id, "unknown"),
                        "hunt_id": data.get("hunt_id"),
                        "model": data.get("model"),
                        "score": data.get("score"),
                        "response_preview": data.get("response_preview"),
                        "reasoning_preview": data.get("reasoning_preview"),
                        "criteria": data.get("criteria"),
                        "judge_explanation": data.get("judge_explanation")
                    })
        
        return breaks[:limit]
    
    def get_failures_list(self, hours: int = 168, limit: int = 50) -> List[Dict]:
        """Get list of failures."""
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        
        failures = []
        for event in events:
            event_type = event.get("type")
            data = event.get("data", {})
            
            if event_type == "api_call_end" and not data.get("success"):
                failures.append({
                    "timestamp": event.get("ts"),
                    "type": "api_call",
                    "provider": data.get("provider"),
                    "model": data.get("model"),
                    "error": data.get("error"),
                    "session_id": data.get("session_id")
                })
            
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
    
    def get_detailed_api_calls(self, hours: int = 24, limit: int = 100) -> List[Dict]:
        """Get detailed API calls."""
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
    
    def search_events(self, query: str, hours: int = 168, limit: int = 100) -> List[Dict]:
        """Search across all events."""
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        query_lower = query.lower()
        
        results = []
        for event in events:
            event_str = json.dumps(event, default=str).lower()
            if query_lower in event_str:
                event_copy = dict(event)
                event_copy.pop("_ts", None)
                results.append(event_copy)
        
        return results[:limit]
    
    # ============== NEW: Trainer Analytics ==============
    
    def get_trainer_leaderboard(self, hours: int = 168, limit: int = 20) -> Dict[str, Any]:
        """
        Get trainer leaderboard with rankings.
        """
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        trainer_mapping = self._load_trainer_mapping()
        
        trainer_stats = defaultdict(lambda: {
            "sessions": 0,
            "hunts": 0,
            "breaks": 0,
            "api_calls": 0,
            "first_seen": None,
            "last_seen": None,
            "domains": set()
        })
        
        for event in events:
            event_type = event.get("type", "")
            data = event.get("data", {})
            session_id = data.get("session_id")
            ts = event.get("ts")
            
            if not session_id or session_id not in trainer_mapping:
                continue
            
            trainer_id = trainer_mapping[session_id]
            stats = trainer_stats[trainer_id]
            
            # Update timestamps
            if ts:
                if not stats["first_seen"] or ts < stats["first_seen"]:
                    stats["first_seen"] = ts
                if not stats["last_seen"] or ts > stats["last_seen"]:
                    stats["last_seen"] = ts
            
            if event_type == "session_created":
                stats["sessions"] += 1
            elif event_type == "hunt_complete":
                stats["hunts"] += data.get("completed_hunts", 0)
                stats["breaks"] += data.get("breaks_found", 0)
        
        # Build leaderboard
        leaderboard = []
        for trainer_id, stats in trainer_stats.items():
            if stats["hunts"] == 0:
                continue
            
            # Each hunt = 1 model call + 1 judge call = 2 API calls
            estimated_api_calls = stats["hunts"] * 2
            
            leaderboard.append({
                "trainer_id": trainer_id,
                "total_sessions": stats["sessions"],
                "total_hunts": stats["hunts"],
                "total_breaks": stats["breaks"],
                "break_rate": stats["breaks"] / stats["hunts"] if stats["hunts"] else 0,
                "api_calls": estimated_api_calls,
                "efficiency": stats["breaks"] / stats["sessions"] if stats["sessions"] else 0,
                "first_seen": stats["first_seen"],
                "last_seen": stats["last_seen"]
            })
        
        # Sort by breaks
        leaderboard.sort(key=lambda x: x["total_breaks"], reverse=True)
        
        # Add ranks
        for i, entry in enumerate(leaderboard):
            entry["rank"] = i + 1
        
        return {
            "count": len(leaderboard),
            "time_window_hours": hours,
            "leaderboard": leaderboard[:limit]
        }
    
    def get_criteria_analysis(self, hours: int = 168) -> Dict[str, Any]:
        """
        Get criteria difficulty analysis.
        """
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        
        criteria_stats = defaultdict(lambda: {
            "total": 0,
            "passes": 0,
            "fails": 0,
            "sessions": set()
        })
        
        for event in events:
            if event.get("type") == "hunt_result":
                data = event.get("data", {})
                criteria = data.get("criteria", {})
                session_id = data.get("session_id", "")
                
                for crit_id, result in criteria.items():
                    stats = criteria_stats[crit_id]
                    stats["total"] += 1
                    if result == "PASS":
                        stats["passes"] += 1
                    elif result == "FAIL":
                        stats["fails"] += 1
                    stats["sessions"].add(session_id)
        
        analysis = []
        for crit_id, stats in criteria_stats.items():
            if stats["total"] == 0:
                continue
            
            analysis.append({
                "criteria_id": crit_id,
                "total_evaluations": stats["total"],
                "pass_count": stats["passes"],
                "fail_count": stats["fails"],
                "pass_rate": stats["passes"] / stats["total"],
                "fail_rate": stats["fails"] / stats["total"],
                "difficulty_score": stats["fails"] / stats["total"],
                "sessions_count": len(stats["sessions"])
            })
        
        # Sort by difficulty
        analysis.sort(key=lambda x: x["difficulty_score"], reverse=True)
        
        return {
            "count": len(analysis),
            "time_window_hours": hours,
            "criteria": analysis
        }
    
    def get_activity_heatmap(self, hours: int = 168) -> Dict[str, Any]:
        """
        Get activity heatmap (hour x day of week).
        """
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        
        # Initialize heatmap (7 days x 24 hours)
        heatmap = [[0 for _ in range(24)] for _ in range(7)]
        
        for event in events:
            ts = event.get("_ts")
            if not ts:
                continue
            
            day = ts.weekday()  # 0=Monday
            hour = ts.hour
            heatmap[day][hour] += 1
        
        return {
            "time_window_hours": hours,
            "days": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
            "hours": list(range(24)),
            "data": heatmap
        }
    
    def get_realtime_stats(self) -> Dict[str, Any]:
        """
        Get real-time stats (last 5 minutes).
        """
        since = datetime.utcnow() - timedelta(minutes=5)
        events = self._read_events(since=since)
        trainer_mapping = self._load_trainer_mapping()
        
        active_sessions = set()
        active_trainers = set()
        hunts_in_progress = 0
        recent_breaks = 0
        
        for event in events:
            event_type = event.get("type", "")
            data = event.get("data", {})
            session_id = data.get("session_id")
            
            if session_id:
                active_sessions.add(session_id)
                if session_id in trainer_mapping:
                    active_trainers.add(trainer_mapping[session_id])
            
            if event_type == "hunt_start":
                hunts_in_progress += 1
            elif event_type == "hunt_complete":
                hunts_in_progress = max(0, hunts_in_progress - 1)
                recent_breaks += data.get("breaks_found", 0)
        
        return {
            "active_sessions": len(active_sessions),
            "active_trainers": len(active_trainers),
            "hunts_in_progress": hunts_in_progress,
            "recent_breaks": recent_breaks,
            "last_updated": datetime.utcnow().isoformat() + "Z"
        }


# Singleton instance
_log_reader: Optional[EnhancedLogReader] = None


def get_log_reader(log_path: Optional[str] = None) -> EnhancedLogReader:
    """Get or create the log reader singleton."""
    global _log_reader
    if _log_reader is None or log_path:
        _log_reader = EnhancedLogReader(log_path)
    return _log_reader
