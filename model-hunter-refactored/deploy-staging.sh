#!/bin/bash
#
# Staging Deploy Script — does NOT touch production.
# Deploys from staging branch to port 8080.
#
# Usage:
#   ./deploy-staging.sh              # Full deploy (pull staging + rebuild)
#   ./deploy-staging.sh --status     # Show staging container status
#   ./deploy-staging.sh --frontend   # Frontend-only (git pull, no rebuild)
#

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

COMPOSE_FILE="docker-compose.staging.yml"
PROJECT="model-hunter-staging"
BLUE_PORT=8010
GREEN_PORT=8012

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

show_status() {
    echo -e "${BLUE}╔═══════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║   Model Hunter — STAGING Status      ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════╝${NC}"
    echo ""

    for name in model-hunter-staging-blue model-hunter-staging-green model-hunter-staging-nginx model-hunter-staging-redis model-hunter-staging-dashboard; do
        status=$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo "not running")
        health=$(docker inspect -f '{{.State.Health.Status}}' "$name" 2>/dev/null || echo "n/a")

        if [ "$status" = "running" ]; then
            echo -e "  ${GREEN}●${NC} $name  ${GREEN}$status${NC}  (health: $health)"
        else
            echo -e "  ${RED}●${NC} $name  ${RED}$status${NC}"
        fi
    done
    echo ""
    echo -e "  Staging URL: ${BLUE}http://<vm-ip>:8080${NC}"
    echo ""
}

wait_healthy() {
    local port=$1
    local name=$2
    local max_attempts=20

    echo -ne "  Waiting for $name (port $port)..."
    for i in $(seq 1 $max_attempts); do
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
    echo -e "${YELLOW}[1/1] Pulling staging branch (frontend-only)...${NC}"
    cd "$SCRIPT_DIR/.." && git fetch origin staging && git checkout staging && git pull origin staging && cd "$SCRIPT_DIR"
    echo -e "${GREEN}Done. Static files are volume-mounted — changes are live immediately.${NC}"
}

deploy_full() {
    echo -e "${BLUE}╔═══════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║   Staging Deploy (branch: staging)   ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════╝${NC}"
    echo ""

    echo -e "${YELLOW}[1/5] Pulling staging branch...${NC}"
    cd "$SCRIPT_DIR/.." && git fetch origin staging && git checkout staging && git pull origin staging && cd "$SCRIPT_DIR"
    echo -e "${GREEN}  Code updated.${NC}"
    echo ""

    echo -e "${YELLOW}[2/5] Rebuilding green...${NC}"
    docker-compose -p $PROJECT -f $COMPOSE_FILE up -d --build --no-deps model-hunter-green
    echo ""

    echo -e "${YELLOW}[3/5] Health checking green...${NC}"
    if ! wait_healthy $GREEN_PORT "green"; then
        echo -e "${RED}Green failed. Blue still serving. Deploy aborted.${NC}"
        exit 1
    fi
    echo ""

    echo -e "${YELLOW}[4/5] Rebuilding blue...${NC}"
    docker-compose -p $PROJECT -f $COMPOSE_FILE up -d --build --no-deps model-hunter-blue
    echo ""

    echo -e "${YELLOW}[5/5] Health checking blue...${NC}"
    if ! wait_healthy $BLUE_PORT "blue"; then
        echo -e "${RED}Blue failed. Green is serving. Manual intervention needed.${NC}"
        exit 1
    fi
    echo ""

    docker-compose -p $PROJECT -f $COMPOSE_FILE exec -T nginx nginx -s reload 2>/dev/null || true

    echo -e "${GREEN}╔═══════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║   Staging Deploy Complete             ║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  Staging: ${BLUE}http://$(hostname -I 2>/dev/null | awk '{print $1}'):8080${NC}"
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
