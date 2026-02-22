"""
Analytics Engine for Admin Dashboard

Computes all analytics from telemetry events:
- Trainer timing (work session clustering, active time, calendar)
- Criteria co-failure analysis
- Judge consistency scoring
- Prompt clustering (TF-IDF + KMeans)
- Anomaly detection (z-scores)
"""
import re
import math
from datetime import datetime, timedelta
from typing import Dict, List, Any, Optional, Tuple
from collections import defaultdict

# Optional ML imports (graceful degradation)
try:
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.cluster import KMeans
    from sklearn.metrics import silhouette_score
    _sklearn_available = True
except ImportError:
    _sklearn_available = False


# ============== Trainer Timing ==============

WORK_SESSION_GAP_MINUTES = 30  # Gap > 30 min = new work session
ONLINE_THRESHOLD_SECONDS = 120  # Heartbeat < 2 min = online
IDLE_THRESHOLD_SECONDS = 600  # Heartbeat < 10 min = idle


def compute_trainer_timing(events: List[Dict], trainer_registry: Dict[str, Dict],
                           session_to_email: Dict[str, str]) -> Dict[str, Dict]:
    """
    Compute per-trainer timing analytics.
    Groups events by trainer_email, clusters into work sessions, computes metrics.
    
    Returns: {email: {name, status, active_hours, work_sessions, breaks_per_hour, 
                      calendar, peak_hours, insight, ...}}
    """
    # Group events by trainer email
    trainer_events: Dict[str, List[Dict]] = defaultdict(list)

    for event in events:
        data = event.get("data", {})
        email = data.get("trainer_email", "")
        if not email:
            sid = data.get("session_id")
            if sid:
                email = session_to_email.get(sid, "")
        if email:
            trainer_events[email].append(event)

    result = {}
    now = datetime.utcnow()

    for email, evts in trainer_events.items():
        reg = trainer_registry.get(email, {})
        name = reg.get("name", email.split("@")[0])

        # Sort by timestamp
        evts.sort(key=lambda e: e.get("_ts", datetime.min))
        timestamps = [e.get("_ts") for e in evts if e.get("_ts")]
        if not timestamps:
            continue

        # Cluster into work sessions (gap > 30 min = new session)
        work_sessions = []
        current_session_start = timestamps[0]
        current_session_end = timestamps[0]

        for ts in timestamps[1:]:
            gap = (ts - current_session_end).total_seconds()
            if gap > WORK_SESSION_GAP_MINUTES * 60:
                work_sessions.append({
                    "start": current_session_start.isoformat(),
                    "end": current_session_end.isoformat(),
                    "duration_minutes": (current_session_end - current_session_start).total_seconds() / 60
                })
                current_session_start = ts
            current_session_end = ts

        # Don't forget the last session
        work_sessions.append({
            "start": current_session_start.isoformat(),
            "end": current_session_end.isoformat(),
            "duration_minutes": (current_session_end - current_session_start).total_seconds() / 60
        })

        # Total active time
        total_minutes = sum(ws["duration_minutes"] for ws in work_sessions)
        # For single-event sessions, count at least 1 minute
        total_minutes = max(total_minutes, len(work_sessions))
        total_hours = total_minutes / 60

        # Count hunts and breaks
        total_hunts = 0
        total_breaks = 0
        for e in evts:
            if e.get("type") == "hunt_result":
                total_hunts += 1
                if e.get("data", {}).get("is_breaking"):
                    total_breaks += 1

        breaks_per_hour = round(total_breaks / max(total_hours, 0.01), 2)

        # Online status (based on most recent event)
        last_event_ts = timestamps[-1]
        seconds_since_last = (now - last_event_ts).total_seconds()
        if seconds_since_last < ONLINE_THRESHOLD_SECONDS:
            status = "online"
        elif seconds_since_last < IDLE_THRESHOLD_SECONDS:
            status = "idle"
        else:
            status = "offline"

        # Calendar data (daily activity for heatmap, last 90 days)
        calendar = _compute_calendar(timestamps, days=90)

        # Peak hours (histogram of activity by hour of day)
        peak_hours = [0] * 24
        for ts in timestamps:
            peak_hours[ts.hour] += 1

        # Auto-generated insight sentence
        insight = _generate_insight(name, total_hours, breaks_per_hour, total_hunts, total_breaks, peak_hours, evts)

        result[email] = {
            "name": name,
            "email": email,
            "status": status,
            "active_hours": round(total_hours, 1),
            "work_session_count": len(work_sessions),
            "total_hunts": total_hunts,
            "total_breaks": total_breaks,
            "breaks_per_hour": breaks_per_hour,
            "first_seen": timestamps[0].isoformat(),
            "last_seen": timestamps[-1].isoformat(),
            "calendar": calendar,
            "peak_hours": peak_hours,
            "insight": insight,
            "work_sessions": work_sessions[-20:]  # Last 20 sessions for drill-down
        }

    return result


