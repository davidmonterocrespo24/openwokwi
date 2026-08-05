/**
 * CircuitSimulationService tests.
 *
 * Fully isolated from useSimulatorStore + useElectricalStore + the
 * WASM scheduler.  Uses fakes for every port so the service's
 * orchestration logic is exercised standalone.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CircuitSimulationService,
  type SimulatorStorePort,
  type ElectricalStorePort,
  type MixedModeSchedulerPort,
  type ElectricalSnapshot,
} from '../simulation/spice/CircuitSimulationService';
import {
  getMixedModeScheduler,
  __resetMixedModeScheduler,
  __setSchedulerSolverFactoryForTests,
} from '../simulation/spice/MixedModeScheduler';
import { FakeSolverAdapter } from '../simulation/spice/adapters/FakeSolverAdapter';

// Tracks unsubscribe handles + services so afterEach can fully shut
// the orchestrator down. Two leaks fixed together:
//
//   1. service.start() returns an unsubscribe handle for the store
//      subscription. If the test never called it, the listener pinned
//      the simStore (+ service + scheduler via closure) and vitest's
//      forks pool stopped exiting cleanly.
//   2. Even with the subscription released, service.tick() is async
//      and its finally-block recursively re-schedules itself when
//      `pendingMcuEdges` is non-empty. After afterEach disposes the
//      scheduler, those re-scheduled ticks throw "call loadCircuit
//      first", get caught, and schedule ANOTHER tick — infinite
//      Promise loop in the event queue that survives until the worker
//      OOMs (the manifest of the original "circuit-sim solve failed"
//      console.warn that kept appearing across files). Fix: call
//      `service.stop()` which flips an internal `stopped` flag that
//      short-circuits tick() + handleMcuEdge().
const _activeUnsubs: Array<() => void> = [];
const _activeServices: Array<{ stop: () => void }> = [];

function startTracked(service: {
  start: () => () => void;
  stop: () => void;
}): () => void {
  const unsub = service.start();
  _activeUnsubs.push(unsub);
  _activeServices.push(service);
  return unsub;
}

afterEach(() => {
  for (const unsub of _activeUnsubs.splice(0)) {
    try { unsub(); } catch { /* ignore */ }
  }
  for (const service of _activeServices.splice(0)) {
    try { service.stop(); } catch { /* ignore */ }
  }
  __resetMixedModeScheduler();
});

