/**
 * GpsParts.ts — Simulation for the u-blox NEO-6M GPS module.
 *
 * The NEO-6M is a UART talker: it EMITS an NMEA-0183 stream at 9600 baud
 * out of its TX pin, once per second. This part synthesises a valid
 * GPGGA + GPRMC cycle (correct checksums, position from the element's
 * lat/lng/altitude/speed properties, UTC time that advances 1 s per cycle)
 * and pushes it into whatever the TX pin is wired to:
 *
 *   1. Hardware UART RX pin  → byte-level injection through the uniform
 *      `sim.feedUart(uart, data)` seam (AVR USART0, RP2040 uart0/1,
 *      ESP32 uart0/2 via the backend QEMU bridge, STM32 USART1/2), with
 *      `sim.serialWrite` as a uart-0 fallback for sims without feedUart.
 *   2. Any other digital pin on a cycle-accurate sim (AVR) → real 8N1
 *      bit-banged waveform via `schedulePinChange`, so SoftwareSerial
 *      (the classic NEO-6M wiring in Arduino tutorials) decodes it.
 *
 * Byte-level injection is paced at ~9600 baud in wall-clock chunks so
 * small RX FIFOs (rp2040js PL011 = 32 bytes) never overflow: the sketch
 * gets simulated time to drain between chunks.
 *
 * Defaults: 40.4168 N, 3.7038 W (Madrid), 667 m — overridable via the
 * property dialog and live via the SensorControlPanel.
 */

import { PartSimulationRegistry } from './PartSimulationRegistry';
import { registerSensorUpdate, unregisterSensorUpdate } from '../SensorUpdateRegistry';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { classifyPin } from '../../utils/boardProtocols';
import { isBoardComponent } from '../../utils/boardPinMapping';

export const GPS_BAUD = 9600;

// ─── NMEA sentence builders (exported for tests) ─────────────────────────────

/** XOR checksum of every char between '$' and '*', as 2-digit uppercase hex. */
export function nmeaChecksum(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum ^= body.charCodeAt(i);
  return sum.toString(16).toUpperCase().padStart(2, '0');
}

/** Wrap a sentence body: `$<body>*<checksum>`. */
export function nmeaSentence(body: string): string {
  return `$${body}*${nmeaChecksum(body)}`;
}

const pad2 = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0');

/** Decimal degrees → NMEA ddmm.mmmmm (lat) / dddmm.mmmmm (lon) + hemisphere. */
export function formatNmeaCoord(
  decimalDegrees: number,
  axis: 'lat' | 'lon',
): { value: string; hemisphere: string } {
  const hemisphere =
    axis === 'lat' ? (decimalDegrees < 0 ? 'S' : 'N') : (decimalDegrees < 0 ? 'W' : 'E');
  const abs = Math.abs(decimalDegrees);
  const degrees = Math.trunc(abs);
  const minutes = (abs - degrees) * 60;
  const degStr = String(degrees).padStart(axis === 'lat' ? 2 : 3, '0');
  // NEO-6M emits 5 decimal digits of minutes.
  let minStr = minutes.toFixed(5);
  if (minutes < 10) minStr = `0${minStr}`;
  return { value: `${degStr}${minStr}`, hemisphere };
}

const nmeaTime = (d: Date) =>
  `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}.00`;

const nmeaDate = (d: Date) =>
  `${pad2(d.getUTCDate())}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCFullYear() % 100)}`;

export interface GpsFix {
  lat: number;
  lng: number;
  /** Metres above mean sea level. */
  altitude: number;
  /** Speed over ground, knots. */
  speed: number;
  /** Course over ground, degrees true. */
  course: number;
}

/** GGA — fix data: time, position, fix quality 1 (GPS), 7 sats, altitude. */
export function buildGpgga(date: Date, fix: GpsFix): string {
  const lat = formatNmeaCoord(fix.lat, 'lat');
  const lon = formatNmeaCoord(fix.lng, 'lon');
  const body =
    `GPGGA,${nmeaTime(date)},${lat.value},${lat.hemisphere},` +
    `${lon.value},${lon.hemisphere},1,07,1.2,${fix.altitude.toFixed(1)},M,0.0,M,,`;
  return nmeaSentence(body);
}

/** RMC — recommended minimum: time, status A, position, speed, course, date. */
export function buildGprmc(date: Date, fix: GpsFix): string {
  const lat = formatNmeaCoord(fix.lat, 'lat');
  const lon = formatNmeaCoord(fix.lng, 'lon');
  const body =
    `GPRMC,${nmeaTime(date)},A,${lat.value},${lat.hemisphere},` +
    `${lon.value},${lon.hemisphere},${fix.speed.toFixed(1)},${fix.course.toFixed(1)},` +
    `${nmeaDate(date)},,,A`;
  return nmeaSentence(body);
}

/** One full per-second emission: GPGGA + GPRMC, each CRLF-terminated. */
export function buildNmeaCycle(date: Date, fix: GpsFix): string {
  return `${buildGpgga(date, fix)}\r\n${buildGprmc(date, fix)}\r\n`;
}

