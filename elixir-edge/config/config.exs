import Config

config :model_hunter_edge,
  generators: [timestamp_type: :utc_datetime]

# Configure the endpoint
config :model_hunter_edge, ModelHunterEdgeWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [
    formats: [json: ModelHunterEdgeWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: ModelHunterEdge.PubSub,
  live_view: [signing_salt: "evOqoPiG"]

config :model_hunter_edge, :python_core_url, "http://localhost:8000"
config :model_hunter_edge, :redis_url, "redis://localhost:6379/0"

# Configure Elixir's Logger
config :logger, :default_formatter,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id]

# Use Jason for JSON parsing in Phoenix
config :phoenix, :json_library, Jason

# Import environment specific config. This must remain at the bottom
# of this file so it overrides the configuration defined above.
import_config "#{config_env()}.exs"
