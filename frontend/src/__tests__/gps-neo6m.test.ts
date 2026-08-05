/**
 * gps-neo6m.test.ts — u-blox NEO-6M GPS module simulation.
 *
 * Covers:
 *   • NMEA building blocks: checksum, ddmm.mmmmm coordinate encoding,
 *     GPGGA / GPRMC structure, CRLF cycle framing.
 *   • Part registration in PartSimulationRegistry.
 *   • Byte-level injection: TX wired to a hardware UART RX pin routes the
 *     stream through `sim.feedUart(uart, data)` — Uno pin 0 (uart 0) and
 *     ESP32 GPIO16 (uart 2).
 *   • Bit-banged injection: TX wired to a plain digital pin on a
 *     cycle-accurate sim emits a real 9600-baud 8N1 waveform via
 *     `schedulePinChange` that decodes back to the NMEA text
 *     (the SoftwareSerial wiring every NEO-6M Arduino tutorial uses).
 *   • Live position updates via the SensorControlPanel registry.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';
import { useSimulatorStore } from '../store/useSimulatorStore';
import {
  GPS_BAUD,
  nmeaChecksum,
  nmeaSentence,
  formatNmeaCoord,
  buildGpgga,
  buildGprmc,
  buildNmeaCycle,
  scheduleUartBitstream,
} from '../simulation/parts/GpsParts';
import '../simulation/parts/GpsParts';

// ─── Globals ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  useSimulatorStore.setState({ boards: [], wires: [] } as never);
});

const MADRID = { lat: 40.4168, lng: -3.7038, altitude: 667, speed: 0, course: 0 };
const T0 = new Date(Date.UTC(2026, 6, 31, 12, 35, 19));

/** Validate `$<body>*<cs>` framing + checksum for a single sentence. */
function expectValidSentence(sentence: string): void {
  const m = /^\$([A-Z0-9,.-]*)\*([0-9A-F]{2})$/.exec(sentence);
  expect(m, `malformed sentence: ${sentence}`).not.toBeNull();
  expect(nmeaChecksum(m![1])).toBe(m![2]);
}

// ─── NMEA builders ────────────────────────────────────────────────────────────

describe('NMEA building blocks', () => {
  it('checksum matches the canonical GPGGA example (0x47)', () => {
    // Textbook sentence: $GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47
    expect(nmeaChecksum('GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,')).toBe(
      '47',
    );
    expect(nmeaSentence('GPGGA,x')).toMatch(/^\$GPGGA,x\*[0-9A-F]{2}$/);
  });

  it('encodes decimal degrees as ddmm.mmmmm with the right hemisphere', () => {
    expect(formatNmeaCoord(40.4168, 'lat')).toEqual({ value: '4025.00800', hemisphere: 'N' });
    expect(formatNmeaCoord(-3.7038, 'lon')).toEqual({ value: '00342.22800', hemisphere: 'W' });
    expect(formatNmeaCoord(-33.4489, 'lat').hemisphere).toBe('S');
    expect(formatNmeaCoord(151.2093, 'lon').hemisphere).toBe('E');
    // Longitude uses 3 degree digits, latitude 2.
    expect(formatNmeaCoord(151.2093, 'lon').value).toMatch(/^151/);
    expect(formatNmeaCoord(8.5, 'lat').value).toMatch(/^08/);
  });

  it('GPGGA carries time, position, fix=1, sats and altitude with a valid checksum', () => {
    const gga = buildGpgga(T0, MADRID);
    expectValidSentence(gga);
    const f = gga.split(',');
    expect(f[0]).toBe('$GPGGA');
    expect(f[1]).toBe('123519.00');
    expect(f[2]).toBe('4025.00800');
    expect(f[3]).toBe('N');
    expect(f[4]).toBe('00342.22800');
    expect(f[5]).toBe('W');
    expect(f[6]).toBe('1'); // GPS fix
    expect(f[9]).toBe('667.0'); // altitude
    expect(f[10]).toBe('M');
  });

  it('GPRMC carries status A, position, speed, date with a valid checksum', () => {
    const rmc = buildGprmc(T0, { ...MADRID, speed: 12.5, course: 84.4 });
    expectValidSentence(rmc);
    const f = rmc.split(',');
    expect(f[0]).toBe('$GPRMC');
    expect(f[1]).toBe('123519.00');
    expect(f[2]).toBe('A');
    expect(f[3]).toBe('4025.00800');
    expect(f[7]).toBe('12.5'); // knots
    expect(f[8]).toBe('84.4'); // course
    expect(f[9]).toBe('310726'); // ddmmyy
  });

  it('a cycle is GPGGA + GPRMC, each CRLF-terminated', () => {
    const cycle = buildNmeaCycle(T0, MADRID);
    const lines = cycle.split('\r\n');
    expect(lines).toHaveLength(3); // two sentences + trailing empty
    expect(lines[0]).toMatch(/^\$GPGGA,/);
    expect(lines[1]).toMatch(/^\$GPRMC,/);
    expect(lines[2]).toBe('');
    expectValidSentence(lines[0]);
    expectValidSentence(lines[1]);
  });
});

