/**
 * Dual Raspberry Pi Pico W — Serial1 (UART0) passthrough
 * =====================================================
 *
 * Reproduces the user-reported bug:
 *   https://velxio.dev/project/cb406120-d40e-4225-bbfd-1b362a64445a
 *
 * Setup:
 *   - Two Raspberry Pi Pico W boards
 *   - Wires: GND<->GND, picoA.GP0(TX) <-> picoB.GP1(RX),
 *                       picoA.GP1(RX) <-> picoB.GP0(TX)
 *   - Sketch: standard Arduino "SerialPassthrough" example on both boards
 *       loop() {
 *         if (Serial.available())  Serial1.write(Serial.read());
 *         if (Serial1.available()) Serial.write(Serial1.read());
 *       }
 *
 * Expected behaviour:
 *   A byte written to picoA's USB Serial -> picoA's Serial1 TX (GP0)
 *     -> wire -> picoB's Serial1 RX (GP1) -> picoB's USB Serial output
 *
 * Observed behaviour (bug):
 *   The cross-board UART bridge in `useSimulatorStore.addBoard` only forwards
 *   AVR/RP2040 TX bytes to **Raspberry Pi 3B bridges** (`bridgeMap`) and never
 *   to other RP2040 / AVR / RiscV simulators. The wire list itself is also
 *   ignored — routing is broadcast, not wire-based — but even with broadcast,
 *   simulator-to-simulator delivery is missing, so two Picos can never talk
 *   over Serial1.
 *
 * This test pins down the broken behaviour so a future fix can flip the
 * `expect(...).toBe(0)` assertions to `toBe(1)` once the implementation
 * routes UART bytes between simulators along the actual wires.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────
// We don't run real rp2040js / avr8js here — we just need stubs that expose
// the same surface the store wires up (onSerialData, serialWrite, ...).

vi.mock('../simulation/AVRSimulator', () => ({
  AVRSimulator: vi.fn(function (this: any) {
    this.onSerialData = null;
    this.onBaudRateChange = null;
    this.onPinChangeWithTime = null;
    this.start = vi.fn();
    this.stop = vi.fn();
    this.reset = vi.fn();
    this.loadHex = vi.fn();
    this.serialWrite = vi.fn();
    this.feedUart = vi.fn();
    this.addI2CDevice = vi.fn();
    this.setPinState = vi.fn();
  }),
}));

vi.mock('../simulation/RP2040Simulator', () => ({
  RP2040Simulator: vi.fn(function (this: any) {
    this.onSerialData = null;
    this.onUartByte = null;
    this.onPinChangeWithTime = null;
    this.start = vi.fn();
    this.stop = vi.fn();
    this.reset = vi.fn();
    this.loadBinary = vi.fn();
    this.serialWrite = vi.fn();
    this.feedUart = vi.fn();
    this.addI2CDevice = vi.fn();
    this.setPinState = vi.fn();
    this.attachPioPeripheral = vi.fn();
    this.spi = { onByte: null, completeTransfer: vi.fn() };
  }),
}));

vi.mock('../simulation/RiscVSimulator', () => ({
  RiscVSimulator: vi.fn(function (this: any) {
    this.onSerialData = null;
    this.serialWrite = vi.fn();
    this.feedUart = vi.fn();
    this.start = vi.fn();
    this.stop = vi.fn();
    this.reset = vi.fn();
    this.setPinState = vi.fn();
  }),
}));

vi.mock('../simulation/Esp32C3Simulator', () => ({
  Esp32C3Simulator: vi.fn(function (this: any) {
    this.onSerialData = null;
    this.serialWrite = vi.fn();
    this.feedUart = vi.fn();
    this.start = vi.fn();
    this.stop = vi.fn();
    this.reset = vi.fn();
    this.setPinState = vi.fn();
  }),
}));

// PinManager is left UNMOCKED so the Interconnect can use it normally.

vi.mock('../simulation/I2CBusManager', async () => {
  const actual = await vi.importActual<typeof import('../simulation/I2CBusManager')>(
    '../simulation/I2CBusManager',
  );
  return actual;
});

vi.mock('../store/useOscilloscopeStore', () => ({
  useOscilloscopeStore: {
    getState: vi.fn().mockReturnValue({ channels: [], pushSample: vi.fn() }),
  },
}));

vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 1);
vi.stubGlobal('cancelAnimationFrame', vi.fn());

// ── Imports (after mocks) ────────────────────────────────────────────────
import { setWires, resetStore, clearAllPinManagerState } from './helpers/multiBoardSetup';
import { resetInterconnect } from '../simulation/Interconnect';
import {
  useSimulatorStore,
  getBoardSimulator,
  getBoardBridge,
  getBoardPinManager,
} from '../store/useSimulatorStore';
import { RP2040Simulator } from '../simulation/RP2040Simulator';

function fullReset() {
  clearAllPinManagerState(useSimulatorStore, getBoardPinManager);
  resetInterconnect();
  resetStore(useSimulatorStore);
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Build the two Pico W boards + the user's wire setup
 * (GND<->GND, GP0<->GP1, GP1<->GP0) and return the board ids.
 *
 * Mirrors what the user did at
 *   https://velxio.dev/project/cb406120-d40e-4225-bbfd-1b362a64445a
 */
