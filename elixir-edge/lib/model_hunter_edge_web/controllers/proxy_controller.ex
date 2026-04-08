defmodule ModelHunterEdgeWeb.ProxyController do
  @moduledoc """
  Reverse proxy to Python services: core (trainer, reviewer, /api) and dashboard (monitoring, /admin).
  Generates/propagates X-Trace-Id and X-Authenticated-User headers.

  Path routing source of truth: config_routing.py
  /dashboard -> PYTHON_DASHBOARD_URL (strips /dashboard prefix)
  /admin, /api/admin -> PYTHON_DASHBOARD_URL (keeps path)
  everything else -> PYTHON_CORE_URL (keeps path, including /reviewer)
  """
  use Plug.Router
  require Logger

  plug :match
  plug :dispatch

  @sse_timeout 1_200_000
  @default_timeout 60_000

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

    req = Finch.build(method_atom(conn.method), target_url, headers, body)

    accept = List.first(Plug.Conn.get_req_header(conn, "accept")) || ""
    is_sse_request = String.contains?(accept, "text/event-stream") or
                     String.contains?(request_path, "-stream")
    timeout = if is_sse_request, do: @sse_timeout, else: @default_timeout

    case proxy_request(req, conn, trace_id, timeout) do
      {:ok, conn} ->
        conn

      {:error, :timeout} ->
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

  # Use Finch.stream/5: on headers, decide SSE (chunked) vs normal (buffer).
  # Accumulator: {mode, status, resp_headers, conn_or_body_acc}
  #   mode = :init | :sse | :buffer
  defp proxy_request(req, conn, trace_id, timeout) do
    init_acc = {:init, nil, nil, conn}

    result =
      Finch.stream(
        req,
        ModelHunterEdge.Finch,
        init_acc,
        fn
          {:status, status}, {:init, _, _, conn} ->
            {:init, status, nil, conn}

          {:headers, resp_headers}, {:init, status, _, conn} ->
            ct = get_content_type(resp_headers)

            if String.starts_with?(ct, "text/event-stream") do
              chunked_conn =
                conn
                |> forward_set_cookie_headers(resp_headers)
                |> put_resp_content_type("text/event-stream")
                |> Plug.Conn.put_resp_header("x-trace-id", trace_id)
                |> Plug.Conn.put_resp_header("cache-control", "no-cache")
                |> Plug.Conn.put_resp_header("x-accel-buffering", "no")
                |> Plug.Conn.send_chunked(status)

              {:sse, status, resp_headers, chunked_conn}
            else
              {:buffer, status, resp_headers, []}
            end

          {:data, chunk}, {:sse, status, hdrs, chunked_conn} ->
            case Plug.Conn.chunk(chunked_conn, chunk) do
              {:ok, new_conn} -> {:sse, status, hdrs, new_conn}
              {:error, _} -> {:sse, status, hdrs, chunked_conn}
            end

          {:data, chunk}, {:buffer, status, hdrs, body_acc} ->
            {:buffer, status, hdrs, [body_acc, chunk]}

          _other, acc ->
            acc
        end,
        receive_timeout: timeout
      )

    case result do
      {:ok, {:sse, _status, _hdrs, final_conn}} ->
        {:ok, final_conn}

      {:ok, {:buffer, status, resp_headers, body_acc}} ->
        body = IO.iodata_to_binary(body_acc)

        final_conn =
          conn
          |> forward_set_cookie_headers(resp_headers)
          |> put_resp_content_type(get_content_type(resp_headers))
          |> Plug.Conn.put_resp_header("x-trace-id", trace_id)
          |> send_resp(status, body)

        {:ok, final_conn}

      # SSE stream that was partially sent before error — connection already chunked
      {:error, _exception, {:sse, _status, _hdrs, final_conn}} ->
        {:ok, final_conn}

      # Buffered request that errored mid-stream before any data sent
      {:error, _exception, {:buffer, _status, _hdrs, _body_acc}} ->
        {:error, :timeout}

      # Error before headers arrived
      {:error, _exception, {:init, _, _, _conn}} ->
        {:error, :timeout}

      # 2-tuple errors (Finch.Error)
      {:error, %Finch.Error{reason: :timeout}} ->
        {:error, :timeout}

      {:error, reason} ->
        {:error, reason}
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
        [
          "x-forwarded-for", "x-forwarded-proto", "x-forwarded-prefix", "x-real-ip",
          "x-reviewer-email", "x-reviewer-id", "x-trainer-email"
        ],
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