// ─── Wiring resolution ───────────────────────────────────────────────────────

/**
 * Find the board endpoint directly wired to (componentId, pinName).
 * Returns the board kind + the board-side pin label, or null when the pin
 * is unwired or reaches the board only through other components.
 */
function findDirectBoardEndpoint(
  componentId: string,
  pinName: string,
): { boardKind: string; pinName: string } | null {
  const s = useSimulatorStore.getState();
  for (const w of s.wires) {
    let other = null;
    if (w.start.componentId === componentId && w.start.pinName === pinName) other = w.end;
    else if (w.end.componentId === componentId && w.end.pinName === pinName) other = w.start;
    if (!other) continue;

    const board = s.boards.find((b) => b.id === other.componentId);
    if (board) return { boardKind: board.boardKind as string, pinName: other.pinName };
    if (isBoardComponent(other.componentId)) {
      return { boardKind: other.componentId, pinName: other.pinName };
    }
  }
  return null;
}

/** Board kind of the active board (fallback for indirect wiring). */
function activeBoardKind(): string | null {
  const s = useSimulatorStore.getState();
  const board = s.boards.find((b) => b.id === s.activeBoardId) ?? s.boards[0];
  return board ? (board.boardKind as string) : null;
}

// ─── Bit-banged UART frames (AVR SoftwareSerial path) ────────────────────────

/**
 * Schedule `text` as an 8N1 bitstream on `pin` using the sim's
 * cycle-accurate pin queue. Emits only state TRANSITIONS (the line idles
 * HIGH), mirroring AVRSimulator.emitUartTxFrame. `tail` carries the cycle
 * where the previous frame ended so back-to-back emissions stay contiguous.
 */
export function scheduleUartBitstream(
  simulator: {
    getCurrentCycles(): number;
    getClockHz?(): number;
    schedulePinChange(pin: number, state: boolean, atCycle: number): void;
  },
  pin: number,
  text: string,
  tail: { cycle: number; lastNow: number },
  baud = GPS_BAUD,
): void {
  const clockHz = typeof simulator.getClockHz === 'function' ? simulator.getClockHz() : 16_000_000;
  const cyclesPerBit = clockHz / baud;
  const now = simulator.getCurrentCycles();

  // CPU cycle counter went backwards → the sim was reset; drop stale tail.
  if (now < tail.lastNow) tail.cycle = 0;
  tail.lastNow = now;

  // More than ~2 s of sim-time backlog means the sim runs far below real
  // time — skip this cycle instead of growing the queue without bound.
  if (tail.cycle > now + 2 * clockHz) return;

  // Start after the previous frame, leaving at least one idle bit from now.
  let t = Math.max(now + cyclesPerBit, tail.cycle);
  let prev = true; // idle HIGH

  for (let i = 0; i < text.length; i++) {
    const byte = text.charCodeAt(i) & 0xff;
    // start LOW, 8 data bits LSB-first, stop HIGH
    const bits: boolean[] = [false];
    for (let b = 0; b < 8; b++) bits.push(((byte >> b) & 1) !== 0);
    bits.push(true);
    for (const bit of bits) {
      if (bit !== prev) {
        simulator.schedulePinChange(pin, bit, Math.round(t));
        prev = bit;
      }
      t += cyclesPerBit;
    }
  }
  tail.cycle = t; // stop bit leaves the line HIGH (idle) — no trailing edge
}

// ─── Part registration ───────────────────────────────────────────────────────

const num = (v: unknown, dflt: number): number => {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : dflt;
};

/** Wall-clock pacing for byte-level injection: ≈9600 baud in 8-byte chunks. */
const FEED_CHUNK_BYTES = 8;
const FEED_CHUNK_MS = 8;

