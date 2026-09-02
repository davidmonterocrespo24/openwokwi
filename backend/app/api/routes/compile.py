import asyncio
import hashlib
import json
import logging
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.core.hooks import (
    compile_priority,
    get_current_user_id,
    get_project_libraries,
    resolve_compile_owner,
    record_compile,
)
from app.services import build_queue
from app.services.arduino_cli import ArduinoCLIService
from app.services.espidf_compiler import espidf_compiler

logger = logging.getLogger(__name__)

router = APIRouter()
arduino_cli = ArduinoCLIService()

# ── Async compile job registry ───────────────────────────────────────────────
# In-process job dict for /compile/start + /compile/status/{job_id}. Cold ESP-IDF
# builds can take 5-7 minutes — far longer than Cloudflare's 100s edge timeout
# that hits any single HTTP request. The async path lets the client poll a
# short-lived status endpoint instead of holding one long-lived POST open.
#
# Single-instance only: if velxio ever scales to multiple FastAPI workers, this
# needs to move to Redis or the sqlite database. For now one process is fine.
COMPILE_JOBS: dict[str, dict[str, Any]] = {}
JOB_BY_KEY: dict[str, str] = {}  # content_hash → job_id, for deduplication
JOB_TTL_S = 1800  # purge results 30 min after completion

# ── Artifact cache ────────────────────────────────────────────────────────
# The dedup above only collapses builds that are still in flight, so hitting
# Run twice on the same gallery example rebuilt it from scratch: measured 28 s
# cold and 27 s warm for an ESP-IDF P4 example, all of it before the emulator
# even starts. Gallery examples are byte-identical for every visitor, so the
# first build can serve everyone. Results are stored under the build volume,
# keyed by the same content hash the dedup uses.
ARTIFACT_CACHE_DIR = Path(
    os.environ.get("VELXIO_ARTIFACT_CACHE", "/var/lib/velxio-build/artifacts")
)
ARTIFACT_CACHE_MAX_ENTRIES = 400
ARTIFACT_CACHE_MAX_AGE_S = 14 * 24 * 3600


def _toolchain_epoch() -> str:
    """Fingerprint the code that TURNS a request into build flags.

    A cached binary is only valid while the sdkconfig/CLI generation behind it
    is unchanged — flipping CONFIG_SPIRAM_MEMTEST off, say, must not keep
    serving images built with it on. Hashing the two service modules makes the
    invalidation automatic: edit them, every key changes.
    """
    h = hashlib.sha256()
    here = Path(__file__).resolve().parents[2] / "services"
    for name in ("espidf_compiler.py", "arduino_cli.py"):
        try:
            h.update((here / name).read_bytes())
        except OSError:
            h.update(b"?")
    return h.hexdigest()[:16]


_TOOLCHAIN_EPOCH = _toolchain_epoch()


def _artifact_path(key: str) -> Path:
    return ARTIFACT_CACHE_DIR / f"{key}.json"


def _artifact_load(key: str) -> dict | None:
    """Return a cached CompileResponse dict, or None. Never raises."""
    path = _artifact_path(key)
    try:
        if not path.is_file():
            return None
        if time.time() - path.stat().st_mtime > ARTIFACT_CACHE_MAX_AGE_S:
            path.unlink(missing_ok=True)
            return None
        data = json.loads(path.read_text())
        os.utime(path, None)  # LRU: touch on read
        return data if isinstance(data, dict) else None
    except Exception:
        logger.warning("[compile] artifact cache read failed", exc_info=True)
        return None


def _artifact_store(key: str, result: dict) -> None:
    """Persist a SUCCESSFUL build. Failures are never cached — a compile error
    is usually the user's half-written code, and they will edit and retry."""
    if not result.get("success"):
        return
    try:
        ARTIFACT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        # The build log is per-run noise and can be hundreds of KB; a cache hit
        # says so in its place rather than replaying someone else's ninja run.
        slim = dict(result)
        slim["stdout"] = "[served from the build cache - identical sources]"
        tmp = _artifact_path(key).with_suffix(".tmp")
        tmp.write_text(json.dumps(slim))
        tmp.replace(_artifact_path(key))
        _artifact_prune()
    except Exception:
        logger.warning("[compile] artifact cache write failed", exc_info=True)


def _artifact_prune() -> None:
    """Keep the newest ARTIFACT_CACHE_MAX_ENTRIES files (LRU by mtime)."""
    try:
        files = sorted(
            ARTIFACT_CACHE_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True
        )
        for stale in files[ARTIFACT_CACHE_MAX_ENTRIES:]:
            stale.unlink(missing_ok=True)
    except Exception:
        pass

# ── Concurrency control ──────────────────────────────────────────────────────
# Two lanes, gated by app.services.build_queue. HEAVY = ESP-IDF (cmake + ninja,
# minutes on a cold cache): capped low — the VPS is modest (saw load avg 30 with
# 6 ninja processes peeling each other apart). LIGHT = arduino-cli boards (AVR,
# RP2040, STM32...): seconds each, so they get their own slots and never queue
# behind an ESP-IDF cold build. Before the split a single Semaphore(2) gated
# both, and a Uno blink could sit "compiling" for minutes while two ESP32 builds
# ran. Concurrent compiles to the SAME ESP-IDF target would corrupt the
# persistent build dir, so those are serialized with a per-target lock layered
# on top.
#
# BuildQueue replaced the two semaphores when velxio.dev started queueing for
# real: a semaphore is FIFO and anonymous, so a paid build could not get past a
# wall of gallery clicks and the route had nothing to tell the waiting user. The
# queue is unbounded on purpose — a build is never refused, only delayed.
_TARGET_LOCKS: dict[str, asyncio.Lock] = {}


def _is_heavy_compile(board_fqbn: str) -> bool:
    """ESP32 boards compile with ESP-IDF when the toolchain is present."""
    return board_fqbn.startswith("esp32:") and espidf_compiler.available


