/**
 * Parts-on-breadboard geometry: hole grids, nearest-hole lookup and the
 * wire flag plumbing that keeps seating wires invisible.
 */

import { describe, it, expect } from 'vitest';
import {
  breadboardHoles,
  nearestHole,
  solvePlacement,
  SEAT_TOLERANCE,
} from '../utils/breadboardSnap';
import { BREADBOARD_PINS } from '../velxio-elements/breadboard-element';
import { BREADBOARD_MINI_PINS } from '../velxio-elements/breadboard-mini-element';

const WRAPPER_INSET = 6;

describe('breadboardHoles', () => {
  it('exposes the full-size grid (830 holes) and the mini grid (170)', () => {
    expect(breadboardHoles('breadboard')).toHaveLength(830);
    expect(breadboardHoles('breadboard-mini')).toHaveLength(170);
    expect(breadboardHoles('led')).toBeNull();
  });

  it('uses the wokwi 9.6 px pitch on both axes', () => {
    const holes = BREADBOARD_PINS;
    const c1a = holes.find((h) => h.name === '1t.a')!;
    const c2a = holes.find((h) => h.name === '2t.a')!;
    const c1b = holes.find((h) => h.name === '1t.b')!;
    expect(c2a.x - c1a.x).toBeCloseTo(9.6, 5);
    expect(c1b.y - c1a.y).toBeCloseTo(9.6, 5);
  });

  it('spans exactly 6 pitches from row b to row f (resistor trench bridge)', () => {
    const b = BREADBOARD_PINS.find((h) => h.name === '10t.b')!;
    const f = BREADBOARD_PINS.find((h) => h.name === '10b.f')!;
    expect(f.y - b.y).toBeCloseTo(6 * 9.6, 5);
    expect(f.x).toBeCloseTo(b.x, 5);
  });

  it('mini board has no rails', () => {
    expect(BREADBOARD_MINI_PINS.some((h) => h.name.includes('p.'))).toBe(false);
  });
});

describe('nearestHole', () => {
  const bb = { id: 'bb1', metadataId: 'breadboard', x: 100, y: 200 };
  const hole = BREADBOARD_PINS.find((h) => h.name === '5t.c')!;
  const world = { x: 100 + WRAPPER_INSET + hole.x, y: 200 + WRAPPER_INSET + hole.y };

  it('finds the exact hole under a world point (wrapper inset accounted)', () => {
    const found = nearestHole(bb, world, SEAT_TOLERANCE);
    expect(found?.name).toBe('5t.c');
    expect(found?.dist).toBeCloseTo(0, 5);
  });

  it('absorbs the resistor 1.2 px pitch residual but rejects beyond tolerance', () => {
    expect(nearestHole(bb, { x: world.x + 1.2, y: world.y }, SEAT_TOLERANCE)?.name).toBe('5t.c');
    // Center of the e-f trench: 14.4 px from the nearest rows — no hole.
    const rowE = BREADBOARD_PINS.find((h) => h.name === '5t.e')!;
    const trench = { x: 100 + WRAPPER_INSET + rowE.x, y: 200 + WRAPPER_INSET + rowE.y + 14.4 };
    expect(nearestHole(bb, trench, SEAT_TOLERANCE)).toBeNull();
  });

  it('tolerance stays below half the hole pitch (no ambiguous seating)', () => {
    expect(SEAT_TOLERANCE).toBeLessThan(9.6 / 2);
  });

  it('refuses rotated breadboards', () => {
    const rotated = { ...bb, properties: { rotation: 90 } };
    expect(nearestHole(rotated, world, SEAT_TOLERANCE)).toBeNull();
  });
});

