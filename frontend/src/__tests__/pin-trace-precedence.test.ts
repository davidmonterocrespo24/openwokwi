// @vitest-environment jsdom
/**
 * What the wire walk answers when a net offers more than one answer.
 *
 * These are the cases that decide whether walking the WHOLE node (rather than
 * a single chain) is safe. Each topology below is one a user really draws, and
 * each one broke a plausible implementation of the divider fix:
 *
 *  - a ground tie point almost always has something else on it (a button's
 *    pull-down, a decoupling cap). If reaching a rail did not END the walk,
 *    a grounded pin would resolve to whatever GPIO the pull-down hangs off;
 *  - a resistor lead used as a tie point can put a custom chip one hop away
 *    from a pin that also reaches a real GPIO. The board pin has to win, even
 *    when the chip is found first;
 *  - the depth budget is spent by CROSSING parts, so a long chain explored
 *    first must not make a shorter route to the same pin unreachable.
 *
 * Every case here fails on the first cut of the fix (57325aa), which returned
 * the first non-null answer any branch produced.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { traceDetailed, traceBoardGpio } from '../simulation/PinTrace';

const BOARD = 'arduino-uno';

const wire = (id: string, a: [string, string], b: [string, string]) => ({
  id,
  waypoints: [],
  color: '#000',
  start: { componentId: a[0], pinName: a[1], x: 0, y: 0 },
  end: { componentId: b[0], pinName: b[1], x: 0, y: 0 },
});

function load(components: unknown[], wires: unknown[]) {
  useSimulatorStore.setState({ boards: [], components: [], wires: [] } as never);
  useSimulatorStore.getState().addBoard('arduino-uno' as never, 0, 0, BOARD);
  const s = useSimulatorStore.getState();
  s.setComponents(components as never);
  s.setWires(wires as never);
  return useSimulatorStore.getState();
}

const R = (id: string, metadataId = 'resistor-1k') => ({
  id,
  metadataId,
  x: 0,
  y: 0,
  properties: { value: '1000' },
});

describe('what wins on a net', () => {
  beforeEach(() => useSimulatorStore.setState({ boards: [], components: [], wires: [] } as never));

  it('a node that touches a rail IS the rail, whatever hangs off it', () => {
    // The LED's cathode is soldered to the same lead as a button's pull-down,
    // and that lead goes to GND. The cathode is grounded — it is not "wired to
    // D2" just because the pull-down's other leg is.
    const state = load(
      [{ id: 'led1', metadataId: 'led', x: 0, y: 0, properties: {} }, R('r-pulldown')],
      [
        wire('g1', ['led1', 'C'], ['r-pulldown', '2']),
        wire('g2', ['r-pulldown', '2'], [BOARD, 'GND']),
        wire('g3', ['r-pulldown', '1'], [BOARD, '2']),
      ],
    );
    expect(traceDetailed(state as never, 'led1', 'C', 0).arduinoPin).toBe(-1);
  });

  it('but a rail BEHIND a component never hides a GPIO on the near side', () => {
    // The divider shape: the walk crosses the top resistor, and the tap it
    // lands on carries both the lower resistor (to GND) and the wire to D7.
    const state = load(
      [R('r-top'), R('r-bot', 'resistor-2k2')],
      [
        wire('d1', ['sensor', 'ECHO'], ['r-top', '1']),
        wire('d2', ['r-top', '2'], ['r-bot', '1']),
        wire('d3', ['r-bot', '2'], [BOARD, 'GND']),
        wire('d4', ['r-bot', '1'], [BOARD, '7']),
      ],
    );
    expect(traceDetailed(state as never, 'sensor', 'ECHO', 0).arduinoPin).toBe(7);
  });

  it('a real board pin beats a custom chip found first', () => {
    // Wire order is the trap: the chip branch is drawn first, so a walk that
    // returns the first non-null answer hands back a synthetic chip pin and
    // never looks at the wire to D5 on the very same node.
    const state = load(
      [R('r-tie'), { id: 'chip1', metadataId: 'custom-chip', x: 0, y: 0, properties: {} }],
      [
        wire('c1', ['part1', 'OUT'], ['r-tie', '1']),
        wire('c2', ['r-tie', '1'], ['chip1', 'PIN1']),
        wire('c3', ['part1', 'OUT'], [BOARD, '5']),
      ],
    );
    expect(traceDetailed(state as never, 'part1', 'OUT', 0).arduinoPin).toBe(5);
  });

  it('still falls back to the chip pin when no board pin is reachable', () => {
    const state = load(
      [R('r-tie'), { id: 'chip1', metadataId: 'custom-chip', x: 0, y: 0, properties: {} }],
      [
        wire('c1', ['part1', 'OUT'], ['r-tie', '1']),
        wire('c2', ['r-tie', '1'], ['chip1', 'PIN1']),
      ],
    );
    const hit = traceDetailed(state as never, 'part1', 'OUT', 0).arduinoPin;
    expect(hit).not.toBeNull();
    expect(hit).toBeGreaterThanOrEqual(100000); // synthetic chip-pin space
  });

  it('a long dead end explored first does not hide a shorter route', () => {
    // Six resistors in series reach the tie point at the very edge of the
    // depth budget, so its own continuation is cut. The same tie point is one
    // resistor away from the start — that shorter route must still be walked,
    // and it reaches D4.
    const chain = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
    const comps = [...chain.map((id) => R(id)), R('r-short'), R('r-far')];
    const wires = [wire('s0', ['part1', 'OUT'], ['r1', '1'])];
    for (let i = 0; i < chain.length - 1; i++) {
      wires.push(wire(`s${i + 1}`, [chain[i], '2'], [chain[i + 1], '1']));
    }
    // The long chain lands on the tie point (r-far's near lead) at max depth.
    wires.push(wire('s-tie', ['r6', '2'], ['r-far', '1']));
    // The short route to the SAME tie point, drawn last on purpose.
    wires.push(wire('t1', ['part1', 'OUT'], ['r-short', '1']));
    wires.push(wire('t2', ['r-short', '2'], ['r-far', '1']));
    // And the tie point reaches D4 by crossing one more resistor.
    wires.push(wire('t3', ['r-far', '2'], [BOARD, '4']));
    const state = load(comps, wires);
    expect(traceDetailed(state as never, 'part1', 'OUT', 0).arduinoPin).toBe(4);
  });
});

describe('nets whose answer is not a board pin', () => {
  beforeEach(() => useSimulatorStore.setState({ boards: [], components: [], wires: [] } as never));

  it('two chips on one wire share ONE net key', async () => {
    // The chip bus exists so a write on one chip is visible to the other
    // through the same PinManager key. A walk that answers with the chip it
    // happened to reach first hands each endpoint its own key, and the two
    // chips stop hearing each other — with every symptom pointing at the
    // chips rather than at the walk.
    const { setChipBusEnabledForTest, resolveChipNetKey } = await import(
      '../simulation/customChips/chipNets'
    );
    setChipBusEnabledForTest(true);
    try {
      useSimulatorStore.setState({ boards: [], components: [], wires: [] } as never);
      const s = useSimulatorStore.getState();
      s.setComponents([
        { id: 'driver', metadataId: 'custom-chip', x: 0, y: 0, properties: {} },
        { id: 'reader', metadataId: 'custom-chip', x: 0, y: 0, properties: {} },
      ] as never);
      s.setWires([wire('bus', ['driver', 'D0'], ['reader', 'D0'])] as never);
      const state = useSimulatorStore.getState();
      const a = traceDetailed(state as never, 'driver', 'D0', 0).arduinoPin;
      const b = traceDetailed(state as never, 'reader', 'D0', 0).arduinoPin;
      expect(a).toBe(b);
      expect(a).toBe(resolveChipNetKey(state as never, 'driver', 'D0'));
    } finally {
      setChipBusEnabledForTest(null);
    }
  });

  it('a ground plane on a breadboard rail is still ground', () => {
    // Same rule as the tie point, through the shape people actually build: the
    // strip joins the cathode, the board's GND and a pull-down whose far leg
    // is a GPIO. Which hole the walk happens to reach first must not decide it.
    const state = load(
      [
        { id: 'seg7', metadataId: '7segment', x: 0, y: 0, properties: {} },
        { id: 'bb', metadataId: 'breadboard', x: 0, y: 0, properties: {} },
        R('r-pd', 'resistor-10k'),
      ],
      [
        wire('b1', ['seg7', 'COM'], ['bb', 'bn.1']),
        wire('b2', ['r-pd', '2'], ['bb', 'bn.20']),
        wire('b3', ['r-pd', '1'], [BOARD, '2']),
        wire('b4', [BOARD, 'GND'], ['bb', 'bn.10']),
      ],
    );
    expect(traceDetailed(state as never, 'seg7', 'COM', 0).arduinoPin).toBe(-1);
  });
});

describe('cost of walking the net', () => {
  // What is worth guarding, and what is not.
  //
  // Tracing a pin on a shared ground rail costs O(node): the answer is a
  // property of the whole node, so the whole node gets collected. A canvas
  // with more legs on that rail has a bigger node and a higher per-pin cost —
  // by design, not a defect, and an absolute millisecond ceiling on it just
  // fails whenever the machine is busy (it failed a deploy gate that happened
  // to be running two test shards).
  //
  // The real hazard is different: the first cut of this walk re-scanned EVERY
  // wire on the canvas at every frame, so wires that had nothing to do with
  // the traced net still made it slower. The per-array wire index fixed that,
  // and this is the test for it — grow the canvas with UNRELATED circuitry and
  // the cost of tracing the same little net must not move. A ratio says so
  // regardless of how loaded the machine is.
  const BB = 'bb';

  /** One traced cluster (fixed size) plus `noise` legs of unrelated circuitry
   *  on a second breadboard, which shares no node with it. */
  const buildCanvas = (noise: number) => {
    useSimulatorStore.setState({ boards: [], components: [], wires: [] } as never);
    useSimulatorStore.getState().addBoard('arduino-uno' as never, 0, 0, BOARD);
    const comps: unknown[] = [
      { id: BB, metadataId: 'breadboard', x: 0, y: 0, properties: {} },
      { id: 'bb2', metadataId: 'breadboard', x: 0, y: 0, properties: {} },
    ];
    const wires: unknown[] = [wire('gnd', [BOARD, 'GND'], [BB, 'bn.1'])];
    const TRACED = 20;
    for (let i = 0; i < TRACED; i++) {
      comps.push({ id: `led${i}`, metadataId: 'led', x: 0, y: 0, properties: {} });
      comps.push({ id: `r${i}`, metadataId: 'resistor-1k', x: 0, y: 0, properties: { value: '1000' } });
      wires.push(wire(`w${i}a`, [`led${i}`, 'C'], [`r${i}`, '1']));
      wires.push(wire(`w${i}b`, [`r${i}`, '2'], [BB, `bn.${(i % 28) + 2}`]));
      wires.push(wire(`w${i}c`, [`led${i}`, 'A'], [BOARD, String((i % 12) + 2)]));
    }
    // Noise: its own rail, its own parts. A board pad is where a walk stops, so
    // none of this belongs to the node the assertions below trace.
    wires.push(wire('gnd2', [BOARD, 'GND.1'], ['bb2', 'bn.1']));
    for (let i = 0; i < noise; i++) {
      comps.push({ id: `nled${i}`, metadataId: 'led', x: 0, y: 0, properties: {} });
      comps.push({ id: `nr${i}`, metadataId: 'resistor-1k', x: 0, y: 0, properties: { value: '1000' } });
      wires.push(wire(`n${i}a`, [`nled${i}`, 'C'], [`nr${i}`, '1']));
      wires.push(wire(`n${i}b`, [`nr${i}`, '2'], ['bb2', `bn.${(i % 28) + 2}`]));
      wires.push(wire(`n${i}c`, [`nled${i}`, 'A'], [BOARD, String((i % 12) + 2)]));
    }
    const st = useSimulatorStore.getState();
    st.setComponents(comps as never);
    st.setWires(wires as never);
    return { state: useSimulatorStore.getState(), traced: TRACED };
  };

  /** BEST per-pin cost of tracing the traced cluster's cathodes (the rail case,
   *  where the whole node is collected). The minimum of several passes on
   *  purpose: the fastest pass is the one that was not interrupted, so it
   *  measures the code rather than the machine's mood. */
  const costPerPin = (noise: number): number => {
    const { state, traced } = buildCanvas(noise);
    let best = Infinity;
    for (let r = 0; r < 7; r++) {
      const t0 = performance.now();
      for (let i = 0; i < traced; i++) {
        expect(traceDetailed(state as never, `led${i}`, 'C', 0).arduinoPin).toBe(-1);
      }
      best = Math.min(best, (performance.now() - t0) / traced);
    }
    return best;
  };

  it('unrelated wires elsewhere on the canvas do not slow a trace down', () => {
    const quiet = costPerPin(20); // ~122 wires
    const busy = costPerPin(320); // ~1022 wires, same little net under test
    const growth = busy / quiet;
    console.log(
      `[pin-trace] ${quiet.toFixed(3)} ms/pin with 122 wires, ` +
        `${busy.toFixed(3)} with 1022 — growth ${growth.toFixed(2)}x`,
    );
    // Indexed: ~1x, the node is identical. Re-scanning every wire per frame:
    // ~8x, since the canvas is eight times bigger. 3.0 separates them with
    // room for timer noise.
    expect(growth).toBeLessThan(3.0);
  });

  it('a pin wired straight to a GPIO short-circuits, far cheaper than the rail', () => {
    const { state, traced } = buildCanvas(120);
    let driven = Infinity;
    for (let r = 0; r < 7; r++) {
      const t0 = performance.now();
      for (let i = 0; i < traced; i++) {
        expect(traceDetailed(state as never, `led${i}`, 'A', 0).arduinoPin).toBe((i % 12) + 2);
      }
      driven = Math.min(driven, (performance.now() - t0) / traced);
    }
    // The early exit on the first driven pad is what keeps the common case
    // cheap; if it ever stops firing, this collapses towards the rail cost.
    expect(driven).toBeLessThan(costPerPin(120));
  });
});
