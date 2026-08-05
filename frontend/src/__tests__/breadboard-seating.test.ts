// @vitest-environment jsdom
/**
 * Store-level integration of parts-on-breadboard seating: moving a part so
 * its pins land on holes creates invisible bb wires, moving it away removes
 * them, and moving the breadboard carries seated parts along.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { BREADBOARD_PINS } from '../velxio-elements/breadboard-element';
import { computeSeating, resolveSeatPosition, seatOnDrop } from '../utils/breadboardSnap';

const RES_PIN_INFO = [
  { name: '1', x: 0, y: 5.65, signals: [] },
  { name: '2', x: 58.8, y: 5.65, signals: [] },
];
const INSET = 6; // DynamicComponent wrapper border+padding

function mountFakeElement(id: string, pinInfo: unknown): void {
  document.getElementById(id)?.remove();
  const el = document.createElement('div');
  el.id = id;
  (el as unknown as { pinInfo: unknown }).pinInfo = pinInfo;
  document.body.appendChild(el);
}

/** Component x/y that puts resistor pin 1 exactly on the given hole. */
function resistorPosFor(holeName: string, bbX: number, bbY: number) {
  const hole = BREADBOARD_PINS.find((h) => h.name === holeName)!;
  return {
    x: bbX + INSET + hole.x - INSET - RES_PIN_INFO[0].x,
    y: bbY + INSET + hole.y - INSET - RES_PIN_INFO[0].y,
  };
}

describe('breadboard seating via updateComponent', () => {
  beforeEach(() => {
    const s = useSimulatorStore.getState();
    s.setComponents([
      { id: 'bb1', metadataId: 'breadboard', x: 0, y: 0, properties: {} },
      { id: 'res1', metadataId: 'resistor', x: 900, y: 900, properties: {} },
    ] as never);
    s.setWires([]);
    mountFakeElement('res1', RES_PIN_INFO);
  });

  it('creates one invisible bb wire per pin when the part lands on holes', () => {
    const pos = resistorPosFor('5t.a', 0, 0);
    useSimulatorStore.getState().updateComponent('res1', pos);

    const bbWires = useSimulatorStore.getState().wires.filter((w) => w.bb);
    expect(bbWires).toHaveLength(2);
    const holes = bbWires.map((w) => w.end.pinName).sort();
    // Pin 1 on 5t.a; pin 2 is 58.8 px away = 6 pitches + 1.2 px residual,
    // absorbed by the seat tolerance onto column 11.
    expect(holes).toEqual(['11t.a', '5t.a']);
    expect(bbWires.every((w) => w.end.componentId === 'bb1')).toBe(true);
  });

  it('removes the seating when the part moves off the board', () => {
    useSimulatorStore.getState().updateComponent('res1', resistorPosFor('5t.a', 0, 0));
    expect(useSimulatorStore.getState().wires.filter((w) => w.bb)).toHaveLength(2);

    useSimulatorStore.getState().updateComponent('res1', { x: 1500, y: 1500 });
    expect(useSimulatorStore.getState().wires.filter((w) => w.bb)).toHaveLength(0);
  });

  it('carries seated parts when the breadboard moves', () => {
    useSimulatorStore.getState().updateComponent('res1', resistorPosFor('5t.a', 0, 0));
    const before = useSimulatorStore.getState().components.find((c) => c.id === 'res1')!;

    useSimulatorStore.getState().updateComponent('bb1', { x: 120, y: 40 });

    const after = useSimulatorStore.getState().components.find((c) => c.id === 'res1')!;
    expect(after.x).toBeCloseTo(before.x + 120, 5);
    expect(after.y).toBeCloseTo(before.y + 40, 5);
    const holes = useSimulatorStore.getState().wires
      .filter((w) => w.bb)
      .map((w) => w.end.pinName)
      .sort();
    expect(holes).toEqual(['11t.a', '5t.a']); // same holes, new location
  });
});

/**
 * Drop-time auto-seating (seatOnDrop). This is the generic path: pin
 * geometry comes from the element's `pinInfo`, so no part is special-cased.
 */
