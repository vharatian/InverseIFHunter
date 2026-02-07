# Model Hunter

A web-based red-teaming tool for LLM models. Model Hunter automates the process of finding **breaking responses** — cases where language models fail evaluation criteria.

## How It Works

1. **Load** a Colab notebook containing prompts, reference responses, and evaluation criteria
2. **Hunt** — send prompts in parallel to target LLM models (Nemotron, Qwen)
3. **Judge** — GPT-5 automatically evaluates each response against criteria (pass/fail per criterion)
4. **Review** — blind human judging workflow for the worst responses
5. **Save** — results written back to the Colab notebook

A response that fails >50% of criteria is scored as **breaking** (score 0).

## Architecture

- **Backend**: FastAPI + SSE streaming for real-time hunt progress
- **Frontend**: Single-page app with blind review workflow
- **Judge**: GPT-5 with independent per-criterion evaluation
- **Models**: OpenRouter (Nemotron, Qwen) and Fireworks AI
- **Storage**: Redis sessions (with in-memory fallback), Google Drive for notebooks
- **Dashboard**: Real-time monitoring with trainer leaderboard, criteria analysis, cost tracking
- **Deployment**: Docker with blue-green zero-downtime deploys

## Quick Start

```bash
cd model-hunter

# Set environment variables
export OPENAI_API_KEY=...
export OPENROUTER_API_KEY=...

# Run with Docker
docker-compose up --build
```

App runs on `http://localhost:8000`, dashboard on `http://localhost:8001`.

## Project Structure

```
model-hunter/
├── main.py                      # FastAPI app, API endpoints, session management
├── models/schemas.py            # Pydantic models
├── services/
│   ├── hunt_engine.py           # Parallel hunt orchestration
│   ├── notebook_parser.py       # .ipynb parsing and export
│   ├── openai_client.py         # GPT-5 judge
│   ├── openrouter_client.py     # OpenRouter API (Nemotron, Qwen)
│   ├── fireworks_client.py      # Fireworks AI API
│   ├── base_client.py           # Shared HTTP client with retries
│   ├── google_drive_client.py   # Google Drive read/write
│   ├── session_store.py         # Redis-backed sessions
│   ├── rate_limiter.py          # Per-provider rate limiting
│   └── telemetry_logger.py      # Event logging for dashboard
├── static/                      # Frontend (app.js, index.html, style.css)
├── dashboard/                   # Monitoring dashboard (v2 enhanced)
├── docker-compose.yml           # Blue-green deploy with Redis + Nginx
└── deploy-blue-green.sh         # Zero-downtime deployment script
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key for GPT-5 judge |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key for model calls |
| `FIREWORKS_API_KEY` | No | Fireworks AI API key |
| `REDIS_URL` | No | Redis URL (default: `redis://localhost:6379/0`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON_PATH` | No | Path to service account JSON |