describe('solvePlacement', () => {
  const bb = { id: 'bb1', metadataId: 'breadboard', x: 100, y: 200 };
  const ox = 100 + WRAPPER_INSET;
  const oy = 200 + WRAPPER_INSET;
  const hole = (name: string) => BREADBOARD_PINS.find((h) => h.name === name)!;

  /** Pin offsets for a vertical resistor bridging the trench (rows b -> f). */
  const resistorPins = () => {
    const b = hole('10t.b');
    const f = hole('10b.f');
    return [
      { name: '1', dx: 0, dy: 0 },
      { name: '2', dx: f.x - b.x, dy: f.y - b.y },
    ];
  };
  /** Position that puts pin 1 exactly on `name`. */
  const posFor = (name: string) => ({ x: ox + hole(name).x, y: oy + hole(name).y });

  it('leaves an already-correct part exactly where it is', () => {
    const want = posFor('10t.b');
    const got = solvePlacement(resistorPins(), bb, new Set(), want.x, want.y)!;
    expect(got.moved).toBeCloseTo(0, 5);
    expect(got.holes.map((h) => h.holeName)).toEqual(['10t.b', '10b.f']);
  });

  it('pulls a part dropped slightly off back onto the holes', () => {
    const want = posFor('10t.b');
    const got = solvePlacement(resistorPins(), bb, new Set(), want.x + 3, want.y - 2)!;
    expect(got.holes.map((h) => h.holeName)).toEqual(['10t.b', '10b.f']);
    expect(got.x).toBeCloseTo(want.x, 5);
    expect(got.y).toBeCloseTo(want.y, 5);
  });

  it('slides to the next free column when the target is occupied', () => {
    const want = posFor('10t.b');
    const got = solvePlacement(resistorPins(), bb, new Set(['10t.b']), want.x, want.y)!;
    expect(got.holes[0].holeName).not.toBe('10t.b');
    // Nearest free column, not a jump across the board.
    expect(got.moved).toBeLessThanOrEqual(9.6 * 2);
  });

  it('rejects a placement whose SECOND pin would collide', () => {
    const want = posFor('10t.b');
    const got = solvePlacement(resistorPins(), bb, new Set(['10b.f']), want.x, want.y)!;
    expect(got.holes.map((h) => h.holeName)).not.toContain('10b.f');
  });

  it('returns null when every hole in range is taken', () => {
    const all = new Set(BREADBOARD_PINS.map((h) => h.name));
    const want = posFor('10t.b');
    expect(solvePlacement(resistorPins(), bb, all, want.x, want.y)).toBeNull();
  });

  it('never returns a half-seated placement (the 7-segment bug)', () => {
    // The real invariant: a returned placement always assigns EVERY pin a
    // hole. Never a partial seating, whatever the geometry. Swept across
    // spans that are on-pitch, off-pitch and half-pitch.
    const want = posFor('10t.b');
    for (let extra = 0; extra <= 9.6; extra += 0.4) {
      const pins = [
        { name: 'top', dx: 0, dy: 0 },
        { name: 'bottom', dx: 0, dy: 6 * 9.6 + extra },
      ];
      const got = solvePlacement(pins, bb, new Set(), want.x, want.y);
      if (got) expect(got.holes).toHaveLength(pins.length);
    }
  });

  it('refuses to drag a part more than the search radius', () => {
    const want = posFor('10t.b');
    // Occupy a wide band around the drop so nothing fits within 6 pitches.
    const taken = new Set(
      BREADBOARD_PINS.filter((h) => Math.abs(h.x - hole('10t.b').x) < 9.6 * 8).map((h) => h.name),
    );
    expect(solvePlacement(resistorPins(), bb, taken, want.x, want.y)).toBeNull();
  });
});

