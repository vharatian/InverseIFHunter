import Config

# For development, we disable any cache and enable
# debugging and code reloading.
config :model_hunter_edge, ModelHunterEdgeWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4000],
  check_origin: false,
  code_reloader: true,
  debug_errors: true,
  secret_key_base: "dQbd1NKj3H8FAQH85MSW4LgMMUiAbX0daTgU5tPoaCIbTYaCu4LcV34q5J889m0v",
  watchers: []

# Enable dev routes for dashboard and mailbox
config :model_hunter_edge, dev_routes: true

# Do not include metadata nor timestamps in development logs
config :logger, :default_formatter, format: "[$level] $message\n"

# Set a higher stacktrace during development. Avoid configuring such
# in production as building large stacktraces may be expensive.
config :phoenix, :stacktrace_depth, 20

# Initialize plugs at runtime for faster development compilation
config :phoenix, :plug_init_mode, :runtime
