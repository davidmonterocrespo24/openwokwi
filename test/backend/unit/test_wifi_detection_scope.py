"""
Which files count when deciding a sketch uses WiFi (issue #260).

The Arduino path used to read only the entry sketch while the pure-IDF path
read every file, and that asymmetry was not cosmetic: a "no WiFi" verdict made
the QEMU worker leave the radio out of the machine, so the firmware's first
touch of the MAC panicked with LoadStorePIFAddrError instead of merely failing
to connect. A header that includes WiFi.h is as much a WiFi project as an .ino
that does.
"""
import unittest

from app.services.espidf_compiler import ESPIDFCompiler


class TestWifiDetectionScope(unittest.TestCase):
    def setUp(self):
        self.c = ESPIDFCompiler.__new__(ESPIDFCompiler)  # no toolchain needed

    def _joined(self, files):
        """What the compiler scans: every file's content, as one blob."""
        return '\n'.join(f.get('content', '') for f in files)

    def test_include_in_the_entry_sketch(self):
        files = [{'name': 'main.ino', 'content': '#include <WiFi.h>\nvoid setup(){}'}]
        self.assertTrue(self.c._detect_wifi_usage(self._joined(files)))

    def test_include_in_a_secondary_header(self):
        """The case that reached #260 as a Guru Meditation."""
        files = [
            {'name': 'main.ino', 'content': '#include "net.h"\nvoid setup(){ net_start(); }'},
            {'name': 'net.h', 'content': '#include <WiFi.h>\ninline void net_start(){ WiFi.begin("x",""); }'},
        ]
        self.assertTrue(self.c._detect_wifi_usage(self._joined(files)))

    def test_begin_call_in_a_secondary_source(self):
        files = [
            {'name': 'main.ino', 'content': 'void setup(){ net_start(); }'},
            {'name': 'net.cpp', 'content': 'void net_start(){ WiFi.begin("x",""); }'},
        ]
        self.assertTrue(self.c._detect_wifi_usage(self._joined(files)))

    def test_a_project_with_no_wifi_anywhere(self):
        files = [
            {'name': 'main.ino', 'content': 'void setup(){ Serial.begin(115200); }'},
            {'name': 'helper.h', 'content': 'inline int twice(int n){ return n * 2; }'},
        ]
        self.assertFalse(self.c._detect_wifi_usage(self._joined(files)))

    def test_idf_projects_already_read_everything(self):
        files = [
            {'name': 'main.c', 'content': '#include "net.h"\nvoid app_main(){}'},
            {'name': 'net.h', 'content': '#include <esp_wifi.h>'},
        ]
        self.assertTrue(self.c._detect_idf_wifi_usage(self._joined(files)))
