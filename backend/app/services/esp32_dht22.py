"""DHT22 reply for the QEMU ESP32 worker: the sensor's waveform, paced in guest
time, armed by either way a driver releases the line.

Why this module exists. `esp32_worker.py` used to answer a DHT22 only when the
firmware switched the pin to INPUT after holding it LOW: the push-pull idiom of
Adafruit's DHT.h (`pinMode(INPUT_PULLUP)`). It paced the reply by counting the
guest's GPIO_IN reads, because that library measures a pulse by counting
`digitalRead()` iterations. MicroPython's `dht` driver does neither. Its pin is
open-drain for the whole transaction and the release is `gpio_set_level(pin, 1)`,
so the worker saw the start LOW and then nothing, and `measure()` raised
ETIMEDOUT forever (issue #291). That driver also measures pulses in
microseconds (`machine_time_pulse_us`, 100 us timeout per phase, a bit is a HIGH
longer than 48 us), which read counting cannot satisfy: 70 counted reads are
20 us on a fast host and 200 us on a slow one.

So the model here follows the browser one (`simulation/line/models/dht22.ts`):

- The reply is armed by the RELEASE of a line the guest held LOW, in both
  idioms: direction OUTPUT -> INPUT, or a write of 1 while the pad is still an
  output (QEMU only reports level writes on output-enabled pads, so a reported
  write of 1 IS the open-drain release).
- Phases are guest microseconds read off QEMU's virtual clock at every GPIO_IN
  read, the only instant the guest can observe the pad.
- Between two reads the phase clock is credited at most `stall_cap_us` (2 us).
  That one rule serves the two regimes this worker runs in:

    * Under `-icount` (the worker turns it on for a MicroPython run with a
      line sensor) a guest read costs ~0.5-0.9 us of guest time, under the
      cap, so the phase clock IS guest time and a driver that times pulses
      measures 80/26/70 us exactly (checked with `machine.time_pulse_us`).
      A hiccup between two reads (one ~20 us event per frame was measured at
      shift 4) is credited as 2 us, so it moves a phase boundary by nothing
      the guest can notice beyond the hiccup itself.
    * Without `-icount` the guest's clock is host time and a read costs
      40-90 us of it (the read exits into a Python callback), so a phase
      can only be a number of READS. Every gap hits the cap and each read
      credits 2 us: the frame becomes 40/40/25/11/35 reads, which is what a
      read-counting driver (Adafruit's DHT.h compares the reads it made in
      the 50 us LOW against the reads in the HIGH) decodes correctly, and
      which no host stall can disturb. A pulse-timing driver cannot work in
      this regime whatever we do: it would see one read per 40-90 us.

The first edge is placed at the first read after the release rather than inside
the release callback: QEMU copies GPIO_OUT into GPIO_IN after it has run the
write callback, so a level driven from inside that callback is overwritten
before the guest can see it.
"""

from __future__ import annotations

from typing import Callable

# AM2302 datasheet figures. The '0' HIGH sits at the short end of its 22-30 us
# range on purpose: MicroPython calls a HIGH longer than 48 us a '1', and the
# ~20 us hiccup measured once per frame under -icount shift 4 would push a
# 26 us pulse to 46. Every DHT library thresholds the '0' between 30 and 50.
RESPONSE_LOW_US = 80
RESPONSE_HIGH_US = 80
BIT_LOW_US = 50
BIT0_HIGH_US = 22
BIT1_HIGH_US = 70
TAIL_LOW_US = 50

# Longest gap between two guest reads that is credited to the phase clock; see
# the module docstring for the two regimes it serves. Above the ~0.9 us a read
# costs under -icount shift 4, below anything a host stall produces.
STALL_CAP_US = 2.0

Level = int
Phase = tuple[Level, int]  # (level, duration_us)


def coerce_number(value: object, default: float) -> float:
    """A finite number off a sensor property, else the default. The canvas
    serialises property values as strings ("28"), the frontend usually converts
    them, and a payload built from a str would raise inside a QEMU callback."""
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return default
    return default


def dht22_payload(temperature_c: float, humidity_pct: float) -> list[int]:
    """The 5 bytes an AM2302 sends: [hum_H, hum_L, temp_H, temp_L, checksum].
    Humidity in 0.1 %RH, temperature in 0.1 C with the sign in bit 15."""
    hum = round(humidity_pct * 10)
    tmp = round(temperature_c * 10)
    h_H = (hum >> 8) & 0xFF
    h_L = hum & 0xFF
    raw_t = ((-tmp) & 0x7FFF) | 0x8000 if tmp < 0 else tmp & 0x7FFF
    t_H = (raw_t >> 8) & 0xFF
    t_L = raw_t & 0xFF
    chk = (h_H + h_L + t_H + t_L) & 0xFF
    return [h_H, h_L, t_H, t_L, chk]