def _build_identity(board_fqbn: str) -> str:
    """The identity of the persistent BUILD DIRECTORY this FQBN compiles in.

    The lock below has to be keyed on the shared resource, and that resource is
    the build dir — which `_prepare_persistent_project_dir` keys on
    (idf_target, variant), NOT on the FQBN. Several FQBNs map to one variant:
    arduino-esp32's boards.txt gives both `esp32` and `esp32cam`
    `build.variant=esp32`, so they land in the SAME directory.

    Keying the lock on the FQBN therefore left the two of them free to run at
    once inside one build dir. Measured: compiling `esp32:esp32:esp32` and
    `esp32:esp32:esp32cam` concurrently returned BYTE-IDENTICAL firmware (same
    sha256, 285504 bytes) and the esp32cam request got the other sketch's
    binary — its serial printed the other example's output. In the app that
    looked like an example running someone else's program: two gallery tabs
    open, and the second one shows the first one's log and does nothing.

    Falls back to the raw FQBN if the compiler cannot resolve the pair, which
    is the previous behaviour and never less strict than it needs to be for a
    board whose variant we could not read.
    """
    # Only the ESP-IDF lane HAS a shared build dir (the predicate is the same
    # one _run_compile routes on). An AVR / RP2040 / STM32 FQBN has no IDF
    # target at all, and _idf_target defaults unknown boards to 'esp32' — so
    # every non-ESP32 board used to collapse onto the `esp32::esp32` key and
    # queue behind unrelated ESP32 builds for no reason.
    if not board_fqbn.startswith("esp32:"):
        return board_fqbn
    try:
        target = espidf_compiler._idf_target(board_fqbn)
        variant = espidf_compiler._arduino_variant(board_fqbn, target)
        return f"{target}::{variant}"
    except Exception:  # noqa: BLE001 - identity is best-effort; FQBN is a safe fallback
        return board_fqbn


def _target_lock(board_fqbn: str) -> asyncio.Lock:
    """Lazy-initialised lock so concurrent compiles that SHARE A BUILD DIR
    serialise. Boards with genuinely different build dirs still run in
    parallel up to the semaphore cap."""
    key = _build_identity(board_fqbn)
    lock = _TARGET_LOCKS.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _TARGET_LOCKS[key] = lock
    return lock


# ── Progress + duration estimation ───────────────────────────────────────────
# A spinner does not tell anyone whether to wait 8 seconds or 4 minutes, and a
# cold ESP-IDF build looks identical to a hung one. Two sources feed the bar the
# frontend draws:
#
#   1. REAL progress, when the build emits it. ninja prefixes every action with
#      `[done/total]`, which is an exact fraction of the work left. Nothing
#      guesses while that number is available.
#   2. A time estimate for the rest — arduino-cli prints no counter at all, and
#      even a ninja build has a silent cmake phase before the first action.
#      `_DURATION_EMA` learns the real duration per build identity as builds
#      complete, so the estimate is this server's actual numbers rather than a
#      constant, from the second build of a given target onwards.

_NINJA_PROGRESS_RE = re.compile(r"^\s*\[(\d+)/(\d+)\]")

# Seed estimates, in seconds, until the EMA has seen a real build. Deliberately
# on the pessimistic side: a bar that arrives early reads as fast, one that
# stalls at 99% reads as broken.
_SEED_ESTIMATE_S = {"heavy": 150.0, "light": 20.0}

# Weight of the newest sample. High enough to follow a cache going cold within
# a couple of builds, low enough that one outlier does not move the bar.
_EMA_ALPHA = 0.3

_DURATION_EMA: dict[str, float] = {}


def _estimate_key(lane: str, board_fqbn: str) -> str:
    return f"{lane}:{_build_identity(board_fqbn)}"


def _estimated_seconds(lane: str, board_fqbn: str) -> float:
    return _DURATION_EMA.get(
        _estimate_key(lane, board_fqbn), _SEED_ESTIMATE_S.get(lane, 60.0)
    )


def _record_duration(lane: str, board_fqbn: str, seconds: float) -> None:
    """Fold one completed build's wall time into the running estimate.

    Only the BUILD is measured — queue time is excluded by the caller, or a
    busy hour would teach the estimator that this target takes ten minutes and
    leave the bar crawling once the queue drains.
    """
    if seconds <= 0 or seconds > 3600:
        return
    key = _estimate_key(lane, board_fqbn)
    prev = _DURATION_EMA.get(key)
    _DURATION_EMA[key] = seconds if prev is None else (
        _EMA_ALPHA * seconds + (1 - _EMA_ALPHA) * prev
    )


def _scan_progress(line: str, job: dict[str, Any]) -> None:
    """Update a job's `progress` / `stage` from one line of build output.

    Cheap enough to run per line: one regex against the head of the string,
    then a few substring checks on the phase keywords.
    """
    match = _NINJA_PROGRESS_RE.match(line)
    if match:
        done, total = int(match.group(1)), int(match.group(2))
        if total <= 0:
            return
        # An ESP-IDF build runs NESTED ninjas: the bootloader is its own
        # ExternalProject with its own small counter, so a raw reading goes
        # [480/500] -> [3/40] and the bar visibly collapses mid-build. Track
        # the largest total seen and ignore counters from a much smaller run —
        # those belong to a sub-project, not to the work the user is waiting on.
        biggest = int(job.get("progress_total", 0))
        if total >= biggest:
            job["progress_total"] = total
        elif total * 4 < biggest:
            return
        # Held below 1.0 — ninja hits [512/512] well before esptool has
        # produced the image the user is actually waiting for.
        fraction = min(0.97, done / total)
        # Never walk backwards: a bar that retreats reads as a bug even when
        # the underlying number is honest.
        job["progress"] = max(float(job.get("progress") or 0.0), fraction)
        job["stage"] = "compiling"
        return
    lowered = line.lower()
    if "linking" in lowered:
        job["stage"] = "linking"
    elif "esptool" in lowered or "creating esp32" in lowered:
        # Deliberately NOT keying on bare "generating": cmake's configure phase
        # prints "Generating done" minutes before any compilation, and the
        # first live ESP32 probe (2026-09-01) showed the card saying
        # "packaging" while cmake was still configuring.
        job["stage"] = "packaging"


