# Backend Autopsy — Model Hunter VM (34.68.227.248)

**Date**: 2026-03-06
**Investigator**: Automated SSH inspection + local codebase analysis
**VM**: `mandy@34.68.227.248` (GCP instance `instance-20260113-154421`)

---

## Resolution Status (updated 2026-03-06)

| Issue | Severity | Status | How |
|-------|----------|--------|-----|
| CRITICAL-01 Disk 84% | CRITICAL | FIXED | Pruned 46 dangling images, orphaned volumes/networks, removed old production dir |
| CRITICAL-02 Different codebases | CRITICAL | FIXED | Both prod and staging now run `mth` branch with shared `docker/Dockerfile` |
| CRITICAL-03 Wrong branch in deploy | CRITICAL | FIXED | `environments/prod/deploy.sh` and `environments/staging/deploy.sh` both pull `mth` |
| CRITICAL-04 Log rotation | CRITICAL | DEFERRED | Requires Docker daemon restart (brief container restart) |
| CRITICAL-05 502 during deploy | CRITICAL | FIXED | nginx `max_fails=1 fail_timeout=30s` + `proxy_next_upstream` auto-retries |
| HIGH-06 Host nginx wrong port | HIGH | FIXED | Stale `/etc/nginx/sites-enabled/model-hunter` removed |
| HIGH-07 Stale systemd services | HIGH | FIXED | `model-hunter.service` and dashboard service removed |
| HIGH-08 Dashboard 444MB memory | HIGH | FIXED | Fresh container start with new production setup |
| HIGH-09 No graceful shutdown | HIGH | FIXED | `exec` added to Dockerfile CMD -- uvicorn receives SIGTERM directly |
| HIGH-10 Cron wrong container | HIGH | DEFERRED | Needs separate fix |
| MEDIUM-11 No swap | MEDIUM | DEFERRED | Low priority -- current usage 2.6/16 GB |
| MEDIUM-12 Ports exposed 0.0.0.0 | MEDIUM | FIXED | All app ports bound to `127.0.0.1` in docker-compose |
| MEDIUM-13 Orphaned volumes | MEDIUM | FIXED | All orphaned volumes pruned |
| MEDIUM-14 Redis AOF | MEDIUM | NO CHANGE | Monitoring only |
| MEDIUM-15 Root-owned files | MEDIUM | DEFERRED | Needs USER directive in Dockerfile |
| MEDIUM-16 No backup | MEDIUM | DEFERRED | Needs GCS/Drive backup setup |
| LOW-17 Weak passwords | LOW | USER ACTION | User sets strong password in `.env` |
| LOW-18 Staging in prod nginx | LOW | FIXED | Separate `environments/prod/nginx.conf` and `environments/staging/nginx.conf` |
| LOW-19 docker-compose v1 EOL | LOW | DEFERRED | Upgrade during maintenance window |
| LOW-20 No .dockerignore | LOW | FIXED | `.dockerignore` added at repo root |

---

## VM Snapshot

| Attribute         | Value                                      |
|-------------------|--------------------------------------------|
| OS                | Debian 12 (bookworm)                       |
| CPU               | 4 vCPUs                                    |
| RAM               | 16 GB (no swap)                            |
| Disk              | 10 GB total, **7.6 GB used (84%), 1.6 GB free** |
| Docker            | 20.10.24+dfsg1                             |
| Docker Compose    | 1.29.2 (v1, legacy EOL)                    |
| Uptime            | Stable                                     |
| Swap              | **None configured**                        |

### Running Containers (10 total)