def dht11_payload(temperature_c: float, humidity_pct: float) -> list[int]:
    """The 5 bytes a DHT11 sends: [hum_int, hum_dec, temp_int, temp_dec, checksum].

    The DHT11 reports whole units (its decimal bytes are 0 on the classic part),
    which is why a DHT22 frame read by a DHT11 driver comes out ten times too
    large — the frame timing is identical, the payload is not.
    """
    hum = max(0, min(100, int(round(humidity_pct))))
    tmp = int(round(temperature_c))
    neg = tmp < 0
    tmp_int = abs(tmp) & 0x7F
    t_int = tmp_int | (0x80 if neg else 0)
    chk = (hum + 0 + t_int + 0) & 0xFF
    return [hum, 0, t_int, 0, chk]


def dht22_phases(payload: list[int]) -> list[Phase]:
    """The frame as (level, duration_us) phases, first phase first. After the
    last one the sensor lets go and the pull-up idles the line HIGH."""
    phases: list[Phase] = [(0, RESPONSE_LOW_US), (1, RESPONSE_HIGH_US)]
    for byte in payload:
        for b in range(7, -1, -1):
            bit = (byte >> b) & 1
            phases.append((0, BIT_LOW_US))
            phases.append((1, BIT1_HIGH_US if bit else BIT0_HIGH_US))
    phases.append((0, TAIL_LOW_US))
    return phases


class Dht22Trigger:
    """When to answer: the release of a line the guest held LOW, either idiom.

    Fed with what QEMU reports about the pad. `on_write(level)` is a level the
    guest wrote while the pad is an output; `on_direction(is_output)` is the pad
    changing direction. Both return True exactly when a reply should start.
    """

    def __init__(self) -> None:
        self.saw_low = False

    def on_write(self, level: int) -> bool:
        if level == 0:
            self.saw_low = True
            return False
        if self.saw_low:            # open-drain release: a 1 after the LOW
            self.saw_low = False
            return True
        return False

    def on_direction(self, is_output: bool) -> bool:
        if is_output:
            return False
        if self.saw_low:            # push-pull release: INPUT after the LOW
            self.saw_low = False
            return True
        return False


class Dht22Reply:
    """One frame on one pad, advanced by the guest's GPIO_IN reads.

    `set_level(level)` drives the pad (QEMU's GPIO_IN bit); `now_us()` is the
    guest clock in microseconds. `step()` is called once per read and returns
    True once the frame is out and the line is idle again.
    """

    def __init__(
        self,
        phases: list[Phase],
        set_level: Callable[[int], None],
        now_us: Callable[[], float],
        stall_cap_us: float = STALL_CAP_US,
    ) -> None:
        if not phases:
            raise ValueError('a DHT22 frame has at least one phase')
        self._phases = phases
        self._set = set_level
        self._now = now_us
        self._cap = float(stall_cap_us)
        self._idx = -1              # -1: nothing driven yet
        self._elapsed = 0.0         # guest us credited to the current phase
        self._last: float | None = None
        self.done = False
        # Diagnostics.
        self.reads = 0
        self.stalls = 0
        self.gaps_us: list[float] = []
        self.started_at_us: float | None = None
        self.finished_at_us: float | None = None

    @property
    def phase(self) -> int:
        """Index of the phase on the wire, -1 before the first read."""
        return self._idx

    def step(self) -> bool:
        if self.done:
            return True
        t = self._now()
        self.reads += 1
        if self._idx < 0:
            self._idx = 0
            self._last = t
            self.started_at_us = t
            self._set(self._phases[0][0])
            return False
        assert self._last is not None
        gap = t - self._last
        self._last = t
        if gap < 0:                 # the guest clock went backwards: a reboot
            gap = 0.0
        self.gaps_us.append(gap)
        if gap > self._cap:
            self.stalls += 1
            gap = self._cap
        self._elapsed += gap
        # The cap keeps one step under the shortest phase, so this crosses at
        # most one boundary per read in practice; the loop is for correctness.
        while self._elapsed >= self._phases[self._idx][1]:
            self._elapsed -= self._phases[self._idx][1]
            self._idx += 1
            if self._idx >= len(self._phases):
                self._settle(t)
                return True
            self._set(self._phases[self._idx][0])
        return False

    def settle(self) -> bool:
        """Release the line if the frame is over but the guest stopped reading
        before the tail ran out (a read-counting driver returns on the last
        falling edge and never looks again). Returns True when it acted."""
        if self.done or self._idx < 0:
            return False
        self._settle(self._now())
        return True

    def _settle(self, t: float) -> None:
        self._set(1)                # released: the pull-up idles it HIGH
        self.done = True
        self.finished_at_us = t

    def diag(self) -> dict:
        gaps = sorted(self.gaps_us)
        n = len(gaps)
        return {
            'reads': self.reads,
            'stalls': self.stalls,
            'gap_p50_us': round(gaps[n // 2], 2) if n else None,
            'gap_p95_us': round(gaps[min(n - 1, (n * 95) // 100)], 2) if n else None,
            'gap_max_us': round(gaps[-1], 2) if n else None,
            'frame_us': (
                round(self.finished_at_us - self.started_at_us, 1)
                if self.started_at_us is not None and self.finished_at_us is not None
                else None
            ),
        }
