"""arduino-cli failures reach the UI / agent as one actionable sentence.

Regression for 2026-08-17: a fresh desktop install has no library index
yet; when arduino-cli could not download it (firewall / proxy) `lib search`
returned a JSON blob on stderr and we forwarded it verbatim, so the in-app
agent told the user "the library server returns a JSON error" ten times in
a row. The strings below are the real arduino-cli 1.0.4 output captured
offline (`unshare -n`) against an empty data dir.
"""
from __future__ import annotations

import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO / "backend"))

from app.services.arduino_cli import humanize_cli_error  # noqa: E402

SEARCH_JSON_STDERR = (
    '{\n  "error": "Error updating library index: Error downloading index '
    "'https://downloads.arduino.cc/libraries/library_index.tar.bz2': Get "
    '\\"https://downloads.arduino.cc/libraries/library_index.tar.bz2\\": dial tcp: '
    'lookup downloads.arduino.cc on 127.0.0.53:53: dial udp 127.0.0.53:53: connect: '
    'network is unreachable",\n  "warnings": [\n    "Error initializing instance: '
    "Error downloading index 'https://downloads.arduino.cc/libraries/library_index.tar.bz2'\"\n  ]\n}"
)

INSTALL_NO_INDEX_STDERR = (
    "Error initializing instance: Error downloading index "
    "'https://downloads.arduino.cc/libraries/library_index.tar.bz2': Get "
    '"https://downloads.arduino.cc/libraries/library_index.tar.bz2": dial tcp: lookup '
    "downloads.arduino.cc on 127.0.0.53:53: dial udp 127.0.0.53:53: connect: network is unreachable\n"
    "Error initializing instance: Loading index file: reading library_index.json: open "
    "/x/data/library_index.json: no such file or directory\n"
)

INSTALL_NO_NET_WITH_INDEX = (
    "Downloading Adafruit GFX Library@1.12.6...\n"
    'Adafruit GFX Library@1.12.6 Get "https://downloads.arduino.cc/libraries/github.com/adafruit/'
    'Adafruit_GFX_Library-1.12.6.zip?query=install": dial tcp: lookup downloads.arduino.cc on '
    "127.0.0.53:53: dial udp 127.0.0.53:53: connect: network is unreachable\n"
    "Error installing Adafruit GFX Library: Can't download library: Get "
    '"https://downloads.arduino.cc/libraries/github.com/adafruit/Adafruit_GFX_Library-1.12.6.zip'
    '?query=install": dial tcp: lookup downloads.arduino.cc on 127.0.0.53:53: dial udp '
    "127.0.0.53:53: connect: network is unreachable\n"
)


def test_search_json_error_becomes_index_download_sentence():
    msg = humanize_cli_error(SEARCH_JSON_STDERR, action="search libraries")
    assert msg.startswith("Could not search libraries:")
    assert "library index" in msg
    assert "downloads.arduino.cc" in msg
    assert "firewall or proxy" in msg
    # No JSON leaks through to the user / agent.
    assert "{" not in msg and "warnings" not in msg


def test_install_without_index_is_the_same_story():
    msg = humanize_cli_error(INSTALL_NO_INDEX_STDERR, action="install Adafruit GFX Library")
    assert msg.startswith("Could not install Adafruit GFX Library:")
    assert "library index" in msg
    assert "downloads.arduino.cc" in msg


def test_install_with_index_but_no_network_names_the_download():
    msg = humanize_cli_error(INSTALL_NO_NET_WITH_INDEX, action="install Adafruit GFX Library")
    assert msg.startswith("Could not install Adafruit GFX Library:")
    assert "download from downloads.arduino.cc failed" in msg
    assert "firewall or proxy" in msg


def test_unknown_library_passes_the_cli_line_through():
    msg = humanize_cli_error("Error installing NoSuchLib: Library 'NoSuchLib' not found", action="install NoSuchLib")
    assert msg == "Could not install NoSuchLib: Error installing NoSuchLib: Library 'NoSuchLib' not found"


def test_empty_and_unknown_shapes_still_return_a_sentence():
    assert humanize_cli_error("", action="search libraries") == (
        "Could not search libraries: arduino-cli returned no output."
    )
    assert humanize_cli_error(None, action="search libraries").startswith("Could not search libraries:")
    long = "x" * 1000
    msg = humanize_cli_error(long, action="search libraries")
    assert msg.startswith("Could not search libraries: ") and len(msg) < 400


def test_multiline_unknown_error_uses_first_line_only():
    msg = humanize_cli_error("\n\nfirst line here\nsecond line\n", action="search libraries")
    assert msg == "Could not search libraries: first line here"