def _job_progress(job: dict[str, Any]) -> tuple[float | None, float | None]:
    """(progress 0..1, estimated total seconds) for a status response.

    Returns the measured fraction when the build reported one, otherwise an
    elapsed/estimate ratio capped short of full. A queued job has neither — it
    has not started, and pretending otherwise would show a bar that moves while
    nothing is happening.
    """
    if job.get("state") in ("done", "error"):
        return 1.0, None
    if job.get("stage") == "queued":
        return None, None
    estimate = job.get("estimate_s")
    measured = job.get("progress")
    if measured is not None:
        return float(measured), estimate
    run_started = job.get("run_started_at")
    if run_started is None or not estimate:
        return None, estimate
    elapsed = max(0.0, time.time() - run_started)
    # Asymptotic tail: an overrunning build keeps creeping instead of parking
    # at the cap, so the bar never looks frozen on a slower-than-usual run.
    ratio = elapsed / float(estimate)
    return (min(0.9, ratio) if ratio < 0.9 else 0.9 + 0.09 * (1 - 1 / (1 + ratio - 0.9))), estimate


def _job_display_fields(job_id: str) -> dict[str, Any]:
    """The per-job labels that must survive a wholesale COMPILE_JOBS rewrite.

    `_compile_job` replaces the whole job dict on completion (simpler than
    patching six keys under a race), which used to drop the queue metadata with
    it — a finished build then reported the wrong tier to a late poll.
    """
    job = COMPILE_JOBS.get(job_id) or {}
    return {
        key: job[key]
        for key in ("tier", "priority", "lane", "estimate_s", "run_started_at")
        if key in job
    }


async def _resolve_queue_priority(user_id: str | None) -> tuple[int, str]:
    """(priority, display tier) for a compile. OSS default: everyone equal.

    The tier string only ever reaches the client as a label ('pro' shows a
    priority badge, 'free' shows the upgrade line). 'local' means no plan
    vocabulary applies — a self-hosted OSS build — and the UI shows neither.
    """
    info = await compile_priority(user_id)
    if not isinstance(info, dict):
        return build_queue.PRIORITY_STANDARD, "local"
    try:
        priority = int(info.get("priority", build_queue.PRIORITY_STANDARD))
    except (TypeError, ValueError):
        priority = build_queue.PRIORITY_STANDARD
    tier = str(info.get("tier") or "standard")
    return priority, tier


def _job_key(
    files: list[dict[str, str]],
    board_fqbn: str,
    board_options: dict | None = None,
    spiffs_files: list[dict] | None = None,
    libraries: list[str] | None = None,
    owner_id: str | None = None,
    language: str | None = None,
    custom_wifi_ssids: list[str] | None = None,
) -> str:
    """Stable content hash of (files, board, options, spiffs, libraries, owner)
    used as the deduplication key.

    Excludes project_id (analytics-only — different projects with identical
    code should still dedup to one build). File order is normalised so the
    same set of files in any order produces the same key. Board options
    and SPIFFS files are included so a partition / scheme / file change
    queues a fresh build rather than serving the previous cached job.

    `owner_id` is folded in ONLY when a manifest is present (P2.1f/P2.2): a
    manifest may reference a per-OWNER custom library, so two different owners
    with byte-identical sketch + board + manifest can resolve DIFFERENT library
    bytes and must not dedup to one another's build. Index-only / no-manifest
    compiles pass owner_id=None and keep cross-owner dedup (the cache is shared,
    so the build is owner-independent).
    """
    h = hashlib.sha256()
    # Bind every key to the code that generates build flags: a binary cached
    # before a sdkconfig change must not be served after it.
    h.update(_TOOLCHAIN_EPOCH.encode())
    h.update(b"\0")
    h.update(board_fqbn.encode())
    h.update(b"\0")
    for f in sorted(files, key=lambda x: x["name"]):
        h.update(f["name"].encode())
        h.update(b"\0")
        h.update(f["content"].encode())
        h.update(b"\0")
    if board_options:
        # Sort keys so option-order doesn't perturb the hash.
        import json
        h.update(json.dumps(board_options, sort_keys=True).encode())
        h.update(b"\0")
    if custom_wifi_ssids:
        # Custom APs suppress the SSID rewrite, so the same source builds
        # DIFFERENT bytes with vs without them — the key must see it. Only
        # presence matters for the rewrite, but hash the sorted list so a
        # rename also invalidates cleanly.
        for ssid in sorted(custom_wifi_ssids):
            h.update(ssid.encode())
            h.update(b"\0")
        h.update(b"\0custom-aps\0")
    if spiffs_files:
        for f in sorted(spiffs_files, key=lambda x: x["name"]):
            h.update(f["name"].encode())
            h.update(b"\0")
            h.update(f["content_b64"].encode())
            h.update(b"\0")
    if libraries:
        # Manifest changes the resolved library set → different binary, so it
        # must not dedup to a job built with a different manifest.
        for name in sorted(libraries):
            h.update(name.encode())
            h.update(b"\0")
    if owner_id:
        # Per-owner custom-lib disambiguation (see docstring). Only set when a
        # manifest is present, so it never perturbs the owner-independent
        # index-only case.
        h.update(b"owner:")
        h.update(owner_id.encode())
        h.update(b"\0")
    if language and language != "arduino":
        # Pure ESP-IDF mode produces a different binary from the same bytes —
        # never dedup across language modes. Guarded so 'arduino' (explicit or
        # omitted) keeps the historical key.
        h.update(b"lang:")
        h.update(language.encode())
        h.update(b"\0")
    return h.hexdigest()


def _purge_expired_jobs() -> None:
    """Drop completed jobs older than JOB_TTL_S so the dict doesn't grow
    forever. Also evicts the matching JOB_BY_KEY entry so the next request
    with the same content schedules a fresh build instead of dedupping to
    a stale job_id."""
    now = time.time()
    stale = [
        jid for jid, job in COMPILE_JOBS.items()
        if job.get("state") in ("done", "error")
        and now - job.get("finished_at", now) > JOB_TTL_S
    ]
    for jid in stale:
        job = COMPILE_JOBS.pop(jid, None)
        if job is not None:
            key = job.get("key")
            # Only remove the JOB_BY_KEY entry if it still points at this job —
            # a newer job with the same key may have replaced it after this one
            # finished but before TTL elapsed.
            if key and JOB_BY_KEY.get(key) == jid:
                JOB_BY_KEY.pop(key, None)


class SketchFile(BaseModel):
    name: str
    content: str