function setupTwoPicosWithSerial1Crossover(): { picoA: string; picoB: string } {
  const store = useSimulatorStore.getState();

  // The store ships with a default Arduino Uno board — replace it with our Picos.
  // We add two Pico W boards. The first will get id 'pi-pico-w', the second
  // 'pi-pico-w-2' (per addBoard's id-collision rule).
  const picoA = store.addBoard('pi-pico-w', 100, 100);
  const picoB = store.addBoard('pi-pico-w', 400, 100);

  // Build the wires the user drew. Pin names match the wokwi-elements
  // pi-pico-w element conventions (GP0/GP1/GND).
  const wires = [
    {
      id: 'w-gnd',
      start: { componentId: picoA, pinName: 'GND', x: 0, y: 0 },
      end: { componentId: picoB, pinName: 'GND', x: 0, y: 0 },
      color: 'black',
      signalType: 'power-gnd' as const,
    },
    {
      id: 'w-a-tx-to-b-rx',
      start: { componentId: picoA, pinName: 'GP0', x: 0, y: 0 }, // A.UART0.TX
      end: { componentId: picoB, pinName: 'GP1', x: 0, y: 0 },   // B.UART0.RX
      color: 'green',
      signalType: 'digital' as const,
    },
    {
      id: 'w-b-tx-to-a-rx',
      start: { componentId: picoB, pinName: 'GP0', x: 0, y: 0 }, // B.UART0.TX
      end: { componentId: picoA, pinName: 'GP1', x: 0, y: 0 },   // A.UART0.RX
      color: 'yellow',
      signalType: 'digital' as const,
    },
  ];
  useSimulatorStore.setState({ wires });

  return { picoA, picoB };
}

// ─────────────────────────────────────────────────────────────────────────
// Scenario 1 — physical wire setup is correct
// ─────────────────────────────────────────────────────────────────────────

