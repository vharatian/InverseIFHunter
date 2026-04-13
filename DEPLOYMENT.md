# Deployment Guide

**Operations runbook** (four apps, smoke checks, known issues, incident templates): [operations/README.md](operations/README.md).

## Architecture

Both stacks use **`docker-compose.prod.yml`** as the base, different **`.env`** files and **Compose project names** (`mh-staging` vs `mh-production`). **Production** also merges **`docker-compose.edge-public.yml`** (nginx on host `:80`). **Staging** merges **`docker-compose.staging-overrides.yml`** (adds **`modelhunter_edge`** aliases only — no public edge container on staging). `deploy.sh` passes the correct `-f` list.

### Same VM: `http://IP/` (prod) + `http://IP/staging` (staging)

- **Production nginx (`edge`)** listens on **`80:80`** and routes **`/`** → production Elixir, **`/grafana/`** → production Grafana, **`/staging/`** → staging Elixir and **`/staging/grafana/`** → staging Grafana over Docker network **`modelhunter_edge`** (aliases **`staging-edge-gateway`**, **`staging-grafana-gateway`**).
- **Staging** does not publish a world-facing reverse proxy; trainers use **port 80** on the production VM only.
- **`modelhunter_edge`** is Compose-managed (fixed name in `docker-compose.prod.yml`); the **first** `docker compose up` creates it; the second stack attaches to the same network.

```
        ┌─────────────────────────────────────────┐
        │  Trainer browser: http://VM_IP:80       │
        └─────────────────┬───────────────────────┘
                          │
              Production nginx edge (:80)
                ├─ /          → mh-production elixir …
                ├─ /grafana/  → mh-production grafana …
                └─ /staging/* → mh-staging (via mh-edge aliases) …
```

### Trainer URLs (replace `IP` with your VM address, e.g. `34.28.88.135`)

Use **HTTP on port 80** only (no `https://`, no `:8080` unless you changed `EDGE_HOST_PORTMAP`).

| What | URL |
|------|-----|
| Production app | `http://IP/` |
| Production Grafana | `http://IP/grafana/` |
| Staging app | `http://IP/staging/` |
| Staging Grafana | `http://IP/staging/grafana/` |

**`:8080` does not serve the app anymore** (old staging Traefik on localhost was removed). **`:3000`** is Grafana bound to `127.0.0.1` on the VM only — not reachable from the internet; use **`/grafana/`** on port 80 instead.

If nothing loads: allow **inbound TCP 80** on the cloud firewall, run **`./deploy.sh production`** on the prod clone, **`./deploy.sh staging`** on the staging clone, then test from the VM: `curl -sI http://127.0.0.1/` and `curl -sI http://127.0.0.1/grafana/`.

### Legacy `environments/prod` (prod-server) nginx on :80

If **`model-hunter-nginx`** from **`environments/prod/docker-compose.yml`** is what listens on **port 80** (Python blue/green + dashboard), it **does not** know about InverseIFHunter until you use the bundled **`environments/prod/nginx.conf`** update: it proxies **`/grafana/`** and **`/staging/`** (except **`/staging/dashboard/`**, **`/staging/admin/`**, etc.) to **InverseIFHunter edge** at **`host.docker.internal:9080`**.

1. In **`.env.production`** for the **unified** stack: set **`EDGE_HOST_PORTMAP=127.0.0.1:9080:80`** so IH `edge` does not fight prod-server for :80.
2. Run **`./deploy.sh production`** (IH) and **`./deploy.sh staging`** (IH).
3. From **`environments/prod`**, **`docker compose up -d nginx`** so **`extra_hosts: host.docker.internal:host-gateway`** applies, then **`nginx -s reload`** or recreate the container.
4. Test: **`curl -sI http://127.0.0.1:9080/grafana/`** on the VM (IH edge), then **`curl -sI http://127.0.0.1/grafana/`** (public nginx → 9080).

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

**Edge / Grafana**