// ─── Part registration + store wiring helpers ────────────────────────────────

const GPS_ID = 'gps_neo6m_test_1';

function wireGpsTo(boardKind: string, boardPin: string): void {
  useSimulatorStore.setState({
    boards: [{ id: 'board-1', boardKind, x: 0, y: 0 }],
    activeBoardId: 'board-1',
    wires: [
      {
        id: 'w1',
        start: { componentId: GPS_ID, pinName: 'TX', x: 0, y: 0 },
        end: { componentId: 'board-1', pinName: boardPin, x: 0, y: 0 },
        color: '#0f0',
        signalType: 'digital',
      },
    ],
  } as never);
}

function makeElement(props: Record<string, unknown> = {}): HTMLElement {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    ...props,
  } as unknown as HTMLElement;
}

function makeByteSim() {
  const fed: Array<{ uart: number; data: string }> = [];
  return {
    isRunning: () => true,
    setPinState: vi.fn(),
    pinManager: { onPinChange: vi.fn().mockReturnValue(() => {}) },
    feedUart: vi.fn((uart: number, data: string) => {
      fed.push({ uart, data });
      return true;
    }),
    fed,
  };
}

/** Drain the wall-clock chunked feed queue (8 bytes / 8 ms). */
const drainFeed = () => vi.advanceTimersByTime(500);

describe('gps-neo6m — registration', () => {
  it('is registered in PartSimulationRegistry', () => {
    expect(PartSimulationRegistry.get('gps-neo6m')).toBeDefined();
  });
});

