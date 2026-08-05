/**
 * Breadboard hole-occupancy rules ("1 pin = 1 cable"):
 *  - clicking an occupied hole selects the occupying wire (findWireAtHole);
 *  - a new wire end landing in an occupied hole shifts to the nearest free
 *    hole of the same 5-hole strip / power rail (resolveFreeHole);
 *  - seated component legs (invisible bb wires) count as occupancy but are
 *    never selectable.
 * Plus the jumper color policy: rails are red/black, strips draw from the
 * jumper palette deterministically per wire id.
 */
import { describe, it, expect } from 'vitest';
import {
  findWireAtHole,
  holeIsOccupied,
  resolveFreeHole,
} from '../utils/breadboardOccupancy';
import {
  railWireColor,
  jumperColorForId,
  WIRE_JUMPER_PALETTE,
} from '../utils/wireUtils';
import type { Wire } from '../types/wire';

const wire = (
  id: string,
  s: [string, string],
  e: [string, string],
  bb = false,
): Wire =>
  ({
    id,
    start: { componentId: s[0], pinName: s[1], x: 0, y: 0 },
    end: { componentId: e[0], pinName: e[1], x: 0, y: 0 },
    waypoints: [],
    color: '#22c55e',
    ...(bb ? { bb: true } : {}),
  }) as unknown as Wire;

// Column 21, top bank: holes a-e — one strip.
const STRIP = ['21t.a', '21t.b', '21t.c', '21t.d', '21t.e'];
const ALL = [...STRIP, '22t.a', '22t.b', 'bp.1', 'bp.2', 'bn.1'];

describe('findWireAtHole', () => {
  it('returns the visible wire whose end sits in the hole', () => {
    const w = wire('w1', ['bb1', '21t.a'], ['bb1', '33t.b']);
    expect(findWireAtHole([w], 'bb1', '21t.a')?.id).toBe('w1');
    expect(findWireAtHole([w], 'bb1', '33t.b')?.id).toBe('w1');
    expect(findWireAtHole([w], 'bb1', '21t.b')).toBeNull();
  });

  it('never returns invisible seating wires', () => {
    const seat = wire('s1', ['comp1', 'A'], ['bb1', '21t.a'], true);
    expect(findWireAtHole([seat], 'bb1', '21t.a')).toBeNull();
  });

  it('topmost wire wins when stacked (legacy stacked circuits)', () => {
    const w1 = wire('w1', ['bb1', '21t.a'], ['bb1', '30t.a']);
    const w2 = wire('w2', ['bb1', '21t.a'], ['bb1', '31t.a']);
    expect(findWireAtHole([w1, w2], 'bb1', '21t.a')?.id).toBe('w2');
  });
});

describe('holeIsOccupied', () => {
  it('counts seated legs (bb wires) as occupancy', () => {
    const seat = wire('s1', ['comp1', 'A'], ['bb1', '21t.a'], true);
    expect(holeIsOccupied([seat], 'bb1', '21t.a')).toBe(true);
    expect(holeIsOccupied([seat], 'bb1', '21t.b')).toBe(false);
  });
});

describe('resolveFreeHole', () => {
  it('keeps a free hole as-is', () => {
    expect(resolveFreeHole('breadboard', 'bb1', '21t.c', [], ALL)).toBe('21t.c');
  });

  it('shifts to the nearest free hole in the same strip', () => {
    const seat = wire('s1', ['comp1', 'A'], ['bb1', '21t.a'], true);
    expect(resolveFreeHole('breadboard', 'bb1', '21t.a', [seat], ALL)).toBe('21t.b');
  });

  it('never shifts across strips', () => {
    // Whole 21t strip occupied → falls back to the clicked hole, NOT 22t.
    const wires = STRIP.map((p, i) => wire(`w${i}`, ['bb1', p], ['bb1', '40t.a']));
    expect(resolveFreeHole('breadboard', 'bb1', '21t.a', wires, ALL)).toBe('21t.a');
  });

  it('shifts within a power rail too', () => {
    const w = wire('w1', ['bb1', 'bp.1'], ['esp32_1', '3V3']);
    expect(resolveFreeHole('breadboard', 'bb1', 'bp.1', [w], ALL)).toBe('bp.2');
  });

  it('non-breadboard pins pass through', () => {
    const w = wire('w1', ['led1', 'A'], ['bb1', '21t.a']);
    expect(resolveFreeHole('wokwi-led', 'led1', 'A', [w], ['A', 'C'])).toBe('A');
  });
});

describe('wire color policy', () => {
  it('rails are red (+) / black (−)', () => {
    expect(railWireColor('tp.5')).toBe('#cc0000');
    expect(railWireColor('bp.12')).toBe('#cc0000');
    expect(railWireColor('tn.5')).toBe('#000000');
    expect(railWireColor('bn.1')).toBe('#000000');
    expect(railWireColor('21t.a')).toBeNull();
    expect(railWireColor('GND')).toBeNull();
  });

  it('jumper colors are deterministic per id and inside the palette', () => {
    const c = jumperColorForId('wire_42');
    expect(jumperColorForId('wire_42')).toBe(c);
    expect(WIRE_JUMPER_PALETTE).toContain(c);
    // Different ids spread — at least two distinct colors among a handful.
    const set = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map(jumperColorForId));
    expect(set.size).toBeGreaterThan(1);
  });

  it('palette reserves red and black for rails', () => {
    expect(WIRE_JUMPER_PALETTE).not.toContain('#cc0000');
    expect(WIRE_JUMPER_PALETTE).not.toContain('#000000');
  });
});
