"""
Regression tests for the library include-root layout (VELXIO_PER_LIB_ROOTS).

Every case here is a real incident. The merged component used to copy all
libraries into one interleaved tree and export EVERY directory that held a
file, so a library's private internals sat on the global -I and hijacked
`#include`s issued by other libraries, by the arduino-esp32 core and by
ESP-IDF itself:

  * FastLED ships a host-test stub `src/platforms/stub/Arduino.h`. With that
    directory exported, U8g2's `#include <Arduino.h>` resolved to the stub —
    'yield' was not declared, and fl::string polluted String overload
    resolution inside the core's WString.h.
  * FastLED ships `src/fl/stl/asio/http/http_parser.h`. Exported, it shadowed
    the IDF http_parser component header that esp_http_server.h includes, and
    every httpd_method_t use failed to compile.
  * LovyanGFX ships `src/lgfx/internal/limits.h`. Exported, FreeRTOS's
    portmacro.h picked it up inside an extern "C" block.

The fix is arduino-cli's model: one subtree per library, exactly one exported
include root per library (`<lib>/src`, or `<lib>` for the flat legacy layout),
`utility/` private. These tests assert the property — no directory other than a
library's own include root is ever exported — rather than any single denylist
entry, so a new library shipping a new generically-named internal cannot
reintroduce the class.

Run from the repo root:
    python -m pytest test/backend/unit/test_espidf_include_roots.py -v
"""

import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

from app.services import espidf_compiler as espidf_mod
from app.services.espidf_compiler import ESPIDFCompiler


def make_compiler() -> ESPIDFCompiler:
    comp = ESPIDFCompiler.__new__(ESPIDFCompiler)
    comp.idf_path = ''
    comp.arduino_path = ''
    comp.has_arduino = False
    comp.idf5_path = ''
    comp.arduino5_path = ''
    comp.has_arduino5 = False
    return comp


def write(path: Path, text: str = '// x') -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')


class IncludeRootsBase(unittest.TestCase):
    """Builds a libraries dir that mirrors the real offenders."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.arduino_libs = self.tmp / 'libraries'
        self.esp32_libs = self.tmp / 'esp32_libs'
        self.user_libs = self.tmp / 'user_libs'
        for d in (self.arduino_libs, self.esp32_libs, self.user_libs):
            d.mkdir(parents=True)
        self.comp = make_compiler()

        # FastLED: recursive layout, ships an Arduino.h stub and an
        # http_parser.h deep inside src/, plus a unity build that reaches them
        # through file-relative includes.
        fl = self.arduino_libs / 'fastled@3.10.5-017d142ff4ff'
        write(fl / 'src' / 'FastLED.h', '#include "platforms/stub/Arduino.h"')
        write(fl / 'src' / 'FastLED.cpp')
        write(fl / 'src' / 'platforms' / 'stub' / 'Arduino.h', '// host-test stub')
        write(fl / 'src' / 'fl' / 'stl' / 'asio' / 'http' / 'http_parser.h')
        write(fl / 'src' / 'fl' / 'stl' / 'string.h')
        write(fl / 'library.properties', 'name=FastLED\narchitectures=*\n')

        # U8g2: recursive layout, includes <Arduino.h> expecting the CORE one.
        u8 = self.arduino_libs / 'U8g2'
        write(u8 / 'src' / 'U8g2lib.h', '#include <Arduino.h>')
        write(u8 / 'src' / 'U8g2lib.cpp', '#include <Arduino.h>')
        # A benign internal subdirectory: not on any denylist, so it is the
        # clean way to show what each layout exports.
        write(u8 / 'src' / 'fonts' / 'Font5x7.h')
        write(u8 / 'library.properties', 'name=U8g2\narchitectures=*\n')

        # LovyanGFX-style internal limits.h.
        lg = self.arduino_libs / 'M5GFX'
        write(lg / 'src' / 'M5GFX.h')
        write(lg / 'src' / 'M5GFX.cpp')
        write(lg / 'src' / 'lgfx' / 'internal' / 'limits.h')
        write(lg / 'library.properties', 'name=M5GFX\narchitectures=esp32\n')

        # Legacy flat layout with a utility/ dir (Arduino keeps it private).
        legacy = self.arduino_libs / 'LegacyLib'
        write(legacy / 'LegacyLib.h')
        write(legacy / 'LegacyLib.cpp')
        write(legacy / 'utility' / 'twi.h')
        write(legacy / 'utility' / 'twi.c')

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def resolve(self, headers):
        return self.comp._resolve_library_components(
            headers, self.arduino_libs, self.esp32_libs,
            'arduino-esp32', self.user_libs,
        )

    def cmake_text(self) -> str:
        return (self.user_libs / 'user_libs_all' / 'CMakeLists.txt').read_text()

    def exported_dirs(self) -> list[str]:
        """Directories on the component's PUBLIC include path."""
        m = re.search(r'INCLUDE_DIRS ([^\n]*)', self.cmake_text())
        self.assertIsNotNone(m, 'component CMakeLists has no INCLUDE_DIRS')
        return re.findall(r'"([^"]+)"', m.group(1))

    def private_dirs(self) -> list[str]:
        m = re.search(r'PRIV_INCLUDE_DIRS ([^\n]*)', self.cmake_text())
        return re.findall(r'"([^"]+)"', m.group(1)) if m else []

    def merged_files(self) -> list[str]:
        root = self.user_libs / 'user_libs_all'
        return sorted(
            str(p.relative_to(root)).replace('\\', '/')
            for p in root.rglob('*') if p.is_file()
        )


