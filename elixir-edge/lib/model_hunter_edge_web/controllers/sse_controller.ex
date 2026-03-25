defmodule ModelHunterEdgeWeb.SSEController do
  @moduledoc """
  SSE fallback for clients that can't use WebSocket.
  Subscribes to Phoenix PubSub and streams events.
  """
  use ModelHunterEdgeWeb, :controller
  require Logger

  def stream(conn, %{"session_id" => session_id}) do
    Phoenix.PubSub.subscribe(ModelHunterEdge.PubSub, "hunt:#{session_id}")

    conn =
      conn
      |> put_resp_content_type("text/event-stream")
      |> put_resp_header("cache-control", "no-cache")
      |> put_resp_header("connection", "keep-alive")
      |> put_resp_header("x-accel-buffering", "no")
      |> send_chunked(200)

    sse_loop(conn)
  end

  defp sse_loop(conn) do
    receive do
      {:redis_event, event} ->
        data = Jason.encode!(event)

        case Plug.Conn.chunk(conn, "data: #{data}\n\n") do
          {:ok, conn} -> sse_loop(conn)
          {:error, _} -> conn
        end
    after
      30_000 ->
        case Plug.Conn.chunk(conn, ": keepalive\n\n") do
          {:ok, conn} -> sse_loop(conn)
          {:error, _} -> conn
        end
    end
  end
end
