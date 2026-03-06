#!/bin/bash
#
# STAGING Deploy — Zero-Downtime
#
# Deploys mth branch to STAGING (port 443). Does NOT touch production (port 80).
#
# Port reference (DO NOT MIX):
#   PRODUCTION (do not touch): port 80, app 8000/8002, dashboard 8001
#   STAGING (this script):     port 443, app 8010/8012, dashboard 8011
#
# Usage:
#   ./environments/staging/deploy.sh              # Full deploy to staging
#   ./environments/staging/deploy.sh --status     # Show staging container status
#   ./environments/staging/deploy.sh --frontend   # Frontend-only (just git pull)
#

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE="docker-compose --project-name staging-server -f $SCRIPT_DIR/docker-compose.yml --env-file $REPO_ROOT/.env"
BLUE_PORT=8010
GREEN_PORT=8012

show_status() {
    echo -e "${BLUE}╔═══════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║   Staging — Deployment Status         ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════╝${NC}"
    echo ""

    for name in model-hunter-staging-blue model-hunter-staging-green model-hunter-staging-nginx model-hunter-staging-redis model-hunter-staging-dashboard; do
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
    echo "  Staging URL: http://34.68.227.248:443/"
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
    echo -e "${BLUE}║   Staging — Zero-Downtime Deploy      ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  Ports: 443 (nginx), 8010/8012 (app), 8011 (dashboard)"
    echo -e "  Production (unchanged): 80, 8000/8002, 8001"
    echo ""

    mkdir -p "$REPO_ROOT/.storage-staging"

    echo -e "${YELLOW}[1/5] Pulling latest code...${NC}"
    cd "$REPO_ROOT" && git pull origin mth
    echo -e "${GREEN}  Code updated.${NC}"
    echo ""

    echo -e "${YELLOW}[2/5] Rebuilding staging-green...${NC}"
    $COMPOSE up -d --build --no-deps model-hunter-green
    echo ""

    echo -e "${YELLOW}[3/5] Health checking staging-green...${NC}"
    if ! wait_healthy $GREEN_PORT "staging-green"; then
        echo -e "${RED}Staging-green failed. Staging-blue still serving. Deploy aborted.${NC}"
        exit 1
    fi
    echo ""

    echo -e "${YELLOW}[4/5] Rebuilding staging-blue...${NC}"
    $COMPOSE up -d --build --no-deps model-hunter-blue
    echo ""

    echo -e "${YELLOW}[5/5] Health checking staging-blue...${NC}"
    if ! wait_healthy $BLUE_PORT "staging-blue"; then
        echo -e "${RED}Staging-blue failed. Staging-green is serving.${NC}"
        exit 1
    fi
    echo ""

    $COMPOSE exec -T nginx nginx -s reload 2>/dev/null || true

    echo -e "${GREEN}╔═══════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║   Staging Deploy Complete             ║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  Staging:    http://34.68.227.248:443/"
    echo -e "  Production: http://34.68.227.248/ (unchanged)"
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
