"""Support dirs (extras/, examples/, test/) must not add dependencies to a build.

Regression for the 2026-09 clock session: a XIAO ESP32-S3 sketch that included
only <Adafruit_GFX.h> and <Adafruit_GC9A01A.h> compiled with 26 merged
libraries and failed inside Adafruit Arcada, a SAMD-only library it never
mentioned. Adafruit_GC9A01A ships extras/Adafruit_Arcada_FeatherM4.h, whose
`#include <arcadatype.h>` was picked up by the transitive scan and resolved
against the shared cache.

The scan may not simply skip those dirs: a few libraries genuinely reach into
them (FirebaseJson's src/json/FirebaseJson.h, FastLED's unity build), so
_support_dirs_are_reachable decides per library.
"""
from __future__ import annotations

from pathlib import Path

from app.services.espidf_compiler import ESPIDFCompiler


def _write(root: Path, rel: str, body: str) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body, encoding="utf-8")


def test_extras_only_library_is_not_reachable(tmp_path: Path) -> None:
    """The Adafruit_GC9A01A shape: extras/ exists, nothing compiled reaches it."""
    _write(tmp_path, "src/Adafruit_GC9A01A.h", '#include <Adafruit_GFX.h>\n')
    _write(tmp_path, "src/Adafruit_GC9A01A.cpp", '#include "Adafruit_GC9A01A.h"\n')
    _write(tmp_path, "extras/Adafruit_Arcada_FeatherM4.h", "#include <arcadatype.h>\n")

    assert ESPIDFCompiler._support_dirs_are_reachable(tmp_path) is False


def test_source_reaching_into_extras_is_reachable(tmp_path: Path) -> None:
    """The FirebaseJson shape: a compiled header includes a path under extras/."""
    _write(tmp_path, "src/FirebaseJson.h", '#include "extras/print/printf.h"\n')
    _write(tmp_path, "extras/print/printf.h", "#include <stdarg.h>\n")

    assert ESPIDFCompiler._support_dirs_are_reachable(tmp_path) is True


def test_include_from_inside_extras_does_not_count_as_reachable(tmp_path: Path) -> None:
    """extras/ referring to itself must not unlock itself."""
    _write(tmp_path, "src/Lib.h", "#include <Arduino.h>\n")
    _write(tmp_path, "extras/a.h", '#include "extras/b.h"\n')
    _write(tmp_path, "extras/b.h", "#include <arcadatype.h>\n")

    assert ESPIDFCompiler._support_dirs_are_reachable(tmp_path) is False


def test_examples_folder_counts_as_a_support_dir(tmp_path: Path) -> None:
    _write(tmp_path, "src/Lib.h", "#include <Arduino.h>\n")
    _write(tmp_path, "examples/Demo/Demo.h", "#include <SomeUnrelatedLib.h>\n")

    assert ESPIDFCompiler._support_dirs_are_reachable(tmp_path) is False


def test_library_with_no_support_dirs_at_all(tmp_path: Path) -> None:
    _write(tmp_path, "src/Lib.h", "#include <Wire.h>\n")

    assert ESPIDFCompiler._support_dirs_are_reachable(tmp_path) is False
