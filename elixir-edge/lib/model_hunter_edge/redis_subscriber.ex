defmodule ModelHunterEdge.RedisSubscriber do
  @moduledoc """
  GenServer that subscribes to mh:events:* Redis pub/sub channels
  and forwards messages to the EventDispatcher.
  """
  use GenServer
  require Logger

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    redis_url = Application.get_env(:model_hunter_edge, :redis_url, "redis://localhost:6379/0")

    case Redix.PubSub.start_link(redis_url, name: :redix_pubsub) do
      {:ok, pubsub} ->
        Redix.PubSub.psubscribe(pubsub, "mh:events:*", self())
        Logger.info("RedisSubscriber: connected and psubscribed to mh:events:*")
        {:ok, %{pubsub: pubsub}}

      {:error, reason} ->
        Logger.error("RedisSubscriber: failed to connect: #{inspect(reason)}")
        {:ok, %{pubsub: nil}}
    end
  end

  @impl true
  def handle_info({:redix_pubsub, _pubsub, _ref, :psubscribed, %{pattern: pattern}}, state) do
    Logger.debug("RedisSubscriber: psubscribed to #{pattern}")
    {:noreply, state}
  end

  @impl true
  def handle_info({:redix_pubsub, _pubsub, _ref, :subscribed, %{channel: channel}}, state) do
    Logger.debug("RedisSubscriber: subscribed to #{channel}")
    {:noreply, state}
  end

  @impl true
  def handle_info(
        {:redix_pubsub, _pubsub, _ref, :pmessage,
         %{pattern: _pattern, channel: channel, payload: payload}},
        state
      ) do
    case Jason.decode(payload) do
      {:ok, event} ->
        ModelHunterEdge.EventDispatcher.dispatch(channel, event)

      {:error, _reason} ->
        Logger.warning("RedisSubscriber: failed to decode pmessage on #{channel}")
    end

    {:noreply, state}
  end

  @impl true
  def handle_info(
        {:redix_pubsub, _pubsub, _ref, :message, %{channel: channel, payload: payload}},
        state
      ) do
    case Jason.decode(payload) do
      {:ok, event} ->
        ModelHunterEdge.EventDispatcher.dispatch(channel, event)

      {:error, _reason} ->
        Logger.warning("RedisSubscriber: failed to decode message on #{channel}")
    end

    {:noreply, state}
  end

  @impl true
  def handle_info(msg, state) do
    Logger.debug("RedisSubscriber: unhandled message: #{inspect(msg)}")
    {:noreply, state}
  end
end
