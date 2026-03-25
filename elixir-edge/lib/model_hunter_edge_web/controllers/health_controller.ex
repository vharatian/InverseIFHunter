defmodule ModelHunterEdgeWeb.HealthController do
  use ModelHunterEdgeWeb, :controller

  def live(conn, _params) do
    json(conn, %{status: "ok"})
  end

  def ready(conn, _params) do
    python_ok = check_python()
    redis_ok = check_redis()
    status = if python_ok and redis_ok, do: "ready", else: "degraded"

    json(conn, %{
      status: status,
      checks: %{
        python_core: if(python_ok, do: "ok", else: "error"),
        redis: if(redis_ok, do: "ok", else: "error")
      }
    })
  end

  def deep(conn, params) do
    ready(conn, params)
  end

  defp check_python do
    python_url =
      Application.get_env(:model_hunter_edge, :python_core_url, "http://localhost:8000")

    case Finch.build(:get, "#{python_url}/health/live")
         |> Finch.request(ModelHunterEdge.Finch, receive_timeout: 5_000) do
      {:ok, %{status: 200}} -> true
      _ -> false
    end
  end

  defp check_redis do
    redis_url = Application.get_env(:model_hunter_edge, :redis_url, "redis://localhost:6379/0")

    case Redix.start_link(redis_url) do
      {:ok, conn} ->
        result = Redix.command(conn, ["PING"])
        Redix.stop(conn)
        match?({:ok, "PONG"}, result)

      _ ->
        false
    end
  end
end
