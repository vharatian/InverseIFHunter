"""
Data Lab - ML-Ready Export Profiles

Pre-configured, feature-engineered datasets for ML analysis.
Supports CSV, JSON, and Parquet output formats.
"""
import io
import json
from typing import Dict, List, Any, Optional
from datetime import datetime

# Optional imports
try:
    import pandas as pd
    _pandas_available = True
except ImportError:
    _pandas_available = False

try:
    import pyarrow
    _parquet_available = True
except ImportError:
    _parquet_available = False


EXPORT_PROFILES = {
    "break_prediction": {
        "name": "Break Prediction Dataset",
        "description": "One row per hunt. Features engineered for break probability modeling.",
        "label": "is_breaking",
    },
    "criteria_analysis": {
        "name": "Criteria Analysis Dataset",
        "description": "One row per criteria evaluation. For criteria difficulty modeling.",
        "label": "is_pass",
    },
    "model_comparison": {
        "name": "Model Comparison Dataset",
        "description": "One row per model per session. For model benchmarking.",
        "label": None,
    },
    "trainer_performance": {
        "name": "Trainer Performance Dataset",
        "description": "One row per trainer. For performance analysis.",
        "label": None,
    },
}


def get_profiles() -> List[Dict]:
    """Return available export profiles with metadata."""
    return [
        {"id": pid, **info, "available": _pandas_available}
        for pid, info in EXPORT_PROFILES.items()
    ]


def build_dataset(profile_id: str, events: List[Dict],
                  trainer_timing: Dict, session_to_email: Dict,
                  since: Optional[datetime] = None) -> Optional[List[Dict]]:
    """
    Build a feature-engineered dataset for the given profile.
    Returns list of row dicts.
    """
    if since:
        events = [e for e in events if e.get("_ts", datetime.min) >= since]

    if profile_id == "break_prediction":
        return _build_break_prediction(events, session_to_email, trainer_timing)
    elif profile_id == "criteria_analysis":
        return _build_criteria_analysis(events)
    elif profile_id == "model_comparison":
        return _build_model_comparison(events)
    elif profile_id == "trainer_performance":
        return _build_trainer_performance(trainer_timing)
    return None


def export_to_format(rows: List[Dict], fmt: str = "csv") -> tuple:
    """
    Export rows to the requested format.
    Returns (bytes, content_type, filename_ext).
    """
    if not _pandas_available or not rows:
        # Fallback to raw JSON
        data = json.dumps(rows, indent=2, default=str).encode("utf-8")
        return data, "application/json", "json"

    df = pd.DataFrame(rows)

    if fmt == "parquet" and _parquet_available:
        buf = io.BytesIO()
        df.to_parquet(buf, index=False)
        return buf.getvalue(), "application/octet-stream", "parquet"
    elif fmt == "json":
        data = df.to_json(orient="records", indent=2, default_handler=str).encode("utf-8")
        return data, "application/json", "json"
    else:  # csv
        data = df.to_csv(index=False).encode("utf-8")
        return data, "text/csv", "csv"


def _build_break_prediction(events: List[Dict], session_to_email: Dict,
                            trainer_timing: Dict) -> List[Dict]:
    """Build break prediction dataset."""
    rows = []
    for e in events:
        if e.get("type") != "hunt_result":
            continue
        data = e.get("data", {})
        criteria = data.get("criteria", {})
        if not isinstance(criteria, dict):
            criteria = {}

        num_criteria = len(criteria)
        has_formatting = any("format" in str(k).lower() or "format" in str(v).lower()
                            for k, v in criteria.items())
        model = data.get("model", "")
        email = data.get("trainer_email", "")
        if not email:
            email = session_to_email.get(data.get("session_id", ""), "")

        trainer_data = trainer_timing.get(email, {})

        rows.append({
            "hunt_id": data.get("hunt_id"),
            "session_id": data.get("session_id", ""),
            "model": model,
            "model_is_qwen": 1 if "qwen" in model.lower() else 0,
            "model_is_nemotron": 1 if "nemotron" in model.lower() else 0,
            "num_criteria": num_criteria,
            "has_formatting_criteria": 1 if has_formatting else 0,
            "trainer_total_hunts": trainer_data.get("total_hunts", 0),
            "trainer_breaks_per_hour": trainer_data.get("breaks_per_hour", 0),
            "is_breaking": 1 if data.get("is_breaking") else 0,
            "score": data.get("score"),
        })
    return rows


def _build_criteria_analysis(events: List[Dict]) -> List[Dict]:
    """Build criteria analysis dataset."""
    rows = []
    for e in events:
        if e.get("type") != "hunt_result":
            continue
        data = e.get("data", {})
        criteria = data.get("criteria", {})
        if not isinstance(criteria, dict):
            continue
        model = data.get("model", "")
        for crit_id, verdict in criteria.items():
            v = str(verdict).strip().upper()
            rows.append({
                "criteria_id": crit_id,
                "model": model,
                "session_id": data.get("session_id", ""),
                "hunt_id": data.get("hunt_id"),
                "is_pass": 1 if v in ("PASS", "1", "TRUE", "YES") else 0,
            })
    return rows


def _build_model_comparison(events: List[Dict]) -> List[Dict]:
    """Build model comparison dataset."""
    from collections import defaultdict
    model_session = defaultdict(lambda: {"hunts": 0, "breaks": 0, "latencies": [], "errors": 0})

    for e in events:
        data = e.get("data", {})
        if e.get("type") == "hunt_result":
            key = (data.get("model", ""), data.get("session_id", ""))
            model_session[key]["hunts"] += 1
            if data.get("is_breaking"):
                model_session[key]["breaks"] += 1
        elif e.get("type") == "api_call_end":
            model = data.get("model", "")
            sid = data.get("session_id", "")
            if model and sid:
                model_session[(model, sid)]["latencies"].append(data.get("latency_ms", 0))
                if not data.get("success", True):
                    model_session[(model, sid)]["errors"] += 1

    rows = []
    for (model, sid), stats in model_session.items():
        if stats["hunts"] == 0:
            continue
        avg_latency = sum(stats["latencies"]) / max(len(stats["latencies"]), 1)
        rows.append({
            "model": model,
            "session_id": sid,
            "hunts": stats["hunts"],
            "breaks": stats["breaks"],
            "break_rate": round(stats["breaks"] / stats["hunts"], 3),
            "avg_latency_ms": round(avg_latency),
            "errors": stats["errors"],
        })
    return rows


def _build_trainer_performance(trainer_timing: Dict) -> List[Dict]:
    """Build trainer performance dataset."""
    rows = []
    for email, data in trainer_timing.items():
        rows.append({
            "email": email,
            "name": data.get("name", ""),
            "active_hours": data.get("active_hours", 0),
            "work_sessions": data.get("work_session_count", 0),
            "total_hunts": data.get("total_hunts", 0),
            "total_breaks": data.get("total_breaks", 0),
            "breaks_per_hour": data.get("breaks_per_hour", 0),
            "first_seen": data.get("first_seen", ""),
            "last_seen": data.get("last_seen", ""),
        })
    return rows
