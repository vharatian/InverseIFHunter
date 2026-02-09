#!/usr/bin/env python3
"""
ML Data Exporter for Model Hunter

Extracts and prepares data from VM for ML training on Google Colab.
Run this on the VM to generate ML-ready datasets.

Usage (inside Docker container):
    docker exec model-hunter-green python /app/ml_pipeline/export_ml_data.py

Or via the export script:
    ./ml_pipeline/run_export.sh
    
Then download:
    scp -r mandy@VM_IP:/tmp/ml_export/ ./
"""

import json
import os
import csv
import gzip
import argparse
from pathlib import Path
from datetime import datetime, timedelta
from collections import defaultdict
from typing import Dict, List, Any, Optional, Tuple
import re
import hashlib


class MLDataExporter:
    """Export Model Hunter data for ML training on Colab."""
    
    def __init__(self, storage_dir: str, telemetry_file: str, output_dir: str):
        self.storage_dir = Path(storage_dir)
        self.telemetry_file = Path(telemetry_file)
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        # Stats
        self.stats = {
            "sessions_processed": 0,
            "hunt_results_extracted": 0,
            "criteria_samples": 0,
            "unique_notebooks": 0,
            "unique_trainers": 0,
            "total_breaks": 0,
            "errors": []
        }
        
        # Cache for notebook metadata
        self._notebook_cache: Dict[str, Dict] = {}
    
    def _extract_trainer_id(self, url: str, filename: str) -> str:
        """
        Extract a trainer identifier from Colab URL or filename.
        Uses the Google Drive file ID as a proxy for trainer identity.
        """
        if url:
            # Extract Drive file ID from Colab URL
            # Format: https://colab.research.google.com/drive/FILE_ID#...
            match = re.search(r'/drive/([a-zA-Z0-9_-]+)', url)
            if match:
                return f"colab_{match.group(1)[:12]}"  # Shortened ID
        
        # Fallback to filename hash
        return f"file_{hashlib.md5(filename.encode()).hexdigest()[:8]}"
    
    def _parse_notebook_content(self, content_json: str) -> Dict[str, Any]:
        """Parse notebook JSON to extract structured fields."""
        try:
            notebook = json.loads(content_json)
            cells = notebook.get("cells", [])
            
            result = {
                "metadata": {},
                "prompt": "",
                "prompt_length": 0,
                "response": "",
                "response_reference": "",
                "criteria": [],
                "num_criteria": 0,
                "has_judge_prompt": False
            }
            
            for cell in cells:
                if cell.get("cell_type") != "markdown":
                    continue
                    
                source = "".join(cell.get("source", []))
                
                # Extract metadata
                if "# Metadata" in source or "**Task ID:**" in source:
                    for line in source.split("\n"):
                        if "**Task ID:**" in line:
                            result["metadata"]["task_id"] = line.split("**Task ID:**")[-1].strip().strip("-").strip()
                        elif "**Domain:**" in line:
                            result["metadata"]["domain"] = line.split("**Domain:**")[-1].strip().strip("-").strip()
                        elif "**Use Case:**" in line:
                            result["metadata"]["use_case"] = line.split("**Use Case:**")[-1].strip().strip("-").strip()
                        elif "**L1 Taxonomy:**" in line:
                            result["metadata"]["taxonomy"] = line.split("**L1 Taxonomy:**")[-1].strip().strip("-").strip()
                        elif "**User Prompt Length:**" in line:
                            result["metadata"]["prompt_length_category"] = line.split("**User Prompt Length:**")[-1].strip().strip("-").strip()
                        elif "**Model:**" in line:
                            result["metadata"]["target_model"] = line.split("**Model:**")[-1].strip().strip("-").strip()
                
                # Extract prompt
                elif "**[prompt]**" in source:
                    prompt_text = source.replace("**[prompt]**", "").strip()
                    result["prompt"] = prompt_text
                    result["prompt_length"] = len(prompt_text)
                
                # Extract expected response
                elif "**[response]**" in source and "**[response_reference]**" not in source:
                    result["response"] = source.replace("**[response]**", "").strip()
                
                # Extract criteria
                elif "**[response_reference]**" in source:
                    ref_text = source.replace("**[response_reference]**", "").strip()
                    try:
                        json_match = re.search(r'\[.*\]', ref_text, re.DOTALL)
                        if json_match:
                            criteria_list = json.loads(json_match.group())
                            result["criteria"] = criteria_list
                            result["num_criteria"] = len(criteria_list)
                            result["response_reference"] = ref_text
                    except json.JSONDecodeError:
                        result["response_reference"] = ref_text
                
                # Check for custom judge prompt
                elif "**[judge_system_prompt]**" in source:
                    content = source.replace("**[judge_system_prompt]**", "").strip()
                    if content:
                        result["has_judge_prompt"] = True
            
            return result
            
        except Exception as e:
            return {"error": str(e)}
    
    def export_comprehensive_dataset(self) -> str:
        """
        Export comprehensive dataset for all ML tasks.
        Single JSONL file with all data needed for predictions.
        """
        output_file = self.output_dir / "ml_dataset.jsonl.gz"
        
        # First pass: collect all hunt results from telemetry
        hunt_results_by_session = defaultdict(list)
        session_timings = defaultdict(lambda: {"start": None, "end": None})
        api_call_stats = defaultdict(lambda: {"count": 0, "total_latency": 0, "tokens_in": 0, "tokens_out": 0})
        
        print("  → Reading telemetry events...")
        if self.telemetry_file.exists():
            with open(self.telemetry_file, "r") as f:
                for line in f:
                    try:
                        event = json.loads(line.strip())
                        event_type = event.get("type")
                        data = event.get("data", {})
                        ts = event.get("ts")
                        session_id = data.get("session_id")
                        
                        if event_type == "hunt_result" and session_id:
                            hunt_results_by_session[session_id].append({
                                "timestamp": ts,
                                "hunt_id": data.get("hunt_id"),
                                "model": data.get("model"),
                                "score": data.get("score"),
                                "is_breaking": data.get("is_breaking"),
                                "error": data.get("error"),
                                "response_preview": data.get("response_preview", ""),
                                "reasoning_preview": data.get("reasoning_preview", ""),
                                "criteria": data.get("criteria", {})
                            })
                            self.stats["hunt_results_extracted"] += 1
                            if data.get("is_breaking"):
                                self.stats["total_breaks"] += 1
                        
                        elif event_type == "hunt_start" and session_id:
                            if not session_timings[session_id]["start"] or ts < session_timings[session_id]["start"]:
                                session_timings[session_id]["start"] = ts
                        
                        elif event_type == "hunt_complete" and session_id:
                            if not session_timings[session_id]["end"] or ts > session_timings[session_id]["end"]:
                                session_timings[session_id]["end"] = ts
                        
                        elif event_type == "api_call_end":
                            model = data.get("model", "unknown")
                            api_call_stats[model]["count"] += 1
                            api_call_stats[model]["total_latency"] += data.get("latency_ms", 0)
                            api_call_stats[model]["tokens_in"] += data.get("tokens_in", 0) or 0
                            api_call_stats[model]["tokens_out"] += data.get("tokens_out", 0) or 0
                            
                    except json.JSONDecodeError:
                        continue
        
        # Second pass: match with session storage for notebook details
        print("  → Processing session files...")
        records = []
        trainer_stats = defaultdict(lambda: {
            "sessions": 0, "hunts": 0, "breaks": 0, "domains": set()
        })
        
        if self.storage_dir.exists():
            session_files = list(self.storage_dir.glob("*.json"))
            total_files = len(session_files)
            
            for i, session_file in enumerate(session_files):
                if i % 500 == 0:
                    print(f"     Processing {i}/{total_files}...")
                
                session_id = session_file.stem
                
                try:
                    with open(session_file, "r") as f:
                        session_data = json.load(f)
                    
                    url = session_data.get("url", "")
                    filename = session_data.get("filename", "notebook.ipynb")
                    original_content = session_data.get("original_content", "")
                    
                    if not original_content:
                        continue
                    
                    # Parse notebook
                    parsed = self._parse_notebook_content(original_content)
                    if "error" in parsed:
                        continue
                    
                    # Get trainer ID
                    trainer_id = self._extract_trainer_id(url, filename)
                    
                    # Get hunt results for this session
                    hunts = hunt_results_by_session.get(session_id, [])
                    
                    if not hunts:
                        continue  # Skip sessions with no hunts
                    
                    # Calculate aggregates
                    breaks_found = sum(1 for h in hunts if h.get("is_breaking"))
                    total_hunts = len(hunts)
                    scores = [h["score"] for h in hunts if h.get("score") is not None]
                    
                    # Criteria failure analysis
                    criteria_failures = defaultdict(int)
                    criteria_passes = defaultdict(int)
                    for h in hunts:
                        for crit_id, result in h.get("criteria", {}).items():
                            if result == "FAIL":
                                criteria_failures[crit_id] += 1
                            elif result == "PASS":
                                criteria_passes[crit_id] += 1
                    
                    # Calculate timing
                    timing = session_timings.get(session_id, {})
                    duration_ms = None
                    if timing.get("start") and timing.get("end"):
                        try:
                            start = datetime.fromisoformat(timing["start"].rstrip("Z"))
                            end = datetime.fromisoformat(timing["end"].rstrip("Z"))
                            duration_ms = int((end - start).total_seconds() * 1000)
                        except:
                            pass
                    
                    # Build record
                    record = {
                        "session_id": session_id,
                        "trainer_id": trainer_id,
                        "notebook_url": url,
                        "filename": filename,
                        
                        # Notebook metadata
                        "task_id": parsed["metadata"].get("task_id", ""),
                        "domain": parsed["metadata"].get("domain", ""),
                        "use_case": parsed["metadata"].get("use_case", ""),
                        "taxonomy": parsed["metadata"].get("taxonomy", ""),
                        "prompt_length_category": parsed["metadata"].get("prompt_length_category", ""),
                        "target_model": parsed["metadata"].get("target_model", ""),
                        
                        # Prompt features
                        "prompt": parsed["prompt"][:3000],  # Truncate for size
                        "prompt_char_length": parsed["prompt_length"],
                        "prompt_word_count": len(parsed["prompt"].split()),
                        "expected_response": parsed["response"][:1000],
                        "expected_response_length": len(parsed["response"]),
                        
                        # Criteria
                        "criteria": parsed["criteria"],
                        "num_criteria": parsed["num_criteria"],
                        "has_custom_judge_prompt": parsed["has_judge_prompt"],
                        
                        # Hunt outcomes (targets for ML)
                        "total_hunts": total_hunts,
                        "breaks_found": breaks_found,
                        "break_rate": breaks_found / total_hunts if total_hunts > 0 else 0,
                        "avg_score": sum(scores) / len(scores) if scores else None,
                        "min_score": min(scores) if scores else None,
                        "max_score": max(scores) if scores else None,
                        
                        # Criteria analysis
                        "criteria_failure_counts": dict(criteria_failures),
                        "criteria_pass_counts": dict(criteria_passes),
                        "hardest_criteria": max(criteria_failures, key=criteria_failures.get) if criteria_failures else None,
                        
                        # Timing
                        "duration_ms": duration_ms,
                        "avg_hunt_duration_ms": duration_ms // total_hunts if duration_ms and total_hunts else None,
                        
                        # Individual hunt results (for detailed analysis)
                        "hunts": hunts
                    }
                    
                    records.append(record)
                    self.stats["sessions_processed"] += 1
                    
                    # Update trainer stats
                    trainer_stats[trainer_id]["sessions"] += 1
                    trainer_stats[trainer_id]["hunts"] += total_hunts
                    trainer_stats[trainer_id]["breaks"] += breaks_found
                    if parsed["metadata"].get("domain"):
                        trainer_stats[trainer_id]["domains"].add(parsed["metadata"]["domain"])
                    
                except Exception as e:
                    self.stats["errors"].append(f"{session_id}: {str(e)}")
        
        # Write compressed JSONL
        print(f"  → Writing {len(records)} records to compressed file...")
        with gzip.open(output_file, "wt", encoding="utf-8") as f:
            for record in records:
                f.write(json.dumps(record, default=str) + "\n")
        
        # Update stats
        self.stats["unique_notebooks"] = len(set(r["notebook_url"] for r in records if r["notebook_url"]))
        self.stats["unique_trainers"] = len(trainer_stats)
        
        return str(output_file)
    
    def export_trainer_leaderboard(self) -> str:
        """Export trainer leaderboard data."""
        output_file = self.output_dir / "trainer_leaderboard.csv"
        
        # Aggregate by trainer from telemetry + storage
        trainer_data = defaultdict(lambda: {
            "sessions": 0,
            "total_hunts": 0,
            "breaks_found": 0,
            "api_calls": 0,
            "domains": set(),
            "models_used": set(),
            "first_seen": None,
            "last_seen": None,
            "avg_break_rate": []
        })
        
        session_trainers = {}  # session_id -> trainer_id
        
        # Map sessions to trainers from storage
        if self.storage_dir.exists():
            for session_file in self.storage_dir.glob("*.json"):
                try:
                    with open(session_file, "r") as f:
                        data = json.load(f)
                    url = data.get("url", "")
                    filename = data.get("filename", "")
                    trainer_id = self._extract_trainer_id(url, filename)
                    session_trainers[session_file.stem] = trainer_id
                    
                    # Parse for domain
                    content = data.get("original_content", "")
                    if content:
                        parsed = self._parse_notebook_content(content)
                        domain = parsed.get("metadata", {}).get("domain", "")
                        if domain:
                            trainer_data[trainer_id]["domains"].add(domain)
                except:
                    continue
        
        # Aggregate from telemetry
        if self.telemetry_file.exists():
            with open(self.telemetry_file, "r") as f:
                for line in f:
                    try:
                        event = json.loads(line.strip())
                        event_type = event.get("type")
                        data = event.get("data", {})
                        ts = event.get("ts")
                        session_id = data.get("session_id")
                        
                        if not session_id or session_id not in session_trainers:
                            continue
                        
                        trainer_id = session_trainers[session_id]
                        trainer = trainer_data[trainer_id]
                        
                        # Update timestamps
                        if ts:
                            if not trainer["first_seen"] or ts < trainer["first_seen"]:
                                trainer["first_seen"] = ts
                            if not trainer["last_seen"] or ts > trainer["last_seen"]:
                                trainer["last_seen"] = ts
                        
                        if event_type == "session_created":
                            trainer["sessions"] += 1
                        
                        elif event_type == "hunt_complete":
                            trainer["total_hunts"] += data.get("completed_hunts", 0)
                            breaks = data.get("breaks_found", 0)
                            trainer["breaks_found"] += breaks
                            completed = data.get("completed_hunts", 0)
                            if completed > 0:
                                trainer["avg_break_rate"].append(breaks / completed)
                        
                        elif event_type == "api_call_start":
                            trainer["api_calls"] += 1
                            model = data.get("model")
                            if model:
                                trainer["models_used"].add(model)
                    except:
                        continue
        
        # Convert to records
        records = []
        for trainer_id, data in trainer_data.items():
            if data["total_hunts"] == 0:
                continue
            
            records.append({
                "trainer_id": trainer_id,
                "total_sessions": data["sessions"],
                "total_hunts": data["total_hunts"],
                "total_breaks": data["breaks_found"],
                "overall_break_rate": data["breaks_found"] / data["total_hunts"] if data["total_hunts"] else 0,
                "avg_break_rate": sum(data["avg_break_rate"]) / len(data["avg_break_rate"]) if data["avg_break_rate"] else 0,
                "api_calls": data["api_calls"],
                "domains": ",".join(data["domains"]),
                "models_used": ",".join(data["models_used"]),
                "first_seen": data["first_seen"],
                "last_seen": data["last_seen"],
                "efficiency_score": data["breaks_found"] / data["api_calls"] if data["api_calls"] else 0  # Breaks per API call
            })
        
        # Sort by breaks found (top performers)
        records.sort(key=lambda x: x["total_breaks"], reverse=True)
        
        # Write CSV
        if records:
            with open(output_file, "w", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=records[0].keys())
                writer.writeheader()
                writer.writerows(records)
        
        return str(output_file)
    
    def export_criteria_difficulty(self) -> str:
        """Export criteria difficulty analysis."""
        output_file = self.output_dir / "criteria_difficulty.csv"
        
        # Aggregate criteria pass/fail across all hunts
        criteria_stats = defaultdict(lambda: {
            "total_evals": 0,
            "passes": 0,
            "fails": 0,
            "criteria_text": "",
            "sessions_seen": set()
        })
        
        # Get criteria text from sessions
        criteria_text_map = {}
        if self.storage_dir.exists():
            for session_file in self.storage_dir.glob("*.json"):
                try:
                    with open(session_file, "r") as f:
                        data = json.load(f)
                    content = data.get("original_content", "")
                    if content:
                        parsed = self._parse_notebook_content(content)
                        for crit in parsed.get("criteria", []):
                            crit_id = crit.get("id", "")
                            crit_text = crit.get("criteria", "")
                            if crit_id and crit_text:
                                # Store if longer than existing
                                if len(crit_text) > len(criteria_text_map.get(crit_id, "")):
                                    criteria_text_map[crit_id] = crit_text
                except:
                    continue
        
        # Aggregate from telemetry
        if self.telemetry_file.exists():
            with open(self.telemetry_file, "r") as f:
                for line in f:
                    try:
                        event = json.loads(line.strip())
                        if event.get("type") == "hunt_result":
                            data = event.get("data", {})
                            session_id = data.get("session_id", "")
                            criteria = data.get("criteria", {})
                            
                            for crit_id, result in criteria.items():
                                stats = criteria_stats[crit_id]
                                stats["total_evals"] += 1
                                if result == "PASS":
                                    stats["passes"] += 1
                                elif result == "FAIL":
                                    stats["fails"] += 1
                                stats["sessions_seen"].add(session_id)
                                self.stats["criteria_samples"] += 1
                    except:
                        continue
        
        # Build records
        records = []
        for crit_id, stats in criteria_stats.items():
            if stats["total_evals"] == 0:
                continue
            
            fail_rate = stats["fails"] / stats["total_evals"]
            records.append({
                "criteria_id": crit_id,
                "criteria_text": criteria_text_map.get(crit_id, "")[:500],
                "total_evaluations": stats["total_evals"],
                "pass_count": stats["passes"],
                "fail_count": stats["fails"],
                "pass_rate": stats["passes"] / stats["total_evals"],
                "fail_rate": fail_rate,
                "difficulty_score": fail_rate,  # Higher = harder
                "sessions_count": len(stats["sessions_seen"])
            })
        
        # Sort by difficulty (fail rate)
        records.sort(key=lambda x: x["difficulty_score"], reverse=True)
        
        # Write CSV
        if records:
            with open(output_file, "w", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=records[0].keys())
                writer.writeheader()
                writer.writerows(records)
        
        return str(output_file)
    
    def export_model_performance(self) -> str:
        """Export model performance comparison."""
        output_file = self.output_dir / "model_performance.csv"
        
        model_stats = defaultdict(lambda: {
            "total_hunts": 0,
            "breaks": 0,
            "errors": 0,
            "total_latency_ms": 0,
            "latencies": [],
            "scores": [],
            "tokens_in": 0,
            "tokens_out": 0
        })
        
        if self.telemetry_file.exists():
            with open(self.telemetry_file, "r") as f:
                for line in f:
                    try:
                        event = json.loads(line.strip())
                        event_type = event.get("type")
                        data = event.get("data", {})
                        
                        if event_type == "hunt_result":
                            model = data.get("model", "unknown")
                            stats = model_stats[model]
                            stats["total_hunts"] += 1
                            if data.get("is_breaking"):
                                stats["breaks"] += 1
                            if data.get("error"):
                                stats["errors"] += 1
                            score = data.get("score")
                            if score is not None:
                                stats["scores"].append(score)
                        
                        elif event_type == "api_call_end":
                            model = data.get("model", "unknown")
                            stats = model_stats[model]
                            latency = data.get("latency_ms", 0)
                            if latency:
                                stats["latencies"].append(latency)
                                stats["total_latency_ms"] += latency
                            stats["tokens_in"] += data.get("tokens_in", 0) or 0
                            stats["tokens_out"] += data.get("tokens_out", 0) or 0
                    except:
                        continue
        
        # Build records
        records = []
        for model, stats in model_stats.items():
            if stats["total_hunts"] == 0:
                continue
            
            records.append({
                "model": model,
                "total_hunts": stats["total_hunts"],
                "breaks_found": stats["breaks"],
                "break_rate": stats["breaks"] / stats["total_hunts"],
                "error_count": stats["errors"],
                "error_rate": stats["errors"] / stats["total_hunts"],
                "avg_latency_ms": sum(stats["latencies"]) / len(stats["latencies"]) if stats["latencies"] else 0,
                "p50_latency_ms": sorted(stats["latencies"])[len(stats["latencies"])//2] if stats["latencies"] else 0,
                "p95_latency_ms": sorted(stats["latencies"])[int(len(stats["latencies"])*0.95)] if stats["latencies"] else 0,
                "avg_score": sum(stats["scores"]) / len(stats["scores"]) if stats["scores"] else None,
                "total_tokens_in": stats["tokens_in"],
                "total_tokens_out": stats["tokens_out"],
                "avg_tokens_per_call": (stats["tokens_in"] + stats["tokens_out"]) / stats["total_hunts"] if stats["total_hunts"] else 0
            })
        
        # Sort by break rate (best for finding breaks)
        records.sort(key=lambda x: x["break_rate"], reverse=True)
        
        if records:
            with open(output_file, "w", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=records[0].keys())
                writer.writeheader()
                writer.writerows(records)
        
        return str(output_file)
    
    def export_api_timing(self) -> str:
        """Export API timing data for latency prediction."""
        output_file = self.output_dir / "api_timing.csv"
        
        records = []
        
        if self.telemetry_file.exists():
            with open(self.telemetry_file, "r") as f:
                for line in f:
                    try:
                        event = json.loads(line.strip())
                        if event.get("type") == "api_call_end":
                            data = event.get("data", {})
                            ts = event.get("ts", "")
                            
                            # Parse timestamp for time features
                            hour = None
                            day_of_week = None
                            if ts:
                                try:
                                    dt = datetime.fromisoformat(ts.rstrip("Z"))
                                    hour = dt.hour
                                    day_of_week = dt.weekday()
                                except:
                                    pass
                            
                            records.append({
                                "timestamp": ts,
                                "provider": data.get("provider"),
                                "model": data.get("model"),
                                "latency_ms": data.get("latency_ms"),
                                "success": data.get("success"),
                                "tokens_in": data.get("tokens_in"),
                                "tokens_out": data.get("tokens_out"),
                                "hour_of_day": hour,
                                "day_of_week": day_of_week
                            })
                    except:
                        continue
        
        if records:
            with open(output_file, "w", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=records[0].keys())
                writer.writeheader()
                writer.writerows(records)
        
        return str(output_file)
    
    def export_all(self) -> Dict[str, str]:
        """Export all ML datasets."""
        print("🔄 Exporting ML data for Colab...")
        print(f"   Storage: {self.storage_dir}")
        print(f"   Telemetry: {self.telemetry_file}")
        print(f"   Output: {self.output_dir}")
        print()
        
        outputs = {}
        
        print("1️⃣  Comprehensive ML dataset...")
        outputs["ml_dataset"] = self.export_comprehensive_dataset()
        
        print("2️⃣  Trainer leaderboard...")
        outputs["trainer_leaderboard"] = self.export_trainer_leaderboard()
        
        print("3️⃣  Criteria difficulty analysis...")
        outputs["criteria_difficulty"] = self.export_criteria_difficulty()
        
        print("4️⃣  Model performance comparison...")
        outputs["model_performance"] = self.export_model_performance()
        
        print("5️⃣  API timing data...")
        outputs["api_timing"] = self.export_api_timing()
        
        # Write stats
        stats_file = self.output_dir / "export_stats.json"
        with open(stats_file, "w") as f:
            json.dump({
                **self.stats,
                "exported_at": datetime.utcnow().isoformat() + "Z",
                "files": {k: str(v) for k, v in outputs.items()}
            }, f, indent=2)
        outputs["stats"] = str(stats_file)
        
        # Calculate total size
        total_size = sum(Path(f).stat().st_size for f in outputs.values())
        
        print()
        print("=" * 50)
        print("✅ Export complete!")
        print(f"   Sessions processed: {self.stats['sessions_processed']}")
        print(f"   Hunt results: {self.stats['hunt_results_extracted']}")
        print(f"   Total breaks: {self.stats['total_breaks']}")
        print(f"   Unique trainers: {self.stats['unique_trainers']}")
        print(f"   Criteria samples: {self.stats['criteria_samples']}")
        print(f"   Total export size: {total_size / 1024 / 1024:.1f} MB")
        print(f"   Output directory: {self.output_dir}")
        print()
        print("📥 To download to your machine:")
        print(f"   scp -r mandy@YOUR_VM_IP:{self.output_dir} ./ml_data/")
        print()
        
        return outputs


def main():
    parser = argparse.ArgumentParser(description="Export Model Hunter data for ML (Colab)")
    parser.add_argument(
        "--storage", 
        default="/app/.storage",
        help="Path to session storage directory"
    )
    parser.add_argument(
        "--telemetry",
        default="/app/.telemetry/events.jsonl",
        help="Path to telemetry log file"
    )
    parser.add_argument(
        "--output",
        default="/tmp/ml_export",
        help="Output directory for ML datasets"
    )
    
    args = parser.parse_args()
    
    exporter = MLDataExporter(
        storage_dir=args.storage,
        telemetry_file=args.telemetry,
        output_dir=args.output
    )
    
    exporter.export_all()


if __name__ == "__main__":
    main()
