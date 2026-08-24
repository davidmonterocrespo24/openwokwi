// @vitest-environment jsdom
/**
 * Per-board regression net for the wire walk (simulation/PinTrace).
 *
 * The HC-SR04 divider bug (see hcsr04-divider-echo.test.ts) was reported on an
 * ESP32-S3, but nothing about it is ESP32-specific: the walk is shared by every
 * board family, and the two behaviours the fix introduced — exploring the whole
 * NODE instead of following a chain, and demoting a supply pad to the weakest
 * possible answer — can regress on one family while the reported board keeps
 * working. Each board here re-plays the same shapes through its own
 * boardPinToNumber naming ('7', 'GP15', 'PC13', bare GPIO numbers).
 *
 * The shapes, and why each one is here:
 *
 *  - the level-shifting divider          ECHO ─[1k]─┬─[2k2]─ GND
 *                                                   └─────── GPIO
 *    the tap carries TWO wires; the walk must look at the other one instead of
 *    answering "tied to a rail" with the first branch that reaches GND.
 *
 *  - the pull-up drawn BEFORE the signal wire: same demotion, without a
 *    divider, and with the rail sitting on the FIRST wire the walk sees.
 *
 *  - a pad that genuinely reaches nothing but a rail must STILL answer -1
 *    (an LED cathode returning a GPIO would be a worse bug than the one fixed),
 *    and a diode must not be traced through the way a resistor is.
 *
 *  - a breadboard strip: the pre-existing multi-hole hop, guarded here so the
 *    node-walk rewrite cannot quietly cost us the ESP32 clock circuit.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (same shape as hcsr04-divider-echo.test.ts) ───────────────────────
// addBoard builds a real simulator / bridge per family; none of them is under
// test here, and the AVR and RP2040 ones pull in WASM.
vi.mock('../simulation/AVRSimulator', () => ({
  AVRSimulator: vi.fn(function (this: any) {
    this.onSerialData = null;
    this.onBaudRateChange = null;
    this.onPinChangeWithTime = null;
    this.start = vi.fn();
    this.stop = vi.fn();
    this.reset = vi.fn();
    this.loadHex = vi.fn();
    this.addI2CDevice = vi.fn();
    this.setPinState = vi.fn();
  }),
}));

vi.mock('../simulation/RP2040Simulator', () => ({
  RP2040Simulator: vi.fn(function (this: any) {
    this.onSerialData = null;
    this.onPinChangeWithTime = null;
    this.start = vi.fn();
    this.stop = vi.fn();
    this.reset = vi.fn();
    this.loadBinary = vi.fn();
    this.addI2CDevice = vi.fn();
    this.attachPioPeripheral = vi.fn();
    this.spi = { onByte: null, completeTransfer: vi.fn() };
  }),
}));

vi.mock('../simulation/PinManager', () => ({
  PinManager: vi.fn(function (this: any) {
    this.updatePort = vi.fn();
    this.onPinChange = vi.fn().mockReturnValue(() => {});
    this.getListenersCount = vi.fn().mockReturnValue(0);
    this.hardResetPinStates = vi.fn();
    this.resetPinStates = vi.fn();
    this.getOutputPins = vi.fn().mockReturnValue(new Set<number>());
  }),
}));

vi.mock('../store/useOscilloscopeStore', () => ({
  useOscilloscopeStore: {
    getState: vi.fn().mockReturnValue({ channels: [], pushSample: vi.fn() }),
  },
}));

class MockWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);
vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 1);
vi.stubGlobal('cancelAnimationFrame', vi.fn());

import { useSimulatorStore } from '../store/useSimulatorStore';
import { traceDetailed, traceBoardGpio } from '../simulation/PinTrace';
import { boardPinToNumber } from '../utils/boardPinMapping';
import { isStm32BoardKind } from '../types/board';

function wire(
  id: string,
  a: [string, string],
  b: [string, string],
): Record<string, unknown> {
  return {
    id,
    waypoints: [],
    color: '#000',
    start: { componentId: a[0], pinName: a[1], x: 0, y: 0 },
    end: { componentId: b[0], pinName: b[1], x: 0, y: 0 },
  };
}

/** Fresh canvas with exactly one board. The store is a module singleton, so a
 *  leftover board from the previous describe would give the walk a second
 *  place to land. */