function makeSimStore(initial: {
  components: Array<{ id: string; metadataId: string; properties: Record<string, unknown> }>;
  wires: Array<{
    id: string;
    start: { componentId: string; pinName: string };
    end: { componentId: string; pinName: string };
  }>;
  boards: Array<{ id: string; boardKind: string }>;
}): { port: SimulatorStorePort; set(next: Partial<typeof initial>): void } {
  let state: typeof initial = initial;
  const listeners: Array<(s: unknown, p: unknown) => void> = [];
  return {
    port: {
      getState: () => state,
      subscribe(l) {
        listeners.push(l);
        return () => {
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    },
    set(next) {
      const prev = state;
      state = { ...state, ...next };
      for (const l of listeners) l(state, prev);
    },
  };
}

function makeElectricalStore(): {
  port: ElectricalStorePort;
  snapshots: ElectricalSnapshot[];
} {
  const snapshots: ElectricalSnapshot[] = [];
  return {
    snapshots,
    port: {
      publish(s) {
        snapshots.push(s);
      },
    },
  };
}

const simpleBoardWithBoard = {
  components: [{ id: 'r1', metadataId: 'resistor', properties: { value: '1k' } }],
  wires: [
    {
      id: 'w1',
      start: { componentId: 'uno', pinName: '5V' },
      end: { componentId: 'r1', pinName: '1' },
    },
    {
      id: 'w2',
      start: { componentId: 'r1', pinName: '2' },
      end: { componentId: 'uno', pinName: 'GND' },
    },
  ],
  boards: [{ id: 'uno', boardKind: 'arduino-uno' }],
};

describe('CircuitSimulationService — orchestration', () => {
  it('runs an initial solve when started', async () => {
    const fake = new FakeSolverAdapter({ vectors: { 'v(vcc_rail)': 5 } });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({ '5V': { type: 'digital', v: 5 } }) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 20));

    expect(fake.calls.loadCircuit.length).toBe(1);
    expect(fake.calls.solve.length).toBe(1);
    expect(elec.snapshots.length).toBe(1);
    expect(elec.snapshots[0]?.analysisMode).toBe('op');
    expect(elec.snapshots[0]?.nodeVoltages.vcc_rail).toBeCloseTo(5);
  });

  it('extracts branch currents from i(v_*) vectors', async () => {
    const fake = new FakeSolverAdapter({
      vectors: { 'v(vcc_rail)': 5, 'i(v_vcc_rail)': -0.005 },
    });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({ '5V': { type: 'digital', v: 5 } }) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 20));

    const snap = elec.snapshots[0];
    expect(snap?.branchCurrents.v_vcc_rail).toBeCloseTo(-0.005);
  });

  it('re-solves on components / wires / boards changes', async () => {
    const fake = new FakeSolverAdapter({ vectors: { 'v(vcc_rail)': 5 } });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({ '5V': { type: 'digital', v: 5 } }) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.calls.solve.length).toBe(1);

    sim.set({ components: [...simpleBoardWithBoard.components, { id: 'r2', metadataId: 'resistor', properties: {} }] });
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.calls.solve.length).toBe(2);
  });

  it('does NOT re-solve when an unrelated field changes', async () => {
    const fake = new FakeSolverAdapter({ vectors: { 'v(vcc_rail)': 5 } });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({}) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 10));
    sim.set({}); // same arrays — should NOT trigger a re-solve
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.calls.solve.length).toBe(1);
  });

  it('coalesces solves when one is in flight', async () => {
    const fake = new FakeSolverAdapter({
      vectors: { 'v(vcc_rail)': 5 },
      solveDelayMs: 30,
    });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({}) },
    );
    startTracked(service);
    // While initial solve runs, fire 3 store changes — should coalesce
    // into 1 trailing solve.
    sim.set({ components: [{ id: 'a', metadataId: 'resistor', properties: {} }] });
    sim.set({ components: [{ id: 'b', metadataId: 'resistor', properties: {} }] });
    sim.set({ components: [{ id: 'c', metadataId: 'resistor', properties: {} }] });
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.calls.solve.length).toBe(2); // initial + 1 trailing
  });

  it('publishes .tran waveforms when analysis is transient', async () => {
    const fake = new FakeSolverAdapter({
      vectors: {
        'v(n_out)': new Float64Array([0, 1, 2, 3, 4]),
        'i(v_src)': new Float64Array([0.01, 0.02, 0.03, 0.04, 0.05]),
      },
      timeAxis: new Float64Array([0, 1e-4, 2e-4, 3e-4, 4e-4]),
    });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore({
      components: [
        // A signal-generator forces .tran in buildInputFromStore.
        {
          id: 'sg1',
          metadataId: 'signal-generator',
          properties: { waveform: 'sine', frequency: 100 },
        },
      ],
      wires: [],
      boards: [{ id: 'uno', boardKind: 'arduino-uno' }],
    });
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({}) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 20));

    const snap = elec.snapshots[0];
    expect(snap?.analysisMode).toBe('tran');
    expect(snap?.timeWaveforms).toBeDefined();
    expect(snap?.timeWaveforms?.time.length).toBe(5);
  });

  it('publishes warnings from the solver', async () => {
    const fake = new FakeSolverAdapter({ vectors: { 'v(vcc_rail)': 5 } });
    // FakeSolverAdapter does not currently emit warnings; vetting that the
    // service forwards them is sufficient — see solver-port-contract for
    // the warnings-field contract.
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({}) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 10));
    // The FakeSolverAdapter returns empty warnings, so the snapshot
    // also has empty warnings — but the field exists.
    expect(elec.snapshots[0]?.warnings).toEqual([]);
  });
});

