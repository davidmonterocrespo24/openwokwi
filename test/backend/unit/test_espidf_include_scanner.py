"""Preprocessor-aware include scanning for the ESP-IDF library resolver.

Reported 2026-08-03: every ESP32 build in a user's project failed with
errors from libraries he never installed (SoftwareSerial.h,
ArduinoBearSSL.h, Adafruit_GFX.h, AsyncElegantOTA.h) coming out of
user_libs_all.

Chain: ESPAsyncWebServer guards `#include <Hash.h>` behind
`#if defined(ESP8266) || defined(TARGET_RP2040)`. The old scanner was a
bare regex with no preprocessor state, so it reported Hash.h anyway; the
resolver then searched ~1000 installed libraries, found stemi-hexapod's
src/Hash.h, merged that hexapod-robot library whole, and compiled all of
its sources.

Design rule under test: a branch is skipped ONLY when every identifier in
its condition is a platform macro known to be undefined on ESP32.
Anything unknown stays LIVE — hiding a genuinely needed header would be a
far worse failure than the old over-reporting.

No toolchain required: pure scanning logic.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

from app.services.espidf_compiler import ESPIDFCompiler


class TestPreprocessorAwareIncludeScan(unittest.TestCase):
    def setUp(self) -> None:
        self.scan = ESPIDFCompiler()._detect_external_includes

    def test_real_espasyncwebserver_shape(self):
        """The exact reported break."""
        got = self.scan(
            '#if defined(ESP8266) || defined(TARGET_RP2040)\n'
            '#include <Hash.h>\n'
            '#include <ESPAsyncTCP.h>\n'
            '#else\n'
            '#include <AsyncTCP.h>\n'
            '#endif\n'
            '#include <ArduinoJson.h>\n'
        )
        self.assertNotIn('Hash.h', got)
        self.assertNotIn('ESPAsyncTCP.h', got)
        self.assertIn('AsyncTCP.h', got)
        self.assertIn('ArduinoJson.h', got)

    def test_unknown_macro_stays_live(self):
        """The safety property: we must never hide a header we cannot rule
        out. A project-specific macro is not a platform macro."""
        self.assertIn('MyLib.h', self.scan(
            '#if USE_CUSTOM_THING\n#include <MyLib.h>\n#endif'))
        self.assertIn('Other.h', self.scan(
            '#if LIB_VERSION > 2\n#include <Other.h>\n#endif'))

    def test_esp32_branch_lives_and_foreign_branch_dies(self):
        got = self.scan(
            '#ifdef ESP32\n#include <WiFi.h>\n#endif\n'
            '#ifdef __AVR__\n#include <SoftwareSerial.h>\n#endif')
        self.assertIn('WiFi.h', got)
        self.assertNotIn('SoftwareSerial.h', got)

    def test_else_of_a_dead_branch_is_live(self):
        self.assertEqual(
            self.scan('#ifdef ESP8266\n#include <Dead.h>\n'
                      '#else\n#include <Alive.h>\n#endif'),
            ['Alive.h'])

    def test_elif_selects_the_esp32_arm(self):
        self.assertEqual(
            self.scan('#if defined(ESP8266)\n#include <A.h>\n'
                      '#elif defined(ESP32)\n#include <B.h>\n'
                      '#else\n#include <C.h>\n#endif'),
            ['B.h'])

    def test_nested_dead_block(self):
        self.assertEqual(
            self.scan('#ifdef ESP8266\n#ifdef FOO\n#include <Deep.h>\n'
                      '#endif\n#endif\n#include <Top.h>'),
            ['Top.h'])

    def test_comments_are_not_includes(self):
        self.assertEqual(
            self.scan('// #include <Commented.h>\n'
                      '/* #include <Block.h> */\n'
                      '#include <Real.h>'),
            ['Real.h'])

    def test_plain_sketch_unchanged(self):
        got = self.scan('#include <ESPAsyncWebServer.h>\n'
                        '#include <ESP32Servo.h>\n'
                        '#include <WiFi.h>')
        self.assertIn('ESPAsyncWebServer.h', got)
        self.assertIn('ESP32Servo.h', got)

    def test_idf_internal_and_pathed_headers_still_skipped(self):
        got = self.scan('#include <freertos/FreeRTOS.h>\n'
                        '#include <esp_wifi.h>\n'
                        '#include <DHT.h>')
        self.assertEqual(got, ['DHT.h'])


if __name__ == '__main__':
    unittest.main()
