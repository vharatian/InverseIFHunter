import Config

config :model_hunter_edge, :python_core_url,
  System.get_env("PYTHON_CORE_URL") || "http://localhost:8000"

config :model_hunter_edge, :python_dashboard_url,
  System.get_env("PYTHON_DASHBOARD_URL") || "http://localhost:8001"

config :model_hunter_edge, :redis_url,
  System.get_env("REDIS_URL") || "redis://localhost:6379/0"

if System.get_env("PHX_SERVER") do
  config :model_hunter_edge, ModelHunterEdgeWeb.Endpoint, server: true
end

port = String.to_integer(System.get_env("PORT") || "4000")
config :model_hunter_edge, ModelHunterEdgeWeb.Endpoint,
  http: [ip: {0, 0, 0, 0}, port: port],
  server: true

if config_env() == :prod do
  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise """
      environment variable SECRET_KEY_BASE is missing.
      You can generate one by calling: mix phx.gen.secret
      """

  host = System.get_env("PHX_HOST") || "example.com"
  scheme = System.get_env("PHX_URL_SCHEME") || "http"
  pub_port = String.to_integer(System.get_env("PHX_PUBLIC_PORT") || "80")

  config :model_hunter_edge, :dns_cluster_query, System.get_env("DNS_CLUSTER_QUERY")

  config :model_hunter_edge, ModelHunterEdgeWeb.Endpoint,
    url: [host: host, port: pub_port, scheme: scheme],
    http: [
      ip: {0, 0, 0, 0, 0, 0, 0, 0}
    ],
    secret_key_base: secret_key_base
end
