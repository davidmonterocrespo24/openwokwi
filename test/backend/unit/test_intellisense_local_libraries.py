"""The symbol server answers from a plain arduino-cli sketchbook too.

velxio.dev keeps its libraries in a content-addressed cache, where an entry
dir name IS the content hash. Velxio Desktop's sidecar has no such cache: its
libraries are whatever `arduino-cli lib install` put in the sketchbook, under
plain folder names, and they get rewritten in place on upgrade. Without this
path the desktop editor gets the engine's embedded catalog and nothing else —
`client.` on a library the user installed himself resolves to nothing.

The routes are called directly (no TestClient) so the suite keeps needing
nothing but pytest.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

_REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO / "backend"))

from app.api.routes import intellisense  # noqa: E402

HEADER = """
class Widget : public Print {
 public:
  Widget(int pin);
  void begin(void);
  bool ready();
 private:
  int _pin;
};
"""


def _lib(libraries: Path, folder: str, name: str, version: str, header: str = HEADER) -> Path:
    d = libraries / folder
    (d / "src").mkdir(parents=True, exist_ok=True)
    (d / "library.properties").write_text(
        f"name={name}\nversion={version}\narchitectures=*\n", encoding="utf-8"
    )
    (d / "src" / f"{folder}.h").write_text(header, encoding="utf-8")
    return d


@pytest.fixture
def sketchbook(tmp_path, monkeypatch):
    """A sketchbook with no content-addressed cache in sight. Both env vars are
    set so the resolver never reaches arduino-cli or the home-dir guesses —
    a unit test must not depend on what is installed on the machine."""
    libraries = tmp_path / "sketchbook" / "libraries"
    libraries.mkdir(parents=True)
    monkeypatch.setenv("VELXIO_LIBCACHE_DIR", str(tmp_path / "no-cache-here"))
    monkeypatch.setenv("VELXIO_SYMBOL_LIBRARIES_DIR", str(libraries))
    return libraries


def _body(response) -> dict:
    return json.loads(response.body)


def test_a_sketchbook_library_answers_by_display_name(sketchbook):
    _lib(sketchbook, "MyWidget", "My Widget Library", "1.4.0")

    payload = _body(intellisense.get_symbols("My Widget Library"))

    assert payload["id"] == "My Widget Library"
    assert "MyWidget.h" in payload["triggers"]
    assert {"begin", "ready"} <= {s["name"] for s in payload["symbols"]}


def test_the_installed_version_answers_a_pin_for_another_one(sketchbook):
    """The project pins what velxio.dev cached; the desktop compiles against
    what is on disk. Answering with the installed version beats a 404."""
    _lib(sketchbook, "MyWidget", "My Widget Library", "1.4.0")

    exact = _body(intellisense.get_symbols("My Widget Library@1.4.0"))
    other = _body(intellisense.get_symbols("My Widget Library@9.9.9"))

    assert exact["id"] == other["id"] == "My Widget Library"


def test_an_uninstalled_library_is_404(sketchbook):
    _lib(sketchbook, "MyWidget", "My Widget Library", "1.4.0")

    with pytest.raises(HTTPException) as err:
        intellisense.get_symbols("Nothing Like This")
    assert err.value.status_code == 404


def test_type_lookup_resolves_a_class_from_the_sketchbook(sketchbook):
    _lib(sketchbook, "MyWidget", "My Widget Library", "1.4.0")

    payload = _body(intellisense.get_type_members("Widget"))

    assert payload["type"] == "Widget"
    assert {"begin", "ready"} <= {s["name"] for s in payload["symbols"]}
    # Print is not an installed library — reported as an unresolved base so the
    # editor can supply its own members for it.
    assert "Print" in payload["bases"]


def test_scans_are_cached_beside_libraries_not_inside_them(sketchbook):
    """arduino-cli scans `libraries/` for libraries. Nothing we write may land
    there, or a stray dir shows up in `lib list`."""
    _lib(sketchbook, "MyWidget", "My Widget Library", "1.4.0")

    intellisense.get_symbols("My Widget Library")

    assert (sketchbook.parent / ".velxio-symbols").is_dir()
    assert [d.name for d in sketchbook.iterdir()] == ["MyWidget"]


def test_upgrading_a_library_in_place_invalidates_its_cached_scan(sketchbook):
    """A sketchbook folder keeps its name across `lib upgrade`, so the scan
    cannot be keyed by name — it is keyed by a content stamp."""
    lib = _lib(sketchbook, "MyWidget", "My Widget Library", "1.4.0")
    first = _body(intellisense.get_symbols("My Widget Library"))
    assert "shutdown" not in {s["name"] for s in first["symbols"]}

    (lib / "src" / "MyWidget.h").write_text(
        HEADER.replace("bool ready();", "bool ready();\n  void shutdown();"), encoding="utf-8"
    )
    (lib / "library.properties").write_text(
        "name=My Widget Library\nversion=1.5.0\narchitectures=*\n", encoding="utf-8"
    )

    second = _body(intellisense.get_symbols("My Widget Library"))
    assert "shutdown" in {s["name"] for s in second["symbols"]}


def test_the_content_addressed_cache_wins_over_the_sketchbook(tmp_path, monkeypatch):
    """On velxio.dev both exist (the pro overlay points arduino-cli's
    sketchbook at the cache). The immutable one answers."""
    cache = tmp_path / "libcache"
    cache.mkdir()
    _lib(cache, "mywidgetlibrary@2.0.0-abcdef123456", "My Widget Library", "2.0.0")
    libraries = tmp_path / "sketchbook" / "libraries"
    libraries.mkdir(parents=True)
    _lib(libraries, "MyWidget", "My Widget Library", "1.4.0")
    monkeypatch.setenv("VELXIO_LIBCACHE_DIR", str(cache))
    monkeypatch.setenv("VELXIO_SYMBOL_LIBRARIES_DIR", str(libraries))

    payload = _body(intellisense.get_symbols("My Widget Library"))

    # The cache entry's scan is keyed by its dir name; the sketchbook's is not.
    assert (cache / ".symbols" / "mywidgetlibrary@2.0.0-abcdef123456.json").is_file()
    assert not (libraries.parent / ".velxio-symbols").exists()
    assert payload["id"] == "My Widget Library"


def test_a_sketchbook_that_resolves_to_the_cache_is_not_scanned_twice(tmp_path, monkeypatch):
    """The pro overlay's fallback sketchbook is a symlink to the cache root."""
    cache = tmp_path / "libcache"
    cache.mkdir()
    _lib(cache, "mywidgetlibrary@2.0.0-abcdef123456", "My Widget Library", "2.0.0")
    sketchbook = tmp_path / "cache-sketchbook"
    sketchbook.mkdir()
    (sketchbook / "libraries").symlink_to(cache, target_is_directory=True)
    monkeypatch.setenv("VELXIO_LIBCACHE_DIR", str(cache))
    monkeypatch.delenv("VELXIO_SYMBOL_LIBRARIES_DIR", raising=False)
    monkeypatch.setenv("VELXIO_FALLBACK_SKETCHBOOK", str(sketchbook))

    assert [s.content_addressed for s in intellisense._sources()] == [True]


def test_no_library_source_at_all_is_404(tmp_path, monkeypatch):
    monkeypatch.setenv("VELXIO_LIBCACHE_DIR", str(tmp_path / "nope"))
    monkeypatch.setenv("VELXIO_SYMBOL_LIBRARIES_DIR", str(tmp_path / "also-nope"))
    monkeypatch.delenv("ARDUINO_DIRECTORIES_USER", raising=False)
    monkeypatch.delenv("VELXIO_FALLBACK_SKETCHBOOK", raising=False)
    # Never probe arduino-cli or the home dir from a unit test.
    monkeypatch.setattr(intellisense, "_cli_sketchbook", lambda: None)
    monkeypatch.setattr(intellisense.Path, "home", staticmethod(lambda: tmp_path / "empty-home"))

    with pytest.raises(HTTPException) as err:
        intellisense.get_symbols("Anything")
    assert err.value.status_code == 404
