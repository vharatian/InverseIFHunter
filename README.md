# Model Hunter

Red-team LLM models with parallel hunts and automated judging.

## Architecture

- **Python/FastAPI** — Business logic, LLM orchestration, session CRUD, background workers
- **Elixir/Phoenix** — Real-time edge (WebSocket, SSE, presence, connection management)
- **PostgreSQL** — Primary database (sessions, hunt results, telemetry, notifications)
- **Redis** — Cache, pub/sub bridge between Python and Elixir, task queue

## Quick Start (Local Development)

### Prerequisites

- Python 3.11+
- Elixir 1.17+ / Erlang/OTP 27+
- PostgreSQL 16+
- Redis 7+

### Setup

```bash
# Install Python dependencies
pip install -r requirements.txt

# Start PostgreSQL and Redis (via Homebrew or Docker)
brew services start postgresql@16
brew services start redis

# Create database
createuser -s mh
createdb -O mh model_hunter
psql -U mh -d model_hunter -c "ALTER USER mh WITH PASSWORD 'mh_dev'"

# Run migrations
alembic upgrade head

# Migrate existing data (if coming from SQLite)
python scripts/migrate_to_pg.py

# Start Python API
uvicorn main:app --port 8000 --reload

# Start Elixir edge (separate terminal)
cd elixir-edge && mix deps.get && mix phx.server
```

### Docker Compose (Alternative)

```bash
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml up
```

## Production Deployment

```bash
# Configure environment
cp .env.example.prod .env
# Edit .env with production values

# Deploy
./deploy.sh
```

See [design spec](docs/plans/2026-03-25-backend-restructure-design.md) for full architecture details.

## Project Structure

```
├── main.py                  # FastAPI entry point
├── database.py              # PostgreSQL async engine
├── redis_client.py          # Shared Redis connection pool
├── config.py                # Configuration interface
├── middleware/               # Trace ID, error handling
├── resilience/              # Circuit breaker, health checks
├── providers/               # LLM clients (OpenRouter, OpenAI, Fireworks)
├── modules/review/          # Reviewer routes (absorbed from reviewer-app)
├── routes/                  # API route handlers
├── services/                # Business logic services
├── models/                  # Pydantic schemas + SQLAlchemy ORM models
├── agentic_reviewer/        # QC rules engine, council, notifications
├── elixir-edge/             # Phoenix real-time service
├── dashboard/               # Analytics dashboard (separate FastAPI app)
├── monitoring/              # Prometheus + Grafana configs
├── migrations/              # Alembic database migrations
├── tests/                   # Unit + integration tests
├── docker-compose.dev.yml   # Local development stack
├── docker-compose.prod.yml  # Production stack (Traefik, PG, Redis, Grafana)
└── deploy.sh                # Production deployment script
```

## Health Checks

- `GET /health/live` — Is the process running?
- `GET /health/ready` — Can it serve requests? (checks PostgreSQL + Redis)
- `GET /health/deep` — Full diagnostics (provider circuit breakers, worker status)

## Monitoring

Production includes Prometheus + Grafana with 5 pre-configured dashboards:
1. Overview (requests, errors, latency)
2. Hunts (progress, provider comparison, tokens)
3. Real-time (connections, presence, events)
4. Infrastructure (database, Redis, containers)
5. Errors & Resolution (error rates, dead letter queue)