| Container                       | Image                                    | Status             | Memory   | Port Mapping         |
|---------------------------------|------------------------------------------|--------------------|----------|----------------------|
| model-hunter-blue               | model-hunter_model-hunter-blue           | Up ~1h (healthy)   | 95 MB    | 0.0.0.0:8000->8000   |
| model-hunter-green              | model-hunter_model-hunter-green          | Up ~1h (healthy)   | 91 MB    | 0.0.0.0:8002->8002   |
| model-hunter-nginx              | nginx:alpine                             | Up 2 days          | 5 MB     | 0.0.0.0:80->80       |
| model-hunter-redis              | redis:7-alpine                           | Up 5 days (healthy)| 12 MB    | internal only        |
| model-hunter-dashboard          | model-hunter_dashboard                   | Up 5 days          | **444 MB** | 0.0.0.0:8001->8001 |
| model-hunter-staging-blue       | model-hunter-staging_model-hunter-blue   | Up 7h (healthy)    | 93 MB    | 0.0.0.0:8010->8010   |
| model-hunter-staging-green      | model-hunter-staging_model-hunter-green  | Up 7h (healthy)    | 92 MB    | 0.0.0.0:8012->8012   |
| model-hunter-staging-nginx      | nginx:alpine                             | Up 5 days          | 5 MB     | 0.0.0.0:443->80      |
| model-hunter-staging-redis      | redis:7-alpine                           | Up 5 days (healthy)| 10 MB    | internal only        |
| model-hunter-staging-dashboard  | staging-server_dashboard                 | Up 5 days          | 76 MB    | 0.0.0.0:8011->8011   |

### Git State on VM

| Location                                    | Branch               | main.py Lines | Architecture         |
|---------------------------------------------|-----------------------|--------------|----------------------|
| `/home/mandy/InverseIFHunter/model-hunter/` (PROD) | `feature/multi-turn` | 2216         | Monolith (everything in main.py) |
| `/home/mandy/staging-server/` (STAGING)     | `mth`                | 219          | Modular (routes/, services/, storage/) |

---

## Architecture: What Is Actually Running

```
                    Internet (Trainers)
                           |
              +------------+------------+
              |                         |
         Port 80 (PROD)          Port 443 (STAGING)
              |                         |
    Docker: model-hunter-nginx   Docker: model-hunter-staging-nginx
              |                         |
      +-------+-------+        +-------+-------+
      |               |        |               |
  blue:8000     green:8002  blue:8010    green:8012
      |               |        |               |
      +-------+-------+        +-------+-------+
              |                         |
    model-hunter-redis        model-hunter-staging-redis
         (prod)                    (staging)
              |                         |
    .storage/ (1247 JSON files)  .storage-staging/
         164 MB                      14 MB

    Host nginx: DISABLED (stale config at /etc/nginx/sites-enabled/model-hunter)
    Systemd model-hunter.service: DISABLED (stale, points to venv)
```

**Key fact**: Production and staging are TWO SEPARATE GIT CLONES of the same repo, on DIFFERENT BRANCHES, with DIFFERENT architectures. They share nothing except the VM and the Docker daemon.

---

## Issues

---

### CRITICAL-01: Disk at 84% — 1.6 GB remaining on a 10 GB disk

**Severity**: CRITICAL — will cause full outage when disk fills
**Category**: Infrastructure

**Evidence**:
```
$ df -h
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1       9.7G  7.6G  1.6G  84% /
```

**Where the space is going**:

| Consumer                   | Size       | Notes                                |
|----------------------------|------------|--------------------------------------|
| Docker images (total)      | ~2.4 GB   | 55 images, only 7 active             |
| Dangling images            | 46 images | 87% of image space is reclaimable    |
| .storage/ (prod sessions)  | 164 MB    | 1247 JSON files, growing daily       |
| /var/log                   | 932 MB    | No rotation configured               |
| Docker volumes (all)       | ~106 MB   | 14 volumes, 10 orphaned              |
| Redis AOF (prod)           | 47 MB     | appendonlydir/                       |
| Redis RDB (prod)           | 947 KB    | dump.rdb                             |

**Immediate reclaimable space estimate**:

| Action                                | Recoverable |
|---------------------------------------|-------------|
| `docker image prune` (46 dangling)    | ~1.5-2 GB   |
| Remove orphaned volumes               | ~33 MB      |
| Log rotation / truncation             | ~500-800 MB |
| **Total**                             | **~2-2.8 GB** |

