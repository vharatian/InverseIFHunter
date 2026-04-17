"""Unit tests for events_bus envelope + channel resolution."""
import json

from events_bus import (
    CHANNEL_CONFIG,
    CHANNEL_DB,
    CHANNEL_TEAM,
    CHANNEL_TELEMETRY,
    CHANNEL_ADMINS,
    _build_envelope,
    _resolve_channel,
)


def test_resolve_channel_short_names():
    assert _resolve_channel("telemetry") == CHANNEL_TELEMETRY
    assert _resolve_channel("config") == CHANNEL_CONFIG
    assert _resolve_channel("team") == CHANNEL_TEAM
    assert _resolve_channel("admins") == CHANNEL_ADMINS
    assert _resolve_channel("db") == CHANNEL_DB


def test_resolve_channel_passthrough_mth_prefix():
    assert _resolve_channel("mth:custom") == "mth:custom"


def test_resolve_channel_unknown_gets_mth_prefix():
    assert _resolve_channel("unknown") == "mth:unknown"


def test_build_envelope_strips_mth_prefix():
    env = _build_envelope("mth:config", {"keys": ["a"]})
    parsed = json.loads(env)
    assert parsed["channel"] == "config"
    assert parsed["payload"] == {"keys": ["a"]}
    assert "ts" in parsed


def test_build_envelope_non_jsonable_via_default():
    class Obj:
        def __str__(self):
            return "custom"
    env = _build_envelope("config", {"o": Obj()})
    parsed = json.loads(env)
    assert parsed["payload"] == {"o": "custom"}
