# Elixir Edge Service — multi-stage build
FROM elixir:1.17-alpine AS builder

RUN apk add --no-cache git

WORKDIR /app

ENV MIX_ENV=prod

RUN mix local.hex --force && mix local.rebar --force

COPY mix.exs mix.lock ./
RUN mix deps.get --only prod && mix deps.compile

COPY config config
COPY lib lib
COPY priv priv

RUN mix compile && mix release

# Runtime
FROM alpine:3.19

RUN apk add --no-cache libstdc++ openssl ncurses-libs

WORKDIR /app

COPY --from=builder /app/_build/prod/rel/model_hunter_edge ./

ENV PHX_SERVER=true
EXPOSE 4000

CMD ["bin/model_hunter_edge", "start"]