**Impact**: When disk hits 100%, Docker cannot write container logs, Redis cannot persist, containers cannot start, and the entire system halts. With 150 trainers running 24/7 generating session data, this will happen within days to weeks.

**Fix priority**: P0 — do this before any other change.

---

### CRITICAL-02: Production and staging are completely different codebases

**Severity**: CRITICAL — staging does not test what production runs
**Category**: Architecture / Process

**Evidence**:
```
# Production (InverseIFHunter/model-hunter/)
$ git branch --show-current
feature/multi-turn

$ wc -l main.py
2216 main.py
# Everything is in one file: routes, services, schemas, hunt logic, SSE, etc.

# Staging (staging-server/)
$ git branch --show-current
mth

$ wc -l main.py
219 main.py
# Properly modular: routes/, services/, storage/, agentic_reviewer/, helpers/
```

Production has:
- A single monolithic `main.py` (2216 lines)
- `services/` directory with support modules
- No `routes/`, no `storage/`, no `agentic_reviewer/`

Staging has:
- A thin `main.py` (219 lines) that imports from modules
- `routes/` with 11 route files
- `services/` with full service layer
- `storage/` with SQLite + session storage
- `agentic_reviewer/` QC engine
- `config.py` + `config/global.yaml` driven configuration

**Impact**: Testing on staging tells you nothing about production behavior. A bug found and fixed in staging may not even be applicable to production. Deploying staging code to production would be a catastrophic breaking change — the architecture is fundamentally different. The team has no way to safely migrate production to the new codebase because they've never been the same.

**Fix priority**: P0 — this is the root cause of almost every other deployment risk. Must be resolved before any production deploy can be trusted.

---

### CRITICAL-03: Deploy script pulls the wrong branch

**Severity**: CRITICAL — any deploy will push wrong code to production
**Category**: Deployment

**Evidence**:

Three different versions of `deploy.sh` reference three different branches:

| Location                          | `git pull` target            | Actual branch on disk  |
|-----------------------------------|------------------------------|------------------------|
| VM production (`/home/mandy/InverseIFHunter/model-hunter/deploy.sh`) | `git pull origin main` | `feature/multi-turn` |
| Local repo (`mth` branch, `deploy.sh`)                               | `git pull origin multiturn-hunter` | `mth` |
| VM staging (`/home/mandy/staging-server/deploy-staging.sh`)           | `git pull origin mth`  | `mth` |

The production deploy.sh on the VM:
```bash
# Step 1: Pull latest code (optional; if pull fails we continue from current code)
(cd .. && git pull origin main) 2>/dev/null || true
```

But the repo is on `feature/multi-turn`. Running `git pull origin main` on a `feature/multi-turn` checkout will either:
- Fail silently (the `|| true` swallows the error)
- Pull `main` branch changes into `feature/multi-turn`, creating merge conflicts or corruption

The local deploy.sh pulls yet another branch:
```bash
cd "$SCRIPT_DIR/.." && git pull origin multiturn-hunter && cd "$SCRIPT_DIR"
```

**Impact**: Nobody knows which code will actually end up running after a deploy. The `|| true` silently swallows failures, so the deploy "succeeds" even when the git pull fails, deploying stale code.

**Fix priority**: P0.

---

### CRITICAL-04: No Docker log rotation configured

**Severity**: CRITICAL — will fill disk and cause outage
**Category**: Infrastructure

**Evidence**:
```
$ cat /etc/docker/daemon.json
# File does not exist

$ docker info --format '{{.LoggingDriver}}'
json-file
```

No `/etc/docker/daemon.json` means Docker uses the `json-file` logging driver with **no size limit and no rotation**. Every line of stdout/stderr from every container is written to a JSON log file that grows forever.

With 10 containers, 150 trainers generating API calls, and hunt operations producing verbose logging, these log files will fill the remaining 1.6 GB of disk space.

**Impact**: Combined with CRITICAL-01, this is the most likely cause of a future outage. When container logs consume all disk space, Docker cannot start containers, Redis cannot write AOF, and the entire system becomes unrecoverable without manual SSH intervention.

