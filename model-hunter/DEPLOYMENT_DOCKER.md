# Model Hunter - Docker Deployment Guide

## Overview

This deployment uses Docker Compose with:
- **Redis** for session persistence (survives restarts)
- **Rate limiting** to prevent API overload
- **Connection pooling** for better performance
- **Zero-downtime deploys**

## Quick Start

### 1. Initial Setup (First Time Only)

```bash
# Install Docker and Docker Compose
# On Ubuntu/Debian:
sudo apt update
sudo apt install -y docker.io docker-compose
sudo usermod -aG docker $USER
# Log out and back in for group changes

# Clone the repo (if not already done)
git clone <your-repo-url>
cd model-hunter

# Create .env file with your API keys
cat > .env << EOF
OPENAI_API_KEY=your-openai-key
OPENROUTER_API_KEY=your-openrouter-key
FIREWORKS_API_KEY=your-fireworks-key
EOF
```

### 2. Start the Stack

```bash
# Start all services (Redis + App + Dashboard + Nginx)
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f model-hunter
```

### 3. Deploy Updates (Zero Downtime)

```bash
# Pull latest code and deploy
./deploy.sh
```

This script:
1. Pulls latest code from git
2. Builds new Docker images
3. Keeps Redis running (sessions preserved!)
4. Restarts only the app container
5. Verifies health before completing

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Docker Compose                        │
│                                                          │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐            │
│  │  Nginx   │──▶│ Model    │──▶│  Redis   │            │
│  │  :80     │   │ Hunter   │   │ :6379    │            │
│  └──────────┘   │ :8000    │   └──────────┘            │
│       │         └──────────┘         │                  │
│       │              │               │                  │
│       ▼              ▼               ▼                  │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐            │
│  │Dashboard │   │ Telemetry│   │ Session  │            │
│  │  :8001   │   │   Logs   │   │   Data   │            │
│  └──────────┘   └──────────┘   └──────────┘            │
└─────────────────────────────────────────────────────────┘
```

## Key Features

### Session Persistence (Redis)
- Sessions stored in Redis, survive app restarts
- 2-hour TTL with automatic refresh on access
- Automatic fallback to memory if Redis unavailable

### Rate Limiting
- Per-provider concurrency limits:
  - OpenRouter: 6 concurrent requests (default)
  - Fireworks: 4 concurrent requests (default)
  - OpenAI: 8 concurrent requests (default)
- Requests queue automatically when at limit
- Configurable via environment variables

### Connection Pooling
- HTTP/2 enabled for better performance
- Connection reuse (no TCP handshake per request)
- Automatic connection management

## Configuration

### Environment Variables

```bash
# API Keys (required)
OPENAI_API_KEY=sk-...
OPENROUTER_API_KEY=sk-or-...
FIREWORKS_API_KEY=...

# Redis (optional, defaults to internal)
REDIS_URL=redis://redis:6379/0

# Rate Limiting (optional, defaults shown)
OPENROUTER_CONCURRENCY=6
FIREWORKS_CONCURRENCY=4
OPENAI_CONCURRENCY=8
```

### Adjust Rate Limits

Edit `docker-compose.yml`:
```yaml
environment:
  - OPENROUTER_CONCURRENCY=10  # Increase for higher API tier
  - FIREWORKS_CONCURRENCY=6
```

## Monitoring

### Health Check
```bash
curl http://localhost:8000/api/health
```

### Detailed Status
```bash
curl http://localhost:8000/api/admin/status
```

### View Logs
```bash
# All services
docker-compose logs -f

# Just the app
docker-compose logs -f model-hunter

# Just Redis
docker-compose logs -f redis
```

### Dashboard
Visit `http://your-server/dashboard/` for the monitoring dashboard.

## Troubleshooting

### Redis Connection Issues
```bash
# Check Redis is running
docker-compose ps redis

# Check Redis health
docker-compose exec redis redis-cli ping
# Should return: PONG

# View Redis logs
docker-compose logs redis
```

### App Not Starting
```bash
# Check container logs
docker-compose logs model-hunter

# Check if port is in use
netstat -tlnp | grep 8000

# Restart just the app
docker-compose restart model-hunter
```

### High Memory Usage
```bash
# Check container stats
docker stats

# Redis memory (configured to max 256MB)
docker-compose exec redis redis-cli INFO memory
```

## Migration from Systemd

If currently running via systemd:

```bash
# Stop the systemd service
sudo systemctl stop model-hunter
sudo systemctl disable model-hunter

# Start with Docker
cd /path/to/model-hunter
docker-compose up -d
```

Note: First deploy will lose active sessions (unavoidable). After this, all sessions survive restarts.

## Rollback

If deployment fails:
```bash
# Check what went wrong
docker-compose logs model-hunter

# Rollback to previous image (if you tagged it)
docker-compose down
git checkout HEAD~1
docker-compose up -d --build
```
