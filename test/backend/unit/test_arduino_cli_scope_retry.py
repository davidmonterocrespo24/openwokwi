"""When both the scoped compile and the scan-all retry fail, report the RETRY's
error.

A manifest-scoped compile only sees the libraries the project declares. Almost
nothing in the Arduino catalogue is self-contained (Adafruit GFX #includes
Adafruit_I2CDevice.h from Adafruit BusIO), so the scoped attempt dies on a
header the user never had a reason to name, and the scan-all retry exists to
rescue that build. When the retry ALSO fails — because the sketch has a real
error — the scoped stderr is the wrong thing to show: it describes a missing
library that only OUR scoping made missing.

2026-08-24: a hand-written SSD1306 sketch whose actual bug was `#include
<Adafruit_SSD1306>` (no .h) was reported to the user as "Adafruit_I2CDevice.h:
No such file or directory".
"""
from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO / "backend"))

from app.core import hooks  # noqa: E402
from app.services.arduino_cli import ArduinoCLIService  # noqa: E402

SKETCH = [{"name": "sketch.ino", "content": "void setup(){}\nvoid loop(){}\n"}]

# The phantom: the scope has GFX but not the BusIO it depends on.
SCOPED_STDERR = (
    "/tmp/velxio-scope-3x_7_kwz/libraries/Adafruit_GFX_Library/Adafruit_GFX.h:12:10: "
    "fatal error: Adafruit_I2CDevice.h: No such file or directory\n"
    " #include <Adafruit_I2CDevice.h>\ncompilation terminated.\n"
)
# The truth: scan-all resolved BusIO and got to the sketch's own error.
REAL_STDERR = (
    "/tmp/x/sketch/sketch.ino:4:65: error: 'class Adafruit_SSD1306' has no member "
    "named 'delay'; did you mean 'display'?\n"
)


def _service() -> ArduinoCLIService:
    """A service without __init__'s arduino-cli config bootstrap — compile()
    only needs cli_path and the board-kind predicates."""
    svc = object.__new__(ArduinoCLIService)
    svc.cli_path = "arduino-cli"
    svc._installed_cores = ""
    return svc


def _scope_hook(tmp_path):
    libs = tmp_path / "scope" / "libraries"
    libs.mkdir(parents=True, exist_ok=True)
    return lambda allowed, owner_id=None: (libs, "tok")


def _fake_run(scoped_stderr, unscoped_stderr, *, unscoped_ok=False, calls=None):
    def run(cmd, **kwargs):
        env = kwargs.get("env") or {}
        scoped = "velxio-scope-" in str(env.get("ARDUINO_DIRECTORIES_USER", "")) \
            or "scope" in str(env.get("ARDUINO_DIRECTORIES_USER", ""))
        if calls is not None:
            calls.append("scoped" if scoped else "unscoped")
        if not scoped and unscoped_ok:
            out = Path(cmd[cmd.index("--output-dir") + 1])
            out.mkdir(parents=True, exist_ok=True)
            (out / "sketch.ino.hex").write_text(":00000001FF\n")
            return subprocess.CompletedProcess(cmd, 0, stdout="ok", stderr="")
        return subprocess.CompletedProcess(
            cmd, 1, stdout="", stderr=scoped_stderr if scoped else unscoped_stderr
        )
    return run


def test_both_fail_reports_the_retry_error(monkeypatch, tmp_path):
    monkeypatch.setattr(hooks, "_materialize_library_scope_hook", _scope_hook(tmp_path))
    calls: list[str] = []
    monkeypatch.setattr(subprocess, "run", _fake_run(SCOPED_STDERR, REAL_STDERR, calls=calls))

    result = asyncio.run(_service().compile(
        SKETCH, "arduino:avr:uno", allowed_libraries={"Adafruit GFX Library"},
    ))

    assert calls == ["scoped", "unscoped"]
    assert result["success"] is False
    assert result["scope_retry_failed"] is True
    assert "has no member named 'delay'" in result["stderr"]
    assert "Adafruit_I2CDevice.h" not in result["stderr"]


def test_a_retry_that_succeeds_still_flags_the_manifest(monkeypatch, tmp_path):
    monkeypatch.setattr(hooks, "_materialize_library_scope_hook", _scope_hook(tmp_path))
    monkeypatch.setattr(subprocess, "run", _fake_run(SCOPED_STDERR, "", unscoped_ok=True))

    result = asyncio.run(_service().compile(
        SKETCH, "arduino:avr:uno", allowed_libraries={"Adafruit GFX Library"},
    ))

    assert result["success"] is True
    assert result["manifest_incomplete"] is True
    assert result.get("scope_retry_failed") is None


def test_a_genuine_error_without_a_scope_is_not_retried(monkeypatch, tmp_path):
    """No manifest -> no scope -> nothing to blame on scoping, and one compile."""
    monkeypatch.setattr(hooks, "_materialize_library_scope_hook", _scope_hook(tmp_path))
    calls: list[str] = []
    monkeypatch.setattr(subprocess, "run", _fake_run(SCOPED_STDERR, REAL_STDERR, calls=calls))

    result = asyncio.run(_service().compile(SKETCH, "arduino:avr:uno"))

    assert calls == ["unscoped"]
    assert result["success"] is False
    assert "has no member named 'delay'" in result["stderr"]
