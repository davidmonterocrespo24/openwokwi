"""Priority admission gate for compile jobs.

The compile route used to gate its two build lanes with a plain
`asyncio.Semaphore`. A semaphore is strictly FIFO and knows nothing about who
is waiting, which left two gaps once velxio.dev started seeing real load:

  1. Every build waited the same amount regardless of plan. Paid users had no
     way to get in front of a queue built out of anonymous gallery clicks.
  2. Nothing could tell the user WHY their build had not started. The route
     could see `semaphore.locked()` and nothing else — not whether this job was
     next, not how loaded the server was.

`BuildQueue` replaces the semaphore with an explicit waiting list ordered by
`(priority, arrival)`. It is deliberately unbounded: a build is never refused
and never dropped, no matter how deep the queue gets. Waiting longer is the
only thing that ever happens to a job.

Anti-starvation
---------------
Strict priority alone can park a free user behind an unbroken stream of paid
builds. Each lane therefore keeps `RESERVED_STANDARD_SLOTS` of its capacity out
of reach of priority jobs *while a standard job is waiting*: priority builds may
occupy at most `capacity - RESERVED_STANDARD_SLOTS` slots, and the remaining
slot admits the longest-waiting standard job. With the default capacities that
is 1 priority + 1 shared on the heavy lane and 2 priority + 1 shared on the
light one. When no standard job is waiting the reservation costs nothing —
priority jobs use the whole lane.

The reservation is skipped for a lane with `capacity < 2`, where holding a slot
back would invert the priority order instead of merely softening it.

Privacy
-------
`load_level()` is the ONLY queue fact this module is meant to reach a client
with, and it is a coarse label. Queue depth, position and waiter counts stay
server-side on purpose: telling a visitor "you are 14th in line" is worse than
telling them nothing, and it leaks how busy (or quiet) the service is.
"""

from __future__ import annotations

import asyncio
import heapq
import itertools
import logging
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import AsyncIterator, Callable, Optional

logger = logging.getLogger(__name__)


# ── Priority ladder ──────────────────────────────────────────────────────────
# LOWER runs first. The gaps leave room for tiers between these without
# renumbering anything that is already persisted in a log line.
PRIORITY_HIGH = 0        # pro / trial / commercial / enterprise
PRIORITY_MEDIUM = 10     # maker / personal
PRIORITY_STANDARD = 20   # free, anonymous, and every OSS build (no overlay)

# A job at or above PRIORITY_STANDARD is "standard" — it is what the reserved
# slot exists for, and it is never the job the reservation holds a slot from.
STANDARD_THRESHOLD = PRIORITY_STANDARD

# Slots per lane that priority jobs may not occupy while a standard job waits.
RESERVED_STANDARD_SLOTS = 1

# How many priority jobs may be admitted back-to-back before a waiting standard
# job takes the next slot. Only binds where the reserved slot cannot: a
# capacity-1 lane (VELXIO_HEAVY_BUILD_SLOTS=1 is a supported setting).
MAX_CONSECUTIVE_PRIORITY = 4


def _env_slots(name: str, default: int) -> int:
    """Read a lane capacity from the environment, clamped to something sane.

    Exposed as env vars so the operator can widen a lane on a bigger box
    (`docker compose up -d`, no image rebuild) the day demand jumps, instead
    of shipping a code change for a capacity number.
    """
    try:
        value = int(os.environ.get(name, "").strip() or default)
    except ValueError:
        logger.warning("[queue] %s is not an integer; using %d", name, default)
        return default
    return max(1, min(64, value))


@dataclass
class _Waiter:
    priority: int
    seq: int
    standard: bool
    future: "asyncio.Future[None]"
    enqueued_at: float = field(default_factory=time.monotonic)
    admitted: bool = False
    #: Caller-supplied handle (the compile job id) so a job can be re-ordered
    #: after it is already queued — see `reprioritize`.
    key: Optional[str] = None


