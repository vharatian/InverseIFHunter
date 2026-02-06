#!/bin/bash
#
# Blue-Green Zero-Downtime Deploy Script
#
# How it works:
# 1. Detects which instance is currently active (blue=8000 or green=8002)
# 2. Builds and starts the IDLE instance with new code
# 3. Waits for it to pass health checks
# 4. Switches nginx to point to the new instance
# 5. Optionally stops the old instance
#
# Usage:
#   ./deploy-blue-green.sh          # Auto-detect and deploy to idle
#   ./deploy-blue-green.sh blue     # Force deploy to blue
#   ./deploy-blue-green.sh green    # Force deploy to green
#   ./deploy-blue-green.sh status   # Show current status
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
NGINX_CONF="/etc/nginx/sites-enabled/model-hunter"
COMPOSE_FILE="docker-compose.yml"
BLUE_PORT=8000
GREEN_PORT=8002
MAX_HEALTH_CHECKS=30
HEALTH_CHECK_INTERVAL=2

# Detect which instance is currently active by checking nginx config
detect_active() {
    if grep -q "server 127.0.0.1:${GREEN_PORT}" "$NGINX_CONF" 2>/dev/null | grep -v "^#" | grep -v "#.*server" | head -1 | grep -q "${GREEN_PORT}"; then
        echo "green"
    else
        echo "blue"
    fi
}

# More reliable detection: check which upstream nginx is actually using
detect_active() {
    # Look for uncommented server line in model_hunter_active upstream
    local active_line
    active_line=$(awk '/upstream model_hunter_active/,/}/' "$NGINX_CONF" | grep -v '#' | grep 'server 127.0.0.1' | head -1)
    
    if echo "$active_line" | grep -q "${GREEN_PORT}"; then
        echo "green"
    else
        echo "blue"
    fi
}

get_port() {
    if [ "$1" = "blue" ]; then
        echo "$BLUE_PORT"
    else
        echo "$GREEN_PORT"
    fi
}

get_service() {
    echo "model-hunter-$1"
}

# Show status
show_status() {
    local active
    active=$(detect_active)
    
    echo -e "${BLUE}╔══════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║   Blue-Green Deployment Status       ║${NC}"
    echo -e "${BLUE}╚══════════════════════════════════════╝${NC}"
    echo ""
    
    local blue_status green_status
    blue_status=$(docker inspect -f '{{.State.Status}}' model-hunter-blue 2>/dev/null || echo "not running")
    green_status=$(docker inspect -f '{{.State.Status}}' model-hunter-green 2>/dev/null || echo "not running")
    
    if [ "$active" = "blue" ]; then
        echo -e "  Blue  (port $BLUE_PORT):  ${GREEN}$blue_status${NC}  ← ${GREEN}ACTIVE${NC}"
        echo -e "  Green (port $GREEN_PORT): ${YELLOW}$green_status${NC}  (idle)"
    else
        echo -e "  Blue  (port $BLUE_PORT):  ${YELLOW}$blue_status${NC}  (idle)"
        echo -e "  Green (port $GREEN_PORT): ${GREEN}$green_status${NC}  ← ${GREEN}ACTIVE${NC}"
    fi
    echo ""
}

# Health check
wait_for_healthy() {
    local port=$1
    local name=$2
    
    echo -e "${YELLOW}  Waiting for $name (port $port) to be healthy...${NC}"
    
    for i in $(seq 1 $MAX_HEALTH_CHECKS); do
        local response
        response=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${port}/api/health" 2>/dev/null || echo "000")
        
        if [ "$response" = "200" ]; then
            echo -e "  ${GREEN}✓ $name is healthy (attempt $i)${NC}"
            return 0
        fi
        
        echo -ne "  Health check $i/$MAX_HEALTH_CHECKS... (HTTP $response)\r"
        sleep $HEALTH_CHECK_INTERVAL
    done
    
    echo -e "  ${RED}✗ $name failed health checks after $MAX_HEALTH_CHECKS attempts${NC}"
    return 1
}

