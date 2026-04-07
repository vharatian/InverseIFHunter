import Config

config :model_hunter_edge, ModelHunterEdgeWeb.Endpoint,
  cache_static_manifest: "priv/static/cache_manifest.json"

# force_ssl disabled — deployment is HTTP-only behind nginx.
# Re-enable when HTTPS is configured:
# config :model_hunter_edge, ModelHunterEdgeWeb.Endpoint,
#   force_ssl: [
#     rewrite_on: [:x_forwarded_proto],
#     exclude: [hosts: ["localhost", "127.0.0.1"]]
#   ]

# Do not print debug messages in production
config :logger, level: :info
