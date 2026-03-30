#!/bin/bash
set -euo pipefail

# =========================================
# Model Hunter — Unified Deploy Script
# =========================================
# Usage:
#   ./deploy.sh staging [options]     Deploy staging stack
#   ./deploy.sh production [options]  Deploy production stack
#   ./deploy.sh status <env>          Show stack status
#   ./deploy.sh logs <env>            Tail logs
#   ./deploy.sh down <env>            Stop stack
#
# Deploy options:
#   --quick / --no-build   Skip image build + prune (reuse cached images; fast config-only / code-on-volume cases)
#   --no-pull              Skip git pull
#   --no-prune             Skip docker image prune after deploy
#
# Tip: set DOCKER_BUILDKIT=1 (default below) for faster layer caching; keep dependency files
# (requirements.txt, mix.lock) before COPY . in Dockerfiles; use .dockerignore to shrink context.
# =========================================

export DOCKER_BUILDKIT=${DOCKER_BUILDKIT:-1}
export COMPOSE_DOCKER_CLI_BUILD=${COMPOSE_DOCKER_CLI_BUILD:-1}

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
            echo -e "${RED}Usage: $0 {staging|production} [opts] | {status|logs|down} {staging|production}${NC}"
            echo ""
            echo "  $0 staging [--quick] [--no-pull] [--no-prune]"
            echo "  $0 production [--quick] [--no-pull] [--no-prune]"
            echo "  $0 status staging"
            echo "  $0 logs staging"
            echo "  $0 down staging"
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
    # docker-compose v1 does not support `ps --format` (breaks with "Usage: ps ...")
    if docker compose version &>/dev/null; then
        run_compose ps --format "table {{.Service}}\t{{.Status}}\t{{.Ports}}"
    else
        run_compose ps
    fi
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

_compose_ps_table() {
    if docker compose version &>/dev/null; then
        run_compose ps --format "table {{.Service}}\t{{.Status}}\t{{.Ports}}"
    else
        run_compose ps
    fi
}

_build_images() {
    if docker compose version &>/dev/null; then
        run_compose build --parallel
    else
        run_compose build --parallel 2>/dev/null || run_compose build
    fi
}

_wait_health_ready() {
    local elixir_port="$1"
    local max_attempts="${2:-45}"
    local i
    for ((i = 1; i <= max_attempts; i++)); do
        local health
        health=$(curl -sf "http://127.0.0.1:${elixir_port}/health/ready" 2>/dev/null || true)
        if echo "$health" | grep -q '"ready"'; then
            echo "  Health: $health"
            return 0
        fi
        sleep 1
    done
    return 1
}

deploy() {
    [[ $# -ge 1 ]] || {
        echo -e "${RED}Usage: $0 staging|production [--quick] [--no-pull] [--no-prune]${NC}"
        exit 1
    }
    local env_arg="$1"
    shift
    local quick=0 no_pull=0 no_prune=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --quick | --no-build) quick=1 ;;
            --no-pull) no_pull=1 ;;
            --no-prune) no_prune=1 ;;
            *)
                echo -e "${RED}Unknown option: $1${NC}"
                echo "  Use: --quick, --no-pull, --no-prune"
                exit 1
                ;;
        esac
        shift
    done

    resolve_env "$env_arg"

    echo -e "${BLUE}=========================================${NC}"
    echo -e "${BLUE}  Model Hunter — $ENV_NAME Deploy${NC}"
    if [[ "$quick" -eq 1 ]]; then
        echo -e "${BLUE}  (quick: no image build)${NC}"
    fi
    echo -e "${BLUE}=========================================${NC}"
    echo ""

    # 1. Pull latest code (tracking branch)
    if [[ "$no_pull" -eq 0 ]]; then
        echo -e "${YELLOW}[1/5] Git pull (tracking branch)...${NC}"
        cd "$SCRIPT_DIR" && git pull --ff-only 2>/dev/null || echo "  (git pull skipped or failed — continuing with local code)"
    else
        echo -e "${YELLOW}[1/5] Skipping git pull (--no-pull)${NC}"
    fi
    echo ""

    # 2. Backup dirs
    echo -e "${YELLOW}[2/5] Backup directories...${NC}"
    mkdir -p backups/daily
    if chown -R 70:70 "$SCRIPT_DIR/backups" 2>/dev/null; then
        echo "  backups/daily ownership set for postgres (uid 70) if you dump into that path"
    fi
    echo ""

    # 3. Build images
    if [[ "$quick" -eq 1 ]]; then
        echo -e "${YELLOW}[3/5] Skipping image build (--quick)${NC}"
    else
        echo -e "${YELLOW}[3/5] Building images...${NC}"
        _build_images
    fi
    echo ""

    # 4. Start / recreate stack (compose orders services via depends_on)
    echo -e "${YELLOW}[4/5] Starting stack (docker compose up -d)...${NC}"
    run_compose up -d
    echo ""

    # 5. Health check (retry; avoids long fixed sleeps)
    echo -e "${YELLOW}[5/5] Verifying health...${NC}"
    local elixir_port
    elixir_port=$(grep -E "^ELIXIR_PORT=" "$SCRIPT_DIR/$ENV_FILE" | cut -d= -f2 || echo "4000")
    elixir_port="${elixir_port:-4000}"

    if _wait_health_ready "$elixir_port" 60; then
        echo -e "  ${GREEN}✓ Health check PASSED${NC}"
    else
        local health
        health=$(curl -sf "http://127.0.0.1:${elixir_port}/health/ready" 2>/dev/null || echo '{"status":"error"}')
        echo "  Health: $health"
        echo -e "  ${RED}✗ Health check FAILED${NC}"
        echo "  Check logs: $0 logs $ENV_NAME"
        exit 1
    fi
    echo ""

    if [[ "$quick" -eq 1 ]] || [[ "$no_prune" -eq 1 ]]; then
        echo -e "${YELLOW}Skipping image prune (--quick or --no-prune)${NC}"
    else
        echo -e "${YELLOW}Pruning unused images...${NC}"
        docker image prune -f
    fi
    echo ""

    echo -e "${GREEN}=========================================${NC}"
    echo -e "${GREEN}  $ENV_NAME deploy complete!${NC}"
    echo -e "${GREEN}=========================================${NC}"
    echo ""
    _compose_ps_table
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
        deploy "$@"
        ;;
esac
