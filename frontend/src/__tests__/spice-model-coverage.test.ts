// @vitest-environment node
/**
 * A part that DEFERS to the circuit must have a circuit to defer to.
 *
 * Three parts hand control of their pin to the electrical solve rather than
 * seeding it themselves (they check `spiceDriven(simulator)` and stand down).
 * That is the right design — a mis-wired button has to read stuck, not "work
 * anyway" — but it only works if SPICE actually models the part. `pushbutton`
 * and `slide-switch` were modelled; `pushbutton-6mm` was not, so on every board
 * with spiceDrivenInputs (all of them) it stood down and nothing took over:
 * the button was dead on the canvas, silently, with no error anywhere.
 *
 * This test reads the parts themselves rather than a list, so the next variant
 * someone adds is covered the day it is written.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isSpiceMapped } from '../simulation/spice/componentToSpice';

const PARTS_DIR = join(__dirname, '..', 'simulation', 'parts');

/** metadataIds whose part stands down when the board solves its inputs. */
function partsThatDeferToSpice(): string[] {
  const found = new Set<string>();
  for (const file of readdirSync(PARTS_DIR).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(PARTS_DIR, file), 'utf8');
    // Walk registrations in order; a `spiceDriven(` inside a registration body
    // belongs to the id that opened it.
    let current: string | null = null;
    for (const line of src.split('\n')) {
      const reg = line.match(/PartSimulationRegistry\.register\(\s*['"]([^'"]+)['"]/);
      if (reg) current = reg[1];
      if (current && /spiceDriven\s*\(/.test(line)) found.add(current);
    }
  }
  return [...found].sort();
}

describe('parts that defer to the electrical solve', () => {
  it('every one of them is modelled by SPICE', () => {
    const deferring = partsThatDeferToSpice();
    // Sanity: the scan finds something, so a rename cannot make this vacuous.
    expect(deferring.length).toBeGreaterThan(0);
    const unmodelled = deferring.filter((id) => !isSpiceMapped(id));
    expect(
      unmodelled,
      `these parts stand down for the circuit but SPICE has no model for them, ` +
        `so they do nothing at all on a board with spiceDrivenInputs: ${unmodelled.join(', ')}`,
    ).toEqual([]);
  });

  it('the 6mm pushbutton is modelled as the same switch as the full-size one', async () => {
    const { componentToSpice } = await import('../simulation/spice/componentToSpice');
    const lookup = (p: string) => (p === '1.l' ? 'n1' : p === '2.l' ? 'n2' : null);
    const big = componentToSpice({ id: 'b', metadataId: 'pushbutton', properties: {} } as never, lookup, {
      vcc: 3.3,
    } as never);
    const small = componentToSpice(
      { id: 'b', metadataId: 'pushbutton-6mm', properties: {} } as never,
      lookup,
      { vcc: 3.3 } as never,
    );
    expect(small).not.toBeNull();
    expect(small!.cards).toEqual(big!.cards);
  });
});