class SpiffsFileBody(BaseModel):
    """One file destined for the SPIFFS partition image, base64-encoded."""
    name: str
    content_b64: str


class CompileRequest(BaseModel):
    # New multi-file API
    files: list[SketchFile] | None = None
    # Legacy single-file API (kept for backward compat)
    code: str | None = None
    board_fqbn: str = "arduino:avr:uno"
    # Optional: associate this compile with a project for analytics
    project_id: str | None = None
    # Optional: the editor's BoardKind (e.g. 'badger-2350'). Purely for
    # analytics — several distinct boards can share one FQBN (the Pimoroni
    # RP2350 boards all compile as rpipico2), and only the kind can tell
    # them apart. Rides into the metric hook's `extra`.
    board_kind: str | None = None
    # Optional: gallery example the workspace was loaded from. Analytics
    # only ("which examples get compiled most"); rides in `extra` too.
    example_id: str | None = None
    # Per-board ESP32 build options (Partition Scheme, CPU Freq, Flash Mode,
    # PSRAM, etc.). Loose dict so the frontend can add fields without a
    # backend deploy — espidf_compiler.compile validates known keys and
    # ignores the rest. None / missing on non-ESP32 boards.
    board_options: dict[str, str | int | bool] | None = None
    # Optional: the SSIDs of the project's custom WiFi access points (the
    # velxio-wifi-ap parts on the canvas, overlay feature). When non-empty
    # the compiler does NOT rewrite the sketch's SSID literals — the project
    # defines its own airspace, so what the user typed is what exists. Empty
    # / missing keeps the legacy behavior (rewrite to the built-in networks).
    custom_wifi_ssids: list[str] | None = None
    # User-uploaded files to bake into the SPIFFS partition (#162). Empty /
    # None means the SPIFFS region stays blank (current behaviour).
    spiffs_files: list[SpiffsFileBody] | None = None
    # P2 — project library manifest (declared library names). When provided,
    # ESP-IDF library resolution is SCOPED to this set: a user-installed lib is
    # merged only if it's declared here, so a sketch never picks up an unrelated
    # library from the shared dir. None / omitted = legacy scan-all (unchanged).
    libraries: list[str] | None = None
    # Pure ESP-IDF language mode (issue #139). 'espidf' compiles the files as
    # a pure ESP-IDF project: the user provides app_main() and IDF APIs, and
    # the arduino-esp32 component is left out of the build entirely. None /
    # 'arduino' = classic Arduino sketch compile. ESP32 boards only.
    language: str | None = None
    # Who triggered this compile: None/'user' = manual UI action,
    # 'agent' = the AI assistant's compile_sketch tool. Metrics overlays
    # use it to keep agent activity distinguishable from the user's own.
    initiated_by: str | None = None


class CompileResponse(BaseModel):
    success: bool
    hex_content: str | None = None
    binary_content: str | None = None  # base64-encoded .bin for RP2040
    binary_type: str | None = None     # 'bin' or 'uf2'
    has_wifi: bool = False             # True when sketch uses WiFi (ESP32 only)
    stdout: str
    stderr: str
    error: str | None = None
    core_install_log: str | None = None
    # P2 — set when a manifest-scoped compile only succeeded after the
    # scan-all fallback (i.e. the manifest is missing a dependency). The
    # suggested map is {header: [candidate library names]} so the manifest
    # can be auto-completed (P2.4) or the user prompted to add the lib.
    manifest_incomplete: bool = False
    manifest_suggested_libraries: dict | None = None


def _classify_compile_error(stderr: str, error: str | None) -> str:
    """Map raw compiler output to a stable error_kind for analytics."""
    haystack = f"{error or ''}\n{stderr or ''}".lower()
    if "no such file or directory" in haystack or "fatal error:" in haystack:
        return "missing_library"
    if "core install" in haystack or "failed to install" in haystack:
        return "core_install_failed"
    if "undefined reference" in haystack:
        return "linker_error"
    if "expected" in haystack and "before" in haystack:
        return "syntax_error"
    if "error:" in haystack:
        return "compile_error"
    return "unknown"


def _resolve_files(request: CompileRequest) -> list[dict[str, str]]:
    """Normalise the multi-file vs legacy single-file request bodies."""
    if request.files:
        return [{"name": f.name, "content": f.content} for f in request.files]
    if request.code is not None:
        return [{"name": "sketch.ino", "content": request.code}]
    raise HTTPException(
        status_code=422,
        detail="Provide either 'files' or 'code' in the request body.",
    )


def _bare_lib_names(names) -> set[str] | None:
    """Strip a trailing @version (or @wokwi:hash) from each manifest name and
    drop empties. None if nothing remains. See _resolve_compile_scope (P2.1h)."""
    out = {n.split("@", 1)[0].strip() for n in names if n and n.split("@", 1)[0].strip()}
    return out or None


async def _resolve_compile_scope(
    request: CompileRequest, requester_id: str | None
) -> tuple[set[str] | None, str | None]:
    """Resolve the per-compile library SCOPE + owner. Used identically by the
    actual build (_run_compile) AND the async dedup key (compile_start) so the
    two can never diverge — a divergence would let one owner be served another's
    in-flight binary, or rebuild needlessly.

    Manifest = resolution SCOPE for BOTH compile paths (ESP-IDF and arduino-cli /
    AVR / RP2040 / ATtiny). Manifests are PER-BOARD (each board carries its own
    velxio.json); the client sends the COMPILING board's manifest in
    request.libraries, so it takes precedence (two boards in one project can
    scope to different libraries). Fall back to the project-level manifest (read
    server-side) only when the client sends none — an anonymous compile or an old
    client. None/empty → legacy scan-all.

    Owner = whose per-user custom libraries the manifest may reference: the
    project OWNER for a saved project (so a shared/embed compile finds that
    owner's libs) — but ONLY when the requester is the owner or the project is
    shareable (public/unlisted), so a private project's custom libs are never
    reachable by another user (resolve_compile_owner enforces this gate). Falls
    back to the REQUESTER for an unsaved / private-non-owner / anon compile (the
    libs they just uploaded are their own).
    """
    # Resolve the visibility-gated owner FIRST: a non-None result means the
    # requester may read THIS project's server-side state (it is their own, or
    # public/unlisted). That same gate decides whether the saved-project manifest
    # may be honored — so a PRIVATE project's declared library NAMES are never
    # exposed to a non-owner via the server-side fallback (symmetry with the
    # owner-bytes gate; P2.2-sec).
    gated_owner = await resolve_compile_owner(request.project_id, requester_id)

    # P2.1h: strip a trailing @version from each manifest name. norm_name fuses
    # the version digits into the name otherwise ("ArduinoJson@6.21.5" ->
    # "arduinojson6215"), which misses the cache entry ("arduinojson") and forces
    # a global-dir scan-all. The per-board manifest (boards_json[].libraries,
    # which the client sends in request.libraries) is the path that still carries
    # @version. We don't version-pin today, so the bare name is what resolves.
    allowed_libraries: set[str] | None = None
    if request.libraries:
        allowed_libraries = _bare_lib_names(request.libraries)
    elif gated_owner is not None:
        project_libs = await get_project_libraries(request.project_id)
        if project_libs:
            allowed_libraries = _bare_lib_names(project_libs)

    owner_id = gated_owner if gated_owner is not None else requester_id
    return allowed_libraries, owner_id


