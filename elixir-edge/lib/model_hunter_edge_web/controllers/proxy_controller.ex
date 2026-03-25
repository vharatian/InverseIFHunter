defmodule ModelHunterEdgeWeb.ProxyController do
  @moduledoc """
  Forwards /api/* requests to Python core service.
  Generates/propagates X-Trace-Id and X-Authenticated-User headers.
  """
  use Plug.Router
  require Logger

  plug :match
  plug :dispatch

  match _ do
    python_url =
      Application.get_env(:model_hunter_edge, :python_core_url, "http://localhost:8000")

    target_url = "#{python_url}#{conn.request_path}"

    target_url =
      if conn.query_string != "", do: "#{target_url}?#{conn.query_string}", else: target_url

    trace_id = get_or_generate_trace_id(conn)
    auth_user = extract_auth_user(conn)

    {:ok, body, conn} = Plug.Conn.read_body(conn)

    headers = build_proxy_headers(conn, trace_id, auth_user)

    case Finch.build(method_atom(conn.method), target_url, headers, body)
         |> Finch.request(ModelHunterEdge.Finch, receive_timeout: 30_000) do
      {:ok, response} ->
        conn
        |> put_resp_content_type(get_content_type(response.headers))
        |> Plug.Conn.put_resp_header("x-trace-id", trace_id)
        |> send_resp(response.status, response.body)

      {:error, %Finch.Error{reason: :timeout}} ->
        Logger.warning(
          "Proxy timeout for #{conn.method} #{conn.request_path} trace=#{trace_id}"
        )

        conn
        |> put_resp_content_type("application/json")
        |> Plug.Conn.put_resp_header("x-trace-id", trace_id)
        |> send_resp(
          504,
          Jason.encode!(%{
            error: %{
              code: "INTERNAL_SERVICE_ERROR",
              message: "Server is taking too long. Please try again.",
              trace_id: trace_id
            }
          })
        )

      {:error, reason} ->
        Logger.error(
          "Proxy error for #{conn.method} #{conn.request_path}: #{inspect(reason)} trace=#{trace_id}"
        )

        conn
        |> put_resp_content_type("application/json")
        |> Plug.Conn.put_resp_header("x-trace-id", trace_id)
        |> send_resp(
          502,
          Jason.encode!(%{
            error: %{
              code: "INTERNAL_SERVICE_ERROR",
              message: "Backend service unavailable.",
              trace_id: trace_id
            }
          })
        )
    end
  end

  defp get_or_generate_trace_id(conn) do
    case Plug.Conn.get_req_header(conn, "x-trace-id") do
      [tid | _] -> tid
      [] -> "tr_" <> Base.encode16(:crypto.strong_rand_bytes(6), case: :lower)
    end
  end

  defp extract_auth_user(conn) do
    case Plug.Conn.get_req_header(conn, "x-trainer-email") do
      [email | _] ->
        email

      [] ->
        case Plug.Conn.get_req_header(conn, "x-reviewer-email") do
          [email | _] -> email
          [] -> nil
        end
    end
  end

  defp build_proxy_headers(conn, trace_id, auth_user) do
    base = [
      {"x-trace-id", trace_id},
      {"content-type",
       List.first(Plug.Conn.get_req_header(conn, "content-type")) || "application/json"},
      {"accept", List.first(Plug.Conn.get_req_header(conn, "accept")) || "application/json"}
    ]

    if auth_user, do: [{"x-authenticated-user", auth_user} | base], else: base
  end

  defp get_content_type(headers) do
    case List.keyfind(headers, "content-type", 0) do
      {_, ct} -> ct
      nil -> "application/json"
    end
  end

  defp method_atom(m) do
    case String.upcase(m) do
      "GET" -> :get
      "POST" -> :post
      "PUT" -> :put
      "PATCH" -> :patch
      "DELETE" -> :delete
      "OPTIONS" -> :options
      "HEAD" -> :head
      _ -> :get
    end
  end
end