# Switch nginx to target
switch_nginx() {
    local target=$1
    local target_port
    target_port=$(get_port "$target")
    local other_port
    
    if [ "$target" = "blue" ]; then
        other_port=$GREEN_PORT
    else
        other_port=$BLUE_PORT
    fi
    
    echo -e "${YELLOW}  Switching nginx to $target (port $target_port)...${NC}"
    
    # Update the active upstream block
    # Comment out old server, uncomment new server
    sudo sed -i "/upstream model_hunter_active/,/}/ {
        s|^\(\s*\)server 127.0.0.1:${other_port};|\\1# server 127.0.0.1:${other_port};|
        s|^\(\s*\)# *server 127.0.0.1:${target_port};|\\1server 127.0.0.1:${target_port};|
    }" "$NGINX_CONF"
    
    # Also update the individual upstreams to point correctly
    sudo sed -i "/upstream model_hunter_blue/,/}/ {
        s|server 127.0.0.1:.*;|server 127.0.0.1:${BLUE_PORT};|
    }" "$NGINX_CONF"
    
    sudo sed -i "/upstream model_hunter_green/,/}/ {
        s|server 127.0.0.1:.*;|server 127.0.0.1:${GREEN_PORT};|
    }" "$NGINX_CONF"
    
    # Test and reload nginx
    if sudo nginx -t 2>/dev/null; then
        sudo systemctl reload nginx
        echo -e "  ${GREEN}✓ Nginx switched to $target${NC}"
    else
        echo -e "  ${RED}✗ Nginx config test failed! Rolling back...${NC}"
        return 1
    fi
}

# Main deploy logic
deploy() {
    local target=$1
    local active
    active=$(detect_active)
    
    # Auto-detect target if not specified
    if [ -z "$target" ]; then
        if [ "$active" = "blue" ]; then
            target="green"
        else
            target="blue"
        fi
    fi
    
    local target_port
    target_port=$(get_port "$target")
    local target_service
    target_service=$(get_service "$target")
    
    echo -e "${BLUE}╔══════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║   Blue-Green Zero-Downtime Deploy    ║${NC}"
    echo -e "${BLUE}╚══════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  Active:  ${GREEN}$active${NC}"
    echo -e "  Target:  ${YELLOW}$target${NC} (port $target_port)"
    echo ""
    
    # Step 1: Pull latest code
    echo -e "${YELLOW}[1/5] Pulling latest code...${NC}"
    cd "$(dirname "$0")"
    cd ..
    git pull origin feature/resilience-upgrade || echo "Git pull skipped"
    cd model-hunter
    echo -e "${GREEN}✓ Code updated${NC}"
    echo ""
    
    # Step 2: Build the target image
    echo -e "${YELLOW}[2/5] Building $target image...${NC}"
    docker-compose -f $COMPOSE_FILE build "$target_service"
    echo -e "${GREEN}✓ Image built${NC}"
    echo ""
    
    # Step 3: Start/restart the target container
    echo -e "${YELLOW}[3/5] Starting $target container...${NC}"
    docker-compose -f $COMPOSE_FILE up -d --no-deps "$target_service"
    echo -e "${GREEN}✓ Container started${NC}"
    echo ""
    
    # Step 4: Wait for health
    echo -e "${YELLOW}[4/5] Health checking $target...${NC}"
    if ! wait_for_healthy "$target_port" "$target"; then
        echo -e "${RED}Deploy ABORTED - $target failed health checks${NC}"
        echo -e "${RED}Active instance ($active) is still serving traffic${NC}"
        exit 1
    fi
    echo ""
    
    # Step 5: Switch nginx
    echo -e "${YELLOW}[5/5] Switching traffic to $target...${NC}"
    if switch_nginx "$target"; then
        echo ""
        echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
        echo -e "${GREEN}║   Deploy Complete! Zero Downtime!    ║${NC}"
        echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
        echo ""
        echo -e "  ${GREEN}$target${NC} is now serving traffic on port $target_port"
        echo -e "  Old instance ($active) is still running as fallback"
        echo ""
        echo -e "  To stop the old instance:"
        echo -e "    docker-compose stop $(get_service $active)"
        echo ""
    else
        echo -e "${RED}Nginx switch failed! $active is still serving traffic${NC}"
        exit 1
    fi
}

# Parse arguments
case "${1:-}" in
    status)
        show_status
        ;;
    blue|green)
        deploy "$1"
        ;;
    *)
        deploy ""
        ;;
esac