def _compute_calendar(timestamps: List[datetime], days: int = 90) -> List[Dict]:
    """Compute daily activity counts for calendar heatmap."""
    cutoff = datetime.utcnow() - timedelta(days=days)
    daily = defaultdict(int)
    for ts in timestamps:
        if ts >= cutoff:
            day_key = ts.strftime("%Y-%m-%d")
            daily[day_key] += 1

    result = []
    current = cutoff
    while current <= datetime.utcnow():
        day_key = current.strftime("%Y-%m-%d")
        result.append({"date": day_key, "count": daily.get(day_key, 0)})
        current += timedelta(days=1)
    return result


def _generate_insight(name: str, hours: float, bph: float, hunts: int, breaks: int,
                      peak_hours: List[int], events: List[Dict]) -> str:
    """Generate a natural language insight sentence for a trainer."""
    parts = []

    # Peak time
    if sum(peak_hours) > 0:
        peak_hour = peak_hours.index(max(peak_hours))
        parts.append(f"Most active around {peak_hour:02d}:00")

    # Efficiency
    if hunts >= 5:
        if bph >= 2.0:
            parts.append(f"{bph} breaks/hr (above average)")
        elif bph >= 1.0:
            parts.append(f"{bph} breaks/hr (average)")
        else:
            parts.append(f"{bph} breaks/hr (below average)")

    # Model preference
    models = defaultdict(int)
    for e in events:
        if e.get("type") == "hunt_result":
            m = e.get("data", {}).get("model", "")
            if m:
                models[m] += 1
    if models:
        top_model = max(models, key=models.get)
        short_name = top_model.split("/")[-1][:20]
        parts.append(f"prefers {short_name}")

    if not parts:
        return f"{name} has limited activity data."

    return f"{name}: " + ". ".join(parts) + "."


# ============== Criteria Analytics ==============

def compute_criteria_analytics(events: List[Dict]) -> Dict[str, Any]:
    """
    Compute criteria difficulty, co-failure matrix, and categories.
    
    Returns: {
        "criteria_stats": [{id, total, pass, fail, pass_rate, difficulty, type, trend}],
        "co_failure_matrix": {crit_a: {crit_b: correlation}},
    }
    """
    # Collect per-hunt criteria verdicts
    criteria_results = defaultdict(lambda: {"pass": 0, "fail": 0, "total": 0})
    hunt_criteria_outcomes: List[Dict[str, bool]] = []  # For co-failure

    for event in events:
        if event.get("type") != "hunt_result":
            continue
        data = event.get("data", {})
        criteria = data.get("criteria")
        if not criteria or not isinstance(criteria, dict):
            continue

        hunt_outcome = {}
        for crit_id, verdict_str in criteria.items():
            verdict = str(verdict_str).strip().upper()
            is_pass = verdict in ("PASS", "1", "TRUE", "YES")
            criteria_results[crit_id]["total"] += 1
            if is_pass:
                criteria_results[crit_id]["pass"] += 1
            else:
                criteria_results[crit_id]["fail"] += 1
            hunt_outcome[crit_id] = is_pass

        if hunt_outcome:
            hunt_criteria_outcomes.append(hunt_outcome)

    # Build criteria stats
    criteria_stats = []
    for crit_id, stats in criteria_results.items():
        total = stats["total"]
        pass_rate = stats["pass"] / max(total, 1)
        fail_rate = 1 - pass_rate
        # Difficulty: higher = harder (more failures)
        difficulty = round(fail_rate * 100, 1)
        # Auto-categorize
        crit_type = _categorize_criteria(crit_id)

        criteria_stats.append({
            "id": crit_id,
            "total": total,
            "pass": stats["pass"],
            "fail": stats["fail"],
            "pass_rate": round(pass_rate * 100, 1),
            "fail_rate": round(fail_rate * 100, 1),
            "difficulty": difficulty,
            "type": crit_type,
        })

    criteria_stats.sort(key=lambda x: x["difficulty"], reverse=True)

    # Co-failure matrix
    co_failure = _compute_co_failure(hunt_criteria_outcomes)

    return {
        "criteria_stats": criteria_stats,
        "co_failure_matrix": co_failure,
    }


