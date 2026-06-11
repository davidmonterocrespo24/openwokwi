/**
 * Phase 4 — wire resistance.
 *
 * Wires marked with `length_cm` get a series R in the netlist
 * (0.01 ohm/cm, order-of-magnitude correct for AWG 22 copper).
 * Wires without `length_cm` keep the legacy perfect-conductor
 * union-find behaviour — backwards compatible.
 *
 * The new path is fully opt-in so no existing canvas changes.
 * Once the UI starts attaching length_cm based on canvas geometry,
 * users see real voltage drop on long buses (e.g. a divider sagging
 * because the supply wire has 5 mΩ in series).
 */
import { describe, it, expect } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { runNetlist } from './helpers/testSolver';
import type { BuildNetlistInput } from '../simulation/spice/types';

function dividerWithWires(supplyWire: { length_cm?: number }): BuildNetlistInput {
  return {
    components: [
      { id: 'r1', metadataId: 'resistor', properties: { value: '100' } },
      { id: 'r2', metadataId: 'resistor', properties: { value: '100' } },
    ],
    wires: [
      // 5V → r1 pin 1 (this is the wire we may add length to)
      {
        id: 'w_supply',
        start: { componentId: 'uno', pinName: '5V' },
        end: { componentId: 'r1', pinName: '1' },
        length_cm: supplyWire.length_cm,
      },
      // r1 pin 2 → r2 pin 1 (the divider mid)
      { id: 'w_mid', start: { componentId: 'r1', pinName: '2' }, end: { componentId: 'r2', pinName: '1' } },
      // r2 pin 2 → GND
      { id: 'w_gnd', start: { componentId: 'r2', pinName: '2' }, end: { componentId: 'uno', pinName: 'GND' } },
    ],
    boards: [
      {
        id: 'uno',
        vcc: 5,
        pins: {
          '5V': { type: 'digital', v: 5 },
          GND: { type: 'digital', v: 0 },
        },
        pinTargets: { 'GND': 'GND', '5V': 'power(5)' },
      },
    ],
    analysis: { kind: 'op' },
  };
}

describe('Phase 4 — wire resistance (opt-in via length_cm)', () => {
  it('wires without length_cm produce no R_wire_ cards (backwards compatible)', () => {
    const { netlist } = buildNetlist(dividerWithWires({}));
    expect(netlist).not.toMatch(/R_wire_/);
  });

  it('wires with length_cm > 0 emit a R_wire_<id> card with correct ohms', () => {
    const { netlist } = buildNetlist(dividerWithWires({ length_cm: 50 }));
    // 50 cm × 0.01 ohm/cm = 0.5 ohm
    expect(netlist).toMatch(/R_wire_w_supply\s+\S+\s+\S+\s+0\.5\b/);
  });

  it(
    'a 1 cm supply wire shifts the divider midpoint by only a few mV',
    { timeout: 30_000 },
    async () => {
      const { netlist, pinNetMap } = buildNetlist(dividerWithWires({ length_cm: 1 }));
      const result = await runNetlist(netlist);
      const midNet = pinNetMap.get('r1:2');
      const vMid = result.dcValue(`v(${midNet})`);
      // 100/100 divider with 5V supply and 1 cm × 0.01 ohm wire (10 mohm)
      // in series. Current ≈ 5/200 = 25 mA. Wire drop = 0.25 mV. Vmid ≈ 2.4999 V.
      expect(vMid).toBeGreaterThan(2.499);
      expect(vMid).toBeLessThan(2.501);
    },
  );

  it(
    'a 500 cm supply wire shifts the divider midpoint visibly',
    { timeout: 30_000 },
    async () => {
      const { netlist, pinNetMap } = buildNetlist(dividerWithWires({ length_cm: 500 }));
      const result = await runNetlist(netlist);
      const midNet = pinNetMap.get('r1:2');
      const vMid = result.dcValue(`v(${midNet})`);
      // 500 cm × 0.01 ohm/cm = 5 ohm in series with 200 ohm divider.
      // Effective: 5V × 100 / (5+100+100) ≈ 2.439 V.
      expect(vMid).toBeGreaterThan(2.40);
      expect(vMid).toBeLessThan(2.46);
    },
  );

  it('length_cm = 0 falls back to perfect-conductor behaviour', () => {
    const { netlist } = buildNetlist(dividerWithWires({ length_cm: 0 }));
    expect(netlist).not.toMatch(/R_wire_/);
  });
});