class TestPerLibraryIncludeRoots(IncludeRootsBase):
    """Default mode: one subtree and one exported include root per library."""

    def setUp(self):
        super().setUp()
        self._saved = espidf_mod._PER_LIB_ROOTS
        espidf_mod._PER_LIB_ROOTS = True

    def tearDown(self):
        espidf_mod._PER_LIB_ROOTS = self._saved
        super().tearDown()

    def test_only_library_roots_are_exported(self):
        """THE property: nothing but '.' and one root per library is on -I."""
        self.resolve(['FastLED.h', 'U8g2lib.h', 'M5GFX.h'])
        dirs = self.exported_dirs()
        self.assertEqual(dirs[0], '.')
        roots = dirs[1:]
        self.assertEqual(len(roots), 3, f'expected one root per library, got {roots}')
        for root in roots:
            self.assertRegex(
                root, r'^[^/]+/src$',
                f'{root} is not a library include root — only <lib>/src may be exported',
            )

    def test_fastled_stub_arduino_h_is_not_exported(self):
        """The 2026-08-19 incident: U8g2's <Arduino.h> must reach the core."""
        self.resolve(['FastLED.h', 'U8g2lib.h'])
        for d in self.exported_dirs():
            self.assertFalse(
                d.endswith('platforms/stub'),
                f'{d} exported — FastLED\'s Arduino.h stub shadows the core again',
            )

    def test_fastled_http_parser_dir_is_not_exported(self):
        """esp_http_server.h's <http_parser.h> must reach the IDF component."""
        self.resolve(['FastLED.h'])
        for d in self.exported_dirs():
            self.assertFalse(
                d.endswith('fl/stl/asio/http'),
                f'{d} exported — FastLED\'s http_parser.h shadows the IDF header again',
            )

    def test_lovyangfx_internal_limits_dir_is_not_exported(self):
        """FreeRTOS portmacro.h's <limits.h> must reach the toolchain."""
        self.resolve(['M5GFX.h'])
        for d in self.exported_dirs():
            self.assertFalse(
                d.endswith('lgfx/internal'),
                f'{d} exported — LovyanGFX\'s limits.h shadows the toolchain again',
            )

    def test_benign_internal_subdirectory_is_not_exported_either(self):
        """Not a denylist: NO subdirectory is exported, harmless or not."""
        self.resolve(['U8g2lib.h'])
        self.assertFalse(
            any(d.endswith('/fonts') for d in self.exported_dirs()),
            'a library internal subdir reached -I — the class is back',
        )
        self.assertTrue(
            any(f.endswith('src/fonts/Font5x7.h') for f in self.merged_files()),
            'the header must still be copied for file-relative includes',
        )

    def test_internals_are_still_copied(self):
        """Exclusion is from -I only: file-relative includes must keep working."""
        files = self.merged_files()
        self.resolve(['FastLED.h'])
        files = self.merged_files()
        self.assertTrue(
            any(f.endswith('src/platforms/stub/Arduino.h') for f in files),
            'the stub was dropped — FastLED\'s own relative include breaks',
        )
        self.assertTrue(
            any(f.endswith('src/fl/stl/asio/http/http_parser.h') for f in files),
        )

    def test_each_library_keeps_its_own_subtree(self):
        """No interleaving: a library's files live under its own directory."""
        self.resolve(['FastLED.h', 'U8g2lib.h'])
        files = self.merged_files()
        fastled = [f for f in files if f.endswith('FastLED.h')]
        u8g2 = [f for f in files if f.endswith('U8g2lib.h')]
        self.assertTrue(fastled and u8g2)
        self.assertNotEqual(
            fastled[0].split('/')[0], u8g2[0].split('/')[0],
            'libraries share a subtree — same-path files can collapse silently',
        )

    def test_same_relative_path_in_two_libraries_survives(self):
        """Legacy dedup dropped one copy; per-library subtrees keep both."""
        a = self.arduino_libs / 'LibA'
        write(a / 'src' / 'LibA.h')
        write(a / 'src' / 'utility' / 'helper.h', '// A')
        b = self.arduino_libs / 'LibB'
        write(b / 'src' / 'LibB.h')
        write(b / 'src' / 'utility' / 'helper.h', '// B')
        self.resolve(['LibA.h', 'LibB.h'])
        helpers = [f for f in self.merged_files() if f.endswith('utility/helper.h')]
        self.assertEqual(len(helpers), 2, f'one copy was silently dropped: {helpers}')

    def test_legacy_utility_dir_is_private_not_public(self):
        """arduino-cli scopes utility/ to the owning library, never globally."""
        self.resolve(['LegacyLib.h'])
        self.assertFalse(
            any(d.endswith('/utility') for d in self.exported_dirs()),
            'utility/ is on the public include path — a generic utility/debug.h '
            'would shadow every other library\'s',
        )
        self.assertTrue(
            any(d.endswith('/utility') for d in self.private_dirs()),
            'utility/ must stay reachable privately for the library\'s own sources',
        )

    def test_flat_library_exports_its_root(self):
        self.resolve(['LegacyLib.h'])
        roots = [d for d in self.exported_dirs() if d != '.']
        self.assertTrue(
            any(not r.endswith('/src') for r in roots),
            f'flat-layout library must export its own root, got {roots}',
        )

    def test_sources_are_registered_with_library_prefixed_paths(self):
        self.resolve(['FastLED.h'])
        srcs = re.search(r'SRCS ([^\n]*)', self.cmake_text()).group(1)
        self.assertIn('/src/FastLED.cpp', srcs)

    def test_versioned_cache_dirname_is_path_safe(self):
        """Cache entries are `name@version-sha`; the subdir must stay valid."""
        self.resolve(['FastLED.h'])
        roots = [d for d in self.exported_dirs() if d != '.']
        self.assertTrue(roots)
        for r in roots:
            self.assertNotRegex(r, r'[<>:"|?*\\\\]', f'unsafe path component: {r}')

    def test_transitive_dependency_still_resolves(self):
        """Per-library scanning must not lose transitive pulls."""
        dep = self.arduino_libs / 'DepLib'
        write(dep / 'src' / 'DepLib.h')
        write(dep / 'src' / 'DepLib.cpp')
        top = self.arduino_libs / 'TopLib'
        write(top / 'src' / 'TopLib.h', '#include <DepLib.h>')
        write(top / 'src' / 'TopLib.cpp')
        self.resolve(['TopLib.h'])
        files = self.merged_files()
        self.assertTrue(any(f.endswith('DepLib.h') for f in files),
                        'transitive dependency was not merged')

    def test_still_one_component(self):
        names, header_to_comp = self.resolve(['FastLED.h'])
        self.assertEqual(names, ['user_libs_all'])
        self.assertEqual(header_to_comp['FastLED.h'], 'user_libs_all')