async def _run_compile(
    request: CompileRequest,
    files: list[dict[str, str]],
    progress_callback: Any = None,
    requester_id: str | None = None,
    scope: tuple[set[str] | None, str | None] | None = None,
) -> CompileResponse:
    """Do the actual compile (ESP-IDF for esp32:*, arduino-cli otherwise).

    `progress_callback`, if provided, receives every stdout/stderr line as
    cmake + ninja run. Wired into the async compile path so the live build
    output is exposed via /api/compile/status/{job_id}'s `stdout` field.
    AVR / RP2040 builds via arduino-cli don't surface progress yet — those
    typically finish in seconds anyway.

    `scope` is the pre-resolved (allowed_libraries, owner_id) from the async
    path — passed so the build uses the SAME values the dedup key was built
    from (no re-resolution, no divergence). The sync path passes None → we
    resolve it here.
    """
    if scope is None:
        allowed_libraries, owner_id = await _resolve_compile_scope(request, requester_id)
    else:
        allowed_libraries, owner_id = scope

    pure_idf = request.language == "espidf"
    if pure_idf and not request.board_fqbn.startswith("esp32:"):
        return CompileResponse(
            success=False,
            stdout="",
            stderr="",
            error="ESP-IDF language mode is only supported on ESP32 boards.",
        )
    if pure_idf and not espidf_compiler.available:
        return CompileResponse(
            success=False,
            stdout="",
            stderr="",
            error="ESP-IDF toolchain is not available on this server.",
        )

    if request.board_fqbn.startswith("esp32:") and espidf_compiler.available:
        logger.info(
            f"[compile] Using ESP-IDF for {request.board_fqbn}"
            + (" (pure ESP-IDF mode)" if pure_idf else "")
        )
        spiffs_dicts = (
            [f.model_dump() for f in request.spiffs_files]
            if request.spiffs_files else None
        )
        result = await espidf_compiler.compile(
            files, request.board_fqbn,
            progress_callback=progress_callback,
            board_options=request.board_options,
            spiffs_files=spiffs_dicts,
            allowed_libraries=allowed_libraries,
            owner_id=owner_id,
            pure_idf=pure_idf,
            custom_wifi_ssids=request.custom_wifi_ssids,
        )
        return CompileResponse(
            success=result["success"],
            hex_content=result.get("hex_content"),
            binary_content=result.get("binary_content"),
            binary_type=result.get("binary_type"),
            has_wifi=result.get("has_wifi", False),
            stdout=result.get("stdout", ""),
            stderr=result.get("stderr", ""),
            error=result.get("error"),
            manifest_incomplete=result.get("manifest_incomplete", False),
            manifest_suggested_libraries=result.get("manifest_suggested_libraries"),
        )

    # AVR, RP2040, and ESP32 fallback: use arduino-cli
    core_status = await arduino_cli.ensure_core_for_board(request.board_fqbn)
    core_log = core_status.get("log", "")
    if core_status.get("needed") and not core_status.get("installed"):
        return CompileResponse(
            success=False,
            stdout="",
            stderr=core_log,
            error=f"Failed to install required core: {core_status.get('core_id')}",
        )

    # AVR / RP2040 / ATTiny path. `board_options` is accepted for API
    # symmetry but currently ignored — those toolchains don't expose the
    # ESP32 partition / PSRAM knobs we're surfacing. P2.1f: the manifest scope
    # + owner now flow through so arduino-cli reads the content-addressed cache
    # (via a scoped ARDUINO_DIRECTORIES_USER sketchbook) instead of the shared
    # global volume.
    result = await arduino_cli.compile(
        files, request.board_fqbn, board_options=request.board_options,
        allowed_libraries=allowed_libraries, owner_id=owner_id,
    )
    return CompileResponse(
        success=result["success"],
        hex_content=result.get("hex_content"),
        binary_content=result.get("binary_content"),
        binary_type=result.get("binary_type"),
        stdout=result.get("stdout", ""),
        stderr=result.get("stderr", ""),
        error=result.get("error"),
        core_install_log=core_log if core_log else None,
        # P2.1f: set when the scoped compile missed a header and recovered via a
        # scan-all retry — signals the project's velxio.json manifest is
        # incomplete (a needed / transitive lib not declared).
        manifest_incomplete=result.get("manifest_incomplete", False),
    )


async def _record_async_metric(
    *,
    user_id: str | None,
    project_id: str | None,
    board_fqbn: str,
    success: bool,
    duration_ms: int,
    error_kind: str | None,
    extra: dict[str, Any],
) -> None:
    """Forward a background-task compile metric to the registered hook.

    Wrapper kept for the async path's signature symmetry with the sync path.
    The hook owns its own DB session (the request-scoped one is gone by now)
    and request=None means country/IP tagging is dropped — only user_id and
    timing flow through.
    """
    await record_compile(
        user_id=user_id,
        project_id=project_id,
        board_fqbn=board_fqbn,
        success=success,
        duration_ms=duration_ms,
        error_kind=error_kind,
        extra=extra,
        request=None,
    )


