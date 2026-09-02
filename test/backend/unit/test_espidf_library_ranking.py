"""Name-affinity ranking + merged-library reporting in the ESP-IDF resolver.

Two behaviours under test, both from the 2026-08 library-contamination
investigation:

1. `_find_library_for_header` used to return the FIRST alphabetical
   provider. <Servo.h> has 6 providers in the live cache, so a random
   stray could win over the library actually named after the header.
   Now the best-named candidate wins (exact normalized name > esp32-arch
   declaration > contains-stem), alphabetical only as tie-break.

2. `_resolve_library_components` reports which library it merged for each
   header (display name from library.properties, version suffix stripped)
   via the optional `merged_libs` out-param. That report becomes
   `manifest_suggested_libraries` on scan-all compiles, which the frontend
   uses to auto-complete the project manifest — the migration path for the
   ~79% of projects that still compile with an empty manifest.

No toolchain required: pure resolution logic.
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


class TestNameAffinityRanking(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.libs = self.tmp / "libraries"
        self.c = ESPIDFCompiler()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_exact_name_beats_alphabetical(self):
        # Sorts FIRST alphabetically but is unrelated to the header.
        _mk(self.libs / "aaaa-stray-robot" / "src" / "Servo.h")
        _mk(self.libs / "aaaa-stray-robot" / "library.properties",
            "name=AAAA Stray Robot\n")
        # The library actually named after the header.
        _mk(self.libs / "servo@1.2.0-cafebabe" / "src" / "Servo.h")
        _mk(self.libs / "servo@1.2.0-cafebabe" / "library.properties",
            "name=Servo\narchitectures=*\n")
        got = self.c._find_library_for_header("Servo.h", self.libs)
        self.assertIsNotNone(got)
        self.assertIn("servo@1.2.0", str(got))

    def test_esp32_arch_beats_wildcard_when_no_name_match(self):
        _mk(self.libs / "alpha-generic" / "src" / "Foo.h")
        _mk(self.libs / "alpha-generic" / "library.properties",
            "name=Alpha Generic\narchitectures=*\n")
        _mk(self.libs / "zeta-esp32-port" / "src" / "Foo.h")
        _mk(self.libs / "zeta-esp32-port" / "library.properties",
            "name=Zeta ESP32 Port\narchitectures=esp32\n")
        got = self.c._find_library_for_header("Foo.h", self.libs)
        self.assertIn("zeta-esp32-port", str(got))

    def test_contains_stem_prefers_shorter_name(self):
        _mk(self.libs / "simpleservoesp32" / "src" / "Bar.h")
        _mk(self.libs / "simpleservoesp32" / "library.properties",
            "name=SimpleBarKitDeluxeEdition\n")
        _mk(self.libs / "zzz-bar-lib" / "src" / "Bar.h")
        _mk(self.libs / "zzz-bar-lib" / "library.properties", "name=BarLib\n")
        got = self.c._find_library_for_header("Bar.h", self.libs)
        self.assertIn("zzz-bar-lib", str(got))

    def test_single_provider_still_resolves_with_zero_score(self):
        # Legacy behaviour preserved: an unrelated name is still a match
        # when it is the only provider.
        _mk(self.libs / "whatever" / "Baz.h")
        got = self.c._find_library_for_header("Baz.h", self.libs)
        self.assertIn("whatever", str(got))

    def test_no_provider_returns_none(self):
        _mk(self.libs / "something" / "Other.h")
        self.assertIsNone(self.c._find_library_for_header("Missing.h", self.libs))


class TestMergedLibraryReport(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.libs = self.tmp / "libraries"
        self.out = self.tmp / "project" / "user_libs"
        self.out.mkdir(parents=True)
        self.c = ESPIDFCompiler()
        self.c.arduino_path = ""
        self.c._core_headers_cache = None

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _resolve(self, headers, merged):
        return self.c._resolve_library_components(
            headers, arduino_libs=self.libs, esp32_libs=None,
            arduino_comp_name="arduino-esp32", user_libs_dir=self.out,
            merged_libs=merged,
        )

    def test_reports_display_name_not_cache_folder(self):
        _mk(self.libs / "espasyncwebserver@3.11.2-e82094d0" / "src" / "ESPAsyncWebServer.h")
        _mk(self.libs / "espasyncwebserver@3.11.2-e82094d0" / "library.properties",
            "name=ESP Async WebServer\narchitectures=*\n")
        merged: dict[str, str] = {}
        self._resolve(["ESPAsyncWebServer.h"], merged)
        self.assertEqual(merged, {"ESPAsyncWebServer.h": "ESP Async WebServer"})

    def test_falls_back_to_folder_name_without_version_suffix(self):
        _mk(self.libs / "esp32servo@3.2.1-577147ab" / "src" / "ESP32Servo.h")
        # library.properties present but nameless
        _mk(self.libs / "esp32servo@3.2.1-577147ab" / "library.properties", "author=x\n")
        merged: dict[str, str] = {}
        self._resolve(["ESP32Servo.h"], merged)
        self.assertEqual(merged, {"ESP32Servo.h": "esp32servo"})

    def test_transitive_pulls_are_reported_too(self):
        _mk(self.libs / "toplib" / "src" / "Top.h", "#include <Dep.h>\n")
        _mk(self.libs / "toplib" / "library.properties", "name=TopLib\n")
        _mk(self.libs / "deplib" / "src" / "Dep.h")
        _mk(self.libs / "deplib" / "library.properties", "name=DepLib\n")
        merged: dict[str, str] = {}
        self._resolve(["Top.h"], merged)
        self.assertEqual(merged.get("Top.h"), "TopLib")
        self.assertEqual(merged.get("Dep.h"), "DepLib")

    def test_none_out_param_keeps_legacy_shape(self):
        _mk(self.libs / "somelib" / "src" / "A.h")
        names, hdr2comp = self.c._resolve_library_components(
            ["A.h"], arduino_libs=self.libs, esp32_libs=None,
            arduino_comp_name="arduino-esp32", user_libs_dir=self.out,
        )
        self.assertEqual(names, ["user_libs_all"])
        self.assertEqual(hdr2comp.get("A.h"), "user_libs_all")


class TestProjectSuppliedHeaders(unittest.TestCase):
    """A config header the PROJECT owns must never drag in a library.

    The live failure (2026-08-28, an LVGL clock on a XIAO ESP32-S3): the
    sketch included only <lvgl.h>, but LVGL's sources carry
    `#include "lv_conf.h"` behind `#if !LV_CONF_SKIP`. The include scan is
    textual, so lv_conf.h got queued even though the build defined
    LV_CONF_SKIP=1, resolved to Adafruit LvGL Glue (which vendors its own
    copy for LVGL v7), and merged that whole library. Its sources then failed
    against LVGL v8 and the build died naming a library the user never asked
    for.
    """

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.libs = self.tmp / "libraries"
        self.out = self.tmp / "project" / "user_libs"
        self.out.mkdir(parents=True)
        self.c = ESPIDFCompiler()
        self.c.arduino_path = ""
        self.c._core_headers_cache = None

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _resolve(self, headers, merged):
        return self.c._resolve_library_components(
            headers, arduino_libs=self.libs, esp32_libs=None,
            arduino_comp_name="arduino-esp32", user_libs_dir=self.out,
            merged_libs=merged,
        )

    def _make_lvgl_world(self) -> None:
        # LVGL itself: lvgl.h pulls lv_conf.h the way the real sources do.
        _mk(self.libs / "lvgl@8.3.11-0d103ab1" / "src" / "lvgl.h",
            '#include "lv_conf.h"\n')
        _mk(self.libs / "lvgl@8.3.11-0d103ab1" / "library.properties",
            "name=lvgl\narchitectures=*\n")
        # The unrelated library that happens to vendor an lv_conf.h.
        _mk(self.libs / "adafruitlittlevglgluelibrary@2.1.7-896f753c" / "src" / "lv_conf.h")
        _mk(self.libs / "adafruitlittlevglgluelibrary@2.1.7-896f753c" / "src"
            / "Adafruit_LvGL_Glue.h")
        _mk(self.libs / "adafruitlittlevglgluelibrary@2.1.7-896f753c" / "library.properties",
            "name=Adafruit LvGL Glue Library\narchitectures=*\n")

    def test_lv_conf_does_not_drag_in_the_glue_library(self):
        self._make_lvgl_world()
        merged: dict[str, str] = {}
        self._resolve(["lvgl.h"], merged)
        self.assertEqual(merged.get("lvgl.h"), "lvgl")
        self.assertNotIn("lv_conf.h", merged)
        self.assertNotIn(
            "Adafruit LvGL Glue Library", merged.values(),
            "a sketch that only includes <lvgl.h> must not merge the glue library",
        )

    def test_the_guard_is_generic_not_an_lvgl_special_case(self):
        """Every config-header shape, not a hardcoded list of two names.

        One live compile resolved six of these against the shared library dir
        in a single build, so the rule has to be about the shape of the name.
        """
        for cfg in (
            "lv_conf.h", "lv_conf_kconfig.h", "lv_rt_thread_conf.h",
            "User_Config.h", "sdkconfig.h", "zconf.h", "User_Setup.h",
        ):
            with self.subTest(header=cfg):
                shutil.rmtree(self.libs, ignore_errors=True)
                _mk(self.libs / "toplib" / "src" / "Top.h", f'#include "{cfg}"\n')
                _mk(self.libs / "toplib" / "library.properties", "name=TopLib\n")
                # An unrelated library that happens to vendor that config header.
                _mk(self.libs / "zzz-stray" / "src" / cfg)
                _mk(self.libs / "zzz-stray" / "library.properties", "name=Stray\n")
                merged: dict[str, str] = {}
                self._resolve(["Top.h"], merged)
                self.assertEqual(merged.get("Top.h"), "TopLib")
                self.assertNotIn(
                    "Stray", merged.values(),
                    f"<{cfg}> must not drag in an unrelated library",
                )

    def test_a_direct_sketch_include_is_still_resolved(self):
        """The guard is for transitive pulls only.

        A sketch that includes a config header itself is stating intent, and
        that path keeps working exactly as before.
        """
        _mk(self.libs / "somelib" / "src" / "my_config.h")
        _mk(self.libs / "somelib" / "library.properties", "name=SomeLib\n")
        merged: dict[str, str] = {}
        self._resolve(["my_config.h"], merged)
        self.assertEqual(merged.get("my_config.h"), "SomeLib")

    def test_ordinary_transitive_dependencies_still_merge(self):
        """The guard must not touch normal library-to-library deps."""
        _mk(self.libs / "adafruitgfx" / "src" / "Adafruit_GFX.h",
            '#include <Adafruit_I2CDevice.h>\n')
        _mk(self.libs / "adafruitgfx" / "library.properties", "name=Adafruit GFX Library\n")
        _mk(self.libs / "adafruitbusio" / "src" / "Adafruit_I2CDevice.h")
        _mk(self.libs / "adafruitbusio" / "library.properties", "name=Adafruit BusIO\n")
        merged: dict[str, str] = {}
        self._resolve(["Adafruit_GFX.h"], merged)
        self.assertEqual(merged.get("Adafruit_I2CDevice.h"), "Adafruit BusIO")

    def test_a_library_that_owns_lv_conf_is_still_reachable_by_its_own_header(self):
        # The guard is scoped to the config header, not to the library: a
        # project that really wants the glue can still include its header.
        self._make_lvgl_world()
        merged: dict[str, str] = {}
        self._resolve(["Adafruit_LvGL_Glue.h"], merged)
        self.assertEqual(
            merged.get("Adafruit_LvGL_Glue.h"), "Adafruit LvGL Glue Library"
        )


if __name__ == "__main__":
    unittest.main()
