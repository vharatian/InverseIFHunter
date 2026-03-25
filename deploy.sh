#!/bin/bash
set -euo pipefail

echo "========================================="
echo "  Model Hunter — Production Deploy"
echo "========================================="

COMPOSE_FILE="docker-compose.prod.yml"

echo ""
echo "[1/5] Building new images..."
docker compose -f $COMPOSE_FILE build

echo ""
echo "[2/5] Creating backup directory..."
mkdir -p backups/wal backups/daily

echo ""
echo "[3/5] Rolling update (one service at a time)..."
docker compose -f $COMPOSE_FILE up -d --no-deps postgres redis
echo "  Waiting for database..."
sleep 5

docker compose -f $COMPOSE_FILE up -d --no-deps python-core
echo "  Waiting for python-core..."
sleep 5

docker compose -f $COMPOSE_FILE up -d --no-deps python-dashboard
docker compose -f $COMPOSE_FILE up -d --no-deps elixir-edge
echo "  Waiting for elixir-edge..."
sleep 5

docker compose -f $COMPOSE_FILE up -d --no-deps traefik prometheus grafana

echo ""
echo "[4/5] Verifying health..."
sleep 5

HEALTH=$(curl -sf http://localhost:4000/health/ready 2>/dev/null || echo '{"status":"error"}')
echo "  Health check: $HEALTH"

if echo "$HEALTH" | grep -q '"ready"'; then
    echo "  ✓ Health check PASSED"
else
    echo "  ✗ Health check FAILED — check logs with: docker compose -f $COMPOSE_FILE logs"
    exit 1
fi

echo ""
echo "[5/5] Cleanup old images..."
docker image prune -f

echo ""
echo "========================================="
echo "  Deploy complete!"
echo "========================================="
echo ""
echo "Services:"
docker compose -f $COMPOSE_FILE ps --format "table {{.Service}}\t{{.Status}}\t{{.Ports}}"