async def _compile_job(
    job_id: str,
    request: CompileRequest,
    files: list[dict[str, str]],
    user_id: str | None,
    scope: tuple[set[str] | None, str | None] | None = None,
    priority: int = build_queue.PRIORITY_STANDARD,
) -> None:
    """Background worker: acquire a build slot + per-target lock, run the
    compile, store result in COMPILE_JOBS.

    `scope` is the (allowed_libraries, owner_id) already resolved by
    compile_start for the dedup key — threaded through so the build uses the
    exact same scope the key was computed from (no second resolution that could
    disagree under a transient owner-lookup failure).

    `priority` decides where this job sits in its lane's queue (lower runs
    first); it comes from the plan resolved at /compile/start.

    `state=pending` while waiting on either gate; transitions to `running`
    only once the actual build is about to start, so clients polling
    /compile/status see an accurate snapshot of where their job is. The finer
    `stage` field distinguishes "queued behind other builds" from "the build
    is running but has not printed anything yet".

    Live build output is appended to COMPILE_JOBS[job_id]['stdout_buffer']
    line-by-line as cmake + ninja emit it, so /compile/status responses
    stream a growing log instead of returning everything at the end.
    """
    started = time.monotonic()
    job = COMPILE_JOBS[job_id]
    started_at = job["started_at"]
    job_key = job.get("key")

    # Live stdout buffer — written from a worker thread (espidf_compiler
    # drain threads). dict[str].update with a single str assignment is GIL-
    # protected so we don't need an explicit lock; the polling endpoint
    # reads the same field.
    COMPILE_JOBS[job_id]["stdout_buffer"] = ""

    def on_progress_line(line: str) -> None:
        # Cap buffer at 256 KB so a runaway build can't OOM the process.
        # Keep the tail (most recent output) — that's what the user wants
        # to see anyway.
        current = COMPILE_JOBS.get(job_id)
        if current is None:
            return
        new = (current.get("stdout_buffer", "") or "") + line
        if len(new) > 262_144:
            new = new[-262_144:]
        current["stdout_buffer"] = new
        _scan_progress(line, current)

    heavy = _is_heavy_compile(request.board_fqbn)
    lane_name = "heavy" if heavy else "light"
    lane = build_queue.lane_for(heavy)
    build_started = started

    def on_queued() -> None:
        # Tell the user WHY nothing is happening yet. Deliberately says
        # nothing about how many builds are ahead: a queue depth is worse
        # than no number at all, and it publishes how busy the service is.
        current = COMPILE_JOBS.get(job_id)
        if current is not None:
            current["stage"] = "queued"
        on_progress_line(
            "[queue] Waiting for a free build slot — your build starts "
            "automatically, and is never dropped.\n"
        )

    try:
        async with lane.slot(priority=priority, key=job_id, on_queued=on_queued):
            async with _target_lock(request.board_fqbn):
                # Job may have been purged or replaced while we were queued.
                # Re-fetch and bail out if so.
                if COMPILE_JOBS.get(job_id) is None:
                    logger.info(f"[compile] job {job_id} purged before run; skipping")
                    return
                COMPILE_JOBS[job_id]["state"] = "running"
                COMPILE_JOBS[job_id]["stage"] = "preparing"
                # Progress and ETA are measured from HERE, not from the moment
                # the job was queued — otherwise every build that waited would
                # render as already half-finished the instant it starts.
                COMPILE_JOBS[job_id]["run_started_at"] = time.time()
                COMPILE_JOBS[job_id]["estimate_s"] = _estimated_seconds(
                    lane_name, request.board_fqbn
                )
                build_started = time.monotonic()
                response = await _run_compile(
                    request, files, progress_callback=on_progress_line,
                    requester_id=user_id, scope=scope,
                )
        if response.success:
            _record_duration(
                lane_name, request.board_fqbn, time.monotonic() - build_started
            )
        COMPILE_JOBS[job_id] = {
            **_job_display_fields(job_id),
            "state": "done",
            "stage": "done",
            "started_at": started_at,
            "finished_at": time.time(),
            "result": response.model_dump(),
            "key": job_key,
            # Preserve the streamed buffer post-completion so a late poll
            # still has access to the live log (clients usually display
            # result.stdout once state=done, but having both costs nothing).
            "stdout_buffer": COMPILE_JOBS.get(job_id, {}).get("stdout_buffer", ""),
        }
        if job_key:
            _artifact_store(job_key, response.model_dump())
        error_kind = (
            None if response.success
            else _classify_compile_error(response.stderr, response.error)
        )
        await _record_async_metric(
            user_id=user_id,
            project_id=request.project_id,
            board_fqbn=request.board_fqbn,
            success=response.success,
            duration_ms=int((time.monotonic() - started) * 1000),
            error_kind=error_kind,
            extra={
                "file_count": len(files),
                "has_wifi": response.has_wifi,
                "async": True,
                "initiated_by": request.initiated_by,
                "board_kind": request.board_kind,
                "example_id": request.example_id,
                "partition_scheme": (request.board_options or {}).get("partitionScheme"),
                "spiffs_file_count": len(request.spiffs_files or []),
                # duration_ms is queue + build, which it always was (the old
                # semaphore wait counted too). Splitting the wait out is what
                # tells the operator whether a slow week means slow builds or a
                # deep queue — i.e. whether to buy CPU or raise the lane caps.
                "queue_ms": int((build_started - started) * 1000),
                "lane": lane_name,
                "priority": priority,
            },
        )
    except Exception as exc:
        logger.exception(f"[compile] async job {job_id} failed")
        COMPILE_JOBS[job_id] = {
            **_job_display_fields(job_id),
            "state": "error",
            "stage": "done",
            "started_at": started_at,
            "finished_at": time.time(),
            "error": str(exc)[:500],
            "key": job_key,
            "stdout_buffer": COMPILE_JOBS.get(job_id, {}).get("stdout_buffer", ""),
        }
        await _record_async_metric(
            user_id=user_id,
            project_id=request.project_id,
            board_fqbn=request.board_fqbn,
            success=False,
            duration_ms=int((time.monotonic() - started) * 1000),
            error_kind="exception",
            extra={"file_count": len(files), "exception": str(exc)[:200], "async": True, "initiated_by": request.initiated_by, "board_kind": request.board_kind, "example_id": request.example_id},
        )


