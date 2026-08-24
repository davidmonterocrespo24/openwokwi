"""micropython-libs route (issue #214) — the pure validation layer.

The network calls are exercised end-to-end against the real index by the
deploy smoke; here we pin the rules that make the endpoint safe to expose:
source-only, path-safe, bounded, and honest search ordering.
"""

import pytest

from app.api.routes.micropython_libs import (
    MAX_FILES_PER_PACKAGE,
    filter_packages,
    validate_package_files,
)


# ── validate_package_files ──────────────────────────────────────────────────

def test_accepts_plain_py_files():
    out = validate_package_files(
        [["ssd1306.py", "156dcec1"], ["umqtt/simple.py", "abc123"]], package="x"
    )
    assert out == [("ssd1306.py", "156dcec1"), ("umqtt/simple.py", "abc123")]


@pytest.mark.parametrize(
    "path",
    [
        "driver.mpy",          # bytecode — the user could not read what runs
        "native.so",
        "README.md",
        "/etc/passwd.py",      # absolute
        "../evil.py",          # traversal
        "a/../../evil.py",
        "a//b.py",             # empty segment
        "c:\\windows\\x.py",   # backslash
    ],
)
def test_rejects_unsafe_or_non_source_paths(path):
    with pytest.raises(ValueError):
        validate_package_files([[path, "abc123"]], package="x")


def test_rejects_malformed_hash():
    with pytest.raises(ValueError):
        validate_package_files([["ok.py", "../f"]], package="x")


def test_rejects_oversized_package():
    entries = [[f"f{i}.py", "abc123"] for i in range(MAX_FILES_PER_PACKAGE + 1)]
    with pytest.raises(ValueError):
        validate_package_files(entries, package="x")


def test_rejects_malformed_entries():
    with pytest.raises(ValueError):
        validate_package_files([["only-one-element"]], package="x")


# ── filter_packages ─────────────────────────────────────────────────────────

INDEX = [
    {"name": "ssd1306", "description": "OLED display driver"},
    {"name": "umqtt.simple", "description": "MQTT client"},
    {"name": "aiohttp", "description": "HTTP client/server with websockets"},
]


def test_name_prefix_ranks_before_description_hits():
    got = [p["name"] for p in filter_packages(INDEX, "ss")]
    assert got == ["ssd1306"]
    got = [p["name"] for p in filter_packages(INDEX, "client")]
    assert set(got) == {"umqtt.simple", "aiohttp"}


def test_empty_query_returns_everything():
    assert filter_packages(INDEX, "  ") == INDEX


def test_prefix_hits_come_first():
    idx = [
        {"name": "requests", "description": "umqtt helper"},
        {"name": "umqtt.robust", "description": ""},
    ]
    got = [p["name"] for p in filter_packages(idx, "umqtt")]
    assert got == ["umqtt.robust", "requests"]