function freshCanvas(boardKind: string, boardId: string) {
  useSimulatorStore.setState({ boards: [], components: [], wires: [] } as never);
  useSimulatorStore.getState().addBoard(boardKind as never, 0, 0, boardId);
}

function trace(componentId: string, pinName: string) {
  return traceDetailed(useSimulatorStore.getState() as never, componentId, pinName, 0);
}

/** The reported divider, parameterised by board: the sensor's ECHO goes into
 *  the top resistor, the bottom one goes to GND, and the GPIO hangs off the
 *  tap between them. Returns the wires so a caller can append its own. */
function dividerWires(
  boardId: string,
  gndPad: string,
  gpioPad: string,
): Array<Record<string, unknown>> {
  return [
    wire('d1', ['sensor', 'ECHO'], ['r_top', '1']),
    wire('d2', ['r_top', '2'], ['r_bottom', '1']),
    wire('d3', [boardId, gndPad], ['r_bottom', '2']),
    wire('d4', [boardId, gpioPad], ['r_bottom', '1']),
  ];
}

const DIVIDER_PARTS = [
  { id: 'sensor', metadataId: 'hc-sr04', x: 0, y: 0, properties: {} },
  { id: 'r_top', metadataId: 'resistor-1k', x: 0, y: 0, properties: { value: '1000' } },
  { id: 'r_bottom', metadataId: 'resistor-2k2', x: 0, y: 0, properties: { value: '2200' } },
];

// ── Arduino Uno (AVR, bare digital pin names) ───────────────────────────────
describe('arduino-uno', () => {
  const BOARD = 'arduino-uno';

  beforeEach(() => {
    freshCanvas('arduino-uno', BOARD);
    const s = useSimulatorStore.getState();
    s.setComponents([
      ...DIVIDER_PARTS,
      { id: 'led1', metadataId: 'led', x: 0, y: 0, properties: {} },
      { id: 'r_led', metadataId: 'resistor-220', x: 0, y: 0, properties: { value: '220' } },
    ] as never);
    s.setWires([
      wire('u1', [BOARD, '5V'], ['sensor', 'VCC']),
      wire('u2', ['sensor', 'TRIG'], [BOARD, '9']),
      wire('u3', [BOARD, 'GND.1'], ['sensor', 'GND']),
      ...dividerWires(BOARD, 'GND.1', '7'),
      // A perfectly ordinary LED: anode on D13, cathode to GND through 220R.
      wire('u4', [BOARD, '13'], ['led1', 'A']),
      wire('u5', ['led1', 'C'], ['r_led', '1']),
      wire('u6', ['r_led', '2'], [BOARD, 'GND.1']),
    ] as never);
  });

  it('traces ECHO across the 1k/2k2 divider to D7', () => {
    const echo = trace('sensor', 'ECHO');
    expect(echo.arduinoPin, 'ECHO must reach D7 through the tap').toBe(7);
    expect(echo.boardId).toBe(BOARD);
  });

  it('traces the directly wired TRIG to D9', () => {
    expect(trace('sensor', 'TRIG').arduinoPin).toBe(9);
  });

  it('still answers -1 for an LED cathode that only reaches GND', () => {
    // Two ways this could regress: the walk crossing the LED (a diode is not a
    // passive the digital layer may traverse, so D13 must NOT come back), or
    // railHit being dropped now that it no longer returns inline.
    const cathode = trace('led1', 'C');
    expect(cathode.arduinoPin, 'the cathode net is the GND rail, nothing else').toBe(-1);
    expect(traceBoardGpio(useSimulatorStore.getState() as never, 'led1', 'C')).toBeNull();
  });
});

