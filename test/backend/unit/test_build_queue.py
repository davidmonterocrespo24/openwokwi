"""The compile queue orders by plan, and never starves anyone.

Two properties the product depends on:

  1. A paid build jumps ahead of standard builds that were queued first. That
     is the whole point of the priority lane.
  2. A standard build ALWAYS advances anyway. Strict priority alone parks a
     free user behind an unbroken stream of paid builds; each lane therefore
     keeps one slot out of reach of priority jobs while a standard job waits.

Plus the invariant that makes the whole thing safe to expose: a build is
delayed, never refused — the queue is unbounded and nothing is ever dropped.

Run from the repo root:
    python -m pytest test/backend/unit/test_build_queue.py -v
"""

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

from app.services.build_queue import (  # noqa: E402
    MAX_CONSECUTIVE_PRIORITY,
    PRIORITY_HIGH,
    PRIORITY_MEDIUM,
    PRIORITY_STANDARD,
    BuildQueue,
    load_level,
)


class _Recorder:
    """Runs jobs through a queue and records the admission order."""

    def __init__(self, queue: BuildQueue) -> None:
        self.queue = queue
        self.order: list[str] = []
        self.release = asyncio.Event()

    async def job(self, label: str, priority: int, hold: bool = True) -> None:
        async with self.queue.slot(priority=priority):
            self.order.append(label)
            if hold:
                await self.release.wait()


class PriorityOrderTests(unittest.IsolatedAsyncioTestCase):
    async def test_paid_jumps_ahead_of_earlier_standard_builds(self) -> None:
        """A pro build queued last is admitted before free builds queued first."""
        queue = BuildQueue('test', capacity=1)
        rec = _Recorder(queue)

        blocker = asyncio.create_task(rec.job('blocker', PRIORITY_STANDARD))
        await asyncio.sleep(0)  # let the blocker take the only slot

        waiters = [
            asyncio.create_task(rec.job('free-1', PRIORITY_STANDARD, hold=False)),
            asyncio.create_task(rec.job('free-2', PRIORITY_STANDARD, hold=False)),
            asyncio.create_task(rec.job('maker', PRIORITY_MEDIUM, hold=False)),
            asyncio.create_task(rec.job('pro', PRIORITY_HIGH, hold=False)),
        ]
        await asyncio.sleep(0)

        rec.release.set()
        await asyncio.gather(blocker, *waiters)

        # capacity=1 disables the standard reservation (holding the only slot
        # back would invert the order rather than soften it), so this is the
        # pure ordering: pro, then maker, then the two free builds in arrival
        # order.
        self.assertEqual(
            rec.order, ['blocker', 'pro', 'maker', 'free-1', 'free-2']
        )

    async def test_equal_priority_stays_first_come_first_served(self) -> None:
        queue = BuildQueue('test', capacity=1)
        rec = _Recorder(queue)

        blocker = asyncio.create_task(rec.job('blocker', PRIORITY_STANDARD))
        await asyncio.sleep(0)
        waiters = [
            asyncio.create_task(rec.job(f'free-{i}', PRIORITY_STANDARD, hold=False))
            for i in range(4)
        ]
        await asyncio.sleep(0)

        rec.release.set()
        await asyncio.gather(blocker, *waiters)
        self.assertEqual(
            rec.order, ['blocker', 'free-0', 'free-1', 'free-2', 'free-3']
        )


class AntiStarvationTests(unittest.IsolatedAsyncioTestCase):
    async def test_standard_build_advances_under_a_flood_of_paid_builds(self) -> None:
        """The reserved slot: a free build runs even while pro builds keep arriving.

        Without the reservation the free job is last of thirteen — every slot
        that frees up goes to another pro build. With it, the free job is
        admitted on the FIRST release, because the one pro build still running
        already fills the lane's priority allowance (capacity 2, reserved 1).
        """
        queue = BuildQueue('test', capacity=2)
        admitted: list[str] = []
        gate = asyncio.Event()

        async def paid(idx: int) -> None:
            async with queue.slot(priority=PRIORITY_HIGH):
                admitted.append(f'pro-{idx}')
                await gate.wait()

        async def standard() -> None:
            async with queue.slot(priority=PRIORITY_STANDARD):
                admitted.append('free')

        pros = [asyncio.create_task(paid(i)) for i in range(12)]
        await asyncio.sleep(0)  # the first two take the lane, ten queue up
        free = asyncio.create_task(standard())
        await asyncio.sleep(0)

        gate.set()
        await asyncio.wait_for(asyncio.gather(free, *pros), timeout=2)

        self.assertLessEqual(
            admitted.index('free'), 2,
            f'free build waited behind too many paid builds: {admitted}',
        )

    async def test_reservation_costs_nothing_when_no_standard_job_waits(self) -> None:
        """With no standard job in line, priority builds use the whole lane."""
        queue = BuildQueue('test', capacity=3)
        gate = asyncio.Event()

        async def paid() -> None:
            async with queue.slot(priority=PRIORITY_HIGH):
                await gate.wait()

        tasks = [asyncio.create_task(paid()) for _ in range(3)]
        await asyncio.sleep(0)
        self.assertEqual(queue.active, 3)
        gate.set()
        await asyncio.gather(*tasks)


