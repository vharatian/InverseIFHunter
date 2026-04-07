defmodule ModelHunterEdgeWeb.ProxyController do
  @moduledoc """
  Reverse proxy to Python services: core (trainer, reviewer, /api) and dashboard (monitoring, /admin).
  Generates/propagates X-Trace-Id and X-Authenticated-User headers.
  """
  use Plug.Router
  require Logger

  plug :match
  plug :dispatch

  match _ do
    request_path = conn.request_path

    {base_url, upstream_path} = resolve_upstream(request_path)

    target_url = "#{String.trim_trailing(base_url, "/")}#{upstream_path}"

    target_url =
      if conn.query_string != "", do: "#{target_url}?#{conn.query_string}", else: target_url

    trace_id = get_or_generate_trace_id(conn)
    auth_user = extract_auth_user(conn)

    body = get_request_body(conn)

    headers = build_proxy_headers(conn, trace_id, auth_user)

    case Finch.build(method_atom(conn.method), target_url, headers, body)
         |> Finch.request(ModelHunterEdge.Finch, receive_timeout: 30_000) do
      {:ok, response} ->
        conn
        |> forward_set_cookie_headers(response.headers)
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

  defp resolve_upstream(request_path) do
    core = Application.get_env(:model_hunter_edge, :python_core_url, "http://localhost:8000")
    dash = Application.get_env(:model_hunter_edge, :python_dashboard_url, "http://localhost:8001")

    cond do
      String.starts_with?(request_path, "/dashboard") ->
        suffix =
          case String.replace_prefix(request_path, "/dashboard", "") do
            "" -> "/"
            "/" -> "/"
            other -> other
          end

        {dash, suffix}

      String.starts_with?(request_path, "/admin") or
        String.starts_with?(request_path, "/api/admin") ->
        {dash, request_path}

      true ->
        {core, request_path}
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

  defp get_request_body(conn) do
    case conn.body_params do
      %Plug.Conn.Unfetched{} ->
        case Plug.Conn.read_body(conn) do
          {:ok, body, _conn} -> body
          _ -> ""
        end

      params when is_map(params) and map_size(params) > 0 ->
        Jason.encode!(params)

      _ ->
        ""
    end
  end

  defp forward_set_cookie_headers(conn, headers) do
    headers
    |> Enum.filter(fn {name, _} -> name == "set-cookie" end)
    |> Enum.reduce(conn, fn {_, value}, acc ->
      %{acc | resp_headers: [{"set-cookie", value} | acc.resp_headers]}
    end)
  end

  defp build_proxy_headers(conn, trace_id, auth_user) do
    base = [
      {"x-trace-id", trace_id},
      {"content-type",
       List.first(Plug.Conn.get_req_header(conn, "content-type")) || "application/json"},
      {"accept", List.first(Plug.Conn.get_req_header(conn, "accept")) || "*/*"}
    ]

    base =
      case Plug.Conn.get_req_header(conn, "cookie") do
        [cookie | _] -> [{"cookie", cookie} | base]
        [] -> base
      end

    base =
      Enum.reduce(
        ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-prefix", "x-real-ip"],
        base,
        fn header, acc ->
          case Plug.Conn.get_req_header(conn, header) do
            [val | _] -> [{header, val} | acc]
            [] -> acc
          end
        end
      )

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
