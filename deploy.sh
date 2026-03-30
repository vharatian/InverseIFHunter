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

# Docker Compose reads --env-file for ${VAR} interpolation; exported shell vars override those values.
# Normalize DOMAIN when operators paste a full URL into DOMAIN= (Traefik Host() must be host/IP only).
_compose_normalize_domain_from_env_file() {
    local f="$SCRIPT_DIR/${ENV_FILE:-}"
    [ -n "${ENV_FILE:-}" ] && [ -f "$f" ] || return 0
    local raw
    raw=$(grep -E '^[[:space:]]*DOMAIN=' "$f" | tail -1 | cut -d= -f2- || true)
    raw="${raw%$'\r'}"
    case "$raw" in
        \"*\") raw="${raw#\"}"; raw="${raw%\"}" ;;
        \'*\') raw="${raw#\'}"; raw="${raw%\'}" ;;
    esac
    [ -n "$raw" ] || return 0
    local host="${raw#http://}"
    host="${host#https://}"
    host="${host#HTTP://}"
    host="${host#HTTPS://}"
    host="${host%%/*}"
    if [ "$host" != "$raw" ]; then
        echo -e "${YELLOW}  DOMAIN was a URL; using host only for Traefik/compose: ${host}${NC}" >&2
    fi
    export DOMAIN="$host"
    if [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ "${ENV_NAME:-}" = "staging" ] \
        && ! grep -q '^STAGING_COMPOSE_OVERRIDE=1' "$f" 2>/dev/null; then
        echo -e "${YELLOW}  Staging DOMAIN is an IP: set EDGE_PATH_PREFIX=/staging (etc.) and STAGING_COMPOSE_OVERRIDE=1 if you serve under a path prefix.${NC}" >&2
    fi
}

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
}

# Use Compose V2 plugin if present; otherwise standalone docker-compose (avoids
# "unknown shorthand flag: 'p' in -p" when `docker compose` is not installed).
run_compose() {
    _compose_normalize_domain_from_env_file
    local -a _files=( -f "$SCRIPT_DIR/$COMPOSE_FILE" )
    if [ "${ENV_NAME:-}" = "staging" ] && [ -f "$SCRIPT_DIR/docker-compose.staging-overrides.yml" ] \
        && grep -q '^STAGING_COMPOSE_OVERRIDE=1' "$SCRIPT_DIR/$ENV_FILE" 2>/dev/null; then
        _files+=( -f "$SCRIPT_DIR/docker-compose.staging-overrides.yml" )
    fi
    if docker compose version &>/dev/null; then
        docker compose -p "$PROJECT" "${_files[@]}" --env-file "$SCRIPT_DIR/$ENV_FILE" "$@"
    elif command -v docker-compose &>/dev/null; then
        docker-compose --project-name "$PROJECT" "${_files[@]}" --env-file "$SCRIPT_DIR/$ENV_FILE" "$@"
    else
        echo -e "${RED}Docker Compose not found.${NC}"
        echo "  Debian/Ubuntu: sudo apt-get install -y docker-compose-plugin"
        echo "  Then: docker compose version"
        exit 1
    fi
}

# --- Commands ---

show_status() {
    resolve_env "$1"
    echo -e "${BLUE}=== $ENV_NAME Status ===${NC}"
    run_compose ps --format "table {{.Service}}\t{{.Status}}\t{{.Ports}}"
}

show_logs() {
    resolve_env "$1"
    run_compose logs -f --tail 50
}

stop_stack() {
    resolve_env "$1"
    echo -e "${YELLOW}Stopping $ENV_NAME stack...${NC}"
    run_compose down
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

    # 2. Create backup directories (WAL lives in Docker volume pg_wal_archive; daily dumps use host dir)
    echo -e "${YELLOW}[2/6] Creating backup directories...${NC}"
    mkdir -p backups/daily
    if chown -R 70:70 "$SCRIPT_DIR/backups" 2>/dev/null; then
        echo "  backups/daily ownership set for postgres (uid 70) if you dump into that path"
    fi
    echo ""

    # 3. Build images
    echo -e "${YELLOW}[3/6] Building images...${NC}"
    run_compose build
    echo ""

    # 4. Rolling update
    echo -e "${YELLOW}[4/6] Rolling update...${NC}"
    run_compose up -d --no-deps postgres redis
    echo "  Waiting for database + redis..."
    sleep 5

    run_compose up -d --no-deps python-core
    echo "  Waiting for python-core..."
    sleep 5

    run_compose up -d --no-deps python-dashboard
    run_compose up -d --no-deps elixir-edge
    echo "  Waiting for elixir-edge..."
    sleep 5

    run_compose up -d --no-deps traefik prometheus grafana
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
    run_compose ps --format "table {{.Service}}\t{{.Status}}\t{{.Ports}}"
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