// ── Raspberry Pi Pico (RP2040, 'GPnn' pad names) ────────────────────────────
describe('raspberry-pi-pico', () => {
  const BOARD = 'raspberry-pi-pico';

  beforeEach(() => {
    freshCanvas('raspberry-pi-pico', BOARD);
    const s = useSimulatorStore.getState();
    s.setComponents(DIVIDER_PARTS as never);
    s.setWires([
      wire('p1', [BOARD, 'VSYS'], ['sensor', 'VCC']),
      wire('p2', ['sensor', 'TRIG'], [BOARD, 'GP14']),
      wire('p3', [BOARD, 'GND.3'], ['sensor', 'GND']),
      // The pad is named 'GP15' here; the walk must hand the NAME to
      // boardPinToNumber rather than assume a bare number like the ESP32 pads.
      ...dividerWires(BOARD, 'GND.3', 'GP15'),
    ] as never);
  });

  it('traces ECHO across the divider to GP15', () => {
    const echo = trace('sensor', 'ECHO');
    expect(echo.arduinoPin).toBe(15);
    expect(echo.boardId).toBe(BOARD);
  });

  it('traces the directly wired TRIG to GP14', () => {
    expect(trace('sensor', 'TRIG').arduinoPin).toBe(14);
  });
});

// ── A pull-up drawn before the signal wire ──────────────────────────────────
// Wire ORDER is the whole point: the first wire on the pin leads to a supply
// pad through a resistor, so a walk that returns the first non-null answer
// reports "rail" and the GPIO on the second wire is never seen.
describe('a pull-up drawn before the signal wire', () => {
  const CASES: Array<{ kind: string; id: string; rail: string; gpio: string; expect: number }> = [
    { kind: 'arduino-uno', id: 'arduino-uno', rail: '5V', gpio: '2', expect: 2 },
    { kind: 'esp32', id: 'esp32', rail: '3V3', gpio: '4', expect: 4 },
  ];

  for (const c of CASES) {
    it(`resolves the GPIO, not the ${c.rail} pad behind the resistor (${c.kind})`, () => {
      freshCanvas(c.kind, c.id);
      const s = useSimulatorStore.getState();
      s.setComponents([
        { id: 'dht', metadataId: 'dht22', x: 0, y: 0, properties: {} },
        { id: 'r_pu', metadataId: 'resistor-10k', x: 0, y: 0, properties: { value: '10000' } },
      ] as never);
      s.setWires([
        wire('a1', ['dht', 'SDA'], ['r_pu', '1']),
        wire('a2', ['r_pu', '2'], [c.id, c.rail]),
        wire('a3', ['dht', 'SDA'], [c.id, c.gpio]),
      ] as never);
      const hit = trace('dht', 'SDA');
      expect(hit.arduinoPin).toBe(c.expect);
      expect(hit.boardId).toBe(c.id);
    });
  }
});

// ── STM32 ('PA0' / 'PC13' port-pin names) ───────────────────────────────────
// The family only reaches the walk if boardPinToNumber knows its pad names;
// check that first so a missing mapping reads as "skipped", not as a trace bug.
const STM32_KIND = 'stm32-bluepill';
const STM32_PA0 = boardPinToNumber(STM32_KIND, 'PA0');
const STM32_PC13 = boardPinToNumber(STM32_KIND, 'PC13');
const STM32_MAPPED =
  isStm32BoardKind(STM32_KIND) && STM32_PA0 !== null && STM32_PC13 !== null;

