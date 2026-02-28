#!/bin/bash
# Diagnose 500 Internal Server Error on http://34.68.227.248/
# Run this on the VM: bash diagnose-500.sh

set -e

echo "=== Model Hunter 500 Diagnostic ==="
echo ""

# 0. Which process is on port 80?
echo "0. What is listening on port 80?"
docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null | grep -E '80|0\.0\.0\.0:80' || true
ss -tlnp 2>/dev/null | grep ':80 ' || netstat -tlnp 2>/dev/null | grep ':80 ' || echo "   (could not determine)"
echo ""

# 1. Container status
echo "1. Container status:"
for c in model-hunter-blue model-hunter-green model-hunter-nginx model-hunter-redis model-hunter-dashboard; do
    status=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo "not found")
    health=$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null || echo "n/a")
    echo "   $c: $status (health: $health)"
done
echo ""

# 2. Can nginx resolve upstreams?
echo "2. Nginx upstream resolution (from inside nginx):"
docker exec model-hunter-nginx sh -c 'getent hosts mh-prod-blue 2>/dev/null || echo "mh-prod-blue: FAILED"; getent hosts mh-prod-green 2>/dev/null || echo "mh-prod-green: FAILED"'
echo ""

# 3. Direct app health (bypass nginx)
echo "3. Direct app health (bypass nginx):"
curl -s -o /dev/null -w "   localhost:8000/api/health -> %{http_code}\n" http://localhost:8000/api/health 2>/dev/null || echo "   localhost:8000: FAILED"
curl -s -o /dev/null -w "   localhost:8002/api/health -> %{http_code}\n" http://localhost:8002/api/health 2>/dev/null || echo "   localhost:8002: FAILED"
echo ""

# 4. Direct root (bypass nginx)
echo "4. Direct root from app (bypass nginx):"
curl -s -o /dev/null -w "   localhost:8000/ -> %{http_code}\n" http://localhost:8000/ 2>/dev/null || echo "   localhost:8000/: FAILED"
curl -s -o /dev/null -w "   localhost:8002/ -> %{http_code}\n" http://localhost:8002/ 2>/dev/null || echo "   localhost:8002/: FAILED"
echo ""

# 5. Via nginx (localhost)
echo "5. Via nginx (curl localhost:80):"
code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1/ 2>/dev/null || echo "000")
echo "   http://127.0.0.1/ -> $code"
echo ""

# 6. Nginx error log (last 15 lines)
echo "6. Nginx error log (last 15 lines):"
docker exec model-hunter-nginx tail -15 /var/log/nginx/error.log 2>/dev/null || echo "   (could not read)"
echo ""

# 7. App logs (blue)
echo "7. App logs - model-hunter-blue (last 20 lines):"
docker logs model-hunter-blue 2>&1 | tail -20
echo ""

# 8. Check static files inside container
echo "8. Static files inside blue container:"
docker exec model-hunter-blue ls -la /app/static/index.html 2>/dev/null || echo "   index.html NOT FOUND"
docker exec model-hunter-blue ls -la /app/static/ 2>/dev/null | head -10 || echo "   /app/static/ not readable"
echo ""

# 9. Networks
echo "9. Blue container networks:"
docker inspect model-hunter-blue -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null || echo "   (could not inspect)"
echo ""

echo "=== End diagnostic ==="
echo ""
echo "If direct app (step 4) returns 200 but nginx (step 5) returns 500:"
echo "  - Nginx may be proxying to wrong upstream or wrong network"
echo "  - Check that nginx and app share model-hunter_model-hunter-network"
echo ""
echo "If direct app returns 500:"
echo "  - Check app logs (step 7) for Python tracebacks"
echo "  - Verify index.html exists (step 8)"
echo ""
echo "If /api/trainer-queue or /api/notifications return 500:"
echo "  - Often 'redis: Name or service not known' — blue/green need Redis network"
echo "  - Run: docker network connect model-hunter_model-hunter-network model-hunter-blue"
echo "         docker network connect model-hunter_model-hunter-network model-hunter-green"
echo ""
