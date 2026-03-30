defmodule ModelHunterEdgeWeb.MetricsController do
  use ModelHunterEdgeWeb, :controller

  @prom """
  # HELP mh_elixir_edge_up Elixir edge HTTP server is running
  # TYPE mh_elixir_edge_up gauge
  mh_elixir_edge_up 1
  """

  def index(conn, _params) do
    conn
    |> put_resp_content_type("text/plain; version=0.0.4")
    |> send_resp(200, @prom)
  end
end