@router.post("/", response_model=CompileResponse)
async def compile_sketch(
    request: CompileRequest,
    http_request: Request,
    user_id: str | None = Depends(get_current_user_id),
):
    """
    Compile Arduino sketch and return hex/binary in a single response.

    Synchronous path: held open until the build finishes. Works for AVR /
    RP2040 builds (seconds), but ESP-IDF cold builds can run 5-7 minutes
    and will hit Cloudflare's 100s edge timeout (HTTP 524). Use the async
    path (`/compile/start` + `/compile/status/{job_id}`) for those.

    Accepts either `files` (multi-file) or legacy `code` (single file).
    Auto-installs the required board core if not present.
    """
    files = _resolve_files(request)
    started = time.monotonic()

    priority, _tier = await _resolve_queue_priority(user_id)
    lane = build_queue.lane_for(_is_heavy_compile(request.board_fqbn))

    async def _gated_compile() -> CompileResponse:
        # This path used to call _run_compile directly — no build slot and, far
        # worse, no per-target lock, so a sync compile could run inside the
        # same persistent ESP-IDF build dir as an async one and hand back the
        # other sketch's firmware (the failure _build_identity documents). It
        # also meant an API caller bypassed the queue entirely while everyone
        # in the editor waited.
        async with lane.slot(priority=priority):
            async with _target_lock(request.board_fqbn):
                return await _run_compile(request, files, requester_id=user_id)

    try:
        # Shielded: when the client (or a proxy timeout - nginx 504s a cold
        # ESP-IDF build well before it finishes) drops the connection,
        # Starlette cancels this handler. Without the shield the cancellation
        # killed the build subprocess MID-WRITE and left truncated .obj files
        # in the persistent per-target build cache, poisoning every LATER
        # build of that target ("ranlib: file truncated", seen twice on
        # staging the day the P4 lane landed). The shield lets the build run
        # to completion and keep the cache consistent; only the response is
        # lost.
        #
        # The shield covers the queue wait too. Dropping the slot on
        # disconnect and letting the shielded build run on would put a build
        # outside the concurrency cap — the one thing the lane exists to
        # prevent, so the whole gated coroutine is shielded together.
        #
        # The cost is real and worth naming: this path neither reads nor writes
        # the artifact cache (only the async job path does), so a request
        # abandoned while queued still consumes a slot for a build whose result
        # nobody receives and nothing caches. Acceptable because the sync
        # endpoint is the API/legacy path — the editor uses /compile/start —
        # and a corrupted shared build dir is far worse than a wasted slot.
        response = await asyncio.shield(asyncio.ensure_future(_gated_compile()))
    except Exception as e:
        await record_compile(
            user_id=user_id,
            project_id=request.project_id,
            board_fqbn=request.board_fqbn,
            success=False,
            duration_ms=int((time.monotonic() - started) * 1000),
            error_kind="exception",
            extra={"file_count": len(files), "exception": str(e)[:200], "initiated_by": request.initiated_by, "board_kind": request.board_kind, "example_id": request.example_id},
            request=http_request,
        )
        raise HTTPException(status_code=500, detail=str(e))

    duration_ms = int((time.monotonic() - started) * 1000)
    await record_compile(
        user_id=user_id,
        project_id=request.project_id,
        board_fqbn=request.board_fqbn,
        success=response.success,
        duration_ms=duration_ms,
        error_kind=None if response.success else _classify_compile_error(response.stderr, response.error),
        extra={
            "file_count": len(files),
            "has_wifi": response.has_wifi,
            "initiated_by": request.initiated_by,
                "board_kind": request.board_kind,
                "example_id": request.example_id,
            "partition_scheme": (request.board_options or {}).get("partitionScheme"),
            "spiffs_file_count": len(request.spiffs_files or []),
        },
        request=http_request,
    )
    return response


class CompileStartResponse(BaseModel):
    job_id: str


class CompileStatusResponse(BaseModel):
    state: str  # 'pending' | 'running' | 'done' | 'error'
    started_at: float
    finished_at: float | None = None
    # Live build output. Grows line-by-line during state=running so the
    # frontend can stream it into the compilation console instead of
    # waiting for everything to land at the end. Capped at 256 KB
    # (most recent tail kept).
    stdout: str = ""
    result: CompileResponse | None = None
    error: str | None = None

    # ── Queue + progress telemetry (drives the compile overlay) ──────────
    # What this job is doing right now, finer than `state`:
    #   queued     — waiting for a build slot (nothing is running yet)
    #   preparing  — has a slot; cmake / core setup, no output yet
    #   compiling  — actions are running (ninja is reporting a fraction)
    #   linking / packaging — the tail end of the build
    #   done       — finished, successfully or not
    stage: str = "preparing"
    # 0..1, or null when there is nothing honest to draw (a queued job).
    # Measured from ninja's [done/total] where available, estimated from this
    # server's own recent build times otherwise.
    progress: float | None = None
    # What the estimate above is based on, in seconds. Null while queued.
    estimated_seconds: float | None = None
    # Seconds this job has been BUILDING (excludes queue time), so the timer
    # on screen matches the bar next to it.
    build_seconds: float = 0.0
    # Coarse build-server pressure: 'low' | 'moderate' | 'high' | 'peak'.
    # Deliberately a bucket, never a count: queue depth and position stay
    # server-side (see app/services/build_queue.py).
    server_load: str = "low"
    # Display label for the requester's plan — 'local' (self-hosted OSS, no
    # plan vocabulary), 'anonymous', 'free', 'maker', 'pro'. The UI uses it to
    # choose between a priority badge and an upgrade line; it grants nothing.
    tier: str = "local"
    # Whether this job was admitted ahead of standard builds.
    priority: bool = False


