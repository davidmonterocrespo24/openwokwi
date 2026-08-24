// @vitest-environment jsdom
/**
 * Reported bug: an HC-SR04 on an ESP32-S3 works when ECHO goes straight to the
 * GPIO, and answers "No echo" forever the moment the user inserts the 1k/2k2
 * divider that the real 5 V sensor needs — the wiring you are supposed to use.
 *
 * The circuit below is the reported project verbatim
 * (velxio.dev/martijn-kuipers/esp32-s3-distance):
 *
 *     ECHO ──[1k]──┬──[2k2]── GND
 *                  └──────── GPIO41
 *
 * Two separate resolvers were blind to it:
 *
 *  1. the wire walk crossed the top resistor, crossed the bottom one, hit GND
 *     and reported "tied to a rail" — never looking at the OTHER wire on the
 *     tap, where the GPIO was;
 *  2. the backend sensor pre-registration in startBoard read a single wire's
 *     far end, so ECHO (which lands on a resistor) resolved to nothing and the
 *     QEMU worker fell back to TRIG+1 — pulsing GPIO22, which nobody reads.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (same shape as esp32-integration.test.ts) ─────────────────────────
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
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  get messages(): Array<{ type: string; data: Record<string, unknown> }> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);
vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 1);
vi.stubGlobal('cancelAnimationFrame', vi.fn());

import { useSimulatorStore, getEsp32Bridge } from '../store/useSimulatorStore';
import { traceDetailed, traceBoardGpio } from '../simulation/PinTrace';

const BOARD = 'esp32-s3';
const SENSOR = 'hc_sr04_1';
const R_TOP = 'resistor_1k_1'; // ECHO → tap
const R_BOTTOM = 'resistor_2k2_1'; // tap → GND

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

/** The reported project: 5 V sensor, TRIG straight to GPIO21, ECHO through a
 *  1k/2k2 divider whose tap carries the wire to GPIO41. */
function loadDividerCircuit() {
  const s = useSimulatorStore.getState();
  s.setComponents([
    { id: SENSOR, metadataId: 'hc-sr04', x: 0, y: 0, properties: {} },
    { id: R_TOP, metadataId: 'resistor-1k', x: 0, y: 0, properties: { value: '1000' } },
    { id: R_BOTTOM, metadataId: 'resistor-2k2', x: 0, y: 0, properties: { value: '2200' } },
  ] as never);
  s.setWires([
    wire('w1', [BOARD, '5V'], [SENSOR, 'VCC']),
    wire('w2', [SENSOR, 'TRIG'], [BOARD, '21']),
    wire('w3', [BOARD, 'GND.4'], [SENSOR, 'GND']),
    wire('w4', [SENSOR, 'ECHO'], [R_TOP, '1']),
    wire('w5', [R_TOP, '2'], [R_BOTTOM, '1']),
    wire('w6', [BOARD, 'GND.4'], [R_BOTTOM, '2']),
    wire('w7', [BOARD, '41'], [R_BOTTOM, '1']),
  ] as never);
}

describe('HC-SR04 behind a 1k/2k2 level-shifting divider', () => {
  beforeEach(() => {
    useSimulatorStore.setState({ boards: [], components: [], wires: [] } as never);
    useSimulatorStore.getState().addBoard('esp32-s3' as never, 0, 0, BOARD);
    loadDividerCircuit();
  });

  it('traces ECHO through both resistors to GPIO41, not to the GND leg', () => {
    const state = useSimulatorStore.getState();
    const echo = traceDetailed(state as never, SENSOR, 'ECHO', 0);
    expect(echo.arduinoPin, 'ECHO reaches GPIO41 across the divider tap').toBe(41);
    expect(echo.boardId).toBe(BOARD);
  });

  it('still traces the directly wired TRIG to GPIO21', () => {
    const state = useSimulatorStore.getState();
    expect(traceDetailed(state as never, SENSOR, 'TRIG', 0).arduinoPin).toBe(21);
  });

  it('reports a rail (-1) only for a pin that reaches nothing else', () => {
    const state = useSimulatorStore.getState();
    // The sensor's own GND pad: a rail is the honest answer there.
    expect(traceDetailed(state as never, SENSOR, 'GND', 0).arduinoPin).toBe(-1);
    // traceBoardGpio speaks only of real GPIOs, so a rail is "no GPIO".
    expect(traceBoardGpio(state as never, SENSOR, 'GND')).toBeNull();
  });

  it('pre-registers the sensor with echo_pin 41 in the start_esp32 payload', () => {
    const bridge = getEsp32Bridge(BOARD)!;
    useSimulatorStore.getState().startBoard(BOARD);
    const socket = (bridge as unknown as { socket: MockWebSocket }).socket;
    socket.open();
    const start = socket.messages.find((m) => m.type === 'start_esp32');
    expect(start, 'start_esp32 was sent').toBeDefined();
    const sensors = start!.data.sensors as Array<Record<string, unknown>>;
    expect(sensors).toContainEqual(
      expect.objectContaining({ sensor_type: 'hc-sr04', pin: 21, echo_pin: 41 }),
    );
  });
});

describe('a data pin whose first wire is a pull-up', () => {
  beforeEach(() => {
    useSimulatorStore.setState({ boards: [], components: [], wires: [] } as never);
    useSimulatorStore.getState().addBoard('esp32-s3' as never, 0, 0, BOARD);
    const s = useSimulatorStore.getState();
    s.setComponents([
      { id: 'dht22_1', metadataId: 'dht22', x: 0, y: 0, properties: {} },
      { id: 'r_pullup', metadataId: 'resistor-10k', x: 0, y: 0, properties: { value: '10000' } },
    ] as never);
    // The pull-up wire is drawn FIRST — the walk used to answer with the 3V3
    // pad it reaches through the resistor and stop looking.
    s.setWires([
      wire('p1', ['dht22_1', 'SDA'], ['r_pullup', '1']),
      wire('p2', ['r_pullup', '2'], [BOARD, '3V3']),
      wire('p3', ['dht22_1', 'SDA'], [BOARD, '4']),
    ] as never);
  });

  it('resolves the GPIO, not the supply pad behind the resistor', () => {
    const state = useSimulatorStore.getState();
    expect(traceDetailed(state as never, 'dht22_1', 'SDA', 0).arduinoPin).toBe(4);
  });
});
