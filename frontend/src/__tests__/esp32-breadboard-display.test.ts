// @vitest-environment jsdom
/**
 * Reproduction of the reported "ESP32 clock through a breadboard is dead"
 * bug, using the exact circuit the agent built (fixture exported from the
 * real project). QEMU was proven to emit every GPIO edge (437 events/pin on
 * the live site) — the break is in the frontend resolution/subscription.
 *
 * These tests interrogate each stage separately so a failure names the
 * broken stage rather than just "display dead".
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { traceDetailed } from '../components/DynamicComponent';
import circuit from './fixtures/esp32-clock-circuit.json';

const BOARD = circuit.boardId;

function loadCircuit() {
  const s = useSimulatorStore.getState();
  s.setComponents(circuit.components.map((c) => ({ ...c, x: 0, y: 0 })) as never);
  s.setWires(circuit.wires.map((w) => ({
    ...w, waypoints: [], color: '#000',
    start: { ...w.start, x: 0, y: 0 }, end: { ...w.end, x: 0, y: 0 },
  })) as never);
}

describe('ESP32 + breadboard-seated 7segment (real agent circuit)', () => {
  beforeAll(() => {
    const s = useSimulatorStore.getState();
    s.addBoard('esp32' as never, 0, 0, BOARD);
    loadCircuit();
  });

  it('traceDetailed resolves every segment pin to its GPIO through the breadboard', () => {
    const state = useSimulatorStore.getState();
    const expected: Record<string, number> = {
      A: 32, B: 33, C: 25, D: 26, E: 27, F: 14, G: 12, DP: 13,
      DIG1: 15, DIG2: 2, DIG3: 4, DIG4: 5,
    };
    for (const [pin, gpio] of Object.entries(expected)) {
      const r = traceDetailed(state as never, '7segment_1', pin, 0);
      expect(r.arduinoPin, `7segment.${pin} should reach GPIO ${gpio}`).toBe(gpio);
    }
  });

  it('COM resolves to ground (-1) through the rail', () => {
    const state = useSimulatorStore.getState();
    const r = traceDetailed(state as never, '7segment_1', 'COM', 0);
    expect(r.arduinoPin).toBe(-1);
  });

  it('the esp32 board exposes a simulator with a live pinManager', () => {
    // DynamicComponent's attach effect reads store.simulator; the 7segment's
    // attachEvents bails out entirely when simulator.pinManager is missing,
    // which strands the display on the breadboard-blind onPinStateChange
    // path (single-hop isBoardComponent — never true through a breadboard).
    const s = useSimulatorStore.getState();
    s.setActiveBoardId(BOARD);
    const after = useSimulatorStore.getState();
    expect(after.simulator, 'store.simulator for the esp32 board').toBeTruthy();
    const pm = (after.simulator as { pinManager?: unknown } | null)?.pinManager;
    expect(pm, 'simulator.pinManager (attachEvents bails without it)').toBeTruthy();
  });

  it('a GPIO edge from the bridge reaches a resolver subscribed via the pinManager', () => {
    const s = useSimulatorStore.getState();
    const pm = (s.simulator as { pinManager?: {
      onPinChange: (pin: number, cb: (pin: number, state: boolean) => void) => () => void;
      triggerPinChange: (pin: number, state: boolean, source?: string) => void;
    } } | null)?.pinManager;
    expect(pm).toBeTruthy();
    let seen: boolean | null = null;
    const un = pm!.onPinChange(32, (_p, st) => { seen = st; });
    // What Esp32Bridge.onPinChange does on a gpio_change frame:
    pm!.triggerPinChange(32, true, 'mcu');
    un();
    expect(seen, 'edge on GPIO 32 must reach subscribers').toBe(true);
  });
});
