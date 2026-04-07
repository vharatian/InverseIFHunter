"""
Routing Configuration — Single Source of Truth
===============================================
All URL path prefixes, service ports, and upstream hostnames for the
Model Hunter platform.

Used by:
  - main.py                     (FastAPI mount prefixes, base_href)
  - dashboard/main.py           (FastAPI mount prefixes)
  - scripts/generate_nginx.py   (renders nginx/edge.conf)

Referenced by (via comments):
  - proxy_controller.ex          (Elixir reverse-proxy upstream routing)
  - api.js / admin.js            (auto-detect prefix from location.pathname)

Request flow
------------
  Browser ──► nginx (edge.conf) ──► Elixir edge ──► Python core / dashboard

  /staging/*        nginx strips /staging, forwards to staging Elixir
  /reviewer/*       Elixir forwards to python-core as-is
  /dashboard/*      Elixir forwards to python-dashboard (strips /dashboard)
  /admin/*          Elixir forwards to python-dashboard as-is
  /grafana/*        nginx proxies directly to Grafana
"""

# ── Staging prefix (stripped by nginx before forwarding) ──────────────
STAGING_PREFIX = "/staging"

# ── App path prefixes ─────────────────────────────────────────────────
REVIEWER_PREFIX = "/reviewer"
REVIEWER_STATIC = "/reviewer/static"
DASHBOARD_PREFIX = "/dashboard"
ADMIN_PREFIX = "/admin"
GRAFANA_PREFIX = "/grafana"
TRAINER_STATIC = "/static"

# ── Service ports (must match docker-compose.prod.yml) ────────────────
PYTHON_CORE_PORT = 8000
PYTHON_DASHBOARD_PORT = 8001
ELIXIR_EDGE_PORT = 4000
GRAFANA_PORT = 3000

# ── Docker upstream hostnames ─────────────────────────────────────────
ELIXIR_EDGE_HOST = "elixir-edge"
STAGING_ELIXIR_HOST = "staging-edge-gateway"
STAGING_GRAFANA_HOST = "staging-grafana-gateway"
GRAFANA_HOST = "grafana"
