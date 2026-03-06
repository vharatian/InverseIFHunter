#!/bin/bash
# Diagnose 500 / 502 errors on production (port 80)
# Run from the VM: bash environments/prod/diagnose-500.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

ok()   { echo -e "   ${GREEN}OK${NC}: $1"; }
fail() { echo -e "   ${RED}FAIL${NC}: $1"; }

echo "=== Production Diagnostic (port 80) ==="
echo ""

echo "1. Container status:"
for c in model-hunter-blue model-hunter-green model-hunter-nginx model-hunter-redis model-hunter-dashboard; do
    status=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo "not found")
    health=$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null || echo "n/a")
    if [ "$status" = "running" ]; then
        ok "$c: $status (health: $health)"
    else
        fail "$c: $status"
    fi
done
echo ""

echo "2. Direct app health (bypass nginx):"
for port in 8000 8002; do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${port}/api/health" 2>/dev/null || echo "000")
    if [ "$code" = "200" ]; then
        ok "localhost:$port/api/health -> $code"
    else
        fail "localhost:$port/api/health -> $code"
    fi
done
echo ""

echo "3. Via nginx (port 80):"
code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1/ 2>/dev/null || echo "000")
if [ "$code" = "200" ]; then
    ok "http://127.0.0.1/ -> $code"
else
    fail "http://127.0.0.1/ -> $code"
fi
echo ""

echo "4. Nginx upstream resolution:"
docker exec model-hunter-nginx sh -c '
    for host in model-hunter-blue model-hunter-green dashboard; do
        if getent hosts "$host" >/dev/null 2>&1; then
            echo "   OK: $host -> $(getent hosts $host | awk "{print \$1}")"
        else
            echo "   FAIL: $host -> cannot resolve"
        fi
    done
' 2>/dev/null || fail "Could not exec into nginx container"
echo ""

echo "5. Redis connectivity:"
docker exec model-hunter-redis redis-cli ping 2>/dev/null | grep -q PONG && ok "Redis PONG" || fail "Redis not responding"
echo ""

echo "6. Nginx error log (last 15 lines):"
docker exec model-hunter-nginx tail -15 /var/log/nginx/error.log 2>/dev/null || echo "   (could not read)"
echo ""

echo "7. App logs - blue (last 15 lines):"
docker logs model-hunter-blue 2>&1 | tail -15
echo ""

echo "8. App logs - green (last 15 lines):"
docker logs model-hunter-green 2>&1 | tail -15
echo ""

echo "9. Disk space:"
df -h / | tail -1 | awk '{print "   " $5 " used (" $4 " free of " $2 ")"}'
echo ""

echo "10. Memory:"
free -h | awk '/Mem:/{print "   " $3 " used / " $2 " total (" $7 " available)"}'
echo ""

echo "=== End diagnostic ==="
