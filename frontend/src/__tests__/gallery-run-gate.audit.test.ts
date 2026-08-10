import { describe, expect, it } from 'vitest';
import { exampleProjects as examples } from '../data/examples';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { BOARD_PIN_GROUPS } from '../simulation/spice/boardPinGroups';
import { verifyCircuit } from '../simulation/verify/circuitVerifier';
import { stripBrandPrefix, isBoardComponentType } from '../utils/exampleToBuildNetlistInput';
import type { PinSourceState } from '../simulation/spice/types';
import type { BoardKind } from '../store/useSimulatorStore';

/**
 * Gallery audit: which examples would the Run button REFUSE to start?
 *
 * EditorToolbar's `checkOrBlock` runs `verifyCircuitFromStore()` before every Run and
 * returns false when the verifier reports errors — the compile never fires and the user
 * gets a "run anyway?" modal. So a circuit error is not cosmetic: it is the difference
 * between an example that runs and one that appears dead.
 *
 * This mattered because the defects hide until the circuit solves END TO END. c3-button
 * wired its button to pins that do not exist, so the netlist never closed and nobody saw
 * that its LED had no series resistor. Fixing the pin names surfaced a 506 mA LED that
 * had been wrong since the example was written.
 *
 * Reproduces the Run gate exactly: same worst-case snapshot (every wired digital pin
 * forced HIGH at the board's vcc, rails skipped), same buildInputFromStore, same
 * verifyCircuit. Real ngspice, no browser.
 */

function boardKindOf(example: (typeof examples)[number]): BoardKind | null {
  const bt = (example as { boardType?: string }).boardType;
  return (bt as BoardKind) ?? null;
}

/** The board component id an example's wires refer to (legacy examples say 'arduino-uno'). */
function boardIdsOf(example: (typeof examples)[number]): Set<string> {
  const declared = new Set(example.components?.map((c) => c.id) ?? []);
  const refs = new Set<string>();
  for (const w of example.wires ?? []) {
    for (const ep of [w.start, w.end]) if (!declared.has(ep.componentId)) refs.add(ep.componentId);
  }
  return refs;
}

async function runGate(example: (typeof examples)[number]) {
  const kind = boardKindOf(example);
  const components = (example.components ?? [])
    .filter((c) => !isBoardComponentType(c.type))
    .map((c) => ({
      id: c.id,
      metadataId: stripBrandPrefix(c.type),
      properties: c.properties ?? {},
    }));
  const wires = (example.wires ?? []).map((w) => ({
    id: w.id,
    start: { componentId: w.start.componentId, pinName: w.start.pinName },
    end: { componentId: w.end.componentId, pinName: w.end.pinName },
    color: '#666',
    waypoints: [],
  }));

  const boards = kind
    ? [...boardIdsOf(example)].map((id) => {
        const group = BOARD_PIN_GROUPS[kind] ?? BOARD_PIN_GROUPS.default;
        const pinStates: Record<string, PinSourceState> = {};
        const wired = new Set<string>();
        for (const w of wires) {
          if (w.start.componentId === id) wired.add(w.start.pinName);
          if (w.end.componentId === id) wired.add(w.end.pinName);
        }
        for (const pinName of wired) {
          if (group.gnd.includes(pinName)) continue;
          if (group.vcc_pins.includes(pinName)) continue;
          if (Number.isNaN(Number.parseInt(pinName, 10))) continue;
          pinStates[pinName] = { type: 'digital', v: group.vcc };
        }
        return { id, boardKind: kind, pinStates };
      })
    : [];

  const input = buildInputFromStore({ components, wires, boards });
  return verifyCircuit(input);
}

describe('gallery: no example is blocked by its own circuit', () => {
  const candidates = examples.filter(
    (e) => (e.components?.length ?? 0) > 0 && (e.wires?.length ?? 0) > 0,
  );

  it('audits every wired example and reports the blockers', async () => {
    const blocked: Array<{ id: string; board: string; codes: string[]; detail: string }> = [];
    for (const ex of candidates) {
      let res;
      try {
        res = await runGate(ex);
      } catch {
        continue; // unbuildable snapshot — the real app treats that as "don't block"
      }
      if (res.errors.length) {
        blocked.push({
          id: ex.id,
          board: (ex as { boardType?: string }).boardType ?? '(sin placa)',
          codes: [...new Set(res.errors.map((e) => e.code))],
          detail: res.errors[0].message.slice(0, 110),
        });
      }
    }

    if (blocked.length) {
      console.log(
        `\n=== ${blocked.length} de ${candidates.length} ejemplos con el Run BLOQUEADO ===`,
      );
      for (const b of blocked)
        console.log(`  ${b.board.padEnd(20)} ${b.id.padEnd(36)} ${b.codes.join(',')}  ${b.detail}`);
    }
    expect(blocked.map((b) => `${b.id} [${b.codes.join(',')}]`)).toEqual([]);
  }, 600_000);
});
