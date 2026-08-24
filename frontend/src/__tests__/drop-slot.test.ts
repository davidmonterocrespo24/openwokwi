/**
 * Where a new component lands.
 *
 * The complaint this fixes: "I add an element and sometimes I cannot even
 * see where it went". Two causes — placement at fixed world coordinates
 * (off-screen once the canvas is panned, fixed elsewhere by anchoring to the
 * visible corner) and a cascade keyed on components.length, which kept
 * marching down-right forever even after parts were moved away or deleted.
 *
 * These lock the rule that replaced it: first FREE slot from the corner.
 */
import { describe, it, expect } from 'vitest';
import { pickDropSlot } from '../utils/dropSlot';

const ORIGIN = { x: 100, y: 50 };
const STEP = 36;

describe('pickDropSlot', () => {
  it('drops at the corner when nothing is there', () => {
    expect(pickDropSlot(ORIGIN, [], { step: STEP })).toEqual(ORIGIN);
  });

  it('steps down-right when the corner is taken', () => {
    const slot = pickDropSlot(ORIGIN, [ORIGIN], { step: STEP });
    expect(slot).toEqual({ x: 100 + STEP, y: 50 + STEP });
  });

  it('keeps cascading while each slot in turn is taken', () => {
    const placed = [ORIGIN, { x: 100 + STEP, y: 50 + STEP }];
    expect(pickDropSlot(ORIGIN, placed, { step: STEP })).toEqual({
      x: 100 + 2 * STEP,
      y: 50 + 2 * STEP,
    });
  });

  it('reclaims a slot whose component was moved away', () => {
    // The whole point of not counting components: the user parked the last
    // drop somewhere else, so the corner is free again and the next one
    // belongs there — not three steps further down the diagonal.
    const movedAside = [{ x: 900, y: 700 }];
    expect(pickDropSlot(ORIGIN, movedAside, { step: STEP })).toEqual(ORIGIN);
  });

  it('ignores components that are merely near, not on, the slot', () => {
    const nearby = [{ x: ORIGIN.x + STEP * 0.9, y: ORIGIN.y + STEP * 0.9 }];
    expect(pickDropSlot(ORIGIN, nearby, { step: STEP })).toEqual(ORIGIN);
  });

  it('treats a slightly nudged component as still parked', () => {
    // A few px of drag should not make the next drop land on top of it.
    const nudged = [{ x: ORIGIN.x + 4, y: ORIGIN.y - 3 }];
    expect(pickDropSlot(ORIGIN, nudged, { step: STEP })).toEqual({
      x: ORIGIN.x + STEP,
      y: ORIGIN.y + STEP,
    });
  });

  it('stops cascading instead of walking off the viewport', () => {
    // Every slot occupied: it stacks at the last one rather than marching
    // out of sight, which is the failure mode being fixed.
    const full = Array.from({ length: 40 }, (_, i) => ({
      x: ORIGIN.x + i * STEP,
      y: ORIGIN.y + i * STEP,
    }));
    const slot = pickDropSlot(ORIGIN, full, { step: STEP, maxSlots: 12 });
    expect(slot).toEqual({ x: ORIGIN.x + 12 * STEP, y: ORIGIN.y + 12 * STEP });
  });

  it('treats boards and components as one set of parked items', () => {
    // Boards used to be placed 420 world-px right of the active board plus a
    // per-board offset — never in the visible corner, and marching further
    // out with every board added. The canvas now feeds boards and components
    // through the same rule, so a board parked in the corner pushes the next
    // component to the next slot and a component pushes the next board.
    const boardInCorner = [{ x: ORIGIN.x, y: ORIGIN.y, boardKind: 'arduino-uno' }];
    expect(pickDropSlot(ORIGIN, boardInCorner, { step: STEP })).toEqual({
      x: ORIGIN.x + STEP,
      y: ORIGIN.y + STEP,
    });
    const mixed = [
      { x: ORIGIN.x, y: ORIGIN.y, metadataId: 'led' },
      { x: ORIGIN.x + STEP, y: ORIGIN.y + STEP, boardKind: 'esp32' },
    ];
    expect(pickDropSlot(ORIGIN, mixed, { step: STEP })).toEqual({
      x: ORIGIN.x + 2 * STEP,
      y: ORIGIN.y + 2 * STEP,
    });
  });

  it('scales with zoom, since the step arrives in world units', () => {
    // The canvas passes 36 screen-px / zoom, so the gap looks the same
    // whatever the zoom level.
    const zoomedOut = pickDropSlot(ORIGIN, [ORIGIN], { step: 36 / 0.5 });
    expect(zoomedOut).toEqual({ x: 100 + 72, y: 50 + 72 });
  });
});
