"""
The Bluetooth compile error says something Velxio can answer better.

arduino-pico gates its BT libraries behind a static_assert telling the user to
use the Arduino IDE's "Tools->IP/Bluetooth Stack" menu. In Velxio that menu does
not exist, so the message reads like a setting we forgot to expose rather than
what it is: the CYW43439's Bluetooth side is not emulated at all.
"""

from app.services.arduino_cli import annotate_build_stderr

REAL_ERROR = (
    "/root/.arduino15/packages/rp2040/hardware/rp2040/6.0.0/cores/rp2040/_needsbt.h:4:24: "
    "error: static assertion failed: This library needs Bluetooth enabled.  "
    "Use the 'Tools->IP/Bluetooth Stack' menu in the IDE to enable it\n"
    "Error during build: exit status 1\n"
)


def test_the_bluetooth_assert_gets_a_velxio_answer():
    out = annotate_build_stderr(REAL_ERROR)
    # The compiler's own text survives — the developer still needs it.
    assert '_needsbt.h' in out
    assert 'static assertion failed' in out
    # ...and we say what is actually true underneath.
    assert 'Bluetooth is not emulated on this board' in out
    assert 'WiFi' in out


def test_an_ordinary_error_is_left_alone():
    ordinary = "sketch.ino:5:3: error: 'foo' was not declared in this scope\n"
    assert annotate_build_stderr(ordinary) == ordinary


def test_empty_output_is_passed_through():
    assert annotate_build_stderr(None) is None
    assert annotate_build_stderr('') == ''
