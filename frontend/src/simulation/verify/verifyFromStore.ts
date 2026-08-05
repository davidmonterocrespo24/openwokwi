/**
 * Store-driven pre-flight verification — shared by the Run button
 * (EditorToolbar) and any programmatic runner (extensions can gate their own
 * run paths on the same rules). Builds the worst-case snapshot — every wired
 * digital pin driven HIGH at the board's vcc — and solves it.
 *
 * Returns null when there is nothing analysable yet or the solver failed to
 * converge; callers treat null as "don't block".
 */

import { useSimulatorStore } from '../../store/useSimulatorStore';
import { buildInputFromStore } from '../spice/storeAdapter';
import { BOARD_PIN_GROUPS } from '../spice/boardPinGroups';
import type { PinSourceState } from '../spice/types';
import { verifyCircuit, type VerificationResult } from './circuitVerifier';

export async function verifyCircuitFromStore(): Promise<VerificationResult | null> {
  try {
    const sim = useSimulatorStore.getState();
    // Skip if the circuit hasn't got anything analysable on it yet.
    const hasSource = sim.components.some(
      (c) =>
        c.metadataId.startsWith('signal-generator') ||
        c.metadataId.startsWith('battery') ||
        c.metadataId.startsWith('power-supply'),
    );
    if (!hasSource && sim.boards.length === 0) return null;

    const snap = {
      components: sim.components.map((c) => ({
        id: c.id,
        metadataId: c.metadataId,
        properties: c.properties,
      })),
      wires: sim.wires,
      boards: sim.boards.map((b) => {
        // Realistic pre-flight: simulate the WORST CASE — every digital
        // pin connected to a load is forced HIGH at the board's vcc.
        // This is what we want because the user's sketch WILL eventually
        // do `digitalWrite(pin, HIGH)` (otherwise why is the LED wired?).
        // Testing idle state would never flag a missing series resistor
        // because the LED draws zero current when its pin is LOW.
        //
        // Caveat: pins wired only to inputs (e.g. a pull-up resistor +
        // button) get over-driven here too. The verifier rules are
        // already tolerant — a properly-spec'd pull-up sees minimal
        // current and doesn't trip overcurrent / overpower. A circuit
        // that would actually fault under HIGH is flagged correctly.
        const pinStates: Record<string, PinSourceState> = {};
        const group = BOARD_PIN_GROUPS[b.boardKind] ?? BOARD_PIN_GROUPS.default;
        const wiredPinNames = new Set<string>();
        for (const w of sim.wires) {
          if (w.start.componentId === b.id) wiredPinNames.add(w.start.pinName);
          if (w.end.componentId === b.id) wiredPinNames.add(w.end.pinName);
        }
        for (const pinName of wiredPinNames) {
          // Skip GND / power-rail pin names — they belong to the rail
          // groups and don't need to be re-asserted as digital sources.
          if (group.gnd.includes(pinName)) continue;
          if (group.vcc_pins.includes(pinName)) continue;
          const arduinoPin = Number.parseInt(pinName, 10);
          // Skip pins we can't identify as a digital GPIO (e.g.
          // 'AREF', 'RESET', 'TX', 'RX' on some boards). Those are
          // either rail-ish or non-driven by the sketch.
          if (Number.isNaN(arduinoPin)) continue;
          pinStates[pinName] = { type: 'digital', v: group.vcc };
        }
        return { id: b.id, boardKind: b.boardKind, pinStates };
      }),
    };
    const input = buildInputFromStore(snap);
    const result = await verifyCircuit(input);
    // Concise outcome log — verification failing silently in production is
    // hard to spot otherwise (the rules read 0 A when currents are missing).
    console.log(
      '[verify]',
      JSON.stringify({
        errors: result.errors.map((e) => e.code),
        warnings: result.warnings.map((w) => w.code),
        solved: !!result.solve,
        branches: result.solve ? Object.keys(result.solve.branchCurrents) : null,
        nodes: result.solve ? Object.keys(result.solve.nodeVoltages) : null,
      }),
    );
    return result;
  } catch (err) {
    console.warn('[verifyCircuit] failed', err);
    return null;
  }
}
