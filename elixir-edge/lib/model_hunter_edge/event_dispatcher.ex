defmodule ModelHunterEdge.EventDispatcher do
  @moduledoc """
  Routes Redis pub/sub events to Phoenix PubSub topics.
  Channels subscribe to PubSub topics and push to connected clients.
  """
  require Logger

  @pubsub ModelHunterEdge.PubSub

  def dispatch(channel, event) do
    case extract_topic(channel, event) do
      {:ok, topic, payload} ->
        Phoenix.PubSub.broadcast(@pubsub, topic, {:redis_event, payload})

      :ignore ->
        :ok
    end
  end

  defp extract_topic(channel, event) do
    session_id = Map.get(event, "session_id")

    cond do
      String.starts_with?(channel, "mh:events:hunt:") and session_id != nil ->
        {:ok, "hunt:#{session_id}", event}

      String.starts_with?(channel, "mh:events:qc:") and session_id != nil ->
        {:ok, "hunt:#{session_id}", event}

      String.starts_with?(channel, "mh:events:calibrate:") and session_id != nil ->
        {:ok, "hunt:#{session_id}", event}

      String.starts_with?(channel, "mh:events:notify:") ->
        user = String.replace_prefix(channel, "mh:events:notify:", "")
        {:ok, "notify:#{user}", event}

      String.starts_with?(channel, "mh:events:presence") ->
        {:ok, "presence:lobby", event}

      String.starts_with?(channel, "mh:events:system") ->
        {:ok, "system:broadcast", event}

      true ->
        :ignore
    end
  end
end