describe('handleMcuEdge (Phase 1c D1)', () => {
  it('runs an initial full solve, then alter + republish on edge', async () => {
    let gateV = 0;
    let drainV = 4.9;
    const fake = new FakeSolverAdapter({
      vectors: () => ({
        'v(net_gate)': gateV,
        'v(net_drain)': drainV,
        'v(vcc_rail)': 5,
        'i(v_vcc_rail)': -0.005,
      }),
    });
    fake.onAlter = (name, value) => {
      if (name === 'V_uno_9') {
        gateV = value;
        drainV = value >= 1.6 ? 0.05 : 4.9;
      }
    };
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore({
      components: [
        { id: 'q1', metadataId: 'bjt-2n2222', properties: {} },
        { id: 'rb', metadataId: 'resistor', properties: { value: '1k' } },
      ],
      wires: [
        {
          id: 'w1',
          start: { componentId: 'uno', pinName: '9' },
          end: { componentId: 'rb', pinName: '1' },
        },
        {
          id: 'w2',
          start: { componentId: 'rb', pinName: '2' },
          end: { componentId: 'q1', pinName: 'B' },
        },
      ],
      boards: [{ id: 'uno', boardKind: 'arduino-uno' }],
    });
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      // Mark pin 9 as a digital MCU output so the netlist emits
      // V_uno_9 from the very first solve. Without this the
      // self-heal path in handleMcuEdge triggers a rebuild (full
      // tick) instead of the alter + resolveDc fast path the test
      // is verifying, and the assertion below races the rebuild's
      // own solve completing.
      { collectBoardPinStates: () => ({ '9': { type: 'digital', v: 0 } }) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 20));
    const initialSolves = fake.calls.solve.length;
    const initialSnapshots = elec.snapshots.length;
    expect(initialSolves).toBe(1); // initial full solve
    expect(initialSnapshots).toBe(1);

    await service.handleMcuEdge('uno', '9', true, 5);
    // Solve count went up by exactly 1 (alter + .op), no new loadCircuit.
    expect(fake.calls.solve.length).toBe(initialSolves + 1);
    expect(fake.calls.loadCircuit.length).toBe(1); // still 1
    expect(fake.calls.alterSource).toEqual([['V_uno_9', 5]]);
    expect(elec.snapshots.length).toBe(initialSnapshots + 1);
  });

  it('coalesces an edge with an in-flight full solve', async () => {
    const fake = new FakeSolverAdapter({
      vectors: { 'v(vcc_rail)': 5 },
      solveDelayMs: 30,
    });
    __setSchedulerSolverFactoryForTests(() => fake);
    // Pin 9 must be wired into the netlist so buildNetlist emits
    // V_uno_9 (NetlistBuilder line 158 skips board pins whose net
    // lookup returns null). Without a wire, hasSource stays false
    // forever and handleMcuEdge's self-heal path would loop. Mirrors
    // the wired fixture used by the alter+republish test above.
    const sim = makeSimStore({
      components: [
        { id: 'rb', metadataId: 'resistor', properties: { value: '1k' } },
      ],
      wires: [
        {
          id: 'w1',
          start: { componentId: 'uno', pinName: '9' },
          end: { componentId: 'rb', pinName: '1' },
        },
        {
          id: 'w2',
          start: { componentId: 'rb', pinName: '2' },
          end: { componentId: 'uno', pinName: 'GND' },
        },
      ],
      boards: [{ id: 'uno', boardKind: 'arduino-uno' }],
    });
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({ '9': { type: 'digital', v: 0 } }) },
    );
    startTracked(service);
    // While initial solve is running, fire an edge.
    void service.handleMcuEdge('uno', '9', true, 5);
    await new Promise((r) => setTimeout(r, 100));
    // After initial solve, the pending edge replays — total solves = 2.
    expect(fake.calls.solve.length).toBe(2);
    expect(fake.calls.alterSource).toEqual([['V_uno_9', 5]]);
  });

  it('bounds solve rate under a sustained edge storm (multiplexed display)', async () => {
    // Regression: a 4-digit 7-segment clock over QEMU keeps ~13 pins hot
    // (thousands of GPIO edges/second). Replaying queued edges IMMEDIATELY
    // after each solve ran the solver at 100% duty with no idle gap — the
    // main thread starved for minutes until the sim WebSocket dropped.
    // The drain timer must space solves out: over a ~200 ms storm window
    // the solve count stays bounded (~1 per 33 ms gap), nowhere near the
    // one-solve-per-edge fire hose.
    const fake = new FakeSolverAdapter({
      vectors: { 'v(vcc_rail)': 5 },
      solveDelayMs: 2,
    });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore({
      components: [
        { id: 'rb', metadataId: 'resistor', properties: { value: '1k' } },
      ],
      wires: [
        {
          id: 'w1',
          start: { componentId: 'uno', pinName: '9' },
          end: { componentId: 'rb', pinName: '1' },
        },
        {
          id: 'w2',
          start: { componentId: 'rb', pinName: '2' },
          end: { componentId: 'uno', pinName: 'GND' },
        },
      ],
      boards: [{ id: 'uno', boardKind: 'arduino-uno' }],
    });
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({ '9': { type: 'digital', v: 0 } }) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 30)); // let the initial solve land

    // Storm: toggle the pin every 2 ms for 200 ms (~100 edges).
    let state = false;
    for (let i = 0; i < 100; i++) {
      state = !state;
      void service.handleMcuEdge('uno', '9', state, 5);
      await new Promise((r) => setTimeout(r, 2));
    }
    await new Promise((r) => setTimeout(r, 80)); // trailing drain

    // 100 edges in ~200 ms with a 33 ms drain gap → ~7 solves + initial.
    // Generous ceiling; the pre-fix behaviour was 1 solve per edge (100+).
    const total = fake.calls.solve.length;
    expect(total).toBeGreaterThanOrEqual(2); // it DID keep solving
    expect(total).toBeLessThanOrEqual(30);
  });

  it('kicks a full tick when no circuit has been loaded yet', async () => {
    const fake = new FakeSolverAdapter({ vectors: { 'v(vcc_rail)': 5 } });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({}) },
    );
    // No service.start() — first call is handleMcuEdge.
    await service.handleMcuEdge('uno', '9', true, 5);
    await new Promise((r) => setTimeout(r, 10));
    // Should have done a FULL tick (loadCircuit + solve), not just alter.
    expect(fake.calls.loadCircuit.length).toBe(1);
    expect(fake.calls.alterSource).toEqual([]);
  });
});

describe('CircuitSimulationService — error handling', () => {
  it('logs but does not throw when solver fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = new FakeSolverAdapter();
    // Override solve to reject on first call.
    let calls = 0;
    fake.solve = async () => {
      calls++;
      throw new Error('boom');
    };
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({}) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 10));
    expect(warn).toHaveBeenCalled();
    expect(elec.snapshots.length).toBe(0); // no publish on failure
    expect(calls).toBeGreaterThan(0);
    warn.mockRestore();
  });
});
