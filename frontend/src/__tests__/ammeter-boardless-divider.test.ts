import { describe, it, expect } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { readAmmeter } from '../simulation/spice/probes';
import { runNetlist } from './helpers/testSolver';
import type { Wire } from '../types/wire';

const wire = (id: string, a: [string, string], b: [string, string]) =>
  ({ id, start: { componentId: a[0], pinName: a[1] }, end: { componentId: b[0], pinName: b[1] } }) as Wire;

/**
 * Companion to voltmeter-boardless-divider: the same user circuit with an
 * ammeter in series. Guards BOTH the magnitude and the sign — every previous
 * ammeter assertion wrapped the value in Math.abs(), so the polarity was
 * never actually pinned down and the ordinary series wiring
 * (source -> A+ -> load -> A-) read negative.
 */
describe('ammeter on the board-less 7805 divider', () => {
  it('reads +1.56 mA through the 1k+2k2 chain, positive into A+', { timeout: 30_000 }, async () => {
    // 9V -> 7805 -> [A] -> 1k -> 2k2 -> GND
    const wires: Wire[] = [
      wire('w1', ['bat', '+'], ['reg', 'VIN']),
      wire('w2', ['bat', '−'], ['reg', 'GND']),
      wire('w3', ['reg', 'VOUT'], ['am', 'A+']),
      wire('w4', ['am', 'A-'], ['r1k', '1']),
      wire('w5', ['r1k', '2'], ['r2k2', '1']),
      wire('w6', ['r2k2', '2'], ['bat', '−']),
    ];
    const { netlist } = buildNetlist({
      components: [
        { id: 'bat', metadataId: 'battery-9v', properties: {} },
        { id: 'reg', metadataId: 'reg-7805', properties: {} },
        { id: 'am', metadataId: 'instr-ammeter', properties: {} },
        { id: 'r1k', metadataId: 'resistor-1k', properties: { value: '1000' } },
        { id: 'r2k2', metadataId: 'resistor-2k2', properties: { value: '2200' } },
      ],
      wires,
      boards: [],
      analysis: { kind: 'op' },
    });
    const result = await runNetlist(netlist);
    const branchCurrents: Record<string, number> = {};
    for (const name of result.variableNames) {
      const m = name.match(/^i\((.+)\)$/i);
      if (m) branchCurrents[m[1].toLowerCase()] = result.dcValue(name);
    }
    const reading = readAmmeter({ id: 'am', metadataId: 'instr-ammeter', properties: {} }, {
      nodeVoltages: {}, branchCurrents, converged: true, error: null, solveMs: 0,
      submittedNetlist: netlist, pinNetMap: new Map(), analysisMode: 'op' as const,
    });
    expect(reading.unit).toBe('mA');
    expect(reading.value).toBeCloseTo(1.5625, 2);
  });
});
