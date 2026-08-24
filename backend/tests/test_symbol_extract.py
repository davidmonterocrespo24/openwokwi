"""Unit tests for the intellisense symbol scanner and its library-cache
resolution helpers. Pure-Python — no FastAPI app, no HTTP server, no
toolchain — so they run anywhere pytest does.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.services.symbol_extract import (
    find_cache_entry,
    norm_name,
    norm_version,
    parse_spec,
    scan_library,
)


# ── fixture library ───────────────────────────────────────────────────────

_HEADER = """\
#pragma once
#include <stdint.h>

#define FAKE_MAX_PIXELS 64
#define FAKE_NAME "fake"  // string-valued define still counts
#define FAKE_FUNC(x) ((x) * 2)
#define lowercase_define 1
#define FAKE_GUARD_H

enum FakeMode { FAKE_MODE_A, FAKE_MODE_B = 2 };
enum class FakeColor : uint8_t { Red, Green };

/* block comment with a fake decl: void notReal(); */
class FakeLib {
public:
    FakeLib(uint8_t pin);
    ~FakeLib();
    bool begin(uint8_t pin, int count = 8);
    void show();
private:
    void internalUpdate();
    uint8_t pin_;
};
"""


@pytest.fixture
def fake_lib(tmp_path: Path) -> Path:
    lib = tmp_path / "fakelib@1.2.3-0123456789ab"
    src = lib / "src"
    src.mkdir(parents=True)
    (lib / "library.properties").write_text(
        "name=Fake Lib\nversion=1.2.3\n", encoding="utf-8"
    )
    (src / "FakeLib.h").write_text(_HEADER, encoding="utf-8")
    examples = lib / "examples"
    examples.mkdir()
    (examples / "Noise.h").write_text(
        "class NotMe { public: void nope(); };\n", encoding="utf-8"
    )
    return lib


def _by_kind(result: dict, kind: str) -> dict[str, dict]:
    return {s["name"]: s for s in result["symbols"] if s["kind"] == kind}


# ── scan_library ──────────────────────────────────────────────────────────

def test_scan_library_id_and_triggers(fake_lib: Path) -> None:
    result = scan_library(fake_lib)
    assert result["id"] == "Fake Lib"
    assert "FakeLib.h" in result["triggers"]
    # examples/ headers are neither triggers nor scanned for symbols
    assert "Noise.h" not in result["triggers"]
    assert all(s["name"] != "NotMe" for s in result["symbols"])


def test_scan_library_class_and_public_methods(fake_lib: Path) -> None:
    result = scan_library(fake_lib)
    classes = _by_kind(result, "class")
    methods = _by_kind(result, "method")

    assert "FakeLib" in classes
    # constructor is folded into the class symbol, not a separate method
    assert classes["FakeLib"]["insertText"] == "FakeLib(${1:pin})$0"
    assert classes["FakeLib"]["params"] == ["uint8_t pin"]

    assert set(methods) == {"begin", "show"}
    for m in methods.values():
        assert m["owner"] == "FakeLib"
        assert m["detail"] == "Fake Lib"
    assert methods["begin"]["signature"] == "bool begin(uint8_t pin, int count = 8)"
    # only the required (non-defaulted) arg becomes a snippet placeholder
    assert methods["begin"]["insertText"] == "begin(${1:pin})$0"
    assert methods["begin"]["params"] == ["uint8_t pin", "int count = 8"]
    assert methods["show"]["insertText"] == "show()"

    # private method and destructor never surface
    assert "internalUpdate" not in methods
    assert all("~" not in s["name"] for s in result["symbols"])


def test_scan_library_constants_and_enums(fake_lib: Path) -> None:
    result = scan_library(fake_lib)
    constants = _by_kind(result, "constant")

    assert "FAKE_MAX_PIXELS" in constants
    assert "FAKE_NAME" in constants
    # function-like macro, lowercase define, and value-less include guard: out
    assert "FAKE_FUNC" not in constants
    assert "lowercase_define" not in constants
    assert "FAKE_GUARD_H" not in constants

    # plain enum values: no owner; enum class values: owner set
    assert "FAKE_MODE_A" in constants and "owner" not in constants["FAKE_MODE_A"]
    assert "FAKE_MODE_B" in constants
    assert constants["Red"]["owner"] == "FakeColor"
    assert constants["Green"]["owner"] == "FakeColor"


# ── spec parsing / normalization (used by the route) ──────────────────────

def test_access_label_survives_a_nested_enum(tmp_path: Path) -> None:
    """`public:` followed by a nested typedef enum used to take the enum branch
    of the walker without ever applying the access label, so the class stayed
    private and every method after the enum vanished. AccelStepper shipped 4
    of its ~50 public methods that way; DallasTemperature shipped 0."""
    lib = tmp_path / "steplib@1.0.0-abcdefabcdef"
    src = lib / "src"
    src.mkdir(parents=True)
    (lib / "library.properties").write_text("name=Step Lib\nversion=1.0.0\n", encoding="utf-8")
    (src / "Step.h").write_text(
        """\