describe('solvePlacement — sub-pitch translation (off-lattice footprints)', () => {
  const bb = { id: 'bb1', metadataId: 'breadboard', x: 100, y: 200 };
  const ox = 100 + WRAPPER_INSET;
  const oy = 200 + WRAPPER_INSET;
  const hole = (name: string) => BREADBOARD_PINS.find((h) => h.name === name)!;
  const posFor = (name: string) => ({ x: ox + hole(name).x, y: oy + hole(name).y });

  /** Nearest-hole distance for every pin of a placement, for assertions. */
  const residuals = (pins: { name: string; dx: number; dy: number }[], p: { x: number; y: number }) =>
    pins.map((pin) => {
      const px = p.x + pin.dx;
      const py = p.y + pin.dy;
      let best = Infinity;
      for (const h of BREADBOARD_PINS) best = Math.min(best, Math.hypot(ox + h.x - px, oy + h.y - py));
      return best;
    });

  it('seats a diode: 7.5-pitch span splits the error between both legs', () => {
    // DiodeElements.ts diodePinInfo(): A at x=0, C at x=72 = 7.5 * 9.6.
    // Anchor-exact placement leaves C 4.8 px out; the fine translation puts
    // both legs 2.4 px off centre instead, which is inside tolerance.
    const pins = [
      { name: 'A', dx: 0, dy: 0 },
      { name: 'C', dx: 72, dy: 0 },
    ];
    const want = posFor('10t.b');
    const got = solvePlacement(pins, bb, new Set(), want.x, want.y);

    expect(got).not.toBeNull();
    expect(got!.holes).toHaveLength(2);
    for (const r of residuals(pins, got!)) {
      expect(r).toBeLessThanOrEqual(SEAT_TOLERANCE);
      expect(r).toBeGreaterThan(0.5); // genuinely off-centre, not a lucky exact fit
    }
  });

  it('keeps every pin inside tolerance, so hole resolution stays unambiguous', () => {
    // SEAT_TOLERANCE < half pitch is what guarantees computeSeating later
    // picks the SAME holes the solver assigned — i.e. the netlist is
    // unaffected by the part rendering a couple of px off centre.
    const pins = [
      { name: 'A', dx: 0, dy: 0 },
      { name: 'C', dx: 72, dy: 0 },
    ];
    const want = posFor('10t.b');
    const got = solvePlacement(pins, bb, new Set(), want.x, want.y)!;
    for (const r of residuals(pins, got)) expect(r).toBeLessThan(9.6 / 2);
  });

  it('still refuses a DIP-14 on the wrong pitch — 8 px cannot be rescued', () => {
    // LogicICElements.ts dip14Pins(): y = 12 + i*8. Seven pins at 8 px drift
    // 1.6 px per step against the 9.6 grid; by pin 7 that is 4.8 px, and no
    // single translation can absorb a spread that large.
    const pins = Array.from({ length: 7 }, (_, i) => ({ name: `p${i + 1}`, dx: 0, dy: i * 8 }));
    const want = posFor('10t.a');
    expect(solvePlacement(pins, bb, new Set(), want.x, want.y)).toBeNull();
  });

  it('makes EVERY two-pin footprint seatable, at any span', () => {
    // Guarantee of the centroid rule: with two pins the worst span error
    // against the lattice is half a pitch (4.8 px), which splits into 2.4 px
    // per pin — always inside SEAT_TOLERANCE. This is what rescues the whole
    // 72 px family (diodes, transistors, regulators) with no artwork change.
    const want = posFor('10t.b');
    for (let span = 9.6; span <= 96; span += 0.4) {
      const pins = [
        { name: 'a', dx: 0, dy: 0 },
        { name: 'b', dx: span, dy: 0 },
      ];
      const got = solvePlacement(pins, bb, new Set(), want.x, want.y);
      expect(got, `span ${span.toFixed(1)} px should seat`).not.toBeNull();
      for (const r of residuals(pins, got!)) expect(r).toBeLessThanOrEqual(SEAT_TOLERANCE);
    }
  });

  it('an exactly-on-grid part is still placed dead centre, not nudged', () => {
    const pins = [
      { name: '1', dx: 0, dy: 0 },
      { name: '2', dx: 9.6 * 4, dy: 0 },
    ];
    const want = posFor('10t.b');
    const got = solvePlacement(pins, bb, new Set(), want.x, want.y)!;
    expect(got.moved).toBeCloseTo(0, 6);
    for (const r of residuals(pins, got)) expect(r).toBeCloseTo(0, 6);
  });
});

describe('solvePlacement — real catalog footprints', () => {
  // Coordinates copied verbatim from the element sources, so this locks in
  // the measured coverage boundary. If artwork changes, these move with it.
  const bb = { id: 'bb1', metadataId: 'breadboard', x: 100, y: 200 };
  const ox = 100 + WRAPPER_INSET;
  const oy = 200 + WRAPPER_INSET;
  const hole = (name: string) => BREADBOARD_PINS.find((h) => h.name === name)!;
  const at = (name: string) => ({ x: ox + hole(name).x, y: oy + hole(name).y });

  const seats = (pins: { name: string; dx: number; dy: number }[], anchor = '10t.a') => {
    const want = at(anchor);
    return solvePlacement(pins, bb, new Set(), want.x, want.y);
  };

  it('SEATS a diode — DiodeElements.ts, A/C 72 px apart', () => {
    expect(
      seats([
        { name: 'A', dx: 0, dy: 16 },
        { name: 'C', dx: 72, dy: 16 },
      ]),
    ).not.toBeNull();
  });

  it('SEATS a TO-92 transistor — TransistorElements.ts C/B/E', () => {
    const got = seats([
      { name: 'C', dx: 60, dy: 0 },
      { name: 'B', dx: 0, dy: 36 },
      { name: 'E', dx: 60, dy: 72 },
    ]);
    expect(got).not.toBeNull();
    expect(got!.holes).toHaveLength(3);
    // Distinct holes — a transistor shorting two of its own legs is useless.
    expect(new Set(got!.holes.map((h) => h.holeName)).size).toBe(3);
  });

  it('SEATS the 74HC595 — IC74HC595.ts, already on an exact 9.6 pitch', () => {
    const xs = [8.1, 17.7, 27.3, 36.9, 46.5, 56.1, 65.7, 75.3];
    const pins = [
      ...xs.map((x, i) => ({ name: `b${i}`, dx: x, dy: 51.3 })),
      ...xs.map((x, i) => ({ name: `t${i}`, dx: x, dy: 3 })),
    ];
    const got = seats(pins);
    expect(got).not.toBeNull();
    expect(got!.holes).toHaveLength(16);
  });

  it('REFUSES the 74HC00 family — LogicICElements.ts dip14Pins() 8 px pitch', () => {
    // The one defect no solver can absorb: 1.6 px drift per pin compounds
    // to 4.8 px across the package. Needs the artwork fixed against the
    // 74HC595 template above.
    const DIP14_W = 80;
    const pins = Array.from({ length: 14 }, (_, i) => ({
      name: `p${i + 1}`,
      dx: i < 7 ? 0 : DIP14_W,
      dy: i < 7 ? 12 + i * 8 : 12 + (13 - i) * 8,
    }));
    expect(seats(pins)).toBeNull();
  });
});

