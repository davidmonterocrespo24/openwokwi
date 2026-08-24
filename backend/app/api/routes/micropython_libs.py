"""MicroPython library installation (issue #214).

MicroPython has no Library Manager step: a library IS a .py file in the
project, copied onto the board's filesystem before main.py runs. What was
missing is a way to GET those files without hunting GitHub by hand. This
router answers it against the official micropython-lib package index — the
same index `mip` uses on real hardware (https://micropython.org/pi/v2) —
proxied server-side so the browser needs no CORS exception and so the
limits below are enforced somewhere the client cannot skip.

Security model (the concern that kept this feature parked):
  - Only the OFFICIAL index is reachable — the package name is looked up in
    index.json and the files come from the index's own content-addressed
    store. No arbitrary URLs, no GitHub fetch.
  - Source only: the `py` arch is requested, every returned path must end in
    .py, and native/bytecode (.mpy) is rejected. What lands in the editor is
    exactly what will run, readable by the user.
  - Bounded: per-package file count / total size caps, bounded dependency
    recursion, in-process TTL cache over the index.

The files land in the user's WORKSPACE (the frontend writes them into the
board's file group), not on any server store — so quota is the project's own
size and the "installed" library is visible, editable and travels with the
project.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter()

INDEX_URL = "https://micropython.org/pi/v2/index.json"
PACKAGE_URL = "https://micropython.org/pi/v2/package/py/{name}/{version}.json"
FILE_URL = "https://micropython.org/pi/v2/file/{prefix}/{hash}"

# The index changes when micropython-lib publishes — rarely. 15 min keeps a
# busy classroom from hammering micropython.org through us.
INDEX_TTL_S = 15 * 60
FETCH_TIMEOUT_S = 20.0

# Caps: micropython-lib's largest source packages are a handful of files and
# a few tens of KB. Anything past these limits is not a driver, it is a
# mistake (or an index we should not trust that day).
MAX_FILES_PER_PACKAGE = 24
MAX_TOTAL_BYTES = 262_144  # 256 KB of source
MAX_DEP_DEPTH = 3

_index_cache: tuple[float, list[dict[str, Any]]] | None = None
_index_lock = asyncio.Lock()


class MpyPackage(BaseModel):
    name: str
    version: str
    description: str = ""
    author: str = ""
    license: str = ""


class SearchResponse(BaseModel):
    success: bool
    packages: list[MpyPackage] = []
    error: str | None = None


class FetchRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    version: str | None = Field(None, max_length=40)


class MpyFile(BaseModel):
    path: str
    content: str


class FetchResponse(BaseModel):
    success: bool
    name: str
    version: str | None = None
    files: list[MpyFile] = []
    error: str | None = None


async def _get_index() -> list[dict[str, Any]]:
    global _index_cache
    now = time.monotonic()
    if _index_cache is not None and now - _index_cache[0] < INDEX_TTL_S:
        return _index_cache[1]
    async with _index_lock:
        if _index_cache is not None and time.monotonic() - _index_cache[0] < INDEX_TTL_S:
            return _index_cache[1]
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT_S) as client:
            resp = await client.get(INDEX_URL)
            resp.raise_for_status()
            data = resp.json()
        packages = [p for p in data.get("packages", []) if "py" in p.get("versions", {})]
        _index_cache = (time.monotonic(), packages)
        return packages


def filter_packages(packages: list[dict[str, Any]], q: str) -> list[dict[str, Any]]:
    """Name/description substring match, name-prefix hits first. Pure so the
    unit tests need no network."""
    needle = q.strip().lower()
    if not needle:
        return packages
    starts, contains = [], []
    for p in packages:
        name = str(p.get("name", "")).lower()
        desc = str(p.get("description", "")).lower()
        if name.startswith(needle):
            starts.append(p)
        elif needle in name or needle in desc:
            contains.append(p)
    return starts + contains


def validate_package_files(
    hashes: list[Any], *, package: str
) -> list[tuple[str, str]]:
    """The (path, hash) pairs a package json may install, or raise.

    Enforces the source-only and path-safety rules: every path is a relative
    .py with no traversal, and the count cap holds. Pure for unit tests.
    """
    if len(hashes) > MAX_FILES_PER_PACKAGE:
        raise ValueError(f"{package}: too many files ({len(hashes)})")
    out: list[tuple[str, str]] = []
    for entry in hashes:
        if not isinstance(entry, (list, tuple)) or len(entry) != 2:
            raise ValueError(f"{package}: malformed hashes entry")
        path, digest = str(entry[0]), str(entry[1])
        if not path.endswith(".py"):
            raise ValueError(f"{package}: non-source file {path!r} (only .py is installable)")
        if path.startswith("/") or ".." in path.split("/") or "\\" in path:
            raise ValueError(f"{package}: unsafe path {path!r}")
        if not all(seg for seg in path.split("/")):
            raise ValueError(f"{package}: unsafe path {path!r}")
        if not digest.isalnum():
            raise ValueError(f"{package}: malformed hash for {path!r}")
        out.append((path, digest))
    return out


@router.get("/search", response_model=SearchResponse)
async def search_packages(q: str = Query("", max_length=100)) -> SearchResponse:
    """Search the official micropython-lib index (name + description)."""
    try:
        packages = filter_packages(await _get_index(), q)
    except Exception as e:  # network / index shape — degrade, don't 500 the modal
        logger.warning("[mpy-libs] index fetch failed: %s", e)
        return SearchResponse(success=False, error=f"micropython-lib index unavailable: {e}")
    return SearchResponse(
        success=True,
        packages=[
            MpyPackage(
                name=str(p.get("name", "")),
                version=str(p.get("version", "")),
                description=str(p.get("description", "")),
                author=str(p.get("author", "")),
                license=str(p.get("license", "")),
            )
            for p in packages[:60]
        ],
    )


async def _fetch_package_files(
    client: httpx.AsyncClient,
    name: str,
    version: str,
    *,
    seen: set[str],
    depth: int,
    budget: dict[str, int],
) -> list[MpyFile]:
    if name in seen:
        return []
    seen.add(name)
    if depth > MAX_DEP_DEPTH:
        raise ValueError(f"dependency chain too deep at {name!r}")

    resp = await client.get(PACKAGE_URL.format(name=name, version=version))
    if resp.status_code == 404:
        raise ValueError(f"package {name!r} not found in the micropython-lib index")
    resp.raise_for_status()
    pkg = resp.json()

    files: list[MpyFile] = []
    for path, digest in validate_package_files(pkg.get("hashes", []), package=name):
        fresp = await client.get(FILE_URL.format(prefix=digest[:2], hash=digest))
        fresp.raise_for_status()
        content = fresp.text
        budget["bytes"] += len(content.encode("utf-8"))
        if budget["bytes"] > MAX_TOTAL_BYTES:
            raise ValueError(
                f"{name}: install exceeds the {MAX_TOTAL_BYTES // 1024} KB source cap"
            )
        files.append(MpyFile(path=path, content=content))

    # mip-style dependencies: [[name, version], ...]. Same store, same rules.
    for dep in pkg.get("deps", []) or []:
        if isinstance(dep, (list, tuple)) and dep:
            dep_name = str(dep[0])
            dep_version = str(dep[1]) if len(dep) > 1 and dep[1] else "latest"
            files.extend(
                await _fetch_package_files(
                    client, dep_name, dep_version, seen=seen, depth=depth + 1, budget=budget
                )
            )
    return files


@router.post("/fetch", response_model=FetchResponse)
async def fetch_package(request: FetchRequest) -> FetchResponse:
    """Resolve one package (plus its declared deps) into .py files the
    frontend writes into the board's workspace."""
    name = request.name.strip()
    version = (request.version or "latest").strip() or "latest"
    # The name must exist in the official index — this is what pins the fetch
    # to micropython-lib and nothing else.
    try:
        index = await _get_index()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"micropython-lib index unavailable: {e}")
    if not any(p.get("name") == name for p in index):
        raise HTTPException(
            status_code=404,
            detail=f"'{name}' is not in the micropython-lib index. Community drivers outside "
            "the index can be added as a .py file in the workspace.",
        )
    try:
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT_S) as client:
            files = await _fetch_package_files(
                client, name, version, seen=set(), depth=0, budget={"bytes": 0}
            )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("[mpy-libs] fetch %s failed: %s", name, e)
        raise HTTPException(status_code=502, detail=f"fetch failed: {e}")
    if not files:
        raise HTTPException(status_code=422, detail=f"{name}: package resolved to no .py files")
    return FetchResponse(success=True, name=name, version=version, files=files)