describe('gps-neo6m — byte-level UART injection', () => {
  it('feeds uart 0 when TX is wired to Uno pin 0 (RX)', () => {
    wireGpsTo('arduino-uno', '0');
    const sim = makeByteSim();
    const logic = PartSimulationRegistry.get('gps-neo6m')!;
    const cleanup = logic.attachEvents!(
      makeElement(),
      sim as never,
      (name) => (name === 'TX' ? 0 : null),
      GPS_ID,
    );

    vi.advanceTimersByTime(1000);
    drainFeed();
    cleanup();

    expect(sim.feedUart).toHaveBeenCalled();
    expect(sim.fed.every((c) => c.uart === 0)).toBe(true);
    const text = sim.fed.map((c) => c.data).join('');
    const lines = text.split('\r\n').filter((l) => l.length > 0);
    expect(lines[0]).toMatch(/^\$GPGGA,/);
    expect(lines[1]).toMatch(/^\$GPRMC,/);
    for (const line of lines) expectValidSentence(line);
    expect(text).toContain('4025.00800,N');
    expect(text).toContain('00342.22800,W');
  });

  it('feeds uart 2 when TX is wired to ESP32 GPIO16 (RX2)', () => {
    wireGpsTo('esp32', '16');
    const sim = makeByteSim();
    const logic = PartSimulationRegistry.get('gps-neo6m')!;
    const cleanup = logic.attachEvents!(makeElement(), sim as never, () => null, GPS_ID);

    vi.advanceTimersByTime(1000);
    drainFeed();
    cleanup();

    expect(sim.feedUart).toHaveBeenCalled();
    expect(sim.fed.every((c) => c.uart === 2)).toBe(true);
    expect(sim.fed.map((c) => c.data).join('')).toContain('$GPGGA');
  });

  it('advances UTC time by one second per cycle', () => {
    wireGpsTo('arduino-uno', '0');
    const sim = makeByteSim();
    const logic = PartSimulationRegistry.get('gps-neo6m')!;
    const cleanup = logic.attachEvents!(
      makeElement(),
      sim as never,
      (name) => (name === 'TX' ? 0 : null),
      GPS_ID,
    );

    vi.advanceTimersByTime(1000);
    drainFeed();
    vi.advanceTimersByTime(1000);
    drainFeed();
    cleanup();

    const text = sim.fed.map((c) => c.data).join('');
    const times = [...text.matchAll(/\$GPGGA,(\d{6})\.00,/g)].map((m) => m[1]);
    expect(times).toHaveLength(2);
    const toSec = (t: string) =>
      parseInt(t.slice(0, 2), 10) * 3600 + parseInt(t.slice(2, 4), 10) * 60 + parseInt(t.slice(4), 10);
    expect((toSec(times[1]) - toSec(times[0]) + 86400) % 86400).toBe(1);
  });

  it('SensorControlPanel updates change the emitted position live', () => {
    wireGpsTo('arduino-uno', '0');
    const sim = makeByteSim();
    const logic = PartSimulationRegistry.get('gps-neo6m')!;
    const cleanup = logic.attachEvents!(
      makeElement(),
      sim as never,
      (name) => (name === 'TX' ? 0 : null),
      GPS_ID,
    );

    vi.advanceTimersByTime(1000);
    drainFeed();
    sim.fed.length = 0;

    dispatchSensorUpdate(GPS_ID, { lat: -33.4489, lng: -70.6693 }); // Santiago
    vi.advanceTimersByTime(1000);
    drainFeed();
    cleanup();

    const text = sim.fed.map((c) => c.data).join('');
    expect(text).toContain(',S,');
    expect(text).toContain('3326.93400,S');
  });

  it('pulses the PPS LED once per emission', () => {
    wireGpsTo('arduino-uno', '0');
    const sim = makeByteSim();
    const el = makeElement() as unknown as { pps?: boolean };
    const logic = PartSimulationRegistry.get('gps-neo6m')!;
    const cleanup = logic.attachEvents!(
      el as unknown as HTMLElement,
      sim as never,
      (name) => (name === 'TX' ? 0 : null),
      GPS_ID,
    );

    vi.advanceTimersByTime(1000);
    expect(el.pps).toBe(true);
    vi.advanceTimersByTime(200);
    expect(el.pps).toBe(false);
    cleanup();
  });
});

// ─── Bit-banged waveform (SoftwareSerial path) ───────────────────────────────

interface Transition {
  pin: number;
  state: boolean;
  cycle: number;
}

function makeBitbangSim() {
  const scheduled: Transition[] = [];
  return {
    isRunning: () => true,
    setPinState: vi.fn(),
    pinManager: { onPinChange: vi.fn().mockReturnValue(() => {}) },
    getCurrentCycles: () => 0,
    getClockHz: () => 16_000_000,
    schedulePinChange: vi.fn((pin: number, state: boolean, cycle: number) => {
      scheduled.push({ pin, state, cycle });
    }),
    scheduled,
  };
}

/**
 * Decode a contiguous 8N1 bitstream from scheduled transitions. Bytes are
 * back-to-back: byte k's start bit begins at `t0 + k * 10 * cyclesPerBit`
 * where t0 is the first LOW transition. Bits are sampled at bit centres.
 */
function decodeUart(transitions: Transition[], cyclesPerBit: number, count: number): string {
  const sorted = [...transitions].sort((a, b) => a.cycle - b.cycle);
  const lineState = (cycle: number): boolean => {
    let state = true; // idle HIGH
    for (const t of sorted) {
      if (t.cycle <= cycle) state = t.state;
      else break;
    }
    return state;
  };
  const t0 = sorted.find((t) => !t.state)!.cycle;
  let out = '';
  for (let k = 0; k < count; k++) {
    const byteStart = t0 + k * 10 * cyclesPerBit;
    expect(lineState(byteStart + 0.5 * cyclesPerBit)).toBe(false); // start bit
    let byte = 0;
    for (let b = 0; b < 8; b++) {
      if (lineState(byteStart + (1.5 + b) * cyclesPerBit)) byte |= 1 << b;
    }
    expect(lineState(byteStart + 9.5 * cyclesPerBit)).toBe(true); // stop bit
    out += String.fromCharCode(byte);
  }
  return out;
}

