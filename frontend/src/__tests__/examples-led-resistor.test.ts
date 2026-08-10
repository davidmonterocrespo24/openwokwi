/**
 * Every gallery LED must have a resistor in its path.
 *
 * The electrical model is honest: a LED straight across a 3.3 V or 5 V pin
 * asks for an absurd current, the runtime burns it out and it stays dark
 * for the rest of the run — while the sketch happily prints "LED ON". That
 * is the worst kind of broken example, because nothing looks like an
 * error. Twenty-four of them shipped that way (mostly Pico, and every RGB
 * example, which needs one resistor PER CHANNEL) before this guard existed.
 *
 * The check walks the wiring graph rather than the LED's immediate
 * neighbour: a resistor protects from the anode side, from the cathode
 * side, and from the far side of a transistor or relay contact.
 */
import { describe, it, expect } from 'vitest';
import { exampleProjects } from '../data/examples';

const LED_TYPES = new Set(['wokwi-led', 'wokwi-rgb-led']);
/** Anything that limits current well enough to save the LED. */
const LIMITER_TYPES = [
  'wokwi-resistor',
  'wokwi-resistor-us',
  'wokwi-potentiometer',
  'wokwi-slide-potentiometer',
  'wokwi-ntc-temperature-sensor',
  'wokwi-photoresistor-sensor',
];

interface Comp {
  type?: string;
  id?: string;
}
interface Wire {
  start?: { componentId?: string };
  end?: { componentId?: string };
}

function isLimiter(type: string | undefined): boolean {
  return !!type && LIMITER_TYPES.some((t) => type.startsWith(t));
}

/** LEDs with no current limiter anywhere on their side of the circuit. */
function unprotectedLeds(example: {
  components?: Comp[];
  wires?: Wire[];
}): string[] {
  const comps = new Map<string, string>();
  for (const c of example.components ?? []) {
    if (c?.id) comps.set(c.id, c.type ?? '');
  }
  const leds = [...comps.entries()]
    .filter(([, type]) => LED_TYPES.has(type))
    .map(([id]) => id);
  if (!leds.length) return [];

  const adj = new Map<string, string[]>();
  for (const w of example.wires ?? []) {
    const a = w?.start?.componentId;
    const b = w?.end?.componentId;
    if (!a || !b) continue;
    adj.set(a, [...(adj.get(a) ?? []), b]);
    adj.set(b, [...(adj.get(b) ?? []), a]);
  }

  return leds.filter((led) => {
    const seen = new Set([led]);
    const queue = [...(adj.get(led) ?? [])];
    while (queue.length) {
      const node = queue.shift()!;
      if (seen.has(node)) continue;
      seen.add(node);
      const type = comps.get(node);
      if (isLimiter(type)) return false; // protected
      // An unknown id is the board itself (a supply rail) and another LED
      // is not protection either: neither continues the search.
      if (type === undefined || LED_TYPES.has(type)) continue;
      queue.push(...(adj.get(node) ?? []));
    }
    return true;
  });
}

describe('gallery examples — LED current limiting', () => {
  it('no example drives a LED straight off a pin', () => {
    const offenders: string[] = [];
    for (const ex of exampleProjects) {
      for (const led of unprotectedLeds(ex as never)) {
        offenders.push(`${ex.id}: ${led}`);
      }
    }
    expect(offenders, 'LEDs without a series resistor').toEqual([]);
  });
});
