# Staging Setup — Model Hunter

This document describes how staging is set up and how to deploy or update it **without touching production**.

---

## 1. Overview

| | Production | Staging |
|---|------------|--------|
| **Branch** | `feature/multi-turn` or `main` | **`mth`** |
| **Server path** | `/home/mandy/InverseIFHunter` (and `model-hunter/`) | **`/home/mandy/staging-server`** |
| **Port** | **80** (HTTP) | **443** (staging nginx) |
| **Containers** | `model-hunter-*` (blue, green, nginx, redis, dashboard) | `model-hunter-staging-*` |
| **Compose file** | `docker-compose.yml` | **`docker-compose.staging.yml`** |
| **Nginx config** | Production only (ports 8000, 8002, 8001) | **`nginx.staging.conf`** (ports 8010, 8012, 8011) |

**Rule:** All staging work happens **only** in `/home/mandy/staging-server`. Never run `git checkout`/`git reset`/`git pull` or production compose in the production directory when deploying staging.

---

## 2. Staging URL

- **https://34.68.227.248** (port 443)
- Or **http://34.68.227.248:443** if using HTTP on 443

Production stays at **http://34.68.227.248** (port 80).

---

## 3. One-time setup on the server

### 3.1 Create staging directory and clone

```bash
ssh mandy@34.68.227.248

mkdir -p /home/mandy/staging-server
cd /home/mandy/staging-server
git clone https://github.com/vharatian/InverseIFHunter.git .
git fetch origin
git checkout mth
git pull origin mth
```

### 3.2 Create required directories

```bash
mkdir -p .storage-staging ml_pipeline/models
```

### 3.3 Configure `.env`

Staging uses its own `.env` in `staging-server`. It is **not** shared with production.

**Option A — Copy from your local machine (recommended):**

```bash
# Run from your local machine (in the mth project root)
scp .env mandy@34.68.227.248:/home/mandy/staging-server/.env
```

**Option B — Copy from production on the server:**

```bash
# Run on the server (adjust source path if your production path differs)
cp /home/mandy/InverseIFHunter/model-hunter/.env /home/mandy/staging-server/.env
```

**Option C — Create manually:**

```bash
cd /home/mandy/staging-server
cp .env.example .env
nano .env   # or vim .env
```

Required variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key (judge/evaluation) |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key (generation) |
| `FIREWORKS_API_KEY` | No | Fireworks AI (if using Fireworks models) |
| `ADMIN_PASSWORD` | No | Dashboard login (optional) |

### 3.4 Configure `service_account.json`

The app expects **`/workspace/service_account.json`** inside the container. The compose file mounts the staging-server directory as `/workspace`, so the file must exist at:

**`/home/mandy/staging-server/service_account.json`**

**Option A — Copy from your local machine:**

```bash
# Run from your local machine
scp service_account.json mandy@34.68.227.248:/home/mandy/staging-server/service_account.json
```

**Option B — Copy from production on the server:**

```bash
# Run on the server (adjust source path if needed)
cp /home/mandy/InverseIFHunter/model-hunter/service_account.json /home/mandy/staging-server/service_account.json
```

**Option C —** Download from Google Cloud Console (e.g. IAM → Service accounts → Keys) and place the JSON file at the path above.

### 3.5 Verify files before first deploy

```bash
ssh mandy@34.68.227.248 "ls -la /home/mandy/staging-server/.env /home/mandy/staging-server/service_account.json"
```

Both files should exist. Then proceed to **Deploy / update staging** below.

---

## 4. Deploy / update staging

**All commands below are run in `/home/mandy/staging-server` only. Do not run them in the production directory.**

### 4.1 Pull latest `mth` and start staging

```bash
ssh mandy@34.68.227.248

cd /home/mandy/staging-server
git fetch origin
git checkout mth
git pull origin mth

# Optional: remove old staging containers (staging only; production untouched)
docker rm -f model-hunter-staging-redis model-hunter-staging-blue model-hunter-staging-green model-hunter-staging-nginx model-hunter-staging-dashboard 2>/dev/null || true

# Start staging stack only
docker-compose -f docker-compose.staging.yml up -d --build
```

### 4.2 Using the deploy script (if run from staging-server root)

From **inside** `/home/mandy/staging-server`:

```bash
./deploy-staging.sh
```

This pulls `mth`, rebuilds staging blue/green, runs health checks, and reloads staging nginx. It uses **only** `docker-compose.staging.yml` and **only** `model-hunter-staging-*` containers.

### 4.3 Restart only app containers (e.g. after changing `.env`)

```bash
cd /home/mandy/staging-server
docker-compose -f docker-compose.staging.yml up -d --build model-hunter-blue model-hunter-green model-hunter-staging-dashboard
```

---

## 5. Nginx and ports

- **Production nginx** listens on **port 80** and routes only to production backends (8000, 8002, 8001). It is **not** modified by staging setup.
- **Staging nginx** runs in the staging stack and listens on **host port 443** (mapped to container port 80). It uses **`nginx.staging.conf`**, which defines **only** staging upstreams:
  - `model-hunter-staging-blue:8010`
  - `model-hunter-staging-green:8012`
  - `model-hunter-staging-dashboard:8011`

Staging config **must not** reference production ports (80, 8000, 8002, 8001). Production config must not reference staging ports (8010, 8012, 8011).

---

## 6. Verification

```bash
# Staging containers
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep staging

# Staging app health (direct to blue)
curl -s -o /dev/null -w "%{http_code}" http://localhost:8010/api/health
# Expected: 200

# Staging via nginx (port 443)
curl -s -o /dev/null -w "%{http_code}" http://localhost:443/
# Expected: 200
```

In a browser: **https://34.68.227.248** (or **http://34.68.227.248:443**).

---

## 7. What not to do

- Do **not** run `git checkout`, `git reset --hard`, or `git pull` in `/home/mandy/InverseIFHunter` (or the production app path) when deploying or updating staging.
- Do **not** run `docker-compose -f docker-compose.yml` (production compose) from any directory when intending to change staging.
- Do **not** restart or reconfigure production containers (`model-hunter-nginx`, `model-hunter-blue`, `model-hunter-green`, etc.) as part of staging workflow.
- Do **not** use a single nginx config that mixes production and staging upstreams; keep production and staging configs separate.

---

## 8. Files reference

| File | Purpose |
|------|---------|
| `docker-compose.staging.yml` | Staging stack: redis, blue, green, dashboard, nginx (port 443→80). Uses `.:/workspace`, `.env`, `service_account.json`. |
| `nginx.staging.conf` | Nginx config for staging only (8010, 8012, 8011). Loaded by staging nginx container. |
| `deploy-staging.sh` | Script to pull `mth`, rebuild staging blue/green, health-check, reload staging nginx. Run from repo root (e.g. `staging-server`). |
| `.env` | API keys and secrets for staging (per `staging-server`). |
| `service_account.json` | Google service account JSON; must be at `staging-server/service_account.json`. |

---

## 9. Summary checklist (staging only)

- [ ] All work in **`/home/mandy/staging-server`**; production path untouched.
- [ ] Branch **`mth`** checked out and pulled.
- [ ] **`.env`** and **`service_account.json`** present in `staging-server`.
- [ ] Only **`docker-compose -f docker-compose.staging.yml`** used for staging.
- [ ] Staging URL: **https://34.68.227.248** (port 443).
- [ ] Production: **http://34.68.227.248** (port 80), unchanged.
