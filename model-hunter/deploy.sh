#!/bin/bash
#
# Zero-Downtime Deployment Script for Model Hunter
#
# This script performs a rolling update:
# 1. Pulls latest code from git
# 2. Builds new Docker images
# 3. Restarts containers one by one (Redis stays up!)
# 4. Verifies health before marking complete
#
# Usage: ./deploy.sh
#

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
COMPOSE_FILE="docker-compose.yml"
HEALTH_CHECK_URL="http://localhost:8000/api/health"
MAX_HEALTH_CHECKS=30
HEALTH_CHECK_INTERVAL=2

echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║        Model Hunter - Zero Downtime Deploy             ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
echo ""

# Step 1: Pull latest code
echo -e "${YELLOW}[1/6] Pulling latest code from git...${NC}"
git pull origin main || git pull origin master || echo "Git pull skipped (not a git repo or no remote)"
echo -e "${GREEN}✓ Code updated${NC}"
echo ""

# Step 2: Check if Docker is running
echo -e "${YELLOW}[2/6] Checking Docker...${NC}"
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}✗ Docker is not running. Please start Docker first.${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Docker is running${NC}"
echo ""

# Step 3: Build new images (without stopping containers)
echo -e "${YELLOW}[3/6] Building new Docker images...${NC}"
docker-compose -f $COMPOSE_FILE build --no-cache model-hunter
echo -e "${GREEN}✓ Images built${NC}"
echo ""

# Step 4: Ensure Redis is running (critical for session persistence)
echo -e "${YELLOW}[4/6] Ensuring Redis is running...${NC}"
if ! docker-compose -f $COMPOSE_FILE ps redis | grep -q "Up"; then
    echo -e "${YELLOW}  Starting Redis...${NC}"
    docker-compose -f $COMPOSE_FILE up -d redis
    sleep 5
fi

# Wait for Redis to be healthy
echo -e "${YELLOW}  Waiting for Redis health check...${NC}"
for i in $(seq 1 10); do
    if docker-compose -f $COMPOSE_FILE exec -T redis redis-cli ping | grep -q "PONG"; then
        echo -e "${GREEN}✓ Redis is healthy${NC}"
        break
    fi
    if [ $i -eq 10 ]; then
        echo -e "${RED}✗ Redis health check failed${NC}"
        exit 1
    fi
    sleep 1
done
echo ""

# Step 5: Rolling restart of application (Redis stays up!)
echo -e "${YELLOW}[5/6] Performing rolling restart of application...${NC}"
echo -e "${YELLOW}  Note: Redis stays running - sessions are preserved!${NC}"

# Stop and restart ONLY the app container (not Redis)
docker-compose -f $COMPOSE_FILE up -d --no-deps --force-recreate model-hunter
echo -e "${GREEN}✓ Application container restarted${NC}"
echo ""

# Step 6: Health check
echo -e "${YELLOW}[6/6] Verifying deployment health...${NC}"
health_ok=false

for i in $(seq 1 $MAX_HEALTH_CHECKS); do
    echo -ne "  Health check attempt $i/$MAX_HEALTH_CHECKS... "
    
    # Check if container is running first
    if ! docker-compose -f $COMPOSE_FILE ps model-hunter | grep -q "Up"; then
        echo -e "${RED}Container not running${NC}"
        sleep $HEALTH_CHECK_INTERVAL
        continue
    fi
    
    # HTTP health check
    response=$(curl -s -o /dev/null -w "%{http_code}" $HEALTH_CHECK_URL 2>/dev/null || echo "000")
    
    if [ "$response" = "200" ]; then
        echo -e "${GREEN}OK (HTTP $response)${NC}"
        health_ok=true
        break
    else
        echo -e "${YELLOW}Waiting (HTTP $response)${NC}"
    fi
    
    sleep $HEALTH_CHECK_INTERVAL
done

if [ "$health_ok" = true ]; then
    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║              Deployment Successful!                     ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${BLUE}Service Status:${NC}"
    docker-compose -f $COMPOSE_FILE ps
    echo ""
    echo -e "${BLUE}Quick Commands:${NC}"
    echo -e "  View logs:     docker-compose logs -f model-hunter"
    echo -e "  Check health:  curl $HEALTH_CHECK_URL"
    echo -e "  Stop all:      docker-compose down"
    echo ""
else
    echo ""
    echo -e "${RED}╔════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║              Deployment Failed!                         ║${NC}"
    echo -e "${RED}╚════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${YELLOW}Checking logs for errors...${NC}"
    docker-compose -f $COMPOSE_FILE logs --tail=50 model-hunter
    exit 1
fi