class BuildQueue:
    """One lane's admission gate. Not thread-safe; single event loop only.

    Every mutation happens inside a synchronous block with no `await` in it,
    so the counters can never be observed halfway through an admission.
    """

    def __init__(self, name: str, capacity: int) -> None:
        self.name = name
        self.capacity = max(1, capacity)
        self._active = 0
        self._priority_active = 0
        self._standard_waiting = 0
        self._heap: list[tuple[int, int, _Waiter]] = []
        self._seq = itertools.count()
        #: Priority jobs admitted back-to-back while a standard job waited.
        #: The reserved slot cannot protect a capacity-1 lane (holding back its
        #: ONLY slot would invert the order rather than soften it), so this
        #: counter is the fallback that keeps `VELXIO_*_BUILD_SLOTS=1` — a
        #: supported operator setting — from starving standard builds outright.
        self._consecutive_priority = 0

    # ── introspection (server-side only) ─────────────────────────────────
    @property
    def active(self) -> int:
        return self._active

    @property
    def waiting(self) -> int:
        return len(self._heap)

    @property
    def pressure(self) -> float:
        """Running + waiting, as a multiple of capacity. 1.0 = lane exactly full."""
        return (self._active + len(self._heap)) / float(self.capacity)

    # ── admission ────────────────────────────────────────────────────────
    def _drop_cancelled(self) -> None:
        """Evict waiters whose task went away before they were admitted.

        A client disconnect cancels the polling task, not the build — but a job
        cancelled while still queued must not keep a place in line, or the lane
        hands slots to futures nobody is awaiting.
        """
        if not self._heap:
            return
        alive = [e for e in self._heap if not e[2].future.done()]
        if len(alive) != len(self._heap):
            self._standard_waiting = sum(1 for e in alive if e[2].standard)
            self._heap = alive
            heapq.heapify(self._heap)

    def _take_best(self) -> Optional[_Waiter]:
        if not self._heap:
            return None
        waiter = heapq.heappop(self._heap)[2]
        if waiter.standard:
            self._standard_waiting -= 1
        return waiter

    def _take_oldest_standard(self) -> Optional[_Waiter]:
        """The standard waiter that has been in line longest (lowest seq)."""
        best_idx = -1
        best_seq = -1
        for idx, (_prio, seq, waiter) in enumerate(self._heap):
            if waiter.standard and (best_idx < 0 or seq < best_seq):
                best_idx, best_seq = idx, seq
        if best_idx < 0:
            return None
        waiter = self._heap.pop(best_idx)[2]
        heapq.heapify(self._heap)
        self._standard_waiting -= 1
        return waiter

    def _select(self) -> Optional[_Waiter]:
        self._drop_cancelled()
        if not self._heap:
            return None
        # Anti-starvation, first line: while a standard job waits, priority
        # jobs may not hold the lane's last slot.
        if (
            self.capacity >= 2
            and self._standard_waiting > 0
            and self._priority_active >= self.capacity - RESERVED_STANDARD_SLOTS
        ):
            standard = self._take_oldest_standard()
            if standard is not None:
                return standard
        # Second line, and the ONLY one a capacity-1 lane has: after
        # MAX_CONSECUTIVE_PRIORITY priority admissions in a row, the next slot
        # goes to the longest-waiting standard job. Paid builds still get the
        # large majority of the lane; nobody waits forever.
        if (
            self._standard_waiting > 0
            and self._consecutive_priority >= MAX_CONSECUTIVE_PRIORITY
        ):
            standard = self._take_oldest_standard()
            if standard is not None:
                return standard
        return self._take_best()

    def _pump(self) -> None:
        while self._active < self.capacity:
            waiter = self._select()
            if waiter is None:
                return
            if waiter.future.done():
                # Cancelled between selection and admission — nothing to give
                # the slot to, so try the next waiter without consuming it.
                continue
            waiter.admitted = True
            self._active += 1
            if waiter.standard:
                self._consecutive_priority = 0
            else:
                self._priority_active += 1
                self._consecutive_priority += 1
            waiter.future.set_result(None)

    def _release(self, waiter: _Waiter) -> None:
        self._active -= 1
        if not waiter.standard:
            self._priority_active -= 1
        self._pump()

    def _remove(self, waiter: _Waiter) -> None:
        before = len(self._heap)
        self._heap = [e for e in self._heap if e[2] is not waiter]
        if len(self._heap) != before:
            if waiter.standard:
                self._standard_waiting -= 1
            heapq.heapify(self._heap)

    def reprioritize(self, key: str, priority: int) -> bool:
        """Move an already-queued job to a BETTER priority. Returns True if it moved.

        Exists for compile dedup: two users submitting byte-identical sources
        for the same board share ONE build, and the job keeps whoever asked
        first. Without this, a pro user landing on a queued anonymous build of a
        popular gallery example waits at standard priority — the exact case the
        priority lane is for, silently inverted.

        Only ever improves a job's place in line (a later standard requester
        must not demote a paid one), and only while it is still waiting.
        """
        if priority >= STANDARD_THRESHOLD:
            return False
        for idx, (_prio, seq, waiter) in enumerate(self._heap):
            if waiter.key != key:
                continue
            if priority >= waiter.priority:
                return False
            # Only a job that WAS standard leaves the standard-waiting count;
            # a maker->pro upgrade was never counted there to begin with.
            if waiter.standard:
                self._standard_waiting -= 1
            waiter.priority = priority
            waiter.standard = False
            self._heap[idx] = (priority, seq, waiter)
            heapq.heapify(self._heap)
            return True
        return False

    @asynccontextmanager
    async def slot(
        self,
        *,
        priority: int = PRIORITY_STANDARD,
        key: Optional[str] = None,
        on_queued: Optional[Callable[[], None]] = None,
    ) -> AsyncIterator[None]:
        """Hold one of this lane's build slots for the body of the block.

        `on_queued` fires exactly once, and only when the job did NOT get a
        slot immediately — the caller uses it to tell the user their build is
        waiting rather than stalled.
        """
        loop = asyncio.get_running_loop()
        waiter = _Waiter(
            priority=priority,
            seq=next(self._seq),
            standard=priority >= STANDARD_THRESHOLD,
            future=loop.create_future(),
            key=key,
        )
        heapq.heappush(self._heap, (waiter.priority, waiter.seq, waiter))
        if waiter.standard:
            self._standard_waiting += 1
        self._pump()

        if not waiter.future.done() and on_queued is not None:
            try:
                on_queued()
            except Exception:  # noqa: BLE001 - a UI callback must not break admission
                logger.warning("[queue] on_queued callback threw", exc_info=True)

        try:
            await waiter.future
        except BaseException:
            # Cancelled (or the loop tore down) while waiting. If the slot had
            # already been handed over, give it back; otherwise leave the line.
            if waiter.admitted:
                self._release(waiter)
            else:
                self._remove(waiter)
            raise

        try:
            yield
        finally:
            self._release(waiter)