describe('seatOnDrop', () => {
  /** Real wokwi 1-digit 7segment pinInfo (pins='top'), mm*3.78 -> CSS px. */
  const SEG7_PIN_INFO = [
    { name: 'COM.1', x: 23.72, y: 71.82, signals: [] },
    { name: 'COM.2', x: 23.72, y: 3.78, signals: [] },
    { name: 'A', x: 33.32, y: 3.78, signals: [] },
    { name: 'B', x: 42.92, y: 3.78, signals: [] },
    { name: 'C', x: 33.32, y: 71.82, signals: [] },
    { name: 'D', x: 14.12, y: 71.82, signals: [] },
    { name: 'E', x: 4.52, y: 71.82, signals: [] },
    { name: 'F', x: 14.12, y: 3.78, signals: [] },
    { name: 'G', x: 4.52, y: 3.78, signals: [] },
    { name: 'DP', x: 42.92, y: 71.82, signals: [] },
  ];

  const bb = { id: 'bb1', metadataId: 'breadboard', x: 0, y: 0, properties: {} };

  /** Every pin of `comp` that is within seat tolerance of a hole. */
  const seatedCount = (comp: never) =>
    (computeSeating(comp, [bb, comp] as never) ?? []).length;

  beforeEach(() => {
    mountFakeElement('seg1', SEG7_PIN_INFO);
    mountFakeElement('res1', RES_PIN_INFO);
  });

  it('fully seats a 7-segment dropped a few px off — never half-seated', () => {
    // The exact bug from the reported project: dropped slightly high, the
    // top pin row grazes bank-a and the bottom row lands on nothing.
    const comp = { id: 'seg1', metadataId: '7segment', x: 40, y: 30, properties: {} };
    const placed = seatOnDrop(comp as never, 43, 27, [bb, comp] as never);

    expect(placed).not.toBeNull();
    expect(placed!.holes).toHaveLength(SEG7_PIN_INFO.length);
    const seated = { ...comp, x: placed!.x, y: placed!.y };
    expect(seatedCount(seated as never)).toBe(SEG7_PIN_INFO.length);
  });

  it('straddles the trench: top pin row in bank-t, bottom row in bank-b', () => {
    const comp = { id: 'seg1', metadataId: '7segment', x: 40, y: 30, properties: {} };
    const placed = seatOnDrop(comp as never, 43, 27, [bb, comp] as never)!;
    const holeOf = (pin: string) => placed.holes.find((h) => h.pinName === pin)!.holeName;
    // COM.2 is a top-row pin, COM.1 the bottom-row one directly below it.
    expect(holeOf('COM.2')).toMatch(/t\.[a-e]$/);
    expect(holeOf('COM.1')).toMatch(/b\.[f-j]$/);
    // Same column — the part is rigid.
    expect(holeOf('COM.2').split('t.')[0]).toBe(holeOf('COM.1').split('b.')[0]);
  });

  it('never assigns two pins to the same hole', () => {
    const comp = { id: 'seg1', metadataId: '7segment', x: 40, y: 30, properties: {} };
    const placed = seatOnDrop(comp as never, 43, 27, [bb, comp] as never)!;
    const names = placed.holes.map((h) => h.holeName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('slides clear of a part already occupying the target holes', () => {
    const seg = { id: 'seg1', metadataId: '7segment', x: 40, y: 30, properties: {} };
    const first = seatOnDrop(seg as never, 43, 27, [bb, seg] as never)!;
    const seated = { ...seg, x: first.x, y: first.y };

    // Drop a resistor right on top of the seated display.
    const res = { id: 'res1', metadataId: 'resistor', x: first.x, y: first.y, properties: {} };
    const placed = seatOnDrop(res as never, first.x, first.y, [bb, seated, res] as never);

    expect(placed).not.toBeNull();
    const taken = new Set(first.holes.map((h) => h.holeName));
    for (const h of placed!.holes) expect(taken.has(h.holeName)).toBe(false);
  });

  it('leaves a part dropped away from any breadboard alone', () => {
    const comp = { id: 'res1', metadataId: 'resistor', x: 5000, y: 5000, properties: {} };
    expect(seatOnDrop(comp as never, 5000, 5000, [bb, comp] as never)).toBeNull();
  });

  it('works off pinInfo alone — an unknown part type seats just the same', () => {
    // No whitelist: a made-up component with plausible 2-pin geometry.
    mountFakeElement('mystery1', [
      { name: 'P1', x: 0, y: 0, signals: [] },
      { name: 'P2', x: 9.6 * 3, y: 0, signals: [] },
    ]);
    const comp = { id: 'mystery1', metadataId: 'totally-unknown-part', x: 40, y: 30, properties: {} };
    const placed = seatOnDrop(comp as never, 42, 31, [bb, comp] as never);
    expect(placed).not.toBeNull();
    expect(placed!.holes).toHaveLength(2);
  });
});

/**
 * Agent-path seating correction: resolveSeatPosition lands a named pin exactly
 * on a named hole by pure translation. jsdom has no layout (offsetWidth = 0),
 * so this covers the translation + wiring at rotation 0; the rotation-pivot
 * case — the reason the resolver exists — is verified in the browser via
 * Playwright, where the real wrapper (with its text label) exists.
 */
describe('resolveSeatPosition', () => {
  const bbAt = (x: number, y: number) => ({ id: 'bb1', metadataId: 'breadboard', x, y, properties: {} });
  // Anchor target in breadboard-element space (what the solver sends). Here we
  // use a hole centre directly, since a 0-rotation resistor is on-lattice.
  const holeElem = (name: string) => {
    const h = BREADBOARD_PINS.find((p) => p.name === name)!;
    return { x: h.x, y: h.y };
  };

  beforeEach(() => mountFakeElement('res1', RES_PIN_INFO));

  it('lands the anchor pin on its solver target from a wrong position', () => {
    // Simulate the backend delivering an approximate x/y: drop the resistor
    // 27 px off from where pin 1 should sit on hole 10t.b.
    const bb = bbAt(0, 0);
    const a = holeElem('10t.b');
    const targetWorld = { x: bb.x + INSET + a.x, y: bb.y + INSET + a.y };
    const comp = { id: 'res1', metadataId: 'resistor', x: targetWorld.x - 27, y: targetWorld.y + 13, properties: {} };

    const pos = resolveSeatPosition(comp as never, 'bb1', '1', a.x, a.y, [bb, comp] as never)!;
    expect(pos).not.toBeNull();
    // Pin 1 (offset 0,5.65 at rotation 0) now sits on the anchor target.
    expect(pos.x + INSET + RES_PIN_INFO[0].x).toBeCloseTo(targetWorld.x, 6);
    expect(pos.y + INSET + RES_PIN_INFO[0].y).toBeCloseTo(targetWorld.y, 6);
  });

  it('honours a sub-pitch anchor offset instead of snapping to a hole centre', () => {
    // The solver shifts off-lattice parts; the anchor target is deliberately
    // 2.4 px off a hole. The resolver must reproduce that, not re-centre it.
    const bb = bbAt(0, 0);
    const a = holeElem('10t.b');
    const shifted = { x: a.x + 2.4, y: a.y };
    const comp = { id: 'res1', metadataId: 'resistor', x: 500, y: 500, properties: {} };
    const pos = resolveSeatPosition(comp as never, 'bb1', '1', shifted.x, shifted.y, [bb, comp] as never)!;
    expect(pos.x + INSET + RES_PIN_INFO[0].x).toBeCloseTo(bb.x + INSET + shifted.x, 6);
  });

  it('is a no-op when the part is already at its solver position', () => {
    const bb = bbAt(50, 60);
    const a = holeElem('20t.c');
    const comp = {
      id: 'res1', metadataId: 'resistor',
      x: bb.x + a.x - RES_PIN_INFO[0].x,
      y: bb.y + a.y - RES_PIN_INFO[0].y,
      properties: {},
    };
    const pos = resolveSeatPosition(comp as never, 'bb1', '1', a.x, a.y, [bb, comp] as never)!;
    expect(pos.x).toBeCloseTo(comp.x, 6);
    expect(pos.y).toBeCloseTo(comp.y, 6);
  });

  it('returns null for a non-breadboard target', () => {
    const bb = bbAt(0, 0);
    const comp = { id: 'res1', metadataId: 'resistor', x: 0, y: 0, properties: {} };
    expect(resolveSeatPosition(comp as never, 'res1', '1', 0, 0, [bb, comp] as never)).toBeNull();
  });

  it('correction then updateComponent produces the invisible bb wires', () => {
    // End-to-end of the agent path (minus the real rotation pivot): place off,
    // correct, apply — the store should then seat both pins.
    const s = useSimulatorStore.getState();
    s.setComponents([
      { id: 'bb1', metadataId: 'breadboard', x: 0, y: 0, properties: {} },
      { id: 'res1', metadataId: 'resistor', x: 900, y: 900, properties: {} },
    ] as never);
    s.setWires([]);
    const a = holeElem('5t.a');
    const pos = resolveSeatPosition(
      useSimulatorStore.getState().components.find((c) => c.id === 'res1')! as never,
      'bb1', '1', a.x, a.y,
      useSimulatorStore.getState().components as never,
    )!;
    useSimulatorStore.getState().updateComponent('res1', pos);
    const bbWires = useSimulatorStore.getState().wires.filter((w) => w.bb);
    expect(bbWires).toHaveLength(2);
    expect(bbWires.map((w) => w.end.pinName).sort()).toEqual(['11t.a', '5t.a']);
  });
});

/**
 * The run-before-seating race: a part can land in the store at its final
 * position BEFORE its element mounts (the agent streams add_component and the
 * seating move in one batch). The reseat inside updateComponent then finds no
 * DOM and keeps an empty seating — and nothing re-derived it, so a simulation
 * started in that window ran against a part with no bb wires, while reloading
 * the project (bb wires are persisted) worked. DynamicComponent now reseats
 * at mount, as soon as pinInfo is measurable; these tests cover the store
 * half of that contract.
 */
describe('reseat after late element mount', () => {
  beforeEach(() => {
    document.getElementById('res1')?.remove();
    const s = useSimulatorStore.getState();
    s.setComponents([
      { id: 'bb1', metadataId: 'breadboard', x: 0, y: 0, properties: {} },
      { id: 'res1', metadataId: 'resistor', x: 900, y: 900, properties: {} },
    ] as never);
    s.setWires([]);
  });

  it('a seating move with NO mounted element creates no bb wires (the race)', () => {
    // Element deliberately NOT mounted — this is the agent-batch window.
    useSimulatorStore.getState().updateComponent('res1', resistorPosFor('5t.a', 0, 0));
    expect(useSimulatorStore.getState().wires.filter((w) => w.bb)).toHaveLength(0);
  });

  it('reseating once the element mounts creates the missing bb wires', () => {
    useSimulatorStore.getState().updateComponent('res1', resistorPosFor('5t.a', 0, 0));
    expect(useSimulatorStore.getState().wires.filter((w) => w.bb)).toHaveLength(0);

    // Element appears (custom-element upgrade) — the mount-time effect fires:
    mountFakeElement('res1', RES_PIN_INFO);
    useSimulatorStore.getState().reseatComponentOnBreadboard('res1');

    const bbWires = useSimulatorStore.getState().wires.filter((w) => w.bb);
    expect(bbWires).toHaveLength(2);
    expect(bbWires.map((w) => w.end.pinName).sort()).toEqual(['11t.a', '5t.a']);
  });

  it('mount-reseat of an off-board part is a no-op that keeps array identity', () => {
    // Every component reseats at mount now — a project load must not churn
    // the wires array once per off-board part.
    mountFakeElement('res1', RES_PIN_INFO); // far from the board at (900,900)
    const before = useSimulatorStore.getState().wires;
    useSimulatorStore.getState().reseatComponentOnBreadboard('res1');
    expect(useSimulatorStore.getState().wires).toBe(before);
  });
});
