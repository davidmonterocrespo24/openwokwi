"""Unit tests for the .ino forward-declaration generator (espidf_compiler).

The generator is a ctags stand-in for the ESP32 sketch.ino.cpp path: the
classic Arduino idiom (helpers defined after setup()/loop()) must compile,
while anything ambiguous (methods, templates, default args) is left alone.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.espidf_compiler import generate_ino_prototypes  # noqa: E402


def test_helper_after_loop_gets_prototype():
    src = (
        '#include "Arduino.h"\n'
        "void setup() { blinkTwice(); }\n"
        "void loop() { blinkTwice(); }\n"
        "void blinkTwice() { }\n"
    )
    out = generate_ino_prototypes(src)
    assert "void blinkTwice();" in out
    # inserted before the first function definition, after the include
    assert out.index("void blinkTwice();") < out.index("void setup() {")
    assert out.index('#include "Arduino.h"') < out.index("void blinkTwice();")


def test_line_directive_preserves_error_lines():
    src = "void setup() {}\nvoid loop() {}\n"
    out = generate_ino_prototypes(src)
    # the original first function was on line 1
    assert "#line 1\n" in out


def test_control_flow_and_methods_are_not_declared():
    src = (
        "class Foo {\n"
        " public:\n"
        "  void method() { }\n"
        "};\n"
        "void Foo2::method2() { }\n"
        "void run() {\n"
        "  if (millis() > 5) { }\n"
        "  while (true) { }\n"
        "}\n"
    )
    out = generate_ino_prototypes(src)
    assert "method();" not in out
    assert "method2();" not in out
    assert "if(" not in out and "while(" not in out
    assert "void run();" in out


def test_default_args_and_templates_skipped():
    src = (
        "int scaled(int v, int f = 2) { return v * f; }\n"
        "template <typename T>\n"
        "T biggest(T a, T b) { return a > b ? a : b; }\n"
        "void setup() {}\n"
    )
    out = generate_ino_prototypes(src)
    assert "scaled(int v, int f = 2);" not in out
    assert "T biggest(T a, T b);" not in out
    assert "void setup();" in out


def test_strings_comments_and_preprocessor_ignored():
    src = (
        '#define WEIRD "void fake() {"\n'
        '// void alsoFake() {\n'
        '/* void broken(int x) { */\n'
        'const char *s = "void inString() {";\n'
        "void real() { }\n"
    )
    out = generate_ino_prototypes(src)
    assert "fake();" not in out
    assert "alsoFake();" not in out
    assert "broken(int x);" not in out
    assert "inString();" not in out
    assert "void real();" in out


def test_no_functions_returns_unchanged():
    src = "int x = 5;\n#define Y 4\n"
    assert generate_ino_prototypes(src) == src


def test_multiline_signature_params_kept():
    src = (
        "void setup() { drawStatus(1, 2); }\n"
        "void drawStatus(int a,\n"
        "                int b) {\n"
        "}\n"
    )
    out = generate_ino_prototypes(src)
    assert "void drawStatus(int a, int b);" in out


def test_attribute_and_pointer_returns():
    src = (
        "void IRAM_ATTR onTimer() { }\n"
        "char *nameFor(int idx) { return 0; }\n"
        "void setup() { onTimer(); nameFor(1); }\n"
    )
    out = generate_ino_prototypes(src)
    assert "void IRAM_ATTR onTimer();" in out
    assert "char *nameFor(int idx);" in out or "char * nameFor(int idx);" in out
