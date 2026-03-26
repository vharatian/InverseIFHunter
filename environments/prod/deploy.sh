#!/bin/bash
# ⚠️  DEPRECATED — Use the unified deploy script instead:
#     cd /path/to/repo && ./deploy.sh production
#
# This script is kept for backward compatibility.
# See DEPLOYMENT.md for the new workflow.
#
# PRODUCTION Deploy — Zero-Downtime
#
# The app is stateless — all state lives in Redis.
# Nginx load-balances between blue and green with automatic failover.
# Deploy = rebuild one container at a time. Nginx retries on the healthy one.
#
# Usage:
#   ./environments/prod/deploy.sh              # Full deploy (pull + rebuild both)
#   ./environments/prod/deploy.sh --status     # Show container status
#   ./environments/prod/deploy.sh --frontend   # Frontend-only (just git pull, no rebuild)
#

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE="docker-compose --project-name prod-server -f $SCRIPT_DIR/docker-compose.yml --env-file $REPO_ROOT/.env"
BLUE_PORT=8000
GREEN_PORT=8002

show_status() {
    echo -e "${BLUE}╔═══════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║   Production — Deployment Status      ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════╝${NC}"
    echo ""

    for name in model-hunter-blue model-hunter-green model-hunter-nginx model-hunter-redis model-hunter-dashboard; do
        local status
        status=$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo "not running")
        local health
        health=$(docker inspect -f '{{.State.Health.Status}}' "$name" 2>/dev/null || echo "n/a")

        if [ "$status" = "running" ]; then
            echo -e "  ${GREEN}●${NC} $name  ${GREEN}$status${NC}  (health: $health)"
        else
            echo -e "  ${RED}●${NC} $name  ${RED}$status${NC}"
        fi
    done
    echo ""
}

wait_healthy() {
    local port=$1
    local name=$2
    local max_attempts=20

    echo -ne "  Waiting for $name (port $port)..."
    for i in $(seq 1 $max_attempts); do
        local code
        code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${port}/api/health" 2>/dev/null || echo "000")
        if [ "$code" = "200" ]; then
            echo -e " ${GREEN}healthy${NC} (attempt $i)"
            return 0
        fi
        echo -n "."
        sleep 3
    done
    echo -e " ${RED}FAILED after $max_attempts attempts${NC}"
    return 1
}

deploy_frontend() {
    echo -e "${YELLOW}[1/1] Pulling latest code (frontend-only)...${NC}"
    cd "$REPO_ROOT" && git pull origin mth
    echo -e "${GREEN}Done. Static files are volume-mounted — changes are live immediately.${NC}"
}

deploy_full() {
    echo -e "${BLUE}╔═══════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║   Production — Zero-Downtime Deploy   ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════╝${NC}"
    echo ""

    echo -e "${YELLOW}[1/5] Pulling latest code...${NC}"
    cd "$REPO_ROOT" && git pull origin mth
    echo -e "${GREEN}  Code updated.${NC}"
    echo ""

    echo -e "${YELLOW}[2/5] Rebuilding green...${NC}"
    $COMPOSE up -d --build --no-deps model-hunter-green
    echo ""

    echo -e "${YELLOW}[3/5] Health checking green...${NC}"
    if ! wait_healthy $GREEN_PORT "green"; then
        echo -e "${RED}Green failed health check. Blue is still serving. Deploy aborted.${NC}"
        exit 1
    fi
    echo ""

    echo -e "${YELLOW}[4/5] Rebuilding blue...${NC}"
    $COMPOSE up -d --build --no-deps model-hunter-blue
    echo ""

    echo -e "${YELLOW}[5/5] Health checking blue...${NC}"
    if ! wait_healthy $BLUE_PORT "blue"; then
        echo -e "${RED}Blue failed health check. Green is serving. Manual intervention needed.${NC}"
        exit 1
    fi
    echo ""

    $COMPOSE exec -T nginx nginx -s reload 2>/dev/null || true

    echo -e "${GREEN}╔═══════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║   Production Deploy Complete          ║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  Both containers running new code."
    echo -e "  Trainers experienced zero disruption."
    echo ""
}

case "${1:-}" in
    --status)
        show_status
        ;;
    --frontend)
        deploy_frontend
        ;;
    *)
        deploy_full
        ;;
esac
