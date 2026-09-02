import { describe, it, expect, vi } from 'vitest';
import { normalizeChipPins, normalizeChipPinNames } from '../simulation/customChips/chipJson';

describe('normalizeChipPins', () => {
  it('passes through the canonical flat string array', () => {
    expect(normalizeChipPinNames(['VCC', 'GND', 'IN', 'OUT'])).toEqual([
      'VCC', 'GND', 'IN', 'OUT',
    ]);
  });

  it('keeps empty-string slot skips', () => {
    expect(normalizeChipPinNames(['A', '', 'B'])).toEqual(['A', '', 'B']);
  });

  it('keeps explicit {name,x,y} placements', () => {
    expect(normalizeChipPins([{ name: 'CLK', x: 4, y: 20 }, 'D0'])).toEqual([
      { name: 'CLK', x: 4, y: 20 },
      { name: 'D0', x: undefined, y: undefined },
    ]);
  });

  it('flattens the legacy {left,right} object shape with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      normalizeChipPinNames({ left: ['VCC', 'GND'], right: ['OUT'] }),
    ).toEqual(['VCC', 'GND', 'OUT']);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('flattens {top,bottom} sides too', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(normalizeChipPinNames({ top: ['A'], bottom: ['B'] })).toEqual(['A', 'B']);
    warn.mockRestore();
  });

  it('returns empty for garbage', () => {
    expect(normalizeChipPins(undefined)).toEqual([]);
    expect(normalizeChipPins(null)).toEqual([]);
    expect(normalizeChipPins('VCC,GND')).toEqual([]);
    expect(normalizeChipPins({ pins: 'nope' })).toEqual([]);
    expect(normalizeChipPins(42)).toEqual([]);
  });
});
