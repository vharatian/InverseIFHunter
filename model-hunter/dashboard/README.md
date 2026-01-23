# Model Hunter Dashboard

A monitoring dashboard for Model Hunter that displays real-time usage statistics, API call metrics, and hunt results.

## Quick Start

1. **Start the main Model Hunter app** (if not already running):
   ```bash
   cd model-hunter
   python main.py
   ```
   This runs on port 8000.

2. **Start the Dashboard** (in a separate terminal):
   ```bash
   cd model-hunter/dashboard
   python main.py
   ```
   This runs on port 8001.

3. **Open the Dashboard**:
   - Go to http://localhost:8001

## What It Shows

- **Active Sessions** - Users active in the last 5 minutes
- **Total Hunts** - Number of hunts run
- **API Calls** - Calls to OpenRouter, Fireworks, OpenAI
- **Avg Latency** - Average API response time
- **Breaks Found** - Model breaking responses found
- **Failed Calls** - API errors

Plus:
- Activity timeline chart
- Model usage breakdown
- Live event feed
- Recent sessions list
- Model performance table

## How It Works

1. The main Model Hunter app writes telemetry events to `.telemetry/events.jsonl`
2. The dashboard reads this log file and aggregates metrics
3. Dashboard auto-refreshes every 30 seconds

## Configuration

Environment variables:
- `DASHBOARD_PORT` - Port to run on (default: 8001)
- `TELEMETRY_LOG_PATH` - Custom path to log file (default: `.telemetry/events.jsonl`)

## Files

```
dashboard/
  main.py           # FastAPI dashboard server
  log_reader.py     # Log file parser and aggregator
  requirements.txt  # Dependencies (fastapi, uvicorn)
  static/
    index.html      # Dashboard UI
    style.css       # Styling
    dashboard.js    # Client-side JavaScript
```

## Notes

- Dashboard is read-only - it only reads log files
- If dashboard crashes or restarts, the main app continues unaffected
- Logs are automatically rotated (keeps last 7 days)
