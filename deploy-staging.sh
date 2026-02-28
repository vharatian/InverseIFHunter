#!/bin/bash
#
# Deploy multiturn-hunter branch to STAGING only (port 443).
# Does NOT touch production (port 80).
#
# Usage:
#   ./deploy-staging.sh              # Full deploy to staging
#   ./deploy-staging.sh --status     # Show staging container status
#

set -e

COMPOSE_FILE="docker-compose.staging.yml"
COMPOSE_PROJECT="model-hunter-staging"
BLUE_PORT=8010
GREEN_PORT=8012

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Use project name so we get model-hunter-staging-* containers
export COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT"

# ---- Status ----
show_status() {
    echo "=== Staging (port 443) — Status ==="
    echo ""
    for name in model-hunter-staging-blue model-hunter-staging-green model-hunter-staging-nginx model-hunter-staging-redis model-hunter-staging-dashboard; do
        status=$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo "not running")
        if [ "$status" = "running" ]; then
            echo "  ● $name: $status"
        else
            echo "  ● $name: $status"
        fi
    done
    echo ""
    echo "Staging URL: https://34.68.227.248 (or https://staging.inverseifhunter.com)"
    echo ""
}

# ---- Health check ----
wait_healthy() {
    local port=$1
    local name=$2
    local max_attempts=20

    echo -ne "  Waiting for $name (port $port)..."
    for i in $(seq 1 $max_attempts); do
        code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${port}/api/health" 2>/dev/null || echo "000")
        if [ "$code" = "200" ]; then
            echo " healthy (attempt $i)"
            return 0
        fi
        echo -n "."
        sleep 3
    done
    echo " FAILED after $max_attempts attempts"
    return 1
}

# ---- Full deploy to staging ----
deploy_full() {
    echo "=== Deploy multiturn-hunter to STAGING (port 443) ==="
    echo ""

    # Ensure staging storage dir exists
    mkdir -p .storage-staging

    # Step 1: Pull multiturn-hunter (from repo root)
    echo "[1/5] Pulling multiturn-hunter branch..."
    if [ -d "$SCRIPT_DIR/.git" ]; then GIT_ROOT="$SCRIPT_DIR"; else GIT_ROOT="$SCRIPT_DIR/.."; fi
    (cd "$GIT_ROOT" && git pull origin multiturn-hunter)
    cd "$SCRIPT_DIR"
    echo "  Code updated."
    echo ""

    # Step 2: Rebuild green
    echo "[2/5] Rebuilding staging-green..."
    docker-compose -f $COMPOSE_FILE -p $COMPOSE_PROJECT up -d --build --no-deps model-hunter-green
    echo ""

    # Step 3: Wait for green healthy
    echo "[3/5] Health checking staging-green..."
    if ! wait_healthy $GREEN_PORT "staging-green"; then
        echo "Staging-green failed. Staging-blue still serving. Deploy aborted."
        exit 1
    fi
    echo ""

    # Step 4: Rebuild blue
    echo "[4/5] Rebuilding staging-blue..."
    docker-compose -f $COMPOSE_FILE -p $COMPOSE_PROJECT up -d --build --no-deps model-hunter-blue
    echo ""

    # Step 5: Wait for blue healthy
    echo "[5/5] Health checking staging-blue..."
    if ! wait_healthy $BLUE_PORT "staging-blue"; then
        echo "Staging-blue failed. Staging-green is serving."
        exit 1
    fi
    echo ""

    # Reload staging nginx
    docker-compose -f $COMPOSE_FILE -p $COMPOSE_PROJECT exec -T nginx nginx -s reload 2>/dev/null || true

    echo "=== Staging deploy complete ==="
    echo ""
    echo "  Staging: https://34.68.227.248"
    echo "  Production (unchanged): http://34.68.227.248"
    echo ""
}

# ---- Parse args ----
case "${1:-}" in
    --status)
        show_status
        ;;
    *)
        deploy_full
        ;;
esac
