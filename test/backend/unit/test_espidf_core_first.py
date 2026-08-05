"""Regression tests for ESP32 library-resolution core-first behaviour.

A user library that ships a core-named header (e.g. WiFiEspAT/src/WiFi.h)
must never shadow the arduino-esp32 core. This guards the WiFi.h ->
WiFiEspAT -> EspAtDrv.cpp 'const char OK[]'/'STATUS[]' clash with ESP-IDF's
enum STATUS in rom/ets_sys.h, which broke every ESP32 sketch that
#include <WiFi.h>.

No ESP-IDF toolchain required — pure resolution logic.
"""

import sys
import tempfile
import shutil
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

from app.services.espidf_compiler import ESPIDFCompiler


def _mk(p: Path, content: str = "x") -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)


class TestCoreFirstResolution(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_core_header_not_resolved_to_user_lib(self):
        core = self.tmp / "arduino-esp32"
        _mk(core / "cores" / "esp32" / "Arduino.h")
        _mk(core / "libraries" / "WiFi" / "src" / "WiFi.h")

        ulibs = self.tmp / "Arduino" / "libraries"
        _mk(ulibs / "WiFiEspAT" / "library.properties",
            "name=WiFiEspAT\narchitectures=*\n")
        _mk(ulibs / "WiFiEspAT" / "src" / "WiFi.h")
        _mk(ulibs / "WiFiEspAT" / "src" / "utility" / "EspAtDrv.cpp",
            "const char OK[];")
        # a legit cross-platform lib (no architectures field) must still merge
        _mk(ulibs / "DHT_sensor_library" / "DHT.h", "#include <Arduino.h>\n")
        _mk(ulibs / "DHT_sensor_library" / "DHT.cpp")

        c = ESPIDFCompiler()
        c.arduino_path = str(core)
        c._core_headers_cache = None
        out = self.tmp / "project" / "user_libs"
        out.mkdir(parents=True)

        names, hdr2comp = c._resolve_library_components(
            ["WiFi.h", "DHT.h"],
            arduino_libs=ulibs, esp32_libs=None,
            arduino_comp_name="arduino-esp32", user_libs_dir=out,
        )

        merged = out / "user_libs_all"
        copied = [p.name for p in merged.rglob("*")] if merged.exists() else []
        self.assertNotIn("EspAtDrv.cpp", copied,
                         "WiFiEspAT was merged — WiFi.h shadowed the core")
        self.assertNotIn("WiFi.h", hdr2comp)
        self.assertIn("DHT.cpp", copied)
        self.assertEqual(hdr2comp.get("DHT.h"), "user_libs_all")

    def test_arch_excluded_lib_two_tier_guard(self):
        """Issue #257: the architecture guard is two-tier. A DIRECT sketch
        include of an arch-excluded lib merges anyway (user intent; many
        avr-declared libs are pure Wire code — a real compile error beats
        'No such file'). A TRANSITIVE pull of an arch-excluded lib is still
        skipped (the Adafruit_ZeroDMA poison path). And 'all' counts as
        wildcard (LiquidCrystal_I2C 2.0.0 declares architectures=all)."""
        ulibs = self.tmp / "Arduino" / "libraries"
        _mk(ulibs / "AvrOnlyLib" / "library.properties",
            "name=AvrOnlyLib\narchitectures=avr\n")
        _mk(ulibs / "AvrOnlyLib" / "Foo.h")
        _mk(ulibs / "AvrOnlyLib" / "Foo.cpp")
        # An 'all'-declared lib whose header pulls the avr-only one
        # transitively: Bar.h -> #include <Foo2.h>.
        _mk(ulibs / "AllArchLib" / "library.properties",
            "name=AllArchLib\narchitectures=all\n")
        _mk(ulibs / "AllArchLib" / "Bar.h", '#include <Foo2.h>\n')
        _mk(ulibs / "AllArchLib" / "Bar.cpp")
        _mk(ulibs / "AvrOnlyLib2" / "library.properties",
            "name=AvrOnlyLib2\narchitectures=avr\n")
        _mk(ulibs / "AvrOnlyLib2" / "Foo2.h")

        c = ESPIDFCompiler()
        c.arduino_path = ""           # no core path -> static fallback set
        c._core_headers_cache = None
        out = self.tmp / "project" / "user_libs"
        out.mkdir(parents=True)

        names, hdr2comp = c._resolve_library_components(
            ["Foo.h", "Bar.h"],
            arduino_libs=ulibs, esp32_libs=None,
            arduino_comp_name="arduino-esp32", user_libs_dir=out,
        )
        # Direct include of the avr-only lib: merged anyway.
        self.assertEqual(hdr2comp.get("Foo.h"), "user_libs_all")
        # 'all' wildcard lib: merged.
        self.assertEqual(hdr2comp.get("Bar.h"), "user_libs_all")
        # Transitive pull (Foo2.h via Bar.h) of an avr-only lib: skipped.
        self.assertNotIn("Foo2.h", hdr2comp)


class TestManifestScope(unittest.TestCase):
    """P2: when a project declares a library manifest, only declared libraries
    are merged — a user-installed lib outside the manifest is never picked up,
    even if its header is included. None manifest = legacy scan-all (unchanged)."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.ulibs = self.tmp / "Arduino" / "libraries"
        # In-manifest lib, declared by Library Manager display name; on-disk
        # folder name differs by separators/case (the realistic shape).
        _mk(self.ulibs / "DHT_sensor_library" / "library.properties",
            "name=DHT sensor library\n")
        _mk(self.ulibs / "DHT_sensor_library" / "DHT.h")
        _mk(self.ulibs / "DHT_sensor_library" / "DHT.cpp")
        # A STRAY lib that also ships DHT.h and sorts BEFORE the manifest lib
        # (real case: DHT118266 sorts before DHT_sensor_library). The manifest
        # must still resolve DHT.h to the declared lib, not this stray.
        _mk(self.ulibs / "AAAA_strayDHT" / "DHT.h")
        _mk(self.ulibs / "AAAA_strayDHT" / "stray_marker.cpp")
        # Out-of-manifest lib (e.g. another user's install / a clash).
        _mk(self.ulibs / "RandomOtherLib" / "Foo.h")
        _mk(self.ulibs / "RandomOtherLib" / "Foo.cpp")
        self.c = ESPIDFCompiler()
        self.c.arduino_path = ""
        self.c._core_headers_cache = None
        self.out = self.tmp / "project" / "user_libs"
        self.out.mkdir(parents=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _resolve(self, headers, allowed):
        return self.c._resolve_library_components(
            headers, arduino_libs=self.ulibs, esp32_libs=None,
            arduino_comp_name="arduino-esp32", user_libs_dir=self.out,
            allowed_libraries=allowed,
        )

    def test_only_manifest_libs_merge(self):
        # Manifest declares DHT (by display name) but not Foo's lib.
        _, hdr2comp = self._resolve(["DHT.h", "Foo.h"], {"DHT sensor library"})
        self.assertEqual(hdr2comp.get("DHT.h"), "user_libs_all")  # declared → merged
        self.assertNotIn("Foo.h", hdr2comp)                       # undeclared → dropped
        merged = self.out / "user_libs_all"
        copied = [p.name for p in merged.rglob("*")] if merged.exists() else []
        # The DECLARED DHT lib was merged, not the stray that sorts first.
        self.assertIn("DHT.cpp", copied)
        self.assertNotIn("stray_marker.cpp", copied)

    def test_none_manifest_is_scan_all(self):
        # No manifest → legacy behaviour: both resolve.
        _, hdr2comp = self._resolve(["DHT.h", "Foo.h"], None)
        self.assertEqual(hdr2comp.get("DHT.h"), "user_libs_all")
        self.assertEqual(hdr2comp.get("Foo.h"), "user_libs_all")

    def test_match_by_folder_name(self):
        # Manifest may also reference the on-disk folder name directly.
        _, hdr2comp = self._resolve(["Foo.h"], {"RandomOtherLib"})
        self.assertEqual(hdr2comp.get("Foo.h"), "user_libs_all")


if __name__ == "__main__":
    unittest.main()


class TestGenericHeaderCollision(unittest.TestCase):
    """Issue reported 2026-08-03 (nikas79): ESPAsyncWebServer includes
    <Hash.h> (an ESP8266-core header) and the global scan resolved it to a
    hexapod-robot library that happens to ship src/Hash.h. The whole library
    was merged and its unrelated sources broke every ESP32 build with
    'fatal error: SoftwareSerial.h' and friends."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_generic_platform_header_never_resolves_to_a_user_lib(self):
        ulibs = self.tmp / "Arduino" / "libraries"
        # A library with a generic Hash.h, exactly like stemi-hexapod.
        _mk(ulibs / "stemihexapod" / "library.properties",
            "name=stemi-hexapod\narchitectures=esp32\n")
        _mk(ulibs / "stemihexapod" / "src" / "Hash.h")
        _mk(ulibs / "stemihexapod" / "src" / "Serial.cpp",
            '#include <SoftwareSerial.h>\n')

        c = ESPIDFCompiler()
        c.arduino_path = ""
        c._core_headers_cache = None
        out = self.tmp / "project" / "user_libs"
        out.mkdir(parents=True)

        _names, hdr2comp = c._resolve_library_components(
            ["Hash.h", "Server.h", "Serial.h"],
            arduino_libs=ulibs, esp32_libs=None,
            arduino_comp_name="arduino-esp32", user_libs_dir=out,
        )
        for header in ("Hash.h", "Server.h", "Serial.h"):
            self.assertNotIn(header, hdr2comp, f"{header} must stay core-provided")
        copied = [p.name for p in out.rglob("*") if p.is_file()]
        self.assertNotIn("Serial.cpp", copied,
                         "the unrelated library must NOT be merged")
