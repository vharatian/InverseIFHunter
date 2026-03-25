defmodule ModelHunterEdgeWeb.Endpoint do
  use Phoenix.Endpoint, otp_app: :model_hunter_edge

  @session_options [
    store: :cookie,
    key: "_model_hunter_edge_key",
    signing_salt: "IUDZkKhB",
    same_site: "Lax"
  ]

  socket "/socket", ModelHunterEdgeWeb.UserSocket,
    websocket: true,
    longpoll: false

  plug Plug.Static,
    at: "/",
    from: :model_hunter_edge,
    gzip: not code_reloading?,
    only: ModelHunterEdgeWeb.static_paths(),
    raise_on_missing_only: code_reloading?

  if code_reloading? do
    plug Phoenix.CodeReloader
  end

  plug Plug.RequestId
  plug Plug.Telemetry, event_prefix: [:phoenix, :endpoint]

  plug Plug.Parsers,
    parsers: [:urlencoded, :multipart, :json],
    pass: ["*/*"],
    json_decoder: Phoenix.json_library()

  plug Plug.MethodOverride
  plug Plug.Head
  plug Plug.Session, @session_options
  plug ModelHunterEdgeWeb.Router
end
