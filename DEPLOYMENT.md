# Deployment Guide

## Architecture

Both stacks use the **same `docker-compose.prod.yml`**, different **`.env`** files and **Compose project names** (`mh-staging` vs `mh-production`).

### Same VM: `http://IP/` (prod) + `http://IP/staging` (staging)

- **Production Traefik** listens on **`80:80`** and keeps routing **`/`** to production (unchanged).
- A **file-provider route** on production Traefik forwards **`PathPrefix(/staging)`** to the **staging** Traefik over Docker network **`modelhunter_edge`** (alias **`staging-traefik-gateway`**).
- **Staging Traefik** is published on **`127.0.0.1:8080`** only (optional local debugging); **trainers use port 80** and never need 8080 open on the firewall.
- `deploy.sh` creates **`modelhunter_edge`** if missing.

```
        ┌─────────────────────────────────────────┐
        │  Trainer browser: http://VM_IP:80       │
        └─────────────────┬───────────────────────┘
                          │
              Production Traefik (:80)
                ├─ /          → mh-production …
                └─ /staging/* → staging Traefik (mh-edge) → mh-staging …
```

## Initial VM Setup

### 1. Clone the repo twice

```bash
# Production
cd ~
git clone git@github.com:your-org/InverseIFHunter.git production
cd production && git checkout mth

# Staging
cd ~
git clone git@github.com:your-org/InverseIFHunter.git staging
cd staging && git checkout mth
```

### 2. Create environment files

```bash
# Production
cd ~/production
cp .env.production.example .env.production
# Edit .env.production with real values (domain, passwords, API keys)

# Staging
cd ~/staging
cp .env.staging.example .env.staging
# Edit .env.staging with staging values
```

**Traefik / Grafana**

- **`DOMAIN`**: host or IP only (no `http://`, no path). Use the same value on prod and staging if clients use the same `Host` header (e.g. public IP).
- **Production**: `TRAEFIK_DYNAMIC_DIR=./traefik/dynamic-bridge`, `TRAEFIK_HOST_PORTMAP=80:80`, `GRAFANA_ROOT_URL=http://IP/grafana/`.
- **Staging**: `TRAEFIK_DYNAMIC_DIR=./traefik/dynamic-noop`, `TRAEFIK_HOST_PORTMAP=127.0.0.1:8080:80`, `PUBLIC_HTTP_PORT=80`, `STAGING_COMPOSE_OVERRIDE=1`, path vars as in `.env.staging.example`, `GRAFANA_ROOT_URL=http://IP/staging/grafana/`.
- HTTP only (no TLS). `deploy.sh` merges `docker-compose.staging-overrides.yml` (Compose **v2.23+** for `labels: !reset`).

**Postgres WAL archive**

- WAL segments go to the Docker volume **`pg_wal_archive`** (mounted at `/backups/wal`), so archiving does not depend on host permissions. Host **`./backups/daily`** is for optional manual dumps; `deploy.sh` creates it and may `chown` it for UID **70**.

### 3. Create PostgreSQL databases

The first deploy creates the database automatically via the `POSTGRES_DB` env var. Each environment gets its own PostgreSQL container with its own data volume.

### 4. Run Alembic migrations

After the first deploy, run migrations inside each environment's python-core container:

```bash
# Production
cd ~/production
COMPOSE_PROJECT_NAME=mh-production docker compose -f docker-compose.prod.yml --env-file .env.production \
  exec python-core alembic upgrade head

# Staging (include staging overrides if STAGING_COMPOSE_OVERRIDE=1)
cd ~/staging
COMPOSE_PROJECT_NAME=mh-staging docker compose -f docker-compose.prod.yml -f docker-compose.staging-overrides.yml --env-file .env.staging \
  exec python-core alembic upgrade head
```

## Deploy Workflow

**Always deploy to staging first. Test. Then deploy to production.**

```bash
# Step 1: Deploy staging
cd ~/staging
./deploy.sh staging

# Step 2: Test staging (direct container + via production :80 if prod is up)
curl -s http://127.0.0.1:4010/health/ready | python3 -m json.tool
curl -sf "http://127.0.0.1/staging/health/ready" | python3 -m json.tool || true
# Open http://VM_IP/staging in browser (production Traefik must be running on :80)

# Step 3: If staging is good, deploy production
cd ~/production
./deploy.sh production

# Step 4: Verify production
curl -s http://localhost:4000/health/ready | python3 -m json.tool
```

## Commands

```bash
./deploy.sh staging        # Deploy staging
./deploy.sh production     # Deploy production
./deploy.sh status staging # Show staging container status
./deploy.sh status prod    # Show production container status
./deploy.sh logs staging   # Tail staging logs
./deploy.sh logs prod      # Tail production logs
./deploy.sh down staging   # Stop staging stack
./deploy.sh down prod      # Stop production stack
```

Short aliases work: `staging`/`stg`/`s`, `production`/`prod`/`p`.

## Port Map

| Service | Production | Staging |
|---------|-----------|---------|
| Traefik (public) | 80 (`TRAEFIK_HOST_PORTMAP`) | — (staging Traefik on `127.0.0.1:8080` only) |
| Elixir Edge | 4000 | 4010 |
| Python Core | 8000 | 8010 |
| Dashboard | 8001 | 8011 |
| PostgreSQL | 5432 | 5433 |
| Redis | 6379 | 6380 |
| Prometheus | 9090 | 9091 |
| Grafana | 3000 | 3001 |

Other services use `127.0.0.1` publish ports on the VM. **Production Traefik** uses **`TRAEFIK_HOST_PORTMAP`** (default `80:80`) so **:80** can be world-reachable; open only what you need in the cloud firewall.

## Rollback

If a deploy goes wrong:

```bash
# Option 1: Redeploy the previous version
cd ~/production
git log --oneline -5       # Find the last known good commit
git checkout <good-commit>
./deploy.sh production

# Option 2: Stop and restart
./deploy.sh down production
./deploy.sh production

# Option 3: Roll back a single service
COMPOSE_PROJECT_NAME=mh-production docker compose -f docker-compose.prod.yml --env-file .env.production \
  up -d --no-deps --build python-core
```

## Monitoring

- **Health check**: `curl localhost:4000/health/ready` (production) or `localhost:4010/health/ready` (staging)
- **Deep diagnostics**: `curl localhost:4000/health/deep`
- **Grafana**: `http://your-host:PORT/grafana/` (match `GRAFANA_ROOT_URL` / Traefik publish port)
- **Logs**: `./deploy.sh logs production` or `./deploy.sh logs staging`

## Database Backups

Production PostgreSQL is configured with:
- **WAL archiving**: Continuous, stored in Docker volume **`pg_wal_archive`**
- **Daily pg_dump**: Set up a cron job:

```bash
# Add to crontab on the VM
0 3 * * * cd ~/production && COMPOSE_PROJECT_NAME=mh-production docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres pg_dump -Fc -U mh model_hunter > backups/daily/mh_$(date +\%Y\%m\%d).dump
```
