# Elixir Edge — builder + runtime on elixir:1.17.
#
# mix local.hex / default mix local.rebar use Erlang :httpc, which loads
# pubkey_os_cacerts; on some images that returns :no_cacerts_found and crashes
# (OTP public_key bug path). Bootstrap Hex + rebar3 with curl instead, then use
# HEX_UNSAFE_HTTPS for Hex-driven fetches (deps.get) so Erlang skips broken CA loading.
#
# Pin Hex to a build matching elixir:1.17 (OTP 26). installs/hex.ez is latest Hex (e.g. 2.4.x)
# compiled for OTP 27 and will not load on this image.
FROM elixir:1.17 AS builder

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && update-ca-certificates

ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

WORKDIR /app

ENV MIX_ENV=prod

ARG HEX_EZ_URL=https://builds.hex.pm/installs/1.17.0/hex-2.2.1.ez
RUN curl -fsSL "$HEX_EZ_URL" -o /tmp/hex.ez \
    && mix archive.install /tmp/hex.ez --force \
    && rm -f /tmp/hex.ez

ARG REBAR3_VERSION=3.24.0
RUN curl -fsSL "https://github.com/erlang/rebar3/releases/download/${REBAR3_VERSION}/rebar3" -o /tmp/rebar3 \
    && chmod +x /tmp/rebar3 \
    && mix local.rebar rebar3 /tmp/rebar3 --force \
    && rm -f /tmp/rebar3

ENV HEX_UNSAFE_HTTPS=1

COPY mix.exs mix.lock ./
RUN mix deps.get --only prod && mix deps.compile

COPY config config
COPY lib lib
COPY priv priv

RUN mix compile && mix release

# Runtime: CA bundle for normal TLS from the release (APIs, etc.).
FROM elixir:1.17

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && update-ca-certificates

ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

WORKDIR /app

COPY --from=builder /app/_build/prod/rel/model_hunter_edge ./

ENV PHX_SERVER=true
EXPOSE 4000

CMD ["bin/model_hunter_edge", "start"]