**Fix priority**: P0 — must be configured before or alongside disk cleanup.

---

### CRITICAL-05: Blue/green deploy causes 502 errors for trainers

**Severity**: CRITICAL — trainers experience errors during every deploy
**Category**: Deployment / Nginx

**Evidence**:

The production nginx config inside Docker (`model-hunter-nginx`) load-balances across BOTH instances simultaneously:

```nginx
upstream app {
    server model-hunter-blue:8000;
    server model-hunter-green:8002;
}
```

The deploy script rebuilds one at a time:
```bash
# Step 2: Rebuild green (blue stays up)
docker-compose up -d --build --no-deps model-hunter-green
# Step 4: Rebuild blue (green is now up)
docker-compose up -d --build --no-deps model-hunter-blue
```

But during the rebuild window (~30-60 seconds per container), nginx continues round-robin routing to BOTH upstreams. Approximately 50% of requests hit the rebuilding container and get a **502 Bad Gateway**.

There is no `max_fails` or `fail_timeout` directive, so nginx does not automatically mark the downed upstream as unhealthy. Default nginx behavior will retry on the next request, but the current request fails.

**Impact**: Every single deploy causes intermittent 502 errors for all 150 trainers. With 24/7 usage, there is no safe deploy window. Trainers who are mid-hunt or mid-judge will have their SSE streams severed and in-flight work potentially lost.

**Fix priority**: P0 — the deploy script claims "zero downtime" but this is false.

---

### HIGH-06: Host nginx config has wrong green upstream port

**Severity**: HIGH — silent misconfiguration, dormant
**Category**: Configuration

**Evidence**:

`/etc/nginx/sites-enabled/model-hunter` on the host:
```nginx
upstream model_hunter_green {
    server 127.0.0.1:8000;   # <-- WRONG: this is blue's port
    keepalive 8;
}
```

Green runs on port 8002, but the host nginx config points green's upstream to port 8000 (blue). Both "blue" and "green" health checks hit the same container.

Host nginx is currently **disabled** (`systemctl status nginx` → inactive), so this is dormant. But the config exists and could be activated accidentally.

**Impact**: If anyone runs `systemctl start nginx`, it will conflict with Docker nginx on port 80 (bind error), or if Docker nginx is stopped first, the host nginx will route all traffic to blue only — green becomes unreachable and the "blue/green" setup is a lie.

**Fix priority**: P1 — remove the stale host nginx config to prevent accidents.

---

### HIGH-07: Stale systemd services still registered

**Severity**: HIGH — can conflict with Docker if activated
**Category**: Configuration

**Evidence**:
```
$ cat /etc/systemd/system/model-hunter.service
[Service]
User=mandy
WorkingDirectory=/home/mandy/InverseIFHunter/model-hunter
Environment="PATH=/home/mandy/InverseIFHunter/venv/bin"
ExecStart=/home/mandy/InverseIFHunter/venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
Restart=always

$ cat /etc/systemd/system/model-hunter-dashboard.service
[Service]
User=mandy
WorkingDirectory=/home/mandy/InverseIFHunter/model-hunter/dashboard
ExecStart=/home/mandy/InverseIFHunter/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8001
Restart=always
```

These are remnants of a pre-Docker deployment. Both are disabled but remain on disk. The `model-hunter.service` would bind to port 8000 — the same port Docker's `model-hunter-blue` uses.

**Impact**: If someone runs `systemctl start model-hunter`, it will try to bind port 8000 and either fail (if Docker has it) or start a second instance of the app running old venv code outside Docker — serving stale responses to some trainers.

**Fix priority**: P1 — disable and remove both unit files.

---

### HIGH-08: Production dashboard using 444 MB memory

**Severity**: HIGH — memory leak on a constrained system
**Category**: Performance

**Evidence**:
```
$ docker stats --no-stream
model-hunter-dashboard    444.2MiB / 15.63GiB
model-hunter-blue          95.06MiB / 15.63GiB
model-hunter-green         91.48MiB / 15.63GiB
```