class Stepper {
public:
    typedef enum { FUNCTION = 0, DRIVER = 1 } MotorInterfaceType;
    Stepper(uint8_t iface = DRIVER);
    void moveTo(long absolute);
    bool run();
protected:
    void step(long n);
private:
    int _pin;
public:
    void setMaxSpeed(float speed);
};
""",
        encoding="utf-8",
    )
    result = scan_library(lib)
    methods = _by_kind(result, "method")
    assert set(methods) == {"moveTo", "run", "setMaxSpeed"}
    assert all(m["owner"] == "Stepper" for m in methods.values())
    assert _by_kind(result, "class")["Stepper"].get("bases") is None
    assert "step" not in methods and "_pin" not in methods
    assert {"FUNCTION", "DRIVER"} <= set(_by_kind(result, "constant"))


def test_parse_spec() -> None:
    assert parse_spec("Adafruit GFX Library@1.12.6") == ("Adafruit GFX Library", "1.12.6")
    assert parse_spec("FastLED") == ("FastLED", None)
    assert parse_spec("") == ("", None)


def test_norm_rules_mirror_library_cache() -> None:
    assert norm_name("Adafruit GFX Library") == "adafruitgfxlibrary"
    assert norm_name("DHT sensor library") == "dhtsensorlibrary"
    assert norm_name("") == ""
    assert norm_version("1.12.6") == "1.12.6"
    assert norm_version(" 1.2.3 ") == "1.2.3"
    # unsafe chars become '-', leading dots are stripped (no '.'/'..' tokens)
    assert norm_version("../evil/1") == "-evil-1"
    assert norm_version("") == "0"


def test_find_cache_entry(tmp_path: Path) -> None:
    for entry in (
        "fastled@3.6.0-aaaaaaaaaaaa",
        "fastled@3.10.1-bbbbbbbbbbbb",
        "other@1.0.0-cccccccccccc",
        ".symbols",
    ):
        (tmp_path / entry).mkdir()

    exact = find_cache_entry(tmp_path, "FastLED", "3.6.0")
    assert exact is not None and exact.name == "fastled@3.6.0-aaaaaaaaaaaa"

    # bare name -> NEWEST version, compared numerically (3.10.1 > 3.6.0 even
    # though it sorts first lexicographically) — mirrors lookup_by_name
    bare = find_cache_entry(tmp_path, "FastLED")
    assert bare is not None and bare.name == "fastled@3.10.1-bbbbbbbbbbbb"

    assert find_cache_entry(tmp_path, "FastLED", "9.9.9") is None
    assert find_cache_entry(tmp_path, "Nope") is None
    assert find_cache_entry(tmp_path / "missing", "FastLED") is None
    assert find_cache_entry(tmp_path, "!!!") is None  # normalizes to empty


# ── route wiring (skipped where fastapi is not installed) ─────────────────

def test_route_registers_symbols_path() -> None:
    pytest.importorskip("fastapi")
    from app.api.routes import intellisense

    assert any(r.path == "/symbols/{spec}" for r in intellisense.router.routes)


def test_type_endpoint_returns_only_the_declaring_class_members(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """/type/{name} is the completion-safe long-tail path: only the members
    of that class, never a library's module-level constants. And when two
    libraries declare the same class, the one NAMED after it wins over a
    fork/bundle that vendors a trimmed copy."""
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    from app.api.routes import intellisense

    root = tmp_path / "libcache"

    def lib(dirname: str, display: str, header: str) -> None:
        d = root / dirname / "src"
        d.mkdir(parents=True)
        (root / dirname / "library.properties").write_text(
            f"name={display}\nversion=1.0.0\n", encoding="utf-8"
        )
        (d / "Lib.h").write_text(header, encoding="utf-8")

    # The canonical library: named after the class, full API + a macro.
    lib(
        "pubsubclient@2.8-aaaaaaaaaaaa",
        "PubSubClient",
        "#define MQTT_MAX_PACKET_SIZE 256\n"
        "class PubSubClient {\npublic:\n  void setServer(const char*, int);\n"
        "  bool publish(const char*, const char*);\n  bool connected();\n};\n",
    )
    # A bundle that vendors a trimmed copy under another name.
    lib(
        "espbundle@1.0.0-bbbbbbbbbbbb",
        "ESP Bundle",
        "class PubSubClient {\npublic:\n  bool publish(const char*, const char*);\n};\n"
        "class BundleThing {\npublic:\n  void go();\n};\n",
    )
    monkeypatch.setenv("VELXIO_LIBCACHE_DIR", str(root))

    app = fastapi.FastAPI()
    app.include_router(intellisense.router, prefix="/api/intellisense")
    client = TestClient(app)

    r = client.get("/api/intellisense/type/PubSubClient")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == "PubSubClient"          # the canonical one, not the bundle
    names = {s["name"] for s in body["symbols"]}
    assert names == {"setServer", "publish", "connected"}
    assert all(s["owner"] == "PubSubClient" for s in body["symbols"])
    assert "MQTT_MAX_PACKET_SIZE" not in names    # module-level never leaks

    r = client.get("/api/intellisense/type/BundleThing")
    assert r.status_code == 200 and r.json()["id"] == "ESP Bundle"

    # Inheritance is followed through the index, members re-owned to the
    # requested type and tagged with where they came from; bases outside the
    # cache are still listed so the host can supply them.
    lib(
        "gfxlike@1.0.0-cccccccccccc",
        "GfxLike",
        "class GfxBase : public Print {\npublic:\n  void drawPixel(int x, int y);\n"
        "  void setTextSize(uint8_t s), setTextColor(uint16_t c);\n};\n",
    )
    lib(
        "oledlike@1.0.0-dddddddddddd",
        "OledLike",
        "class Oled : public GfxBase {\npublic:\n  bool begin();\n};\n",
    )
    # cache grew -> index rebuilds
    r = client.get("/api/intellisense/type/Oled")
    assert r.status_code == 200
    body = r.json()
    assert body["bases"] == ["GfxBase", "Print"]
    by_name = {s["name"]: s for s in body["symbols"]}
    assert set(by_name) == {"begin", "drawPixel", "setTextSize", "setTextColor"}
    assert "inheritedFrom" not in by_name["begin"]
    assert by_name["setTextSize"]["inheritedFrom"] == "GfxBase"
    assert all(s["owner"] == "Oled" for s in body["symbols"])

    assert client.get("/api/intellisense/type/Nope").status_code == 404
    assert client.get("/api/intellisense/type/not-a-type!").status_code == 400
    # the index is persisted and reused
    assert (root / ".symbols" / "_types.json").is_file()
