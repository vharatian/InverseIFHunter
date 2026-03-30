# Elixir Edge — builder + runtime both elixir:1.17-slim so Erlang crypto NIFs and OpenSSL match.
FROM elixir:1.17-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV MIX_ENV=prod

RUN mix local.hex --force && mix local.rebar --force

COPY mix.exs mix.lock ./
RUN mix deps.get --only prod && mix deps.compile

COPY config config
COPY lib lib
COPY priv priv

RUN mix compile && mix release

# Same image family as builder so Erlang crypto NIFs see the same OpenSSL/libc
# as at link time (debian:bookworm-slim alone can mismatch elixir:1.17-slim).
FROM elixir:1.17-slim

WORKDIR /app

COPY --from=builder /app/_build/prod/rel/model_hunter_edge ./

ENV PHX_SERVER=true
EXPOSE 4000

CMD ["bin/model_hunter_edge", "start"]
