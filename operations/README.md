# Operations runbook

Use this folder first during outages or staging verification. It complements deployment mechanics in [DEPLOYMENT.md](../DEPLOYMENT.md) and health semantics in the repo [README.md](../README.md).

## Contents

| File | Use |
|------|-----|
| [APPS.md](APPS.md) | Four apps: URLs (staging vs prod), what “up” means, dependencies, logs |
| [SMOKE_CHECKS.md](SMOKE_CHECKS.md) | Copy-paste `curl` and quick browser checks |
| [KNOWN_ISSUES.md](KNOWN_ISSUES.md) | Recurring symptoms and workarounds |
| [incidents/TEMPLATE.md](incidents/TEMPLATE.md) | Incident write-up template; add dated files under `incidents/` |
| [smoke.sh](smoke.sh) | Non-interactive smoke script (`DOMAIN` env, optional `STAGING_PREFIX`) |

## Environment variables (mental model)

- **`DOMAIN`**: Hostname or IP of the VM (e.g. from `.env` / examples in `.env.staging.example`).
- **Staging**: Public paths include the prefix **`/staging`** (stripped by nginx before Elixir). **Production** uses the same path segments **without** `/staging` (e.g. `/dashboard/` not `/staging/dashboard/`).

Routing source of truth: [config_routing.py](../config_routing.py). Elixir proxy rules: [proxy_controller.ex](../elixir-edge/lib/model_hunter_edge_web/controllers/proxy_controller.ex).

## On the VM (quick)

```bash
./deploy.sh status prod    # or: staging
./deploy.sh logs prod
```

See [DEPLOYMENT.md](../DEPLOYMENT.md) for ports, rollback, Grafana URLs, and `curl` to Elixir on localhost.

## Monitoring

Prometheus/Grafana configs live under [monitoring/](../monitoring/). Staging Grafana (when deployed): `http://<DOMAIN>/staging/grafana/`. Production: `http://<DOMAIN>/grafana/`.
