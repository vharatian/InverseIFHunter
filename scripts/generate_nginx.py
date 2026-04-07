#!/usr/bin/env python3
"""
Generate nginx/edge.conf from config_routing.py constants.

Usage:
    python scripts/generate_nginx.py          # writes nginx/edge.conf
    python scripts/generate_nginx.py --check  # exits 1 if file is out of date
"""
import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from config_routing import (
    STAGING_PREFIX,
    GRAFANA_PREFIX,
    ELIXIR_EDGE_HOST,
    ELIXIR_EDGE_PORT,
    STAGING_ELIXIR_HOST,
    STAGING_GRAFANA_HOST,
    GRAFANA_HOST,
    GRAFANA_PORT,
)

OUTPUT = REPO_ROOT / "nginx" / "edge.conf"

HEADER = f"""\
# AUTO-GENERATED from config_routing.py — do not edit manually.
# Regenerate:  python scripts/generate_nginx.py
# Source of truth: config_routing.py
"""


def render() -> str:
    stg = STAGING_PREFIX  # /staging
    gf = GRAFANA_PREFIX   # /grafana

    return f"""{HEADER}
map $http_upgrade $connection_upgrade {{
    default upgrade;
    ''      close;
}}

resolver 127.0.0.11 valid=10s ipv6=off;

server {{
    listen 80;
    server_name _;

    client_max_body_size 64m;

    # ── Trailing-slash redirects ──────────────────────────────────────
    location = {stg} {{
        return 302 {stg}/;
    }}
    location = {stg}{gf} {{
        return 302 {stg}{gf}/;
    }}
    location = {gf} {{
        return 302 {gf}/;
    }}

    # ── Staging Grafana: strip {stg} → {gf}/... ──────────────────────
    location {stg}{gf}/ {{
        rewrite ^{stg}({gf}/.*)$ $1 break;
        set $staging_grafana {STAGING_GRAFANA_HOST};
        proxy_pass http://$staging_grafana:{GRAFANA_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Prefix {stg}{gf};
    }}

    # ── Staging app: strip {stg}/ ────────────────────────────────────
    location {stg}/ {{
        rewrite ^{stg}/(.*)$ /$1 break;
        set $staging_elixir {STAGING_ELIXIR_HOST};
        proxy_pass http://$staging_elixir:{ELIXIR_EDGE_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Prefix {stg};
    }}

    # ── Production Grafana ───────────────────────────────────────────
    location {gf}/ {{
        proxy_pass http://{GRAFANA_HOST}:{GRAFANA_PORT}{gf}/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
    }}

    # ── Production app (catch-all → Elixir edge) ────────────────────
    location / {{
        proxy_pass http://{ELIXIR_EDGE_HOST}:{ELIXIR_EDGE_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
    }}
}}
"""


def main():
    parser = argparse.ArgumentParser(description="Generate nginx/edge.conf from routing constants")
    parser.add_argument("--check", action="store_true", help="Check if file is up to date (exit 1 if stale)")
    args = parser.parse_args()

    new_content = render()

    if args.check:
        if not OUTPUT.exists():
            print(f"MISSING: {OUTPUT}")
            sys.exit(1)
        current = OUTPUT.read_text()
        if current != new_content:
            print(f"STALE: {OUTPUT} — run: python scripts/generate_nginx.py")
            sys.exit(1)
        print(f"OK: {OUTPUT} is up to date")
        sys.exit(0)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(new_content)
    print(f"Generated {OUTPUT}")


if __name__ == "__main__":
    main()