def _categorize_criteria(crit_text: str) -> str:
    """Auto-categorize criteria by keywords."""
    text = crit_text.lower()
    if any(w in text for w in ["format", "markdown", "heading", "bullet", "list", "structure", "layout"]):
        return "formatting"
    if any(w in text for w in ["safe", "harm", "toxic", "bias", "ethical"]):
        return "safety"
    if any(w in text for w in ["fact", "correct", "accurate", "true", "false", "real"]):
        return "factual"
    if any(w in text for w in ["reason", "logic", "explain", "why", "because", "step"]):
        return "reasoning"
    if any(w in text for w in ["instruct", "follow", "comply", "asked", "request"]):
        return "instruction"
    return "other"


def _compute_co_failure(outcomes: List[Dict[str, bool]]) -> Dict[str, Dict[str, float]]:
    """Compute co-failure correlation between criteria pairs."""
    if len(outcomes) < 5:
        return {}

    all_criteria = set()
    for o in outcomes:
        all_criteria.update(o.keys())

    co_failure = {}
    criteria_list = sorted(all_criteria)

    for i, c1 in enumerate(criteria_list):
        co_failure[c1] = {}
        for c2 in criteria_list[i:]:
            # Count hunts where both appear
            both_present = [o for o in outcomes if c1 in o and c2 in o]
            if len(both_present) < 3:
                continue
            both_fail = sum(1 for o in both_present if not o[c1] and not o[c2])
            co_fail_rate = both_fail / len(both_present)
            co_failure[c1][c2] = round(co_fail_rate, 3)
            if c1 != c2:
                co_failure.setdefault(c2, {})[c1] = round(co_fail_rate, 3)

    return co_failure


# ============== Judge Analytics ==============

def compute_judge_analytics(events: List[Dict]) -> Dict[str, Any]:
    """
    Compute judge drift, inconsistency flags, and top failure reasons.
    """
    judge_calls = [e for e in events if e.get("type") == "judge_call"]
    hunt_results = [e for e in events if e.get("type") == "hunt_result"]

    # Judge drift: weekly pass rate over time
    weekly_rates = defaultdict(lambda: {"pass": 0, "total": 0})
    for e in hunt_results:
        ts = e.get("_ts")
        data = e.get("data", {})
        score = data.get("score")
        if ts and score is not None:
            week_key = ts.strftime("%Y-W%W")
            weekly_rates[week_key]["total"] += 1
            if score == 1:
                weekly_rates[week_key]["pass"] += 1

    drift_data = []
    for week, rates in sorted(weekly_rates.items()):
        if rates["total"] >= 3:
            drift_data.append({
                "week": week,
                "pass_rate": round(rates["pass"] / rates["total"] * 100, 1),
                "total": rates["total"]
            })

    # Top failure reasons (parse judge_explanation)
    failure_phrases = defaultdict(int)
    for e in hunt_results:
        data = e.get("data", {})
        if data.get("score") == 0 and data.get("judge_explanation"):
            explanation = data["judge_explanation"]
            # Extract key phrases
            for phrase in _extract_failure_phrases(explanation):
                failure_phrases[phrase] += 1

    top_failures = sorted(failure_phrases.items(), key=lambda x: x[1], reverse=True)[:15]

    # Per-criteria inconsistency (criteria with highest variance in verdicts)
    criteria_verdicts = defaultdict(list)
    for e in hunt_results:
        data = e.get("data", {})
        criteria = data.get("criteria")
        if criteria and isinstance(criteria, dict):
            for crit_id, verdict in criteria.items():
                v = str(verdict).strip().upper()
                criteria_verdicts[crit_id].append(1 if v in ("PASS", "1", "TRUE", "YES") else 0)

    inconsistent_criteria = []
    for crit_id, verdicts in criteria_verdicts.items():
        if len(verdicts) >= 5:
            mean = sum(verdicts) / len(verdicts)
            # Agreement = how close to 0 or 1 the mean is
            agreement = max(mean, 1 - mean)
            if agreement < 0.7:
                inconsistent_criteria.append({
                    "criteria": crit_id,
                    "agreement": round(agreement * 100, 1),
                    "total_evaluations": len(verdicts)
                })

    inconsistent_criteria.sort(key=lambda x: x["agreement"])

    return {
        "drift": drift_data,
        "top_failure_reasons": [{"reason": r, "count": c} for r, c in top_failures],
        "inconsistent_criteria": inconsistent_criteria,
    }


