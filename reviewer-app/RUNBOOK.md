# Reviewer App — Runbook

Production-ready runbook for local and VM deployment. See also [README.md](./README.md) and [IMPLEMENTING/REVIEWER_SOURCE_OF_TRUTH.md](../IMPLEMENTING/REVIEWER_SOURCE_OF_TRUTH.md).

---

## 1. Reviewer identity (R6.2)

**How reviewers are identified**

- The app does **not** implement login or sessions. Identity is provided per request via **HTTP headers**.
- **Allowed identities** are listed in `config/global.yaml` under `reviewer.allowed_emails` (e.g. `reviewer@example.com`). Only these values can access reviewer APIs.
- The **UI** stores the email in `sessionStorage` after the first successful check and sends it as `X-Reviewer-Email` on every API request.
- **API**: Any request to `/api/*` must include either:
  - `X-Reviewer-Email: <email>` or
  - `X-Reviewer-Id: <id>`
  The value is checked against `reviewer.allowed_emails` (case-insensitive). If missing or not in the list, the response is **403 Forbidden**.

**For production** you can later replace this with real auth (e.g. OAuth, SSO) and set the header from the auth layer. The allowlist in YAML remains the source of who can act as a reviewer.

---

## 2. Run reviewer app locally (R6.3)

**Prerequisites**

- Python 3.10+
- Redis running (same instance as the trainer app)
- `config/global.yaml` in the **agentic-reviewer** repo root (with `reviewer.allowed_emails` and optional `reviewer.agent`)

**Steps**

1. **Start Redis** (if not already running):
   ```bash
   redis-server
   ```

2. **Install dependencies** (from agentic-reviewer root or reviewer-app):
   ```bash
   pip install -r reviewer-app/requirements.txt
   ```
   Or use the same venv as the trainer app.

3. **Environment** (optional): Create `.env` in agentic-reviewer root or in `app/model-hunter-refactored/` with:
   - `REDIS_URL` (default `redis://localhost:6379/0`)
   - `OPENROUTER_API_KEY` (required if you use the reviewer agent)

4. **Add your email to the allowlist** in `config/global.yaml`:
   ```yaml
   reviewer:
     allowed_emails: ["your@email.com"]
   ```

5. **Start the reviewer app** from the **reviewer-app** directory:
   ```bash
   cd reviewer-app
   uvicorn main:app --reload --port 8001
   ```

6. **Open** `http://localhost:8001/` in a browser, enter your allowlisted email, and use the queue, task view, feedback, edit, and agent.

**Health checks**

- `GET http://localhost:8001/health` → `{"status":"ok"}`
- `GET http://localhost:8001/ready` → `{"status":"ok","redis":"connected"}` (or 503 if Redis is down)

---

## 3. Deploy on VM with ports 80/443 (R6.4)

On the production VM **only ports 80 and 443** are open. Use two hostnames (or paths) so both trainer and reviewer apps are served over 80/443.

**Typical setup**

- **Trainer app (main):** e.g. `https://trainers.example.com` → reverse proxy (nginx/Caddy) → trainer app (e.g. uvicorn on 127.0.0.1:8000).
- **Reviewer app:** e.g. `https://reviewers.example.com` → reverse proxy → reviewer app (e.g. uvicorn on 127.0.0.1:8001).

**Steps**

1. **Run reviewer app** on a local port (e.g. 8001) bound to `127.0.0.1` or `0.0.0.0`:
   ```bash
   cd /path/to/agentic-reviewer/reviewer-app
   uvicorn main:app --host 0.0.0.0 --port 8001
   ```
   Or use a process manager (systemd, supervisord) and set `WorkingDirectory` to `reviewer-app`.

2. **Configure the reverse proxy** (example for **nginx**):
   ```nginx
   server {
       listen 443 ssl;
       server_name reviewers.example.com;
       ssl_certificate /path/to/cert.pem;
       ssl_certificate_key /path/to/key.pem;
       location / {
           proxy_pass http://127.0.0.1:8001;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```

3. **Environment**: Ensure `REDIS_URL` and `OPENROUTER_API_KEY` (if using the agent) are set in the environment or `.env` used by the reviewer app process. `config/global.yaml` is loaded from the agentic-reviewer root (parent of `reviewer-app`), so set `WorkingDirectory` or run from repo root if needed.

4. **Allowlist**: Keep `reviewer.allowed_emails` in `config/global.yaml` up to date; only those identities can access the reviewer app. Restrict access to the reviewer hostname (e.g. firewall or VPN) if required.

**Summary**

| Role      | URL                      | App          | Port (internal) |
|-----------|--------------------------|--------------|------------------|
| Trainers  | https://trainers.example.com  | Trainer app  | 8000             |
| Reviewers | https://reviewers.example.com | Reviewer app | 8001             |

Same VM, same Redis; two hostnames on 80/443.