@router.post("/start", response_model=CompileStartResponse)
async def compile_start(
    request: CompileRequest,
    user_id: str | None = Depends(get_current_user_id),
):
    """
    Queue a compile and return a `job_id` immediately.

    The actual compile runs in a background task; clients then poll
    `GET /compile/status/{job_id}` every couple of seconds until state is
    `done` or `error`. This sidesteps Cloudflare's 100s HTTP edge timeout —
    each individual request returns in milliseconds.

    Deduplication: identical (files, board_fqbn) submissions while a
    matching job is still pending or running return the existing job_id
    instead of spawning a new build. Prevents the "user clicks compile six
    times → six concurrent ninja processes peeling each other apart"
    failure mode.
    """
    files = _resolve_files(request)
    _purge_expired_jobs()

    spiffs_dicts = (
        [f.model_dump() for f in request.spiffs_files] if request.spiffs_files else None
    )
    # Resolve the EXACT scope the build will use (client manifest else the
    # server-side project manifest; owner else requester) — the SAME helper
    # _run_compile uses — and fold it into the dedup key so the key matches the
    # bytes the build actually produces. The resolved set + owner (owner only
    # when a manifest applies, to preserve owner-independent dedup for index-
    # only / no-manifest compiles) is then threaded into the job so the build
    # never re-resolves and the two can't diverge.
    # Where this build sits in the queue. Resolved once, here, so a single
    # plan lookup covers the whole job and the tier the UI displays is the
    # same one the queue actually ordered on.
    priority, tier = await _resolve_queue_priority(user_id)
    heavy = _is_heavy_compile(request.board_fqbn)
    queue_fields = {
        "tier": tier,
        "priority": priority,
        "lane": "heavy" if heavy else "light",
    }

    allowed_libraries, owner_id = await _resolve_compile_scope(request, user_id)
    key = _job_key(
        files, request.board_fqbn, request.board_options, spiffs_dicts,
        sorted(allowed_libraries) if allowed_libraries else None,
        owner_id if allowed_libraries else None,
        language=request.language,
        custom_wifi_ssids=request.custom_wifi_ssids,
    )
    existing_id = JOB_BY_KEY.get(key)
    if existing_id is not None:
        existing = COMPILE_JOBS.get(existing_id)
        if existing is not None and existing.get("state") in ("pending", "running"):
            # Two users submitting byte-identical sources for the same board
            # share ONE build. The job keeps whoever asked first, which used to
            # mean a pro user landing on a queued anonymous build of a popular
            # gallery example waited at standard priority AND was shown the
            # anonymous tier (upgrade prompt and all). Lift the shared job to
            # the better entitlement instead — it never demotes, so the first
            # submitter cannot lose ground either.
            if priority < int(existing.get("priority", build_queue.PRIORITY_STANDARD)):
                existing["priority"] = priority
                existing["tier"] = tier
                lane_for_existing = build_queue.lane_for(
                    existing.get("lane") == "heavy"
                )
                lane_for_existing.reprioritize(existing_id, priority)
                logger.info(
                    "[compile] dedup hit — job %s lifted to %s priority",
                    existing_id, tier,
                )
            logger.info(f"[compile] dedup hit — reusing job {existing_id}")
            return CompileStartResponse(job_id=existing_id)

    # Same sources, same flags, already built: hand the stored artifact back as
    # an already-finished job so the client's normal poll loop just sees `done`.
    cached = _artifact_load(key)
    if cached is not None:
        job_id = uuid.uuid4().hex
        now = time.time()
        COMPILE_JOBS[job_id] = {
            **queue_fields,
            "state": "done",
            "stage": "done",
            "started_at": now,
            "finished_at": now,
            "run_started_at": now,
            "result": cached,
            "key": key,
            "stdout_buffer": cached.get("stdout", ""),
        }
        logger.info("[compile] artifact cache hit — skipping the build")
        await _record_async_metric(
            user_id=user_id,
            project_id=request.project_id,
            board_fqbn=request.board_fqbn,
            success=True,
            duration_ms=0,
            error_kind=None,
            extra={
                "file_count": len(files),
                "async": True,
                "cached": True,
                "initiated_by": request.initiated_by,
                "board_kind": request.board_kind,
                "example_id": request.example_id,
            },
        )
        return CompileStartResponse(job_id=job_id)

    job_id = uuid.uuid4().hex
    COMPILE_JOBS[job_id] = {
        **queue_fields,
        "state": "pending",
        # Every job starts as 'queued': the background task has not reached the
        # admission gate yet, and claiming 'preparing' before it does would show
        # a bar for a build that has not started.
        "stage": "queued",
        "started_at": time.time(),
        "key": key,
    }
    JOB_BY_KEY[key] = job_id

    asyncio.create_task(
        _compile_job(
            job_id=job_id,
            request=request,
            files=files,
            user_id=user_id,
            scope=(allowed_libraries, owner_id),
            priority=priority,
        ),
    )
    return CompileStartResponse(job_id=job_id)


@router.get("/status/{job_id}", response_model=CompileStatusResponse)
async def compile_status(job_id: str):
    """Poll the status of an async compile job submitted via /compile/start.

    `stdout` carries live cmake + ninja output captured line-by-line as
    the build runs. Clients should poll every 1-2s and re-render the
    full string each time (or compute a length delta). Once state=done,
    `result.stdout` carries the same content too — both are kept so a
    late-arriving poll always has the log available.
    """
    job = COMPILE_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found or expired")
    progress, estimate = _job_progress(job)
    run_started = job.get("run_started_at")
    finished = job.get("finished_at")
    build_seconds = (
        max(0.0, (finished or time.time()) - run_started) if run_started else 0.0
    )
    return CompileStatusResponse(
        state=job["state"],
        started_at=job["started_at"],
        finished_at=finished,
        stdout=job.get("stdout_buffer", "") or "",
        result=job.get("result"),
        error=job.get("error"),
        stage=job.get("stage", "preparing"),
        progress=progress,
        estimated_seconds=estimate,
        build_seconds=build_seconds,
        server_load=build_queue.load_level(),
        tier=job.get("tier", "local"),
        priority=int(job.get("priority", build_queue.PRIORITY_STANDARD))
        < build_queue.STANDARD_THRESHOLD,
    )


@router.get("/setup-status")
async def setup_status():
    return await arduino_cli.get_setup_status()


@router.post("/ensure-core")
async def ensure_core(request: CompileRequest):
    fqbn = request.board_fqbn
    result = await arduino_cli.ensure_core_for_board(fqbn)
    return result


@router.get("/boards")
async def list_boards():
    boards = await arduino_cli.list_boards()
    return {"boards": boards}
