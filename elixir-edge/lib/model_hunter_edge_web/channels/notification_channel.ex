defmodule ModelHunterEdgeWeb.NotificationChannel do
  use ModelHunterEdgeWeb, :channel

  @impl true
  def join("notify:" <> user_email, _payload, socket) do
    if socket.assigns.user_email == user_email do
      Phoenix.PubSub.subscribe(ModelHunterEdge.PubSub, "notify:#{user_email}")
      {:ok, socket}
    else
      {:error, %{reason: "unauthorized"}}
    end
  end

  @impl true
  def handle_info({:redis_event, event}, socket) do
    push(socket, "notification", event)
    {:noreply, socket}
  end
end