def _extract_failure_phrases(explanation: str) -> List[str]:
    """Extract key failure phrases from judge explanation text."""
    phrases = []
    text = explanation.lower()

    patterns = [
        r"(?:does not|doesn't|fails to|missing|lacks|no|without)\s+[\w\s]{3,30}",
        r"(?:incorrect|wrong|inaccurate|incomplete|insufficient)\s+[\w\s]{2,20}",
        r"reasoning\s+(?:trace|included|present|visible)",
        r"format(?:ting)?\s+(?:issue|error|incorrect|wrong)",
    ]
    for pattern in patterns:
        matches = re.findall(pattern, text)
        for m in matches:
            cleaned = m.strip()[:60]
            if len(cleaned) > 5:
                phrases.append(cleaned)

    return phrases[:3]  # Max 3 phrases per explanation


# ============== Prompt Analytics ==============

def compute_prompt_analytics(trainer_registry: Dict, session_data: Dict[str, Dict]) -> Dict[str, Any]:
    """
    Cluster prompts and compute domain breakdown.
    Uses TF-IDF + KMeans if sklearn is available, else returns basic stats.
    """
    prompts = []
    prompt_meta = []

    for sid, data in session_data.items():
        session_info = data.get("session_data", {})
        notebook = session_info.get("notebook") if isinstance(session_info, dict) else None
        if notebook and isinstance(notebook, dict):
            prompt_text = notebook.get("prompt", "")
            if prompt_text and len(prompt_text) > 20:
                prompts.append(prompt_text)
                prompt_meta.append({
                    "session_id": sid,
                    "filename": data.get("filename", ""),
                    "trainer_email": data.get("trainer_email", ""),
                })

    result = {
        "total_prompts": len(prompts),
        "clusters": [],
        "domains": [],
    }

    if not prompts:
        return result

    # Domain classification (keyword-based, always available)
    domain_counts = defaultdict(lambda: {"count": 0, "sessions": []})
    for i, prompt in enumerate(prompts):
        domain = _classify_domain(prompt)
        domain_counts[domain]["count"] += 1
        domain_counts[domain]["sessions"].append(prompt_meta[i]["session_id"])

    result["domains"] = [
        {"domain": d, "count": info["count"]}
        for d, info in sorted(domain_counts.items(), key=lambda x: x[1]["count"], reverse=True)
    ]

    # TF-IDF clustering (if sklearn available and enough prompts)
    if _sklearn_available and len(prompts) >= 10:
        try:
            vectorizer = TfidfVectorizer(max_features=500, stop_words="english", max_df=0.8)
            X = vectorizer.fit_transform(prompts)

            # Auto-pick k (3 to min(15, n//3))
            max_k = min(15, len(prompts) // 3)
            best_k = 3
            best_score = -1
            for k in range(3, max_k + 1):
                km = KMeans(n_clusters=k, random_state=42, n_init=5, max_iter=100)
                labels = km.fit_predict(X)
                if len(set(labels)) > 1:
                    score = silhouette_score(X, labels, sample_size=min(300, len(prompts)))
                    if score > best_score:
                        best_score = score
                        best_k = k

            km = KMeans(n_clusters=best_k, random_state=42, n_init=10)
            labels = km.fit_predict(X)

            # Get top terms per cluster
            feature_names = vectorizer.get_feature_names_out()
            clusters = []
            for cluster_id in range(best_k):
                mask = [i for i, l in enumerate(labels) if l == cluster_id]
                if not mask:
                    continue
                center = km.cluster_centers_[cluster_id]
                top_indices = center.argsort()[-5:][::-1]
                top_terms = [feature_names[i] for i in top_indices]
                cluster_name = " / ".join(top_terms[:3])
                clusters.append({
                    "id": cluster_id,
                    "name": cluster_name,
                    "count": len(mask),
                    "top_terms": top_terms,
                })

            result["clusters"] = clusters
        except Exception as e:
            print(f"Prompt clustering error: {e}")

    return result


def _classify_domain(text: str) -> str:
    """Classify a prompt into a domain category."""
    t = text.lower()
    if any(w in t for w in ["safe", "harm", "toxic", "bias", "ethical", "danger", "violence"]):
        return "safety"
    if any(w in t for w in ["code", "program", "function", "algorithm", "debug", "python", "javascript"]):
        return "coding"
    if any(w in t for w in ["math", "calculate", "equation", "proof", "theorem"]):
        return "math"
    if any(w in t for w in ["reason", "logic", "deduc", "infer", "conclusion", "premise"]):
        return "reasoning"
    if any(w in t for w in ["fact", "history", "science", "geography", "who", "when", "where"]):
        return "factual"
    if any(w in t for w in ["creative", "story", "poem", "write", "imagine", "fiction"]):
        return "creative"
    return "general"


# ============== Anomaly Detection ==============

def detect_anomalies(events: List[Dict], hours: int = 24) -> List[Dict]:
    """
    Detect anomalies using z-scores on key metrics.
    Returns list of anomaly dicts with severity, description, metric, value, threshold.
    """
    anomalies = []
    cutoff = datetime.utcnow() - timedelta(hours=hours)
    recent = [e for e in events if e.get("_ts", datetime.min) >= cutoff]

    # Error spike detection (per-provider hourly error rate)
    provider_errors = defaultdict(lambda: defaultdict(lambda: {"errors": 0, "total": 0}))
    for e in events:
        if e.get("type") != "api_call_end":
            continue
        ts = e.get("_ts")
        if not ts:
            continue
        data = e.get("data", {})
        provider = data.get("provider", "unknown")
        hour_key = ts.strftime("%Y-%m-%d-%H")
        provider_errors[provider][hour_key]["total"] += 1
        if not data.get("success", True):
            provider_errors[provider][hour_key]["errors"] += 1

    for provider, hours_data in provider_errors.items():
        if len(hours_data) < 3:
            continue
        error_rates = []
        for h, counts in hours_data.items():
            if counts["total"] > 0:
                error_rates.append(counts["errors"] / counts["total"])

        if len(error_rates) >= 3:
            mean = sum(error_rates) / len(error_rates)
            variance = sum((r - mean) ** 2 for r in error_rates) / len(error_rates)
            std = math.sqrt(variance) if variance > 0 else 0

            # Check latest hour
            latest_hour = max(hours_data.keys())
            latest_data = hours_data[latest_hour]
            if latest_data["total"] > 0:
                latest_rate = latest_data["errors"] / latest_data["total"]
                if std > 0 and (latest_rate - mean) / std > 2:
                    anomalies.append({
                        "type": "error_spike",
                        "severity": "critical" if latest_rate > 0.3 else "warning",
                        "description": f"{provider} error rate {latest_rate:.0%} (normal: {mean:.0%})",
                        "provider": provider,
                        "value": round(latest_rate * 100, 1),
                        "threshold": round((mean + 2 * std) * 100, 1),
                        "timestamp": datetime.utcnow().isoformat()
                    })

    # Idle trainer detection
    session_hunts = defaultdict(lambda: {"hunts": 0, "breaks": 0, "email": ""})
    for e in recent:
        if e.get("type") == "hunt_result":
            data = e.get("data", {})
            sid = data.get("session_id", "")
            session_hunts[sid]["hunts"] += 1
            if data.get("is_breaking"):
                session_hunts[sid]["breaks"] += 1
            session_hunts[sid]["email"] = data.get("trainer_email", "")

    for sid, stats in session_hunts.items():
        if stats["hunts"] >= 10 and stats["breaks"] == 0:
            anomalies.append({
                "type": "idle_trainer",
                "severity": "warning",
                "description": f"Trainer ({stats['email'] or sid[:8]}) ran {stats['hunts']} hunts with 0 breaks",
                "session_id": sid,
                "value": stats["hunts"],
                "threshold": 10,
                "timestamp": datetime.utcnow().isoformat()
            })

    return anomalies


# ============== Overview Metrics ==============

def compute_overview(events: List[Dict], trainer_timing: Dict, hours: int = 24) -> Dict[str, Any]:
    """Compute overview dashboard metrics."""
    cutoff = datetime.utcnow() - timedelta(hours=hours)
    yesterday_cutoff = cutoff - timedelta(hours=hours)

    today_events = [e for e in events if e.get("_ts", datetime.min) >= cutoff]
    yesterday_events = [e for e in events
                        if yesterday_cutoff <= e.get("_ts", datetime.min) < cutoff]

    def count_metric(evts, event_type, field=None, value=None):
        count = 0
        for e in evts:
            if e.get("type") == event_type:
                if field and value is not None:
                    if e.get("data", {}).get(field) == value:
                        count += 1
                else:
                    count += 1
        return count

    sessions_today = count_metric(today_events, "session_created")
    sessions_yesterday = count_metric(yesterday_events, "session_created")
    hunts_today = count_metric(today_events, "hunt_result")
    hunts_yesterday = count_metric(yesterday_events, "hunt_result")
    breaks_today = count_metric(today_events, "hunt_result", "is_breaking", True)
    breaks_yesterday = count_metric(yesterday_events, "hunt_result", "is_breaking", True)

    # Cost today (approximate)
    cost_today = 0
    for e in today_events:
        if e.get("type") == "api_call_end":
            data = e.get("data", {})
            tokens_in = data.get("tokens_in", 0) or 0
            tokens_out = data.get("tokens_out", 0) or 0
            model = data.get("model", "")
            if tokens_in or tokens_out:
                # Inline cost calc
                pricing = LogReader.MODEL_PRICING.get(model, LogReader.MODEL_PRICING.get("default", {"input": 0.5, "output": 1.0}))
                cost_today += (tokens_in * pricing["input"] / 1e6) + (tokens_out * pricing["output"] / 1e6)

    active_trainers = sum(1 for t in trainer_timing.values() if t.get("status") == "online")
    idle_trainers = sum(1 for t in trainer_timing.values() if t.get("status") == "idle")

    return {
        "active_trainers": active_trainers,
        "idle_trainers": idle_trainers,
        "sessions_today": sessions_today,
        "sessions_delta": sessions_today - sessions_yesterday,
        "hunts_today": hunts_today,
        "hunts_delta": hunts_today - hunts_yesterday,
        "breaks_today": breaks_today,
        "breaks_delta": breaks_today - breaks_yesterday,
        "cost_today": round(cost_today, 4),
        "total_events": len(events),
    }


# Import for type reference (avoid circular)
try:
    from log_reader import LogReader
except ImportError:
    LogReader = None


# ============== Model Analytics ==============

def compute_model_analytics(events: List[Dict]) -> List[Dict]:
    """Compute per-model performance metrics."""
    model_stats = defaultdict(lambda: {
        "hunts": 0, "breaks": 0, "latencies": [], "errors": 0,
        "criteria_type_fails": defaultdict(int), "criteria_type_totals": defaultdict(int)
    })

    for e in events:
        data = e.get("data", {})
        if e.get("type") == "hunt_result":
            model = data.get("model", "unknown")
            model_stats[model]["hunts"] += 1
            if data.get("is_breaking"):
                model_stats[model]["breaks"] += 1
            if data.get("error"):
                model_stats[model]["errors"] += 1
            # Criteria type failures
            criteria = data.get("criteria")
            if criteria and isinstance(criteria, dict):
                for crit_id, verdict in criteria.items():
                    crit_type = _categorize_criteria(crit_id)
                    model_stats[model]["criteria_type_totals"][crit_type] += 1
                    v = str(verdict).strip().upper()
                    if v not in ("PASS", "1", "TRUE", "YES"):
                        model_stats[model]["criteria_type_fails"][crit_type] += 1

        elif e.get("type") == "api_call_end":
            model = data.get("model", "")
            latency = data.get("latency_ms")
            if model and latency:
                model_stats[model]["latencies"].append(latency)

    result = []
    for model, stats in model_stats.items():
        latencies = sorted(stats["latencies"])
        p50 = latencies[len(latencies) // 2] if latencies else 0
        p95 = latencies[int(len(latencies) * 0.95)] if latencies else 0

        vulnerability = {}
        for crit_type, total in stats["criteria_type_totals"].items():
            fails = stats["criteria_type_fails"].get(crit_type, 0)
            vulnerability[crit_type] = round(fails / max(total, 1) * 100, 1)

        result.append({
            "model": model,
            "hunts": stats["hunts"],
            "breaks": stats["breaks"],
            "break_rate": round(stats["breaks"] / max(stats["hunts"], 1) * 100, 1),
            "errors": stats["errors"],
            "p50_latency": p50,
            "p95_latency": p95,
            "vulnerability": vulnerability,
        })

    result.sort(key=lambda x: x["hunts"], reverse=True)
    return result


# ============== Cost Analytics ==============

def compute_cost_analytics(events: List[Dict], trainer_timing: Dict,
                           session_to_email: Dict[str, str]) -> Dict[str, Any]:
    """Compute cost attribution by trainer, model, and cost-per-break."""
    model_costs = defaultdict(float)
    trainer_costs = defaultdict(float)
    total_cost = 0
    total_breaks = 0

    for e in events:
        if e.get("type") == "api_call_end":
            data = e.get("data", {})
            model = data.get("model", "unknown")
            tokens_in = data.get("tokens_in", 0) or 0
            tokens_out = data.get("tokens_out", 0) or 0
            sid = data.get("session_id", "")

            if tokens_in or tokens_out:
                # Use default pricing if LogReader not available
                pricing = {"input": 0.5, "output": 1.0}
                for known, p in [
                    ("nemotron", {"input": 0.06, "output": 0.24}),
                    ("qwen", {"input": 0.11, "output": 0.60}),
                    ("gpt-5", {"input": 1.25, "output": 10.00}),
                ]:
                    if known in model.lower():
                        pricing = p
                        break

                cost = (tokens_in * pricing["input"] / 1e6) + (tokens_out * pricing["output"] / 1e6)
                model_costs[model] += cost
                total_cost += cost

                email = session_to_email.get(sid, "")
                if email:
                    trainer_costs[email] += cost

        elif e.get("type") == "hunt_result":
            if e.get("data", {}).get("is_breaking"):
                total_breaks += 1

    cost_per_break = round(total_cost / max(total_breaks, 1), 4)

    # Daily burn rate (last 7 days)
    daily_costs = defaultdict(float)
    for e in events:
        if e.get("type") == "api_call_end":
            ts = e.get("_ts")
            data = e.get("data", {})
            if ts:
                day_key = ts.strftime("%Y-%m-%d")
                tokens_in = data.get("tokens_in", 0) or 0
                tokens_out = data.get("tokens_out", 0) or 0
                if tokens_in or tokens_out:
                    model = data.get("model", "")
                    pricing = {"input": 0.5, "output": 1.0}
                    for known, p in [
                        ("nemotron", {"input": 0.06, "output": 0.24}),
                        ("qwen", {"input": 0.11, "output": 0.60}),
                        ("gpt-5", {"input": 1.25, "output": 10.00}),
                    ]:
                        if known in model.lower():
                            pricing = p
                            break
                    daily_costs[day_key] += (tokens_in * pricing["input"] / 1e6) + (tokens_out * pricing["output"] / 1e6)

    burn_rate = [
        {"date": d, "cost": round(c, 4)}
        for d, c in sorted(daily_costs.items())[-14:]
    ]

    return {
        "total_cost": round(total_cost, 4),
        "cost_per_break": cost_per_break,
        "total_breaks": total_breaks,
        "by_model": [
            {"model": m, "cost": round(c, 4)}
            for m, c in sorted(model_costs.items(), key=lambda x: x[1], reverse=True)
        ],
        "by_trainer": [
            {"email": e, "name": trainer_timing.get(e, {}).get("name", e), "cost": round(c, 4)}
            for e, c in sorted(trainer_costs.items(), key=lambda x: x[1], reverse=True)[:20]
        ],
        "burn_rate": burn_rate,
    }