describe('solvePlacement — never shorts a part to itself', () => {
  const bb = { id: 'bb1', metadataId: 'breadboard', x: 100, y: 200 };
  const ox = 100 + WRAPPER_INSET;
  const oy = 200 + WRAPPER_INSET;
  const hole = (name: string) => BREADBOARD_PINS.find((h) => h.name === name)!;
  const at = (name: string) => ({ x: ox + hole(name).x, y: oy + hole(name).y });

  const groupOf = (h: string) => {
    const m = /^(\d+)([tb])\.[a-j]$/.exec(h);
    if (m) return `col${m[1]}${m[2]}`;
    const r = /^([tb][pn])\.\d+$/.exec(h);
    return r ? `rail${r[1]}` : h;
  };

  it('refuses a footprint whose pins would share one column strip', () => {
    // Two pins 9.6 px apart vertically inside a bank land in the same 5-hole
    // column, which is a single net.
    const pins = [
      { name: 'a', dx: 0, dy: 0 },
      { name: 'b', dx: 0, dy: 9.6 },
    ];
    const want = at('20t.a');
    const got = solvePlacement(pins, bb, new Set(), want.x, want.y);
    if (got) {
      const gs = got.holes.map((h) => groupOf(h.holeName));
      expect(new Set(gs).size).toBe(gs.length);
    }
  });

  it('never lays a multi-pin part across a power rail', () => {
    // A rail is one net for the WHOLE board — the worst possible short.
    const pins = Array.from({ length: 5 }, (_, i) => ({ name: `p${i}`, dx: i * 9.6, dy: 0 }));
    const want = at('20t.a');
    const got = solvePlacement(pins, bb, new Set(), want.x, want.y);
    if (got) {
      const rails = got.holes.filter((h) => /^[tb][pn]\./.test(h.holeName));
      expect(rails.length).toBeLessThanOrEqual(1);
    }
  });

  it('every seated real footprint uses one distinct strip per pin', () => {
    const cases: Record<string, { name: string; dx: number; dy: number }[]> = {
      diode: [
        { name: 'A', dx: 0, dy: 16 },
        { name: 'C', dx: 72, dy: 16 },
      ],
      to92: [
        { name: 'C', dx: 60, dy: 0 },
        { name: 'B', dx: 0, dy: 36 },
        { name: 'E', dx: 60, dy: 72 },
      ],
      // neopixel: 20 x 10.5 px rectangle — the audit found this one seats
      // only by shorting itself, at every anchor and rotation.
      neopixel: [
        { name: 'VDD', dx: 0, dy: 0 },
        { name: 'DIN', dx: 0, dy: 10.5 },
        { name: 'DOUT', dx: 20, dy: 0 },
        { name: 'VSS', dx: 20, dy: 10.5 },
      ],
    };
    for (const [label, pins] of Object.entries(cases)) {
      const want = at('20t.a');
      const got = solvePlacement(pins, bb, new Set(), want.x, want.y);
      if (!got) continue; // refusing is a valid answer
      const gs = got.holes.map((h) => groupOf(h.holeName));
      expect(new Set(gs).size, `${label} shorts itself`).toBe(gs.length);
    }
  });
});
