#!/bin/bash
#
# Zero-Downtime Deploy Script
#
# The app is stateless — all state lives in Redis.
# Nginx load-balances between blue and green.
# Deploy = rebuild one container at a time.
# Trainers see zero disruption (SSE auto-reconnects via Redis Streams).
#
# Usage:
#   ./deploy.sh              # Full deploy (pull + rebuild both)
#   ./deploy.sh --status     # Show container status
#   ./deploy.sh --frontend   # Frontend-only (just git pull, no rebuild)
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

COMPOSE_FILE="docker-compose.yml"
BLUE_PORT=8000
GREEN_PORT=8002

cd "$(dirname "$0")"

# ---- Status ----
show_status() {
    echo -e "${BLUE}╔═══════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║   Model Hunter — Deployment Status    ║${NC}"
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

# ---- Health check ----
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

# ---- Frontend-only deploy ----
deploy_frontend() {
    echo -e "${YELLOW}[1/1] Pulling latest code (frontend-only)...${NC}"
    cd .. && git pull origin main && cd model-hunter
    echo -e "${GREEN}Done. Static files are volume-mounted — changes are live immediately.${NC}"
}

# ---- Full deploy ----
deploy_full() {
    echo -e "${BLUE}╔═══════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║   Zero-Downtime Deploy                ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════╝${NC}"
    echo ""

    # Step 1: Pull latest code
    echo -e "${YELLOW}[1/5] Pulling latest code...${NC}"
    cd .. && git pull origin main && cd model-hunter
    echo -e "${GREEN}  Code updated.${NC}"
    echo ""

    # Step 2: Rebuild and restart GREEN (blue stays up, serves all traffic)
    echo -e "${YELLOW}[2/5] Rebuilding green...${NC}"
    docker-compose -f $COMPOSE_FILE up -d --build --no-deps model-hunter-green
    echo ""

    # Step 3: Wait for green to be healthy
    echo -e "${YELLOW}[3/5] Health checking green...${NC}"
    if ! wait_healthy $GREEN_PORT "green"; then
        echo -e "${RED}Green failed health check. Blue is still serving. Deploy aborted.${NC}"
        exit 1
    fi
    echo ""

    # Step 4: Rebuild and restart BLUE (green is now up, serves traffic)
    echo -e "${YELLOW}[4/5] Rebuilding blue...${NC}"
    docker-compose -f $COMPOSE_FILE up -d --build --no-deps model-hunter-blue
    echo ""

    # Step 5: Wait for blue to be healthy
    echo -e "${YELLOW}[5/5] Health checking blue...${NC}"
    if ! wait_healthy $BLUE_PORT "blue"; then
        echo -e "${RED}Blue failed health check. Green is serving. Manual intervention needed.${NC}"
        exit 1
    fi
    echo ""

    # Reload nginx to pick up fresh container IPs
    docker-compose -f $COMPOSE_FILE exec -T nginx nginx -s reload 2>/dev/null || true

    echo -e "${GREEN}╔═══════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║   Deploy Complete — Zero Downtime     ║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  Both containers running new code."
    echo -e "  Trainers experienced zero disruption."
    echo ""
}

# ---- Parse args ----
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
