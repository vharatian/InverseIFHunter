defmodule ModelHunterEdgeWeb.UserSocket do
  use Phoenix.Socket

  channel "hunt:*", ModelHunterEdgeWeb.HuntChannel
  channel "notify:*", ModelHunterEdgeWeb.NotificationChannel

  @impl true
  def connect(params, socket, _connect_info) do
    case Map.get(params, "user_email") do
      nil -> :error
      email -> {:ok, assign(socket, :user_email, email)}
    end
  end

  @impl true
  def id(socket), do: "user_socket:#{socket.assigns.user_email}"
end
