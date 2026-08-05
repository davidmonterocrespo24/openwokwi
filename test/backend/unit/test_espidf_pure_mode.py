"""
Tests for the pure ESP-IDF language mode (issue #139).

Covers the pieces that don't need the ESP-IDF toolchain: the build env
switch, the QEMU WiFi normalization for IDF-style code, the IDF wifi
detection, and the compile-job dedup key variance.

Run from the repo root:
    python -m pytest test/backend/unit/test_espidf_pure_mode.py -v
"""

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

from app.services.espidf_compiler import ESPIDFCompiler, _QEMU_WIFI_SSID
from app.api.routes import compile as compile_module


def make_compiler(has_arduino: bool = True) -> ESPIDFCompiler:
    comp = ESPIDFCompiler.__new__(ESPIDFCompiler)
    comp.idf_path = '/opt/esp-idf'
    comp.arduino_path = '/opt/arduino-esp32' if has_arduino else ''
    comp.has_arduino = has_arduino
    return comp


class TestBuildEnvPureMode(unittest.TestCase):

    def setUp(self):
        self.comp = make_compiler(has_arduino=True)

    def test_arduino_mode_sets_arduino_path(self):
        env = self.comp._build_env('esp32')
        self.assertEqual(env.get('ARDUINO_ESP32_PATH'), '/opt/arduino-esp32')
        self.assertNotIn('VELXIO_PURE_SKETCH', env)

    def test_pure_mode_drops_arduino_and_flags_pure(self):
        env = self.comp._build_env('esp32', pure_idf=True)
        self.assertNotIn('ARDUINO_ESP32_PATH', env)
        self.assertEqual(env.get('VELXIO_PURE_SKETCH'), '1')

    def test_pure_mode_overrides_inherited_arduino_path(self):
        """The uvicorn process env carries ARDUINO_ESP32_PATH in Docker —
        pure mode must strip the inherited copy too, or the template CMake
        would still pick the Arduino branch."""
        os.environ['ARDUINO_ESP32_PATH'] = '/opt/arduino-esp32'
        try:
            env = self.comp._build_env('esp32', pure_idf=True)
            self.assertNotIn('ARDUINO_ESP32_PATH', env)
        finally:
            del os.environ['ARDUINO_ESP32_PATH']


class TestIdfWifiDetection(unittest.TestCase):

    def setUp(self):
        self.comp = make_compiler()

    def test_detects_esp_wifi_include(self):
        self.assertTrue(self.comp._detect_idf_wifi_usage('#include "esp_wifi.h"'))
        self.assertTrue(self.comp._detect_idf_wifi_usage('#include <esp_wifi.h>'))

    def test_detects_esp_wifi_init_call(self):
        code = 'wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();\nesp_wifi_init(&cfg);'
        self.assertTrue(self.comp._detect_idf_wifi_usage(code))

    def test_ignores_plain_gpio_project(self):
        code = '#include "driver/gpio.h"\nvoid app_main(void) {}'
        self.assertFalse(self.comp._detect_idf_wifi_usage(code))


class TestIdfWifiNormalization(unittest.TestCase):

    def setUp(self):
        self.comp = make_compiler()

    def test_define_ssid_rewritten(self):
        code = '#define WIFI_SSID "MyHomeNetwork"\n#define WIFI_PASS "hunter2"'
        out = self.comp._normalize_wifi_for_qemu_idf(code)
        self.assertIn(f'#define WIFI_SSID "{_QEMU_WIFI_SSID}"', out)
        self.assertIn('#define WIFI_PASS ""', out)

    def test_designated_initializers_rewritten(self):
        code = (
            'wifi_config_t wifi_config = {\n'
            '    .sta = {\n'
            '        .ssid = "MyHomeNetwork",\n'
            '        .password = "hunter2",\n'
            '    },\n'
            '};'
        )
        out = self.comp._normalize_wifi_for_qemu_idf(code)
        self.assertIn(f'.ssid = "{_QEMU_WIFI_SSID}"', out)
        self.assertIn('.password = ""', out)
        self.assertNotIn('MyHomeNetwork', out)
        self.assertNotIn('hunter2', out)

    def test_non_wifi_code_untouched(self):
        code = '#include "driver/gpio.h"\nvoid app_main(void) { }\n'
        self.assertEqual(self.comp._normalize_wifi_for_qemu_idf(code), code)


class TestJobKeyLanguageVariance(unittest.TestCase):

    FILES = [{'name': 'main.c', 'content': 'void app_main(void) {}'}]

    def test_language_changes_key(self):
        k_arduino = compile_module._job_key(self.FILES, 'esp32:esp32:esp32')
        k_espidf = compile_module._job_key(
            self.FILES, 'esp32:esp32:esp32', language='espidf',
        )
        self.assertNotEqual(k_arduino, k_espidf)

    def test_explicit_arduino_keeps_historical_key(self):
        """language='arduino' and language=None must hash identically so
        pre-feature clients keep dedupping against new-client submissions."""
        k_none = compile_module._job_key(self.FILES, 'esp32:esp32:esp32')
        k_arduino = compile_module._job_key(
            self.FILES, 'esp32:esp32:esp32', language='arduino',
        )
        self.assertEqual(k_none, k_arduino)

    def test_espidf_key_is_stable(self):
        k1 = compile_module._job_key(self.FILES, 'esp32:esp32:esp32', language='espidf')
        k2 = compile_module._job_key(self.FILES, 'esp32:esp32:esp32', language='espidf')
        self.assertEqual(k1, k2)


if __name__ == '__main__':
    unittest.main()