describe('Dual Pico W — wire topology', () => {
  beforeEach(() => {
    fullReset();
  });

  it('builds two Pico W simulator instances', () => {
    const { picoA, picoB } = setupTwoPicosWithSerial1Crossover();
    const simA = getBoardSimulator(picoA);
    const simB = getBoardSimulator(picoB);
    expect(simA).toBeInstanceOf(RP2040Simulator);
    expect(simB).toBeInstanceOf(RP2040Simulator);
    expect(simA).not.toBe(simB);
  });

  it('wires GP0 ↔ GP1 between the two Picos as the user described', () => {
    const { picoA, picoB } = setupTwoPicosWithSerial1Crossover();
    const { wires } = useSimulatorStore.getState();

    // A.GP0 (TX) → B.GP1 (RX)
    const aTxToBRx = wires.find(
      (w) =>
        w.start.componentId === picoA &&
        w.start.pinName === 'GP0' &&
        w.end.componentId === picoB &&
        w.end.pinName === 'GP1',
    );
    expect(aTxToBRx, 'GP0(A) → GP1(B) wire missing').toBeDefined();

    // B.GP0 (TX) → A.GP1 (RX)
    const bTxToARx = wires.find(
      (w) =>
        w.start.componentId === picoB &&
        w.start.pinName === 'GP0' &&
        w.end.componentId === picoA &&
        w.end.pinName === 'GP1',
    );
    expect(bTxToARx, 'GP0(B) → GP1(A) wire missing').toBeDefined();

    // Common GND
    const gnd = wires.find(
      (w) =>
        (w.start.componentId === picoA && w.start.pinName === 'GND') ||
        (w.end.componentId === picoA && w.end.pinName === 'GND'),
    );
    expect(gnd, 'GND ↔ GND wire missing').toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Scenario 2 — UART byte routing across the wire (THE BUG)
// ─────────────────────────────────────────────────────────────────────────
//
// The SerialPassthrough sketch on picoA reads from USB Serial and writes the
// byte to Serial1 (UART0). The RP2040Simulator surfaces every UART0/UART1 TX
// byte through `onSerialData`. For the user's circuit to work, that byte
// MUST end up calling `picoB.serialWrite()` (which feeds picoB's UART0 RX
// FIFO) — and vice versa.
//
// Today the store's cross-board bridge only forwards AVR/RP2040 TX to
// **Pi3B bridges** (`bridgeMap`). No simulator-to-simulator delivery exists,
// so two Picos can never communicate. These tests document that fact.

describe('Dual Pico W — Serial1 passthrough across wires', () => {
  beforeEach(() => {
    fullReset();
  });

  it('byte emitted by picoA Serial1 TX reaches picoB Serial1 RX', () => {
    const { picoA, picoB } = setupTwoPicosWithSerial1Crossover();
    const simA = getBoardSimulator(picoA) as any;
    const simB = getBoardSimulator(picoB) as any;
    expect(simA?.onSerialData, 'picoA must have a serial output handler').toBeTypeOf('function');

    simA.onSerialData('H');

    // simB's UART0 RX must receive 'H' via either feedUart(0,'H') or serialWrite('H')
    const fed =
      (simB.feedUart as any).mock.calls.some((c: any[]) => c[0] === 0 && c[1] === 'H') ||
      (simB.serialWrite as any).mock.calls.some((c: any[]) => c[0] === 'H');
    expect(fed).toBe(true);
  });

  it('byte emitted by picoB Serial1 TX reaches picoA Serial1 RX', () => {
    const { picoA, picoB } = setupTwoPicosWithSerial1Crossover();
    const simA = getBoardSimulator(picoA) as any;
    const simB = getBoardSimulator(picoB) as any;

    simB.onSerialData('Z');

    const fed =
      (simA.feedUart as any).mock.calls.some((c: any[]) => c[0] === 0 && c[1] === 'Z') ||
      (simA.serialWrite as any).mock.calls.some((c: any[]) => c[0] === 'Z');
    expect(fed).toBe(true);
  });

  it('a multi-byte burst sent on picoA Serial1 is fully delivered, in order', () => {
    const { picoA, picoB } = setupTwoPicosWithSerial1Crossover();
    const simA = getBoardSimulator(picoA) as any;
    const simB = getBoardSimulator(picoB) as any;

    for (const ch of 'Hello') simA.onSerialData(ch);

    const chars = [
      ...(simB.feedUart as any).mock.calls.filter((c: any[]) => c[0] === 0).map((c: any[]) => c[1]),
      ...(simB.serialWrite as any).mock.calls.map((c: any[]) => c[0]),
    ];
    expect(chars.join('')).toContain('Hello');
  });

  it('Pi3B UART0 TX → Uno USART0 RX along an explicit wire', () => {
    // Wire the Pi3B's UART0 TX (BCM14, physical pin 8) to Uno.D0 (USART0 RX).
    // This is now the only path — the previous broadcast behaviour has been
    // replaced by wire-aware routing.
    //
    // A QEMU-Linux board has TWO serial streams and only one of them is on
    // the header: `onUartTx` is what the script writes to /dev/serial0, while
    // `onSerialData` is the console (boot chatter, the shell prompt, the
    // script's stdout). This test used to feed the console and expect the
    // peer to see it, which is exactly the leak that got fixed — the Uno was
    // being handed the guest's login banner as if it were data.
    fullReset();
    const store = useSimulatorStore.getState();
    const arduinoId = store.boards[0].id;
    const piId = store.addBoard('raspberry-pi-3', 300, 100);
    setWires(useSimulatorStore, [
      { fromBoard: piId, fromPin: '8', toBoard: arduinoId, toPin: 'D0' },
    ]);

    const arduinoSim = getBoardSimulator(arduinoId) as any;
    const piBridge = getBoardBridge(piId) as any;
    expect(typeof piBridge.onUartTx).toBe('function');

    piBridge.onUartTx('A');

    const fedFromUart = () =>
      (arduinoSim.feedUart as any).mock.calls.some(
        (c: any[]) => c[0] === 0 && c[1] === 'A',
      ) || (arduinoSim.serialWrite as any).mock.calls.some((c: any[]) => c[0] === 'A');
    expect(fedFromUart()).toBe(true);
  });

  it("the Pi's console output stays off the wire", () => {
    fullReset();
    const store = useSimulatorStore.getState();
    const arduinoId = store.boards[0].id;
    const piId = store.addBoard('raspberry-pi-3', 300, 100);
    setWires(useSimulatorStore, [
      { fromBoard: piId, fromPin: '8', toBoard: arduinoId, toPin: 'D0' },
    ]);

    const arduinoSim = getBoardSimulator(arduinoId) as any;
    const piBridge = getBoardBridge(piId) as any;

    // What the guest prints to its terminal ('login:' during boot) must not
    // reach the peer board, even though the TX wire is there.
    piBridge.onSerialData?.('Q');

    const leaked =
      (arduinoSim.feedUart as any).mock.calls.some((c: any[]) => c[1] === 'Q') ||
      (arduinoSim.serialWrite as any).mock.calls.some((c: any[]) => c[0] === 'Q');
    expect(leaked).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Scenario 3 — what the fix should look like (specification, currently skipped)
// ─────────────────────────────────────────────────────────────────────────
//
// Once cross-board UART routing respects the wire list AND covers
// simulator-to-simulator paths, flip these `it.skip` to `it`.

describe('Dual Pico W — Serial1 passthrough (target behaviour, post-fix)', () => {
  beforeEach(() => {
    fullReset();
  });

  it('picoA Serial1 TX (GP0) feeds picoB Serial1 RX (GP1) along the wire', () => {
    const { picoA, picoB } = setupTwoPicosWithSerial1Crossover();
    const simA = getBoardSimulator(picoA) as any;
    const simB = getBoardSimulator(picoB) as any;

    simA.onSerialData('H');
    simA.onSerialData('i');

    const fedB = [
      ...(simB.feedUart as any).mock.calls.filter((c: any[]) => c[0] === 0).map((c: any[]) => c[1]),
      ...(simB.serialWrite as any).mock.calls.map((c: any[]) => c[0]),
    ].join('');
    expect(fedB).toContain('Hi');
    // And it must NOT echo back to picoA itself.
    expect(simA.serialWrite).not.toHaveBeenCalled();
  });

  it('picoB Serial1 TX (GP0) feeds picoA Serial1 RX (GP1) along the wire', () => {
    const { picoA, picoB } = setupTwoPicosWithSerial1Crossover();
    const simA = getBoardSimulator(picoA) as any;
    const simB = getBoardSimulator(picoB) as any;

    simB.onSerialData('!');

    const fedA =
      (simA.feedUart as any).mock.calls.some((c: any[]) => c[0] === 0 && c[1] === '!') ||
      (simA.serialWrite as any).mock.calls.some((c: any[]) => c[0] === '!');
    expect(fedA).toBe(true);
    expect(simB.serialWrite).not.toHaveBeenCalled();
  });

  it('removing the GP0↔GP1 wire stops byte propagation', () => {
    const { picoA, picoB } = setupTwoPicosWithSerial1Crossover();
    // Drop the A.GP0 → B.GP1 wire
    useSimulatorStore.setState((s) => ({
      wires: s.wires.filter((w) => w.id !== 'w-a-tx-to-b-rx'),
    }));

    const simA = getBoardSimulator(picoA) as any;
    const simB = getBoardSimulator(picoB) as any;
    simA.onSerialData('X');

    const fedB =
      (simB.feedUart as any).mock.calls.some((c: any[]) => c[0] === 0 && c[1] === 'X') ||
      (simB.serialWrite as any).mock.calls.some((c: any[]) => c[0] === 'X');
    expect(fedB).toBe(false);
  });
});
