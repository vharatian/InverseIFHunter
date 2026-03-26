#!/bin/bash
set -euo pipefail

# =========================================
# Model Hunter — Unified Deploy Script
# =========================================
# Usage:
#   ./deploy.sh staging        Deploy staging stack
#   ./deploy.sh production     Deploy production stack
#   ./deploy.sh status <env>   Show stack status
#   ./deploy.sh logs <env>     Tail logs
#   ./deploy.sh down <env>     Stop stack
# =========================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

COMPOSE_FILE="docker-compose.prod.yml"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Resolve environment ---
resolve_env() {
    local env="${1:-}"
    case "$env" in
        staging|stg|s)
            ENV_NAME="staging"
            ENV_FILE=".env.staging"
            PROJECT="mh-staging"
            ;;
        production|prod|p)
            ENV_NAME="production"
            ENV_FILE=".env.production"
            PROJECT="mh-production"
            ;;
        *)
            echo -e "${RED}Usage: $0 {staging|production} or {status|logs|down} {staging|production}${NC}"
            echo ""
            echo "  $0 staging        Deploy staging"
            echo "  $0 production     Deploy production"
            echo "  $0 status staging Show staging status"
            echo "  $0 logs staging   Tail staging logs"
            echo "  $0 down staging   Stop staging stack"
            exit 1
            ;;
    esac

    if [ ! -f "$SCRIPT_DIR/$ENV_FILE" ]; then
        echo -e "${RED}Error: $ENV_FILE not found.${NC}"
        echo "Copy the template: cp ${ENV_FILE/%.env/.env}.example $ENV_FILE"
        echo "Then edit it with your values."
        exit 1
    fi

    COMPOSE="docker compose -p $PROJECT -f $SCRIPT_DIR/$COMPOSE_FILE --env-file $SCRIPT_DIR/$ENV_FILE"
}

# --- Commands ---

show_status() {
    resolve_env "$1"
    echo -e "${BLUE}=== $ENV_NAME Status ===${NC}"
    $COMPOSE ps --format "table {{.Service}}\t{{.Status}}\t{{.Ports}}"
}

show_logs() {
    resolve_env "$1"
    $COMPOSE logs -f --tail 50
}

stop_stack() {
    resolve_env "$1"
    echo -e "${YELLOW}Stopping $ENV_NAME stack...${NC}"
    $COMPOSE down
    echo -e "${GREEN}$ENV_NAME stopped.${NC}"
}

deploy() {
    resolve_env "$1"

    echo -e "${BLUE}=========================================${NC}"
    echo -e "${BLUE}  Model Hunter — $ENV_NAME Deploy${NC}"
    echo -e "${BLUE}=========================================${NC}"
    echo ""

    # 1. Pull latest code
    echo -e "${YELLOW}[1/6] Pulling latest code...${NC}"
    cd "$SCRIPT_DIR" && git pull origin mth 2>/dev/null || echo "  (git pull skipped or failed — continuing with local code)"
    echo ""

    # 2. Create backup directories
    echo -e "${YELLOW}[2/6] Creating backup directories...${NC}"
    mkdir -p backups/wal backups/daily
    echo ""

    # 3. Build images
    echo -e "${YELLOW}[3/6] Building images...${NC}"
    $COMPOSE build
    echo ""

    # 4. Rolling update
    echo -e "${YELLOW}[4/6] Rolling update...${NC}"
    $COMPOSE up -d --no-deps postgres redis
    echo "  Waiting for database + redis..."
    sleep 5

    $COMPOSE up -d --no-deps python-core
    echo "  Waiting for python-core..."
    sleep 5

    $COMPOSE up -d --no-deps python-dashboard
    $COMPOSE up -d --no-deps elixir-edge
    echo "  Waiting for elixir-edge..."
    sleep 5

    $COMPOSE up -d --no-deps traefik prometheus grafana
    echo ""

    # 5. Health check
    echo -e "${YELLOW}[5/6] Verifying health...${NC}"
    sleep 5

    # Read ELIXIR_PORT from env file for health check
    local elixir_port
    elixir_port=$(grep -E "^ELIXIR_PORT=" "$SCRIPT_DIR/$ENV_FILE" | cut -d= -f2 || echo "4000")
    elixir_port="${elixir_port:-4000}"

    local health
    health=$(curl -sf "http://localhost:${elixir_port}/health/ready" 2>/dev/null || echo '{"status":"error"}')
    echo "  Health: $health"

    if echo "$health" | grep -q '"ready"'; then
        echo -e "  ${GREEN}✓ Health check PASSED${NC}"
    else
        echo -e "  ${RED}✗ Health check FAILED${NC}"
        echo "  Check logs: $0 logs $ENV_NAME"
        exit 1
    fi
    echo ""

    # 6. Cleanup
    echo -e "${YELLOW}[6/6] Cleaning up old images...${NC}"
    docker image prune -f
    echo ""

    echo -e "${GREEN}=========================================${NC}"
    echo -e "${GREEN}  $ENV_NAME deploy complete!${NC}"
    echo -e "${GREEN}=========================================${NC}"
    echo ""
    $COMPOSE ps --format "table {{.Service}}\t{{.Status}}\t{{.Ports}}"
}

# --- Main ---
case "${1:-}" in
    status)
        show_status "${2:-}"
        ;;
    logs)
        show_logs "${2:-}"
        ;;
    down)
        stop_stack "${2:-}"
        ;;
    *)
        deploy "${1:-}"
        ;;
esac
