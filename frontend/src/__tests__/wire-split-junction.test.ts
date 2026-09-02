/**
 * Splitting a wire at a junction node.
 *
 * The junction is what lets a wire connect to a wire — one GND rail with taps
 * instead of a star of wires back to the board. It is a NORMAL 1-pin
 * component, which is the whole reason none of the five union-find net
 * builders need to know it exists: `union(A, J)` then `union(J, B)` already
 * puts A, J and B in one net.
 *
 * What this pins down:
 *   - The two halves get UNIQUE ids. The legacy `wire-${Date.now()}` scheme
 *     collides when two wires are minted inside one millisecond, which is
 *     exactly what a split does.
 *   - The drawn shape survives. Splitting on the STORED waypoints instead of
 *     the RENDERED polyline lets each half re-elbow into the other
 *     L-orientation, so the wire visibly jumps when a node is dropped on it.
 *   - Colour and signalType are inherited, so a split GND rail stays a GND rail
 *     for `wireColors` and the UART shortcut in `Interconnect`.
 *   - A click on the wire's own endpoint is REFUSED rather than producing a
 *     zero-length stub.
 */
import { describe, it, expect } from 'vitest';

import { computeWireSplit } from '../utils/wireSplit';
import { getRenderedPoints } from '../utils/wireHitDetection';
import { JUNCTION_METADATA_ID, JUNCTION_PIN, isJunction } from '../utils/junction';
import type { Wire } from '../types/wire';

/** A plain horizontal wire from (0,0) to (200,0). */
const straight = (): Wire => ({
  id: 'wire-original',
  start: { componentId: 'uno-1', pinName: 'GND', x: 0, y: 0 },
  end: { componentId: 'led-1', pinName: 'C', x: 200, y: 0 },
  waypoints: [],
  color: '#00ff00',
  signalType: 'power-gnd',
});

/** An L: (0,0) -> (100,0) -> (100,80). */
const elbow = (): Wire => ({
  id: 'wire-elbow',
  start: { componentId: 'uno-1', pinName: 'GND', x: 0, y: 0 },
  end: { componentId: 'led-1', pinName: 'C', x: 100, y: 80 },
  waypoints: [{ x: 100, y: 0 }],
  color: '#3333ff',
});

describe('computeWireSplit', () => {
  it('mints a junction on the wire and two halves that meet on its pin', () => {
    const split = computeWireSplit(straight(), 120, 0, 8);
    expect(split).not.toBeNull();
    const { junction, wireA, wireB, endpoint } = split!;

    expect(junction.metadataId).toBe(JUNCTION_METADATA_ID);
    expect(isJunction(junction.metadataId)).toBe(true);
    expect(endpoint).toEqual({
      componentId: junction.id,
      pinName: JUNCTION_PIN,
      x: 120,
      y: 0,
    });

    // First half keeps the original start, second half the original end, and
    // both terminate on the node's single pin.
    expect(wireA.start).toEqual(straight().start);
    expect(wireA.end).toEqual(endpoint);
    expect(wireB.start).toEqual(endpoint);
    expect(wireB.end).toEqual(straight().end);
  });

  it('gives the two halves distinct ids', () => {
    // The regression this guards: `wire-${Date.now()}` returns the same string
    // for both halves of a split, and the second wire silently replaces the
    // first everywhere ids are used as keys.
    const { wireA, wireB } = computeWireSplit(straight(), 120, 0, 8)!;
    expect(wireA.id).not.toBe(wireB.id);
    expect(wireA.id).not.toBe('wire-original');
    expect(wireB.id).not.toBe('wire-original');
  });

  it('positions the node so its pin lands exactly on the split point', () => {
    const { junction, endpoint } = computeWireSplit(straight(), 120, 0, 8)!;
    // Stored position + wrapper offset (6) + pin center (5) = the pin.
    expect(junction.x + 6 + 5).toBeCloseTo(endpoint.x, 5);
    expect(junction.y + 6 + 5).toBeCloseTo(endpoint.y, 5);
  });

  it('inherits colour and signal type on both halves', () => {
    const { junction, wireA, wireB } = computeWireSplit(straight(), 120, 0, 8)!;
    expect(wireA.color).toBe('#00ff00');
    expect(wireB.color).toBe('#00ff00');
    expect(wireA.signalType).toBe('power-gnd');
    expect(wireB.signalType).toBe('power-gnd');
    // The dot takes the wire's colour so it reads as part of the run.
    expect(junction.properties.color).toBe('#00ff00');
  });

  it('preserves the drawn shape of an L-shaped wire', () => {
    const original = elbow();
    const before = getRenderedPoints(original);
    // Split on the VERTICAL leg, past the corner.
    const { wireA, wireB } = computeWireSplit(original, 100, 40, 8)!;

    const after = [...getRenderedPoints(wireA), ...getRenderedPoints(wireB).slice(1)];
    // Same corner sequence, just with the split point inserted — every point
    // of the original path still appears, in order.
    for (const p of before) {
      expect(after.some((q) => q.x === p.x && q.y === p.y)).toBe(true);
    }
    // And the halves really do meet at the split point.
    expect(wireA.end.x).toBe(100);
    expect(wireA.end.y).toBe(40);
  });

  it('refuses a click that is not on the wire', () => {
    expect(computeWireSplit(straight(), 120, 60, 8)).toBeNull();
  });

  it('refuses a degenerate split on the wire own endpoints', () => {
    // A zero-length half would render as a stub and confuse every consumer.
    expect(computeWireSplit(straight(), 0, 0, 8)).toBeNull();
    expect(computeWireSplit(straight(), 200, 0, 8)).toBeNull();
  });

  it('never splits a breadboard seating wire', () => {
    // `bb` wires are auto-generated and re-created whenever the part moves —
    // a junction on one would be orphaned by the next drag.
    const seating: Wire = { ...straight(), bb: true };
    expect(computeWireSplit(seating, 120, 0, 8)).toBeNull();
  });

  it('picks the nearest segment, not the first within threshold', () => {
    // Near the corner of the L both legs are within threshold; the split must
    // land on the leg the user actually aimed at.
    const { wireA } = computeWireSplit(elbow(), 100, 30, 20)!;
    // Aimed down the vertical leg -> the first half ends on it, below y=0.
    expect(wireA.end.x).toBe(100);
    expect(wireA.end.y).toBeGreaterThan(0);
  });
});