class NobodyIsRefusedTests(unittest.IsolatedAsyncioTestCase):
    async def test_every_queued_build_eventually_runs(self) -> None:
        """The queue is unbounded: 50 builds on a 2-slot lane all get through."""
        queue = BuildQueue('test', capacity=2)
        done: list[int] = []

        async def job(idx: int) -> None:
            priority = PRIORITY_HIGH if idx % 3 == 0 else PRIORITY_STANDARD
            async with queue.slot(priority=priority):
                await asyncio.sleep(0)
                done.append(idx)

        await asyncio.wait_for(
            asyncio.gather(*(job(i) for i in range(50))), timeout=5
        )
        self.assertEqual(sorted(done), list(range(50)))
        self.assertEqual(queue.active, 0)
        self.assertEqual(queue.waiting, 0)

    async def test_a_cancelled_waiter_frees_its_place(self) -> None:
        """A client that goes away while queued must not hold a slot hostage."""
        queue = BuildQueue('test', capacity=1)
        release = asyncio.Event()
        ran: list[str] = []

        async def job(label: str) -> None:
            async with queue.slot(priority=PRIORITY_STANDARD):
                ran.append(label)
                await release.wait()

        blocker = asyncio.create_task(job('blocker'))
        await asyncio.sleep(0)
        abandoned = asyncio.create_task(job('abandoned'))
        await asyncio.sleep(0)
        follower = asyncio.create_task(job('follower'))
        await asyncio.sleep(0)

        self.assertEqual(queue.waiting, 2)
        abandoned.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await abandoned
        self.assertEqual(queue.waiting, 1)

        release.set()
        await asyncio.gather(blocker, follower)
        self.assertEqual(ran, ['blocker', 'follower'])


class CapacityOneTests(unittest.IsolatedAsyncioTestCase):
    """A 1-slot lane is a supported operator setting (VELXIO_HEAVY_BUILD_SLOTS=1).

    The reserved slot cannot protect it — holding back its only slot would
    invert the priority order rather than soften it — so the consecutive-
    priority counter is the fallback that keeps standard builds moving.
    """

    async def test_standard_build_gets_in_on_a_one_slot_lane(self) -> None:
        queue = BuildQueue('test', capacity=1)
        admitted: list[str] = []
        gate = asyncio.Event()

        async def paid(idx: int) -> None:
            async with queue.slot(priority=PRIORITY_HIGH):
                admitted.append(f'pro-{idx}')
                await gate.wait()

        async def standard() -> None:
            async with queue.slot(priority=PRIORITY_STANDARD):
                admitted.append('free')

        pros = [asyncio.create_task(paid(i)) for i in range(12)]
        await asyncio.sleep(0)
        free = asyncio.create_task(standard())
        await asyncio.sleep(0)

        gate.set()
        await asyncio.wait_for(asyncio.gather(free, *pros), timeout=2)

        # Without the counter the free build is last of thirteen; with it the
        # lane hands it a slot after at most MAX_CONSECUTIVE_PRIORITY paid ones.
        self.assertLessEqual(
            admitted.index('free'), MAX_CONSECUTIVE_PRIORITY + 1,
            f'free build starved on a 1-slot lane: {admitted}',
        )


class ReprioritizeTests(unittest.IsolatedAsyncioTestCase):
    """Compile dedup shares ONE build between users; the shared job must be
    liftable to the better entitlement, or a pro user landing on a queued
    anonymous build of a popular example silently waits at standard priority."""

    async def test_a_queued_job_can_be_lifted_ahead_of_standard_ones(self) -> None:
        queue = BuildQueue('test', capacity=1)
        admitted: list[str] = []
        gate = asyncio.Event()

        async def job(label: str, priority: int, key: str | None = None) -> None:
            async with queue.slot(priority=priority, key=key):
                admitted.append(label)
                if label == 'blocker':
                    await gate.wait()

        blocker = asyncio.create_task(job('blocker', PRIORITY_STANDARD))
        await asyncio.sleep(0)
        first = asyncio.create_task(job('shared', PRIORITY_STANDARD, key='job-1'))
        second = asyncio.create_task(job('other', PRIORITY_STANDARD))
        await asyncio.sleep(0)

        # A pro user dedups onto 'shared' while it is still queued.
        self.assertTrue(queue.reprioritize('job-1', PRIORITY_HIGH))

        gate.set()
        await asyncio.gather(blocker, first, second)
        self.assertEqual(admitted, ['blocker', 'shared', 'other'])

    async def test_reprioritize_never_demotes_and_never_invents_a_job(self) -> None:
        queue = BuildQueue('test', capacity=1)
        gate = asyncio.Event()

        async def job(priority: int, key: str | None = None) -> None:
            async with queue.slot(priority=priority, key=key):
                await gate.wait()

        blocker = asyncio.create_task(job(PRIORITY_STANDARD))
        await asyncio.sleep(0)
        queued = asyncio.create_task(job(PRIORITY_HIGH, key='paid'))
        await asyncio.sleep(0)

        # A later STANDARD requester must not drag a paid job down.
        self.assertFalse(queue.reprioritize('paid', PRIORITY_STANDARD))
        # An unknown key is a no-op, not a crash.
        self.assertFalse(queue.reprioritize('nope', PRIORITY_HIGH))

        gate.set()
        await asyncio.gather(blocker, queued)


class LoadLevelTests(unittest.TestCase):
    def test_idle_server_reports_low(self) -> None:
        self.assertEqual(load_level(), 'low')

    def test_levels_are_coarse_buckets_not_counts(self) -> None:
        """The only queue fact a client may see is one of four labels.

        Anything finer would publish the queue depth, which is exactly what the
        product does not want visitors reading off the wire.
        """
        self.assertIn(load_level(), ('low', 'moderate', 'high', 'peak'))


if __name__ == '__main__':
    unittest.main()
