#!/usr/bin/env python
"""Memoizing front-end for ESP-IDF's ldgen.

ldgen re-parses every component's `linker.lf` with pyparsing on EVERY build —
measured at 15.2 s on this box (3.8 M pyparsing calls for 48 fragment files),
which was 41 % of a whole ESP-IDF compile of a one-file sketch. Its output is a
pure function of its inputs (verified: byte-identical across runs, and unchanged
when only the user's own source changes), so the result is cached by a hash of
every input file plus the argument vector.

Safety rules:
  * every existing path in argv is hashed by CONTENT, plus the argv itself, so a
    changed sdkconfig / fragment / library list misses the cache;
  * a cache hit only ever copies a previously produced file into --output;
  * anything unexpected (parse trouble, unreadable cache, write failure) falls
    through to the real ldgen — the build must never break because of the cache.

Installed as tools/ldgen/ldgen.py, with the upstream script kept alongside as
ldgen_upstream.py.
"""
import hashlib
import os
import runpy
import shutil
import sys
import tempfile

CACHE_DIR = os.environ.get("VELXIO_LDGEN_CACHE", "/var/lib/velxio-build/.ldgen-cache")
MAX_ENTRIES = 64
_HERE = os.path.dirname(os.path.abspath(__file__))
_UPSTREAM = os.path.join(_HERE, "ldgen_upstream.py")


def _run_upstream():
    runpy.run_path(_UPSTREAM, run_name="__main__")


def _output_path(argv):
    for i, a in enumerate(argv):
        if a == "--output" and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith("--output="):
            return a.split("=", 1)[1]
    return None


def _input_hash(argv):
    """Hash the argv and the CONTENT of every path it references.

    Paths arrive either as plain arguments or inside ';'-separated lists
    (--fragments-list), so each token is split on ';' before testing.
    """
    h = hashlib.sha256()
    h.update(b"velxio-ldgen-cache-v1\0")
    out = _output_path(argv)
    for arg in argv[1:]:
        if arg == out:
            continue  # the destination must not perturb the key
        h.update(arg.encode("utf-8", "replace"))
        h.update(b"\0")
        for token in arg.split(";"):
            token = token.strip()
            if not token or token == out or not os.path.isfile(token):
                continue
            with open(token, "rb") as fh:
                h.update(hashlib.sha256(fh.read()).digest())
            h.update(b"\0")
    return h.hexdigest()


def _prune():
    try:
        entries = sorted(
            (os.path.join(CACHE_DIR, n) for n in os.listdir(CACHE_DIR) if n.endswith(".ld")),
            key=os.path.getmtime,
            reverse=True,
        )
        for stale in entries[MAX_ENTRIES:]:
            os.unlink(stale)
    except OSError:
        pass


def main():
    argv = sys.argv
    out = _output_path(argv)
    if not out:
        _run_upstream()
        return

    try:
        key = _input_hash(argv)
        cached = os.path.join(CACHE_DIR, key + ".ld")
    except Exception:
        _run_upstream()
        return

    if os.path.isfile(cached):
        try:
            os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
            shutil.copyfile(cached, out)
            os.utime(cached, None)  # LRU touch
            return
        except OSError:
            pass  # fall through and regenerate

    _run_upstream()

    try:
        if os.path.isfile(out):
            os.makedirs(CACHE_DIR, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=CACHE_DIR, suffix=".tmp")
            os.close(fd)
            shutil.copyfile(out, tmp)
            os.replace(tmp, cached)
            _prune()
    except OSError:
        pass


if __name__ == "__main__":
    main()
