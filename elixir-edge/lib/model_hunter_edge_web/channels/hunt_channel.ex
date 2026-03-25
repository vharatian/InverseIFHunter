defmodule ModelHunterEdgeWeb.HuntChannel do
  use ModelHunterEdgeWeb, :channel

  @impl true
  def join("hunt:" <> session_id, _payload, socket) do
    Phoenix.PubSub.subscribe(ModelHunterEdge.PubSub, "hunt:#{session_id}")
    {:ok, assign(socket, :session_id, session_id)}
  end

  @impl true
  def handle_info({:redis_event, event}, socket) do
    push(socket, "event", event)
    {:noreply, socket}
  end
end
