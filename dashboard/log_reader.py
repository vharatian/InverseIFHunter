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
from typing import Dict, List, Any, Optional, Set
from pathlib import Path
from collections import defaultdict
import threading


_PASS_TOKENS = {"pass", "passed", "true", "1", "yes", "ok", "success"}
_FAIL_TOKENS = {"fail", "failed", "false", "0", "no", "error"}


def _normalize_verdict(value: Any) -> Optional[str]:
    """Normalize a criteria verdict to 'PASS', 'FAIL', or None (unknown)."""
    if value is None:
        return None
    if isinstance(value, bool):
        return "PASS" if value else "FAIL"
    if isinstance(value, (int, float)):
        if value in (0, 1):
            return "PASS" if value == 1 else "FAIL"
        return None
    if isinstance(value, dict):
        for k in ("verdict", "result", "status", "value"):
            if k in value:
                return _normalize_verdict(value[k])
        return None
    s = str(value).strip().lower()
    if not s:
        return None
    if s in _PASS_TOKENS:
        return "PASS"
    if s in _FAIL_TOKENS:
        return "FAIL"
    return None


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
        # session_id -> {trainer_email, colab_url} (disk preferred; telemetry fills gaps)
        self._session_context_cache: Dict[str, Dict[str, str]] = {}
        self._session_context_cache_time: Optional[datetime] = None
    
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

    @staticmethod
    def _pick_colab_url(data: Dict[str, Any]) -> str:
        for k in ("colab_url", "url"):
            v = (data.get(k) or "").strip()
            if v:
                return v
        return ""

    def _merge_session_created_from_events(
        self,
        events: List[Dict],
        base_ctx: Optional[Dict[str, Dict[str, str]]] = None,
    ) -> Dict[str, Dict[str, str]]:
        """
        Merge session_created rows from an event list into context.
        Events are newest-first; first session_created per session_id wins (newest).
        """
        out: Dict[str, Dict[str, str]] = {k: dict(v) for k, v in (base_ctx or {}).items()}
        seen_sid: Set[str] = set()
        for event in events:
            if event.get("type") != "session_created":
                continue
            d = event.get("data") or {}
            sid = d.get("session_id")
            if not sid or sid in seen_sid:
                continue
            seen_sid.add(sid)
            te = (d.get("trainer_email") or "").strip().lower()
            cu = self._pick_colab_url(d)
            cur = out.setdefault(sid, {"trainer_email": "", "colab_url": ""})
            if te:
                cur["trainer_email"] = te
            if cu:
                cur["colab_url"] = cu
        return out

    def _resolve_trainer_key(
        self,
        session_id: str,
        disk_mapping: Dict[str, str],
        ctx: Dict[str, Dict[str, str]],
        event_data: Optional[Dict[str, Any]] = None,
    ) -> Optional[str]:
        """Stable trainer key: disk trainer_id, else telemetry email, else URL/file legacy, else session-scoped id."""
        disk_val = disk_mapping.get(session_id)
        if disk_val and str(disk_val).strip() and str(disk_val).lower() != "unknown":
            return str(disk_val).strip()
        row = ctx.get(session_id) or {}
        d = event_data or {}
        email = (row.get("trainer_email") or d.get("trainer_email") or "").strip().lower()
        if email:
            return email
        url = (row.get("colab_url") or self._pick_colab_url(d) or "").strip()
        fn = d.get("notebook") or d.get("filename") or "notebook.ipynb"
        if url:
            return self._extract_trainer_id_legacy(url, str(fn))
        if session_id:
            return f"session_{session_id[:12]}"
        return None

    def _overview_note_trainer_for_session(
        self,
        active_trainers: Set[str],
        session_id: Optional[str],
        data: Dict[str, Any],
        ctx: Dict[str, Dict[str, str]],
        trainer_mapping: Dict[str, str],
        allowed: Optional[Set[str]],
    ) -> None:
        """Unique-trainer tally: same keys as leaderboard (session_created + hunt activity)."""
        if not session_id:
            return
        if allowed is not None:
            te = (
                (ctx.get(session_id) or {}).get("trainer_email")
                or (data.get("trainer_email") or "")
            ).strip().lower()
            if te and te in allowed:
                active_trainers.add(te)
        else:
            tid = self._resolve_trainer_key(session_id, trainer_mapping, ctx, data)
            if tid:
                active_trainers.add(tid)

    def _load_session_context(self) -> Dict[str, Dict[str, str]]:
        """session_id -> {trainer_email, colab_url}. Disk wins for conflicts; telemetry fills missing."""
        now = datetime.utcnow()
        if (
            self._session_context_cache_time
            and (now - self._session_context_cache_time).total_seconds() < 60
        ):
            return self._session_context_cache

        ctx: Dict[str, Dict[str, str]] = {}

        if self.storage_path.exists():
            for session_file in self.storage_path.glob("*.json"):
                sid = session_file.stem
                try:
                    with open(session_file, "r") as f:
                        data = json.load(f)
                    email = (data.get("trainer_email") or "").strip().lower()
                    colab = self._pick_colab_url(data)
                    ctx[sid] = {"trainer_email": email, "colab_url": colab}
                except Exception:
                    continue

        if self.log_path.exists():
            try:
                with open(self.log_path, "r") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            event = json.loads(line)
                            if event.get("type") != "session_created":
                                continue
                            d = event.get("data") or {}
                            sid = d.get("session_id")
                            if not sid:
                                continue
                            cur = ctx.setdefault(sid, {"trainer_email": "", "colab_url": ""})
                            te = (d.get("trainer_email") or "").strip().lower()
                            if te and not cur["trainer_email"]:
                                cur["trainer_email"] = te
                            cu = self._pick_colab_url(d)
                            if cu and not cur["colab_url"]:
                                cur["colab_url"] = cu
                        except (json.JSONDecodeError, ValueError):
                            continue
            except Exception:
                pass

        self._session_context_cache = ctx
        self._session_context_cache_time = now
        return ctx

    @staticmethod
    def _normalize_trainer_emails_filter(trainer_emails: Optional[List[str]]) -> Optional[Set[str]]:
        if not trainer_emails:
            return None
        s = {e.strip().lower() for e in trainer_emails if e and str(e).strip()}
        return s if s else None

    def _event_matches_trainer_filter(
        self, event: Dict[str, Any], ctx: Dict[str, Dict[str, str]], allowed: Optional[Set[str]]
    ) -> bool:
        if allowed is None:
            return True
        sid = (event.get("data") or {}).get("session_id")
        email = (event.get("trainer_email") or "").strip().lower()
        if not email and sid:
            email = (ctx.get(sid) or {}).get("trainer_email") or ""
        if not email:
            email = ((event.get("data") or {}).get("trainer_email") or "").strip().lower()
        # When a filter is active, exclude events that cannot be attributed
        # to a trainer. Previously events without session_id bypassed the filter.
        return bool(email) and email in allowed

    def _filter_events_by_trainer_emails(
        self, events: List[Dict[str, Any]], trainer_emails: Optional[List[str]]
    ) -> List[Dict[str, Any]]:
        allowed = self._normalize_trainer_emails_filter(trainer_emails)
        if allowed is None:
            return events
        ctx = self._load_session_context()
        ctx = self._merge_session_created_from_events(events, ctx)
        return [e for e in events if self._event_matches_trainer_filter(e, ctx, allowed)]

    def _enrich_row_session_fields(
        self,
        session_id: str,
        row: Dict[str, Any],
        ctx: Dict[str, Dict[str, str]],
    ) -> None:
        sc = ctx.get(session_id) or {}
        row["trainer_email"] = sc.get("trainer_email") or ""
        cu = sc.get("colab_url") or ""
        if cu:
            row["colab_url"] = cu
    
    def _test_account_emails(self) -> Set[str]:
        """Cached set of test-account emails loaded from the admin registry."""
        now = datetime.utcnow()
        cached_at = getattr(self, "_test_cache_at", None)
        if cached_at and (now - cached_at).total_seconds() < 60:
            return getattr(self, "_test_cache_set", set())
        try:
            from auth import get_test_accounts  # lazy to avoid import cycles
            emails = {e.strip().lower() for e in get_test_accounts() if e}
        except Exception:
            emails = set()
        self._test_cache_set = emails
        self._test_cache_at = now
        return emails

    def _drop_test_accounts(
        self,
        events: List[Dict[str, Any]],
        ctx: Optional[Dict[str, Dict[str, str]]] = None,
    ) -> List[Dict[str, Any]]:
        """Remove events whose trainer email is marked as a test account."""
        test_emails = self._test_account_emails()
        if not test_emails:
            return events
        ctx = ctx if ctx is not None else self._load_session_context()
        out: List[Dict[str, Any]] = []
        for event in events:
            data = event.get("data") or {}
            email = (event.get("trainer_email") or "").strip().lower()
            if not email:
                sid = data.get("session_id")
                if sid:
                    email = (ctx.get(sid) or {}).get("trainer_email", "").strip().lower()
            if not email:
                email = (data.get("trainer_email") or "").strip().lower()
            if email and email in test_emails:
                continue
            out.append(event)
        return out

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

            # Exclude events authored by test accounts from all analytics by default.
            events = self._drop_test_accounts(events)

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
    
    def get_overview(
        self, hours: int = 24, trainer_emails: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """Get overview statistics."""
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        allowed = self._normalize_trainer_emails_filter(trainer_emails)
        ctx = self._load_session_context()
        ctx = self._merge_session_created_from_events(events, ctx)
        if allowed is not None:
            events = [e for e in events if self._event_matches_trainer_filter(e, ctx, allowed)]

        stats = {
            "active_sessions": 0,
            "total_sessions": 0,
            # Backward-compatible field: now counts completed hunts to match the
            # trainer leaderboard. `total_hunts_started` exposes hunt_start count.
            "total_hunts": 0,
            "total_hunts_started": 0,
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
                self._overview_note_trainer_for_session(
                    active_trainers, session_id, data, ctx, trainer_mapping, allowed
                )
            
            elif event_type == "hunt_start":
                stats["total_hunts_started"] = stats.get("total_hunts_started", 0) + 1
                if session_id:
                    sessions_with_running[session_id] = sessions_with_running.get(session_id, 0) + 1

            elif event_type == "hunt_complete":
                breaks = data.get("breaks_found", 0)
                completed = data.get("completed_hunts", 0)
                stats["total_hunts"] += 1  # Completed-hunt count (matches leaderboard)
                stats["breaks_found"] += breaks
                if completed > 0:
                    break_rates.append(breaks / completed)
                
                if session_id and session_id in sessions_with_running:
                    sessions_with_running[session_id] -= 1
                    if sessions_with_running[session_id] <= 0:
                        del sessions_with_running[session_id]

                self._overview_note_trainer_for_session(
                    active_trainers, session_id, data, ctx, trainer_mapping, allowed
                )
            
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
    
    def get_recent_events(
        self,
        limit: int = 50,
        event_type: Optional[str] = None,
        trainer_emails: Optional[List[str]] = None,
    ) -> List[Dict]:
        """Get recent events with optional trainer_email/colab_url enrichment and trainer filter."""
        read_cap = limit * 2 if event_type else limit
        if trainer_emails and self._normalize_trainer_emails_filter(trainer_emails):
            read_cap = max(read_cap, limit * 200, 5000)
        read_cap = min(read_cap, 50000)

        raw_events = self._read_events(limit=read_cap)
        if event_type:
            events = [e for e in raw_events if e.get("type") == event_type]
        else:
            # Heartbeats are chatty (every 60s per trainer) — drop from the
            # default live feed. They still power realtime active-trainer
            # counting via `get_realtime_stats`.
            events = [e for e in raw_events if e.get("type") != "trainer_heartbeat"]

        ctx = self._load_session_context()
        ctx = self._merge_session_created_from_events(raw_events, ctx)
        allowed = self._normalize_trainer_emails_filter(trainer_emails)

        out: List[Dict] = []
        for event in events:
            ev = dict(event)
            ev.pop("_ts", None)
            sid = (ev.get("data") or {}).get("session_id")
            if sid:
                sc = ctx.get(sid) or {}
                data = ev.get("data") or {}
                te = sc.get("trainer_email") or (data.get("trainer_email") or "").strip().lower()
                if te:
                    ev["trainer_email"] = te
                cu = sc.get("colab_url") or self._pick_colab_url(data)
                if cu:
                    ev["colab_url"] = cu
            if allowed is not None and not self._event_matches_trainer_filter(ev, ctx, allowed):
                continue
            out.append(ev)
            if len(out) >= limit:
                break

        return out
    
    def get_timeline(
        self,
        hours: int = 24,
        bucket_minutes: int = 60,
        trainer_emails: Optional[List[str]] = None,
    ) -> Dict[str, List]:
        """Get event counts over time."""
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        events = self._filter_events_by_trainer_emails(events, trainer_emails)

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
            "total_calls": 0,
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
                summary["total_calls"] += 1

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
    
    def get_detailed_hunts(
        self,
        hours: int = 24,
        limit: int = 50,
        trainer_emails: Optional[List[str]] = None,
    ) -> List[Dict]:
        """Get detailed hunt results."""
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        trainer_mapping = self._load_trainer_mapping()
        ctx = self._load_session_context()
        ctx = self._merge_session_created_from_events(events, ctx)
        allowed = self._normalize_trainer_emails_filter(trainer_emails)

        hunts = []
        for event in events:
            if event.get("type") != "hunt_result":
                continue
            data = event.get("data", {})
            session_id = data.get("session_id", "")
            if allowed is not None and not self._event_matches_trainer_filter(
                {"data": data, "trainer_email": (ctx.get(session_id) or {}).get("trainer_email", "")},
                ctx,
                allowed,
            ):
                continue
            row = {
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
                "judge_explanation": data.get("judge_explanation"),
            }
            self._enrich_row_session_fields(session_id, row, ctx)
            hunts.append(row)
            if len(hunts) >= limit:
                break

        return hunts
    
    def get_breaks_list(
        self,
        hours: int = 168,
        limit: int = 50,
        trainer_emails: Optional[List[str]] = None,
    ) -> List[Dict]:
        """Get list of breaking responses."""
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        trainer_mapping = self._load_trainer_mapping()
        ctx = self._load_session_context()
        ctx = self._merge_session_created_from_events(events, ctx)
        allowed = self._normalize_trainer_emails_filter(trainer_emails)

        breaks = []
        for event in events:
            if event.get("type") != "hunt_result":
                continue
            data = event.get("data", {})
            if not data.get("is_breaking"):
                continue
            session_id = data.get("session_id", "")
            if allowed is not None and not self._event_matches_trainer_filter(
                {"data": data, "trainer_email": (ctx.get(session_id) or {}).get("trainer_email", "")},
                ctx,
                allowed,
            ):
                continue
            row = {
                "timestamp": event.get("ts"),
                "session_id": session_id,
                "trainer_id": trainer_mapping.get(session_id, "unknown"),
                "hunt_id": data.get("hunt_id"),
                "model": data.get("model"),
                "score": data.get("score"),
                "response_preview": data.get("response_preview"),
                "reasoning_preview": data.get("reasoning_preview"),
                "criteria": data.get("criteria"),
                "judge_explanation": data.get("judge_explanation"),
            }
            self._enrich_row_session_fields(session_id, row, ctx)
            breaks.append(row)
            if len(breaks) >= limit:
                break

        return breaks
    
    def get_failures_list(
        self,
        hours: int = 168,
        limit: int = 50,
        trainer_emails: Optional[List[str]] = None,
    ) -> List[Dict]:
        """Get list of failures."""
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        ctx = self._load_session_context()
        ctx = self._merge_session_created_from_events(events, ctx)
        allowed = self._normalize_trainer_emails_filter(trainer_emails)

        failures = []
        for event in events:
            event_type = event.get("type")
            data = event.get("data", {})

            if event_type == "api_call_end" and not data.get("success"):
                session_id = data.get("session_id") or ""
                if allowed is not None and not self._event_matches_trainer_filter(
                    {"data": data, "trainer_email": (ctx.get(session_id) or {}).get("trainer_email", "")},
                    ctx,
                    allowed,
                ):
                    continue
                row = {
                    "timestamp": event.get("ts"),
                    "type": "api_call",
                    "provider": data.get("provider"),
                    "model": data.get("model"),
                    "error": data.get("error"),
                    "session_id": session_id or None,
                }
                if session_id:
                    self._enrich_row_session_fields(session_id, row, ctx)
                failures.append(row)

            elif event_type == "hunt_result" and data.get("error"):
                session_id = data.get("session_id", "")
                if allowed is not None and not self._event_matches_trainer_filter(
                    {"data": data, "trainer_email": (ctx.get(session_id) or {}).get("trainer_email", "")},
                    ctx,
                    allowed,
                ):
                    continue
                row = {
                    "timestamp": event.get("ts"),
                    "type": "hunt",
                    "model": data.get("model"),
                    "error": data.get("error"),
                    "session_id": session_id,
                    "hunt_id": data.get("hunt_id"),
                }
                self._enrich_row_session_fields(session_id, row, ctx)
                failures.append(row)

            if len(failures) >= limit:
                break

        return failures
    
    def get_detailed_api_calls(
        self,
        hours: int = 24,
        limit: int = 100,
        trainer_emails: Optional[List[str]] = None,
    ) -> List[Dict]:
        """Get detailed API calls."""
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        ctx = self._load_session_context()
        ctx = self._merge_session_created_from_events(events, ctx)
        allowed = self._normalize_trainer_emails_filter(trainer_emails)

        calls = []
        for event in events:
            if event.get("type") != "api_call_end":
                continue
            data = event.get("data", {})
            session_id = data.get("session_id") or ""
            if allowed is not None and not self._event_matches_trainer_filter(
                {"data": data, "trainer_email": (ctx.get(session_id) or {}).get("trainer_email", "")},
                ctx,
                allowed,
            ):
                continue
            model = data.get("model", "unknown")
            tokens_in = data.get("tokens_in") or 0
            tokens_out = data.get("tokens_out") or 0
            cost = self._calculate_cost(model, tokens_in, tokens_out) if (tokens_in or tokens_out) else 0

            row = {
                "timestamp": event.get("ts"),
                "provider": data.get("provider"),
                "model": model,
                "latency_ms": data.get("latency_ms"),
                "success": data.get("success"),
                "error": data.get("error"),
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "cost": cost,
                "session_id": data.get("session_id"),
            }
            if session_id:
                self._enrich_row_session_fields(session_id, row, ctx)
            calls.append(row)
            if len(calls) >= limit:
                break

        return calls
    
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
        ctx = self._load_session_context()
        ctx = self._merge_session_created_from_events(events, ctx)
        
        trainer_stats = defaultdict(lambda: {
            # Distinct sessions with activity in-window (session_created may be older than `hours`)
            "session_ids": set(),
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
            
            if not session_id:
                continue
            trainer_id = self._resolve_trainer_key(
                session_id, trainer_mapping, ctx, data
            )
            if not trainer_id:
                continue
            stats = trainer_stats[trainer_id]
            
            # Update timestamps
            if ts:
                if not stats["first_seen"] or ts < stats["first_seen"]:
                    stats["first_seen"] = ts
                if not stats["last_seen"] or ts > stats["last_seen"]:
                    stats["last_seen"] = ts
            
            if event_type == "session_created":
                stats["session_ids"].add(session_id)
            elif event_type == "hunt_complete":
                stats["session_ids"].add(session_id)
                stats["hunts"] += data.get("completed_hunts", 0)
                stats["breaks"] += data.get("breaks_found", 0)
        
        # Build leaderboard
        leaderboard = []
        for trainer_id, stats in trainer_stats.items():
            if stats["hunts"] == 0:
                continue
            
            # Each hunt = 1 model call + 1 judge call = 2 API calls
            estimated_api_calls = stats["hunts"] * 2
            n_sessions = len(stats["session_ids"])
            
            leaderboard.append({
                "trainer_id": trainer_id,
                "total_sessions": n_sessions,
                "total_hunts": stats["hunts"],
                "total_breaks": stats["breaks"],
                "break_rate": stats["breaks"] / stats["hunts"] if stats["hunts"] else 0,
                "api_calls": estimated_api_calls,
                "efficiency": stats["breaks"] / n_sessions if n_sessions else 0,
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
                    verdict = _normalize_verdict(result)
                    if verdict is None:
                        continue
                    stats = criteria_stats[crit_id]
                    stats["total"] += 1
                    if verdict == "PASS":
                        stats["passes"] += 1
                    elif verdict == "FAIL":
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
    
    def get_weekday_hunt_activity(
        self, hours: int = 168, trainer_emails: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """Hunt results per weekday (clearer than hour×day heatmap for sparse data)."""
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        events = self._filter_events_by_trainer_emails(events, trainer_emails)
        counts = [0] * 7
        for event in events:
            if event.get("type") != "hunt_result":
                continue
            ts = event.get("_ts")
            if ts:
                counts[ts.weekday()] += 1
        return {
            "time_window_hours": hours,
            "days": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
            "hunt_results": counts,
        }
    
    def get_activity_heatmap(
        self, hours: int = 168, trainer_emails: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """Hunt-result counts bucketed by (weekday, hour_of_day) — a 7×24 grid.
        Much more informative than a weekday-only bar when the window is >= a few days.
        """
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        events = self._filter_events_by_trainer_emails(events, trainer_emails)
        # grid[day_idx][hour] — Mon=0 .. Sun=6
        grid = [[0] * 24 for _ in range(7)]
        total = 0
        for event in events:
            if event.get("type") != "hunt_result":
                continue
            ts = event.get("_ts")
            if not ts:
                continue
            grid[ts.weekday()][ts.hour] += 1
            total += 1
        return {
            "time_window_hours": hours,
            "days": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
            "hours": list(range(24)),
            "grid": grid,
            "total": total,
        }

    def get_latency_distribution(
        self, hours: int = 24, trainer_emails: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """API-call latency as an Empirical CDF (scale-free).

        Returns percentile pills (p50/p90/p95/p99), mean/min/max, and an
        ECDF curve (xs_ms, ys) — the fraction of calls completing at or under
        each latency. ECDF is scale-free (works equally well whether calls
        take 500ms or 30s) and has no binning artifacts, unlike a histogram.
        Large sample sizes are downsampled to ~200 points for plot efficiency.
        """
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        events = self._filter_events_by_trainer_emails(events, trainer_emails)
        latencies: List[float] = []
        for event in events:
            if event.get("type") != "api_call_end":
                continue
            v = (event.get("data") or {}).get("latency_ms")
            try:
                f = float(v)
            except (TypeError, ValueError):
                continue
            if f >= 0:
                latencies.append(f)

        def _pct(xs_sorted: List[float], q: float) -> float:
            if not xs_sorted:
                return 0.0
            k = (len(xs_sorted) - 1) * q
            f_i = int(k)
            c = min(f_i + 1, len(xs_sorted) - 1)
            return xs_sorted[f_i] + (xs_sorted[c] - xs_sorted[f_i]) * (k - f_i)

        sorted_lat = sorted(latencies)
        n = len(sorted_lat)
        mean = (sum(sorted_lat) / n) if n else 0.0

        # ECDF points: (value, rank/n) for each sample. Downsample to ~200
        # evenly-spaced indices for plot efficiency, always including endpoints.
        xs_ms: List[float] = []
        ys: List[float] = []
        if n:
            target = min(n, 200)
            if n <= target:
                idxs = list(range(n))
            else:
                step = (n - 1) / (target - 1)
                idxs = sorted({int(round(i * step)) for i in range(target)})
                if idxs[-1] != n - 1:
                    idxs.append(n - 1)
            for i in idxs:
                xs_ms.append(sorted_lat[i])
                ys.append((i + 1) / n)
        return {
            "time_window_hours": hours,
            "count": n,
            "mean_ms": mean,
            "p50_ms": _pct(sorted_lat, 0.50),
            "p90_ms": _pct(sorted_lat, 0.90),
            "p95_ms": _pct(sorted_lat, 0.95),
            "p99_ms": _pct(sorted_lat, 0.99),
            "min_ms": sorted_lat[0] if sorted_lat else 0.0,
            "max_ms": sorted_lat[-1] if sorted_lat else 0.0,
            "ecdf_xs_ms": xs_ms,
            "ecdf_ys": ys,
        }

    def get_reviewer_stats(
        self, hours: int = 168, limit: int = 20
    ) -> Dict[str, Any]:
        """Reviewer-app telemetry aggregates: decisions, council runs, activity."""
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)

        decisions = defaultdict(int)  # decision -> count
        council = {
            "started": 0,
            "completed": 0,
            "passed": 0,
            "failed": 0,
            "errored": 0,
            "durations_ms": [],
        }
        council_votes = defaultdict(lambda: {"PASS": 0, "FAIL": 0, "unclear": 0})
        notebook_fetch = {"success": 0, "failed": 0}
        by_reviewer: Dict[str, Dict[str, Any]] = defaultdict(lambda: {
            "decisions": 0,
            "approved": 0,
            "returned": 0,
            "escalated": 0,
            "completed": 0,
            "council_runs": 0,
            "tasks_opened": 0,
            "tasks_claimed": 0,
            "last_seen": None,
        })
        active_reviewers: Set[str] = set()

        for event in events:
            etype = event.get("type", "")
            data = event.get("data") or {}
            reviewer = (data.get("reviewer_email") or "").strip().lower()
            if not reviewer:
                continue
            ts = event.get("ts")
            r = by_reviewer[reviewer]
            if ts and (not r["last_seen"] or ts > r["last_seen"]):
                r["last_seen"] = ts
            active_reviewers.add(reviewer)

            if etype == "reviewer_decision":
                d = (data.get("decision") or "").lower()
                decisions[d] += 1
                r["decisions"] += 1
                if d in ("approved", "returned", "escalated", "completed"):
                    r[d] += 1
            elif etype == "task_opened":
                r["tasks_opened"] += 1
            elif etype == "task_claimed":
                r["tasks_claimed"] += 1
            elif etype == "council_started":
                council["started"] += 1
                r["council_runs"] += 1
            elif etype == "council_completed":
                council["completed"] += 1
                if data.get("error"):
                    council["errored"] += 1
                elif data.get("passed"):
                    council["passed"] += 1
                else:
                    council["failed"] += 1
                try:
                    dur = float(data.get("duration_ms") or 0)
                    if dur > 0:
                        council["durations_ms"].append(dur)
                except (TypeError, ValueError):
                    pass
            elif etype == "council_model_responded":
                mid = str(data.get("model_id") or "unknown")
                vote = (data.get("vote") or "unclear")
                if vote not in ("PASS", "FAIL", "unclear"):
                    vote = "unclear"
                council_votes[mid][vote] += 1
            elif etype == "notebook_fetched":
                notebook_fetch["success"] += 1
            elif etype == "notebook_fetch_failed":
                notebook_fetch["failed"] += 1

        def _pct(xs: List[float], q: float) -> float:
            if not xs:
                return 0.0
            s = sorted(xs)
            k = (len(s) - 1) * q
            f_i = int(k)
            c = min(f_i + 1, len(s) - 1)
            return s[f_i] + (s[c] - s[f_i]) * (k - f_i)

        dur = council["durations_ms"]
        # Pass rate excludes errored runs (pass/(pass+fail)) — a run that
        # never finished shouldn't be counted as a FAIL for QC purposes.
        decided = council["passed"] + council["failed"]
        council_out = {
            "started": council["started"],
            "completed": council["completed"],
            "passed": council["passed"],
            "failed": council["failed"],
            "errored": council["errored"],
            "pass_rate": (council["passed"] / decided) if decided else 0.0,
            "duration_p50_ms": _pct(dur, 0.50),
            "duration_p95_ms": _pct(dur, 0.95),
            "duration_mean_ms": (sum(dur) / len(dur)) if dur else 0.0,
        }

        leaderboard = []
        for email, s in by_reviewer.items():
            total = s["decisions"]
            if total == 0 and s["council_runs"] == 0 and s["tasks_opened"] == 0:
                continue
            leaderboard.append({
                "reviewer_email": email,
                "decisions": total,
                "approved": s["approved"],
                "returned": s["returned"],
                "escalated": s["escalated"],
                "completed": s["completed"],
                "approval_rate": (s["approved"] / total) if total else 0.0,
                "council_runs": s["council_runs"],
                "tasks_opened": s["tasks_opened"],
                "tasks_claimed": s["tasks_claimed"],
                "last_seen": s["last_seen"],
            })
        leaderboard.sort(key=lambda x: (x["decisions"], x["council_runs"]), reverse=True)

        # Council model performance: vote distribution per model.
        council_models = []
        for mid, v in council_votes.items():
            total = v["PASS"] + v["FAIL"] + v["unclear"]
            council_models.append({
                "model_id": mid,
                "total": total,
                "pass": v["PASS"],
                "fail": v["FAIL"],
                "unclear": v["unclear"],
                "pass_rate": (v["PASS"] / total) if total else 0.0,
                "fail_rate": (v["FAIL"] / total) if total else 0.0,
            })
        council_models.sort(key=lambda x: x["total"], reverse=True)

        return {
            "time_window_hours": hours,
            "active_reviewers": len(active_reviewers),
            "decisions": dict(decisions),
            "decisions_total": sum(decisions.values()),
            "council": council_out,
            "council_models": council_models[:limit],
            "notebook_fetch": notebook_fetch,
            "leaderboard": leaderboard[:limit],
        }

    def get_trainer_workflow(
        self, hours: int = 168, trainer_emails: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """Trainer-app workflow funnel: registered → reviews submitted → tasks completed → results viewed."""
        since = datetime.utcnow() - timedelta(hours=hours)
        events = self._read_events(since=since)
        events = self._filter_events_by_trainer_emails(events, trainer_emails)

        registered_emails: Set[str] = set()
        human_reviews = 0
        tasks_completed = 0
        results_viewed = 0
        completed_methods = defaultdict(int)
        per_trainer: Dict[str, Dict[str, Any]] = defaultdict(lambda: {
            "human_reviews": 0,
            "tasks_completed": 0,
            "results_viewed": 0,
            "registered": False,
            "last_seen": None,
        })

        ctx = self._load_session_context()
        ctx = self._merge_session_created_from_events(events, ctx)

        for event in events:
            etype = event.get("type", "")
            data = event.get("data") or {}
            ts = event.get("ts")
            email = (data.get("trainer_email") or "").strip().lower()
            if not email:
                sid = data.get("session_id")
                if sid:
                    email = (ctx.get(sid) or {}).get("trainer_email", "").strip().lower()

            if etype == "trainer_registered":
                if email:
                    registered_emails.add(email)
                    per_trainer[email]["registered"] = True
                    if ts and (not per_trainer[email]["last_seen"] or ts > per_trainer[email]["last_seen"]):
                        per_trainer[email]["last_seen"] = ts
            elif etype == "human_review_submitted":
                human_reviews += 1
                if email:
                    per_trainer[email]["human_reviews"] += 1
                    if ts and (not per_trainer[email]["last_seen"] or ts > per_trainer[email]["last_seen"]):
                        per_trainer[email]["last_seen"] = ts
            elif etype == "task_completed":
                tasks_completed += 1
                completed_methods[str(data.get("save_method") or "unknown")] += 1
                if email:
                    per_trainer[email]["tasks_completed"] += 1
                    if ts and (not per_trainer[email]["last_seen"] or ts > per_trainer[email]["last_seen"]):
                        per_trainer[email]["last_seen"] = ts
            elif etype == "results_viewed":
                results_viewed += 1
                if email:
                    per_trainer[email]["results_viewed"] += 1
                    if ts and (not per_trainer[email]["last_seen"] or ts > per_trainer[email]["last_seen"]):
                        per_trainer[email]["last_seen"] = ts

        by_trainer = []
        for email, s in per_trainer.items():
            total = s["human_reviews"] + s["tasks_completed"] + s["results_viewed"]
            if total == 0 and not s["registered"]:
                continue
            by_trainer.append({
                "trainer_email": email,
                "registered": s["registered"],
                "human_reviews": s["human_reviews"],
                "tasks_completed": s["tasks_completed"],
                "results_viewed": s["results_viewed"],
                "last_seen": s["last_seen"],
            })
        by_trainer.sort(key=lambda x: x["tasks_completed"], reverse=True)

        return {
            "time_window_hours": hours,
            "trainers_registered": len(registered_emails),
            "human_reviews": human_reviews,
            "tasks_completed": tasks_completed,
            "results_viewed": results_viewed,
            "completed_methods": dict(completed_methods),
            "by_trainer": by_trainer,
        }

    def get_realtime_stats(self) -> Dict[str, Any]:
        """Real-time stats (last 5 minutes).

        `hunts_in_progress` is computed as hunt_start events whose `hunt_id`
        has no matching `hunt_complete` in the same window. Events arrive
        newest-first, so we derive completion per (session_id, hunt_id) key.
        """
        since = datetime.utcnow() - timedelta(minutes=5)
        events = self._read_events(since=since)
        trainer_mapping = self._load_trainer_mapping()
        ctx = self._load_session_context()
        ctx = self._merge_session_created_from_events(events, ctx)

        active_sessions = set()
        active_trainers = set()
        active_trainer_emails: Set[str] = set()
        started_keys: Set[tuple] = set()
        completed_keys: Set[tuple] = set()
        recent_breaks = 0

        def _hunt_key(sid: Optional[str], d: Dict[str, Any]) -> Optional[tuple]:
            if not sid:
                return None
            hunt_id = d.get("hunt_id") or d.get("run_id") or d.get("turn_id")
            if hunt_id is None:
                return None
            return (sid, str(hunt_id))

        for event in events:
            event_type = event.get("type", "")
            data = event.get("data", {}) or {}
            session_id = data.get("session_id")

            if session_id:
                active_sessions.add(session_id)
                tid = self._resolve_trainer_key(
                    session_id, trainer_mapping, ctx, data
                )
                if tid:
                    active_trainers.add(tid)
                email = (
                    (ctx.get(session_id) or {}).get("trainer_email")
                    or (data.get("trainer_email") or "")
                ).strip().lower()
                if email and "@" in email:
                    active_trainer_emails.add(email)

            if event_type == "hunt_start":
                key = _hunt_key(session_id, data)
                if key:
                    started_keys.add(key)
            elif event_type == "hunt_complete":
                key = _hunt_key(session_id, data)
                if key:
                    completed_keys.add(key)
                recent_breaks += int(data.get("breaks_found", 0) or 0)

        # Hunts started with no matching complete in this window are "in progress".
        # Falls back to delta when hunt_id missing across emitters.
        if started_keys or completed_keys:
            hunts_in_progress = len(started_keys - completed_keys)
        else:
            starts = sum(1 for e in events if e.get("type") == "hunt_start")
            completes = sum(1 for e in events if e.get("type") == "hunt_complete")
            hunts_in_progress = max(0, starts - completes)

        return {
            "active_sessions": len(active_sessions),
            "active_trainers": len(active_trainers),
            "active_trainer_emails": sorted(active_trainer_emails),
            "hunts_in_progress": hunts_in_progress,
            "recent_breaks": recent_breaks,
            "last_updated": datetime.utcnow().isoformat() + "Z",
        }


# Singleton instance
_log_reader: Optional[EnhancedLogReader] = None


def get_log_reader(log_path: Optional[str] = None) -> EnhancedLogReader:
    """Get or create the log reader singleton."""
    global _log_reader
    if _log_reader is None or log_path:
        _log_reader = EnhancedLogReader(log_path)
    return _log_reader