PartSimulationRegistry.register('gps-neo6m', {
  attachEvents: (element, simulator, getPin, componentId) => {
    const el = element as unknown as Record<string, unknown> & HTMLElement;
    const sim = simulator as unknown as {
      isRunning?: () => boolean;
      feedUart?: (uart: number, data: string) => boolean;
      serialWrite?: (text: string) => void;
      setPinState?: (pin: number, state: boolean) => void;
      getCurrentCycles?: () => number;
      getClockHz?: () => number;
      schedulePinChange?: (pin: number, state: boolean, atCycle: number) => void;
    };

    const fix: GpsFix = {
      lat: num(el.lat, 40.4168),
      lng: num(el.lng, -3.7038),
      altitude: num(el.altitude, 667),
      speed: num(el.speed, 0),
      course: num(el.course, 0),
    };

    // UTC clock: seeded at attach, advanced one second per emission so the
    // stream stays monotonic under fake timers and sim-speed changes.
    const baseTime = Date.now();
    let tick = 0;

    // ── Resolve the injection route once per attach (DynamicComponent
    //    re-attaches on every wire change, so this stays current). ──────────
    const arduinoPin = getPin('TX');
    const direct = componentId ? findDirectBoardEndpoint(componentId, 'TX') : null;
    let role = direct ? classifyPin(direct.boardKind, direct.pinName) : null;
    if ((!role || role.kind === 'digital') && arduinoPin !== null && arduinoPin >= 0) {
      // Indirect wiring (e.g. through a level-shift resistor): classify the
      // resolved pin number against the active board's protocol table.
      const kind = activeBoardKind();
      if (kind) {
        const numericRole = classifyPin(kind, String(arduinoPin));
        if (numericRole.kind === 'uart-rx') role = numericRole;
      }
    }

    const canBitBang =
      typeof sim.schedulePinChange === 'function' &&
      typeof sim.getCurrentCycles === 'function' &&
      arduinoPin !== null &&
      arduinoPin >= 0;

    // ── Byte-level feed queue, drained at ~9600 baud wall-clock ────────────
    // When `feedUart` reports the target UART unsupported (e.g. Mega
    // USART1-3, which avr8js doesn't model), flip to the bit-banged path
    // permanently so SoftwareSerial on that pin still gets the stream.
    let byteFeedRejected = false;
    let feedQueue = '';
    let feedTimer: ReturnType<typeof setInterval> | null = null;
    const drainFeedQueue = () => {
      if (feedQueue.length === 0) {
        if (feedTimer !== null) {
          clearInterval(feedTimer);
          feedTimer = null;
        }
        return;
      }
      const chunk = feedQueue.slice(0, FEED_CHUNK_BYTES);
      feedQueue = feedQueue.slice(FEED_CHUNK_BYTES);
      if (role?.kind === 'uart-rx' && typeof sim.feedUart === 'function') {
        if (sim.feedUart(role.uart, chunk) === false) {
          byteFeedRejected = true;
          feedQueue = '';
        }
      } else if (typeof sim.serialWrite === 'function') {
        sim.serialWrite(chunk);
      }
    };
    const enqueueBytes = (text: string) => {
      // Never buffer more than ~2 cycles — a stalled sim must not grow this.
      if (feedQueue.length > text.length * 2) return;
      feedQueue += text;
      if (feedTimer === null) {
        feedTimer = setInterval(drainFeedQueue, FEED_CHUNK_MS);
        drainFeedQueue();
      }
    };

    // ── Bit-bang state (AVR SoftwareSerial path) ───────────────────────────
    const tail = { cycle: 0, lastNow: 0 };
    if (canBitBang) {
      // Seed the line at idle HIGH so SoftwareSerial doesn't read a break.
      // (Harmless on byte-fed hardware-UART pins: a UART line idles HIGH.)
      sim.setPinState?.(arduinoPin as number, true);
    }

    let ppsTimeout: ReturnType<typeof setTimeout> | null = null;
    const pulsePps = () => {
      try {
        (el as { pps?: boolean }).pps = true;
        ppsTimeout = setTimeout(() => {
          (el as { pps?: boolean }).pps = false;
        }, 120);
      } catch {
        /* headless element */
      }
    };

    const emit = () => {
      if (typeof sim.isRunning === 'function' && !sim.isRunning()) return;

      const date = new Date(baseTime + tick * 1000);
      tick++;
      const cycle = buildNmeaCycle(date, fix);

      const byteCapable =
        !byteFeedRejected &&
        role?.kind === 'uart-rx' &&
        (typeof sim.feedUart === 'function' || (role.uart === 0 && typeof sim.serialWrite === 'function'));

      if (byteCapable) {
        enqueueBytes(cycle);
      } else if (canBitBang) {
        scheduleUartBitstream(
          sim as Parameters<typeof scheduleUartBitstream>[0],
          arduinoPin as number,
          cycle,
          tail,
        );
      } else if (typeof sim.serialWrite === 'function') {
        // Last resort: deliver on the default serial so raw Serial.read()
        // sketches still see the stream.
        enqueueBytes(cycle);
      } else {
        return; // nowhere to deliver — skip the PPS pulse too
      }
      pulsePps();
    };

    const interval = setInterval(emit, 1000);

    if (componentId) {
      registerSensorUpdate(componentId, (values) => {
        if ('lat' in values) fix.lat = values.lat as number;
        if ('lng' in values) fix.lng = values.lng as number;
        if ('altitude' in values) fix.altitude = values.altitude as number;
        if ('speed' in values) fix.speed = values.speed as number;
        if ('course' in values) fix.course = values.course as number;
        // Mirror onto the element so the property dialog shows live values.
        for (const k of ['lat', 'lng', 'altitude', 'speed', 'course'] as const) {
          if (k in values) (el as Record<string, unknown>)[k] = values[k];
        }
      });
    }

    return () => {
      clearInterval(interval);
      if (feedTimer !== null) clearInterval(feedTimer);
      if (ppsTimeout !== null) clearTimeout(ppsTimeout);
      if (componentId) unregisterSensorUpdate(componentId);
    };
  },
});