The dashboard container uses **5x the memory** of the main application. The staging dashboard uses only 76 MB, confirming this is not normal baseline usage. The production dashboard has been running for 5 days.

**Impact**: On a system with no swap, 444 MB of leaked memory reduces the available pool for other containers. If this grows further (and it likely will — it's been 5 days), it could trigger the OOM killer, which will randomly kill a container — potentially a production app instance mid-request.

**Fix priority**: P1 — restart the dashboard container as immediate mitigation, investigate the leak.

---

### HIGH-09: No graceful shutdown — SIGTERM goes to shell, not uvicorn

**Severity**: HIGH — active requests killed on deploy
**Category**: Deployment / Docker

**Evidence**:

Both Dockerfiles use:
```dockerfile
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
```

When Docker sends SIGTERM to stop a container, it goes to PID 1 which is `sh`. The `sh` process does not forward signals to child processes by default. Uvicorn never receives SIGTERM and gets no chance to:
- Finish in-flight HTTP requests
- Close SSE streams gracefully
- Flush pending writes

After the grace period (default 10s), Docker sends SIGKILL, hard-killing everything.

**Impact**: During every deploy, active trainer requests are abruptly terminated. SSE streams break mid-event. Any hunt in progress loses partial results. The frontend may show incomplete data or error states.

**Fix priority**: P1 — change CMD to exec form: `CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8010"]` with PORT set via environment.

---

### HIGH-10: Cron job targets container that is rebuilt first during deploy

**Severity**: HIGH — data export fails during deploy windows
**Category**: Operations

**Evidence**:

Crontab:
```
0 4 * * * /home/mandy/InverseIFHunter/model-hunter/ml_pipeline/cron_daily_export.sh
```

The script:
```bash
docker exec model-hunter-green python /app/ml_pipeline/export_ml_data.py \
    --storage /app/.storage \
    --telemetry /app/.telemetry/events.jsonl \
    --output ${EXPORT_DIR}
```

The deploy script rebuilds green FIRST:
```bash
# Step 2: Rebuild and restart GREEN
docker-compose up -d --build --no-deps model-hunter-green
```

If a deploy runs at or near 4 AM, the cron job will `docker exec` into a container that is being rebuilt — getting either "container not running" or executing against a partially initialized container.

Additionally, the cron job runs inside the production container context but the export script path `/app/ml_pipeline/export_ml_data.py` must exist in the container image. If the monolith production image doesn't include this file, the cron silently fails (the log file `/var/log/ml_export.log` is empty, confirming it has never succeeded).

**Impact**: ML data export is silently broken. No export has ever run successfully (empty log file).

**Fix priority**: P1.

---

### MEDIUM-11: No swap on 16 GB RAM with 10 containers

**Severity**: MEDIUM — OOM risk under load spikes
**Category**: Infrastructure

**Evidence**:
```
$ cat /proc/swaps
Filename    Type    Size    Used    Priority
# (empty — no swap configured)

$ free -h
              total    used    free    shared  buff/cache  available
Mem:           15Gi    2.6Gi   10Gi    1.5Mi   2.8Gi       13Gi
Swap:            0B      0B      0B
```

Current memory usage is comfortable (2.6 GB / 16 GB). But this is idle state. Under peak load with 150 concurrent trainers, each triggering parallel LLM API calls with streaming responses held in memory, usage can spike significantly.

**Impact**: Without swap, the OOM killer activates immediately when physical RAM is exhausted. It picks a "victim" process — which could be Redis (losing session data), an app container (killing active hunts), or the Docker daemon itself.

**Fix priority**: P2 — add 2-4 GB swapfile as safety net. Not urgent because current usage is 2.6/16 GB, but load patterns are unpredictable.

---

### MEDIUM-12: All app ports exposed to 0.0.0.0

**Severity**: MEDIUM — unnecessary attack surface
**Category**: Security

**Evidence**:

From `docker ps`:
```
model-hunter-blue     0.0.0.0:8000->8000
model-hunter-green    0.0.0.0:8002->8002
model-hunter-dashboard 0.0.0.0:8001->8001
```

Similarly for staging: ports 8010, 8011, 8012 all on 0.0.0.0.

Only ports 80 (production) and 443 (staging) need to be accessible from the internet. The individual app ports bypass nginx entirely — no rate limiting, no access control, no buffering protection.

GCP firewall rules may block these externally, but defense-in-depth requires not exposing them at all.

**Impact**: If GCP firewall is misconfigured, trainers (or attackers) can hit the raw app containers directly, bypassing nginx proxy headers, dashboard auth, and any future WAF rules.

**Fix priority**: P2 — bind internal ports to `127.0.0.1` in docker-compose or remove port mappings entirely (services can communicate via Docker network).

---

### MEDIUM-13: 10 orphaned Docker volumes from old project iterations

**Severity**: MEDIUM — wasting disk space, causes confusion
**Category**: Infrastructure / Hygiene

**Evidence**:
```
$ docker volume ls -f dangling=true
DRIVER    VOLUME NAME
local     inverseifhunter_redis-data
local     inverseifhunter_telemetry-data
local     model-hunter-refactored_redis-data
local     model-hunter-refactored_telemetry-data
local     model-hunter-staging_redis-data
local     model-hunter-staging_redis-data-staging
local     model-hunter-staging_telemetry-data
local     model-hunter-staging_telemetry-data-staging
local     multiturn-hunter_redis-data
local     multiturn-hunter_telemetry-data
```

These are from at least 5 previous project names/iterations: `inverseifhunter`, `model-hunter-refactored`, `multiturn-hunter`, `model-hunter-staging` (old naming), and `staging-server`. Only 4 volumes are actively used by current containers.

Similarly, orphaned networks exist:
```
inverseifhunter_model-hunter-network
model-hunter-refactored_model-hunter-network
multiturn-hunter_model-hunter-network
staging-server_model-hunter-staging-network
```

**Impact**: ~33 MB of dead volume data. More importantly, the naming confusion (`model-hunter-staging_redis-data` vs `staging-server_redis-data-staging`) makes it unclear which volumes are active, risking accidental deletion of the wrong one.

**Fix priority**: P2 — prune after verifying which volumes are mounted by active containers.

---

### MEDIUM-14: Redis AOF at 47 MB with no compaction monitoring

**Severity**: MEDIUM — could grow unbounded on constrained disk
**Category**: Data / Infrastructure

**Evidence**:
```
$ docker exec model-hunter-redis ls -lh /data/
total 952K
drwx------  2 redis redis  4.0K  appendonlydir    # 47.1 MB
-rw-------  1 redis redis  946.7K dump.rdb

$ docker exec model-hunter-redis redis-cli config get save
save
3600 1 300 100 60 10000

$ docker exec model-hunter-redis redis-cli config get appendonly
appendonly
yes
```

Redis is configured with both RDB snapshots AND AOF persistence. The AOF directory is 47 MB for only 81 keys (4.1 MB of actual data). This means the AOF contains a large history of write operations.

Redis auto-triggers AOF rewrite when the file doubles in size from last rewrite. But with 150 trainers writing session data continuously, the AOF can grow faster than rewrite compacts it.

**Impact**: On a disk with 1.6 GB free, an unexpected AOF growth spike (e.g., bulk session writes) could contribute to disk exhaustion. Combined with CRITICAL-01 and CRITICAL-04, this is part of the disk pressure problem.

**Fix priority**: P2 — monitor AOF size, consider manual `BGREWRITEAOF` during off-peak, or tune rewrite thresholds.

---

### MEDIUM-15: .storage files owned by root — permission mismatch

**Severity**: MEDIUM — backup and manual access may fail
**Category**: Operations

**Evidence**:
```
$ ls -la /home/mandy/InverseIFHunter/model-hunter/.storage/ | head -5
total 167676
drwxr-xr-x  2 mandy mandy  274432 Mar  5 19:34 .
drwxr-xr-x 11 mandy mandy    4096 Mar  5 19:26 ..
-rw-r--r--  1 root  root    92242 Feb  7 10:41 0092bcc4.json
-rw-r--r--  1 root  root    81913 Feb  5 19:58 00a7c2e8.json
```

The `.storage/` directory is owned by `mandy:mandy` but all 1247 JSON files inside are owned by `root:root`. This is because the Docker containers run as root (no `USER` directive in Dockerfile), and the `.storage` directory is bind-mounted from the host.

**Impact**: The `mandy` user can read these files (they're world-readable) but cannot delete or modify them without `sudo`. Backup scripts, manual cleanup, or any host-side tooling running as `mandy` will fail to write or rotate these files.

**Fix priority**: P2 — add `USER` directive to Dockerfile or `chown` in entrypoint.

---

### MEDIUM-16: No backup strategy — single point of failure

**Severity**: MEDIUM — data loss risk
**Category**: Operations / Data

**Evidence**:

All persistent data lives on a single 10 GB disk:
- Redis AOF: `/var/lib/docker/volumes/model-hunter_redis-data/` (48 MB)
- Session JSONs: `/home/mandy/InverseIFHunter/model-hunter/.storage/` (164 MB, 1247 files)
- Telemetry: `/var/lib/docker/volumes/model-hunter_telemetry-data/` (2.7 MB)

There is no:
- VM disk snapshot schedule
- Off-site backup (the cron export script has never run — see HIGH-10)
- Database dump to external storage
- Google Drive backup (rclone section is commented out)

**Impact**: If the VM disk fails, or if a bad deploy corrupts Redis/storage, all trainer session data — including hunt results, notebook states, and review history — is permanently lost. For a 3-4 month project with 150 trainers, this is unacceptable.

**Fix priority**: P2 — implement at minimum a daily rsync to a GCS bucket or Drive.

---

### LOW-17: Trivially guessable admin passwords

**Severity**: LOW — security hygiene
**Category**: Security

**Evidence**:
```
# Production .env
ADMIN_PASSWORD=huntmodel

# Staging .env
ADMIN_MODE_PASSWORD=modelhunter
ADMIN_PASSWORD=modelhunter
```

The dashboard is behind nginx basic auth (`/etc/nginx/.htpasswd`), but the application-level admin password is trivially guessable — it's a permutation of the product name.

**Impact**: Any trainer who guesses the password gets admin access to the dashboard, which includes session data, telemetry, and potentially the ability to export or modify data.

**Fix priority**: P3.

---

### LOW-18: Local repo nginx.conf includes staging server blocks

**Severity**: LOW — config mismatch between repo and VM
**Category**: Configuration

**Evidence**:

The local repo (`mth` branch) nginx.conf contains both production and staging server blocks:
```nginx
upstream staging_app {
    server model-hunter-staging-blue:8010;
    server model-hunter-staging-green:8012;
}

server {
    listen 80;
    server_name staging.inverseifhunter.com staging.local;
    location / {
        proxy_pass http://staging_app;
        ...
    }
}
```

But the production Docker nginx container is on the `model-hunter-network` only — it cannot resolve `model-hunter-staging-blue` because staging containers are on `model-hunter-staging-network`. Every request to the staging server block will produce DNS resolution errors in nginx logs.

Meanwhile, the actual VM production nginx.conf is a simpler version without staging blocks.

**Impact**: If the local repo's nginx.conf is deployed to production, nginx will log DNS errors on every staging upstream resolution attempt. These errors won't affect production routing (the staging server block only matches specific hostnames), but they'll pollute logs and could mask real errors.

**Fix priority**: P3 — keep production nginx.conf clean, staging-only config in staging compose.

---

### LOW-19: docker-compose v1 (1.29.2) is EOL

**Severity**: LOW — no security patches, known bugs
**Category**: Infrastructure

**Evidence**:
```
$ docker-compose --version
docker-compose version 1.29.2, build unknown
```

Docker Compose v1 reached end-of-life in April 2023. It has known bugs including:
- Race conditions in parallel container startup
- Inconsistent handling of `depends_on` with health checks
- No support for newer compose spec features

The VM does not have `docker compose` (v2 plugin) installed.

**Impact**: Potential for subtle deployment bugs that are already fixed in Compose v2. No security patches for any newly discovered vulnerabilities.

**Fix priority**: P3 — upgrade to Compose v2 plugin during next maintenance window.

---

### LOW-20: Dockerfile COPY includes everything — bloated images

**Severity**: LOW — wastes disk space on every build
**Category**: Infrastructure / Build

**Evidence**:

Production Dockerfile:
```dockerfile
COPY . .
```

No `.dockerignore` was found in the production directory. This means every build copies:
- `tests/` directory
- `.github/` workflows
- `__pycache__/`
- `*.md` documentation files
- `test_*.py` files
- `deploy.sh`, `verify-deployment.sh`, `diagnose-500.sh`
- `.git/` (if present in build context)

Production image size: **789 MB**. Staging image size: **638 MB**. The 151 MB difference may be partly due to the monolith including more code, but unnecessary files inflate both.

On a 10 GB disk where every deploy builds 2 images (blue + green), this waste is compounded. A proper `.dockerignore` could reduce image size by 50-100 MB each.

**Impact**: Each deploy consumes more disk than necessary. With 46 dangling images already clogging the disk (CRITICAL-01), smaller images directly extend the time before disk exhaustion.

**Fix priority**: P3.

---

## Disk Space Recovery Plan

Estimated space that can be recovered **without affecting running services**:

| Action                                              | Est. Recovery | Risk    |
|-----------------------------------------------------|---------------|---------|
| `docker image prune -f` (remove 46 dangling images) | 1.5-2 GB      | None    |
| `docker volume prune` (10 orphaned volumes)          | ~33 MB        | Low*    |
| Configure log rotation + truncate old logs           | 500-800 MB    | None    |
| `docker network prune` (4 orphaned networks)         | ~0 MB         | None    |
| Add `.dockerignore` (future builds smaller)          | 50-100 MB/build | None |
| **Total immediate**                                  | **~2-2.8 GB** |         |

*Verify orphaned volumes don't contain data you need before pruning.

---

## Priority-Ordered Fix List

### Phase 0: Emergency disk recovery (do FIRST, before any deploy)

1. Prune dangling Docker images: `docker image prune -f`
2. Create `/etc/docker/daemon.json` with log rotation:
   ```json
   {
     "log-driver": "json-file",
     "log-opts": {
       "max-size": "10m",
       "max-file": "3"
     }
   }
   ```
3. Restart Docker daemon (this will restart all containers — schedule during low-traffic)
4. Prune orphaned volumes (after verifying contents): `docker volume prune`
5. Prune orphaned networks: `docker network prune`

### Phase 1: Fix deploy pipeline (before next production deploy)

6. Fix deploy.sh to pull the correct branch
7. Decide: are we migrating production to `mth` (modular) codebase, or keeping monolith? This determines everything else
8. Add `max_fails=2 fail_timeout=10s` to nginx upstream, or switch to proper blue/green (only one in upstream at a time, swap after health check)
9. Fix Dockerfile CMD to exec form for graceful shutdown
10. Remove stale host nginx config and systemd services

### Phase 2: Stability hardening

11. Add swap (2-4 GB swapfile)
12. Bind internal ports to 127.0.0.1 only in docker-compose
13. Fix .storage file ownership (add USER to Dockerfile or entrypoint chown)
14. Restart production dashboard to reclaim 444 MB, investigate leak
15. Fix cron job to target blue (or make it container-agnostic)
16. Implement daily backup to GCS or Google Drive

### Phase 3: Hygiene

17. Rotate admin passwords
18. Clean nginx.conf — separate prod and staging configs
19. Upgrade docker-compose to v2
20. Add `.dockerignore` to reduce image size
