# Deployment Guide

## Architecture

Both staging and production use the **same codebase, same Docker images, same `docker-compose.prod.yml`**. The difference is configuration (`.env` files) and Docker project names (container isolation).

```
Single GitHub repo (branch: mth)
        │
        ├── VM: ~/staging/     → .env.staging     → project: mh-staging
        │                        ports: 4010, 8010, 8011, 5433, 6380
        │
        └── VM: ~/production/  → .env.production  → project: mh-production
                                 ports: 4000, 8000, 8001, 5432, 6379
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

- `DOMAIN` must be a **hostname or IP only** (no `http://`, no path). Routing uses `Host(DOMAIN)` plus `PathPrefix` from `EDGE_PATH_PREFIX` / `GRAFANA_PATH_PREFIX`.
- Set **`GRAFANA_ROOT_URL`** to the full URL browsers use (e.g. `http://YOUR_IP:8080/grafana/`).
- Traefik is **HTTP only** (no TLS / Let’s Encrypt). Set **`GRAFANA_ROOT_URL`** with `http://` and the host port you publish (e.g. `http://YOUR_IP:8080/grafana/`).
- Serving under a path prefix (e.g. `/staging`): set `STAGING_COMPOSE_OVERRIDE=1`, `EDGE_STRIP_PREFIX`, and paths as in `.env.staging.example`. `deploy.sh` merges `docker-compose.staging-overrides.yml` (Docker Compose **v2.23+** for `labels: !reset`).

**Postgres WAL archive**

- WAL segments go to the Docker volume **`pg_wal_archive`** (mounted at `/backups/wal`), so archiving does not depend on host permissions. Host **`./backups/daily`** is for optional manual dumps; `deploy.sh` creates it and may `chown` it for UID **70**.

### 3. Create PostgreSQL databases

The first deploy creates the database automatically via the `POSTGRES_DB` env var. Each environment gets its own PostgreSQL container with its own data volume.

### 4. Run Alembic migrations

After the first deploy, run migrations inside each environment's python-core container:

```bash
# Production
cd ~/production
docker compose -p mh-production -f docker-compose.prod.yml --env-file .env.production \
  exec python-core alembic upgrade head

# Staging
cd ~/staging
docker compose -p mh-staging -f docker-compose.prod.yml --env-file .env.staging \
  exec python-core alembic upgrade head
```

## Deploy Workflow

**Always deploy to staging first. Test. Then deploy to production.**

```bash
# Step 1: Deploy staging
cd ~/staging
./deploy.sh staging

# Step 2: Test staging
curl -s http://localhost:4010/health/ready | python3 -m json.tool
# Open http://localhost:8080/ (or your Traefik URL) in browser, run a test hunt

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
| Traefik HTTP | 80 | 8080 |
| Elixir Edge | 4000 | 4010 |
| Python Core | 8000 | 8010 |
| Dashboard | 8001 | 8011 |
| PostgreSQL | 5432 | 5433 |
| Redis | 6379 | 6380 |
| Prometheus | 9090 | 9091 |
| Grafana | 3000 | 3001 |

All ports are bound to `127.0.0.1` (not accessible from outside the VM). External traffic enters through Traefik only.

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
docker compose -p mh-production -f docker-compose.prod.yml --env-file .env.production \
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
0 3 * * * cd ~/production && docker compose -p mh-production -f docker-compose.prod.yml --env-file .env.production exec -T postgres pg_dump -Fc -U mh model_hunter > backups/daily/mh_$(date +\%Y\%m\%d).dump
```
