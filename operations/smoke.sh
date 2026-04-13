#!/usr/bin/env bash
# Smoke checks for Trainer, Reviewer, Dashboard, Admin (shared dashboard health).
# Usage: DOMAIN=host [STAGING_PREFIX=/staging] ./smoke.sh
# Production: STAGING_PREFIX= ./smoke.sh
set -euo pipefail

DOMAIN="${DOMAIN:-34.28.88.135}"
SP="${STAGING_PREFIX:-/staging}"
BASE="http://${DOMAIN}${SP}"

fail=0
chk() {
  local name="$1"
  shift
  if "$@"; then
    echo "OK  $name"
  else
    echo "FAIL $name" >&2
    fail=1
  fi
}

echo "BASE=$BASE"
chk "trainer health/ready" curl -sf "${BASE}/health/ready" -o /dev/null
chk "trainer health/live" curl -sf "${BASE}/health/live" -o /dev/null
chk "reviewer health" curl -sf "${BASE}/reviewer/health" -o /dev/null
chk "reviewer ready" curl -sf "${BASE}/reviewer/ready" -o /dev/null
chk "dashboard api health" curl -sf "${BASE}/dashboard/api/health" -o /dev/null
# Admin: same backend as dashboard; verify UI path responds
code=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/admin/" || echo "000")
if [[ "$code" =~ ^(200|301|302|303|307|308)$ ]]; then
  echo "OK  admin UI (HTTP $code)"
else
  echo "FAIL admin UI (HTTP $code)" >&2
  fail=1
fi

exit "$fail"