class TestLegacyLayoutStillWorks(IncludeRootsBase):
    """VELXIO_PER_LIB_ROOTS=0 must reproduce the old behaviour exactly."""

    def setUp(self):
        super().setUp()
        self._saved = espidf_mod._PER_LIB_ROOTS
        espidf_mod._PER_LIB_ROOTS = False

    def tearDown(self):
        espidf_mod._PER_LIB_ROOTS = self._saved
        super().tearDown()

    def test_files_are_interleaved_at_component_root(self):
        self.resolve(['FastLED.h', 'U8g2lib.h'])
        files = self.merged_files()
        self.assertIn('src/FastLED.h', files)
        self.assertIn('src/U8g2lib.h', files)

    def test_subdirectories_are_exported(self):
        """The legacy mechanism: every dir holding a file is exported, and only
        the hand-maintained denylist keeps the dangerous ones out. A benign
        internal subdir therefore DOES reach -I here — which is exactly the
        design the per-library layout replaces."""
        self.resolve(['U8g2lib.h'])
        self.assertTrue(
            any(d.endswith('fonts') for d in self.exported_dirs()),
            'legacy mode should still export internal subdirectories',
        )

    def test_denylisted_dirs_are_kept_off_the_include_path(self):
        """The old safety net still works when the flag is off."""
        self.resolve(['FastLED.h'])
        for d in self.exported_dirs():
            self.assertFalse(d.endswith('platforms/stub'), d)
            self.assertFalse(d.endswith('fl/stl/asio/http'), d)

    def test_no_private_include_dirs(self):
        self.resolve(['LegacyLib.h'])
        self.assertEqual(self.private_dirs(), [])


if __name__ == '__main__':
    unittest.main()