# ── The lanes ────────────────────────────────────────────────────────────────
# HEAVY = ESP-IDF (cmake + ninja, minutes on a cold cache): capped low because
# the VPS is modest — six concurrent ninja processes measured a load average of
# 30 and made every build slower than running them two at a time.
# LIGHT = arduino-cli boards (AVR, RP2040, STM32...): seconds each, so they get
# their own lane and never queue behind an ESP-IDF cold build.
HEAVY = BuildQueue("heavy", _env_slots("VELXIO_HEAVY_BUILD_SLOTS", 2))
LIGHT = BuildQueue("light", _env_slots("VELXIO_LIGHT_BUILD_SLOTS", 3))

_LANES = (HEAVY, LIGHT)


def lane_for(heavy: bool) -> BuildQueue:
    return HEAVY if heavy else LIGHT


# ── Coarse load signal ───────────────────────────────────────────────────────
# Four buckets, deliberately vague. The frontend paints them as a four-segment
# "build server load" meter. Anything finer would publish the queue depth,
# which is exactly what we do not want visitors reading off the wire.
_LOAD_LEVELS = ("low", "moderate", "high", "peak")


def load_level() -> str:
    """Overall build-server pressure as one of `_LOAD_LEVELS`."""
    active = sum(lane.active for lane in _LANES)
    waiting = sum(lane.waiting for lane in _LANES)
    capacity = sum(lane.capacity for lane in _LANES)
    pressure = (active + waiting) / float(capacity or 1)
    if pressure < 0.5:
        return "low"
    if pressure < 1.0:
        return "moderate"
    if pressure < 2.0:
        return "high"
    return "peak"


def debug_snapshot() -> dict:
    """Full queue state. Server-side diagnostics (logs, /admin) ONLY —
    never serialise this to an end-user response."""
    return {
        lane.name: {
            "active": lane.active,
            "waiting": lane.waiting,
            "capacity": lane.capacity,
        }
        for lane in _LANES
    }
