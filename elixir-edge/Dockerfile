# Elixir Edge — build and runtime on Debian bookworm + OpenSSL 3 (avoids Alpine/glibc
# OpenSSL mismatches that break Erlang crypto NIFs, e.g. EVP_MD_CTX_get_size_ex).
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

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libssl3 \
    libncurses6 \
    libstdc++6 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/_build/prod/rel/model_hunter_edge ./

ENV PHX_SERVER=true
EXPOSE 4000

CMD ["bin/model_hunter_edge", "start"]