- **`DOMAIN`**: host or IP only (no `http://`, no path). Use the same value on prod and staging if clients use the same `Host` header (e.g. public IP).
- **Production**: `EDGE_HOST_PORTMAP=80:80` (or legacy `TRAEFIK_HOST_PORTMAP`), `GRAFANA_ROOT_URL=http://IP/grafana/`.
- **Staging**: `PUBLIC_HTTP_PORT=80`, `STAGING_COMPOSE_OVERRIDE=1`, path vars as in `.env.staging.example`, `GRAFANA_ROOT_URL=http://IP/staging/grafana/`.
- HTTP only (no TLS).

**Postgres WAL archive**

- WAL segments go to the Docker volume **`pg_wal_archive`** (mounted at `/backups/wal`), so archiving does not depend on host permissions. Host **`./backups/daily`** is for optional manual dumps; `deploy.sh` creates it and may `chown` it for UID **70**.

### 3. Create PostgreSQL databases

The first deploy creates the database automatically via the `POSTGRES_DB` env var. Each environment gets its own PostgreSQL container with its own data volume.

### 4. Run Alembic migrations

After the first deploy, run migrations inside each environment's python-core container:

```bash
# Production
cd ~/production
COMPOSE_PROJECT_NAME=mh-production docker compose -f docker-compose.prod.yml -f docker-compose.edge-public.yml --env-file .env.production \
  exec python-core alembic upgrade head

# Staging (include staging overrides if STAGING_COMPOSE_OVERRIDE=1)
cd ~/staging
COMPOSE_PROJECT_NAME=mh-staging docker compose -f docker-compose.prod.yml -f docker-compose.staging-overrides.yml --env-file .env.staging \
  exec python-core alembic upgrade head
```

## Deploy Workflow

**Always deploy to staging first. Test. Then deploy production.**

```bash
# Step 1: Deploy staging
cd ~/staging
./deploy.sh staging

# Step 2: Test staging (direct container + via production :80 if prod is up)
curl -s http://127.0.0.1:4010/health/ready | python3 -m json.tool
curl -sf "http://127.0.0.1/staging/health/ready" | python3 -m json.tool || true
# Open http://VM_IP/staging in browser (production edge must be on :80)

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
| nginx edge (public) | 80 (`EDGE_HOST_PORTMAP` or `TRAEFIK_HOST_PORTMAP`) | — |
| Elixir Edge | 4000 | 4010 |
| Python Core | 8000 | 8010 |
| Dashboard | 8001 | 8011 |
| PostgreSQL | 5432 | 5433 |
| Redis | 6379 | 6380 |
| Prometheus | 9090 | 9091 |
| Grafana | 3000 | 3001 |

Other services use `127.0.0.1` publish ports on the VM. **Production edge** binds **`EDGE_HOST_PORTMAP`** (default `80:80`) so **:80** can be world-reachable; open only what you need in the cloud firewall.

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
COMPOSE_PROJECT_NAME=mh-production docker compose -f docker-compose.prod.yml -f docker-compose.edge-public.yml --env-file .env.production \
  up -d --no-deps --build python-core
```

## Monitoring

- **Health check**: `curl localhost:4000/health/ready` (production) or `localhost:4010/health/ready` (staging)
- **Deep diagnostics**: `curl localhost:4000/health/deep`
- **Grafana**: `http://your-host/grafana/` (match `GRAFANA_ROOT_URL` / edge publish port)
- **Logs**: `./deploy.sh logs production` or `./deploy.sh logs staging`

## Database Backups

Production PostgreSQL is configured with:
- **WAL archiving**: Continuous, stored in Docker volume **`pg_wal_archive`**
- **Daily pg_dump**: Set up a cron job:

```bash
# Add to crontab on the VM
0 3 * * * cd ~/production && COMPOSE_PROJECT_NAME=mh-production docker compose -f docker-compose.prod.yml -f docker-compose.edge-public.yml --env-file .env.production exec -T postgres pg_dump -Fc -U mh model_hunter > backups/daily/mh_$(date +\%Y\%m\%d).dump
```
