defmodule ModelHunterEdgeWeb.Router do
  use ModelHunterEdgeWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/health", ModelHunterEdgeWeb do
    get "/live", HealthController, :live
    get "/ready", HealthController, :ready
    get "/deep", HealthController, :deep
  end

  scope "/", ModelHunterEdgeWeb do
    get "/metrics", MetricsController, :index
  end

  scope "/sse", ModelHunterEdgeWeb do
    get "/hunt/:session_id", SSEController, :stream
  end

  # Core: /, /static, /reviewer, /api, …  Dashboard: /dashboard/* → PYTHON_DASHBOARD_URL (path stripped).
  forward "/", ModelHunterEdgeWeb.ProxyController
end