describe.skipIf(!STM32_MAPPED)('stm32-bluepill', () => {
  const BOARD = 'stm32-bluepill';

  beforeEach(() => {
    freshCanvas(STM32_KIND, BOARD);
    const s = useSimulatorStore.getState();
    s.setComponents(DIVIDER_PARTS as never);
    s.setWires([
      wire('s1', [BOARD, '5V'], ['sensor', 'VCC']),
      wire('s2', ['sensor', 'TRIG'], [BOARD, 'PA0']),
      wire('s3', [BOARD, 'GND.1'], ['sensor', 'GND']),
      ...dividerWires(BOARD, 'GND.1', 'PC13'),
    ] as never);
  });

  it('traces ECHO across the divider to PC13', () => {
    // Linear numbering, port*16+pin — the same number Stm32Bridge speaks.
    expect(trace('sensor', 'ECHO').arduinoPin).toBe(STM32_PC13);
  });

  it('traces the directly wired TRIG to PA0', () => {
    // PA0 is linear 0: a legitimate driven pin, and the one value that a
    // truthiness check instead of `>= 0` would silently drop.
    expect(STM32_PA0).toBe(0);
    expect(trace('sensor', 'TRIG').arduinoPin).toBe(0);
  });
});

// ── A pin that only ever reaches a supply pad ───────────────────────────────
describe('a pin that only reaches a supply pad', () => {
  const BOARD = 'esp32';

  beforeEach(() => {
    freshCanvas('esp32', BOARD);
    const s = useSimulatorStore.getState();
    s.setComponents([
      { id: 'sensor', metadataId: 'hc-sr04', x: 0, y: 0, properties: {} },
      { id: 'r_pu', metadataId: 'resistor-10k', x: 0, y: 0, properties: { value: '10000' } },
    ] as never);
    s.setWires([
      // Straight to GND.
      wire('g1', ['sensor', 'GND'], [BOARD, 'GND.4']),
      // And to 3V3 through a resistor, with no signal wire anywhere: the
      // demoted rail is the ONLY answer left, so it has to survive the walk.
      wire('g2', ['sensor', 'VCC'], ['r_pu', '1']),
      wire('g3', ['r_pu', '2'], [BOARD, '3V3']),
    ] as never);
  });

  it('answers -1 for a GND pad', () => {
    expect(trace('sensor', 'GND').arduinoPin).toBe(-1);
  });

  it('answers -1 for a 3V3 pad behind a resistor', () => {
    expect(trace('sensor', 'VCC').arduinoPin).toBe(-1);
  });

  it('reports both as "no GPIO" through traceBoardGpio', () => {
    const st = useSimulatorStore.getState() as never;
    expect(traceBoardGpio(st, 'sensor', 'GND')).toBeNull();
    expect(traceBoardGpio(st, 'sensor', 'VCC')).toBeNull();
  });
});

// ── Through a breadboard strip ──────────────────────────────────────────────
describe('through a breadboard strip', () => {
  const BOARD = 'arduino-uno';

  beforeEach(() => {
    freshCanvas('arduino-uno', BOARD);
    const s = useSimulatorStore.getState();
    s.setComponents([
      { id: 'sensor', metadataId: 'hc-sr04', x: 0, y: 0, properties: {} },
      { id: 'bb', metadataId: 'breadboard', x: 0, y: 0, properties: {} },
    ] as never);
    s.setWires([
      // Two different holes of the same 5-hole strip (column 18, top half):
      // internally shorted, with no component to trace "through".
      wire('b1', ['sensor', 'ECHO'], ['bb', '18t.a']),
      wire('b2', ['bb', '18t.e'], [BOARD, '6']),
    ] as never);
  });

  it('resolves a pin that reaches the board through a strip', () => {
    expect(trace('sensor', 'ECHO').arduinoPin).toBe(6);
  });

  it('does not invent a connection to a different column', () => {
    // col17t is a separate net; nothing is wired there, so the answer is
    // "unreached" (null) rather than a neighbouring GPIO.
    useSimulatorStore.getState().setWires([
      wire('b1', ['sensor', 'ECHO'], ['bb', '17t.a']),
      wire('b2', ['bb', '18t.e'], [BOARD, '6']),
    ] as never);
    expect(trace('sensor', 'ECHO').arduinoPin).toBeNull();
  });
});