describe('gps-neo6m — bit-banged SoftwareSerial path', () => {
  it('scheduleUartBitstream produces a decodable 9600-baud 8N1 frame', () => {
    const sim = makeBitbangSim();
    const tail = { cycle: 0, lastNow: 0 };
    scheduleUartBitstream(sim, 4, '$GP', tail);

    const cyclesPerBit = 16_000_000 / GPS_BAUD;
    expect(decodeUart(sim.scheduled, cyclesPerBit, 3)).toBe('$GP');
    expect(sim.scheduled.every((t) => t.pin === 4)).toBe(true);
    // Tail advanced by 3 bytes × 10 bits.
    expect(tail.cycle).toBeGreaterThanOrEqual(30 * cyclesPerBit);
  });

  it('skips emission instead of growing an unbounded backlog', () => {
    const sim = makeBitbangSim();
    const tail = { cycle: 100 * 16_000_000, lastNow: 0 };
    scheduleUartBitstream(sim, 4, 'X', tail);
    // now(0) < lastNow(0) is false and tail is > now + 2 s → skip.
    expect(sim.schedulePinChange).not.toHaveBeenCalled();
  });

  it('resets the tail after a CPU reset (cycle counter went backwards)', () => {
    const sim = makeBitbangSim();
    const tail = { cycle: 100 * 16_000_000, lastNow: 99 * 16_000_000 };
    scheduleUartBitstream(sim, 4, 'A', tail); // now = 0 < lastNow → reset tail
    expect(sim.schedulePinChange).toHaveBeenCalled();
    const first = sim.scheduled[0];
    expect(first.cycle).toBeLessThan(16_000_000); // scheduled near now, not at 100 s
  });

  it('falls back to bit-bang when feedUart rejects the UART (Mega RX1)', () => {
    // Mega pin 19 = RX1 (USART1) — avr8js only models USART0, so the AVR
    // sim's feedUart returns false. The part must degrade to the bit-banged
    // waveform so SoftwareSerial on pin 19 still receives the stream.
    wireGpsTo('arduino-mega', '19');
    const sim = {
      ...makeBitbangSim(),
      feedUart: vi.fn(() => false),
    };
    const logic = PartSimulationRegistry.get('gps-neo6m')!;
    const cleanup = logic.attachEvents!(
      makeElement(),
      sim as never,
      (name) => (name === 'TX' ? 19 : null),
      GPS_ID,
    );

    // Cycle 1: byte path tried once, rejected, queue dropped.
    vi.advanceTimersByTime(1000);
    drainFeed();
    expect(sim.feedUart).toHaveBeenCalledWith(1, expect.any(String));
    expect(sim.schedulePinChange).not.toHaveBeenCalled();

    // Cycle 2 onward: bit-banged on pin 19.
    vi.advanceTimersByTime(1000);
    cleanup();
    expect(sim.schedulePinChange).toHaveBeenCalled();
    expect(sim.scheduled.every((t) => t.pin === 19)).toBe(true);
    const cyclesPerBit = 16_000_000 / GPS_BAUD;
    expect(decodeUart(sim.scheduled, cyclesPerBit, 6)).toBe('$GPGGA');
  });

  it('TX wired to a plain digital pin bit-bangs the NMEA cycle', () => {
    wireGpsTo('arduino-uno', '4');
    const sim = makeBitbangSim();
    const logic = PartSimulationRegistry.get('gps-neo6m')!;
    const cleanup = logic.attachEvents!(
      makeElement(),
      sim as never,
      (name) => (name === 'TX' ? 4 : null),
      GPS_ID,
    );

    // Line seeded at idle HIGH for SoftwareSerial.
    expect(sim.setPinState).toHaveBeenCalledWith(4, true);

    vi.advanceTimersByTime(1000);
    cleanup();

    expect(sim.schedulePinChange).toHaveBeenCalled();
    const cyclesPerBit = 16_000_000 / GPS_BAUD;
    const head = decodeUart(sim.scheduled, cyclesPerBit, 6);
    expect(head).toBe('$GPGGA');
  });
});
