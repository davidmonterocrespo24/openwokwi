/**
 * chipJson — tolerant helpers for the custom chip manifest.
 *
 * The canonical `pins` shape is a flat array (Wokwi-compatible): entries are
 * pin-name strings, `""` skips a slot, and `{name,x,y}` objects position a pin
 * explicitly. An earlier AI-agent prompt taught `{"pins": {"left": [...],
 * "right": [...]}}` instead, so projects saved from those sessions carry that
 * shape — normalize it here instead of rendering a pinless chip.
 */

export interface ChipPinEntry {
  name: string;
  x?: number;
  y?: number;
}

function toPinEntry(p: unknown): ChipPinEntry {
  if (typeof p === 'string') return { name: p };
  if (p && typeof p === 'object') {
    const o = p as { name?: unknown; x?: unknown; y?: unknown };
    return {
      name: String(o.name ?? ''),
      x: typeof o.x === 'number' ? o.x : undefined,
      y: typeof o.y === 'number' ? o.y : undefined,
    };
  }
  return { name: '' };
}

/**
 * Normalize a parsed chip.json `pins` value into the flat entry list.
 * Accepts the canonical array shape and the legacy `{left,right}` (and
 * `{top,bottom}`) object shape; anything else yields an empty list.
 */
export function normalizeChipPins(pins: unknown): ChipPinEntry[] {
  if (Array.isArray(pins)) return pins.map(toPinEntry);
  if (pins && typeof pins === 'object') {
    const o = pins as Record<string, unknown>;
    const sides = ['left', 'right', 'top', 'bottom'].filter((s) => Array.isArray(o[s]));
    if (sides.length > 0) {
      console.warn(
        '[custom-chip] chip.json uses the legacy {left,right} pins object — ' +
        'flattening. The canonical shape is a flat array: "pins": ["VCC", ...].',
      );
      return sides.flatMap((s) => (o[s] as unknown[]).map(toPinEntry));
    }
  }
  return [];
}

/** Normalize and return just the pin names (positions dropped). */
export function normalizeChipPinNames(pins: unknown): string[] {
  return normalizeChipPins(pins).map((p) => p.name);
}
