/**
 * Regression: a board-less circuit reported by a velxio.dev user
 * (project "dividor resistivo") — 9 V cell -> 7805 -> 1k/2k2 divider.
 *
 * The SPICE side always solved this correctly (midpoint = 5 * 2200/3200 =
 * 3.44 V), but the voltmeter rebuilt its own pin->net map and skipped the
 * component-pin ground canonicalization NetlistBuilder does. With no board
 * on the canvas nothing else anchors node "0", so every auto-generated net
 * name shifted by one and the meter subtracted two unrelated nodes,
 * displaying 1.56 V (= 5 - 3.44) instead of 3.44 V.
 */
import { describe, it, expect } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { buildPinNetLookup, readVoltmeter } from '../simulation/spice/probes';
import { runNetlist } from './helpers/testSolver';
import type { Wire } from '../types/wire';

const wire = (id: string, a: [string, string], b: [string, string]) =>
  ({
    id,
    start: { componentId: a[0], pinName: a[1] },
    end: { componentId: b[0], pinName: b[1] },
  }) as Wire;

const wires: Wire[] = [
  wire('w1', ['bat', '+'], ['reg', 'VIN']),
  wire('w2', ['bat', '−'], ['reg', 'GND']),
  wire('w3', ['r2k2', '2'], ['bat', '−']),
  wire('w4', ['vm', 'V-'], ['r2k2', '2']),
  wire('w5', ['reg', 'VOUT'], ['r1k', '1']),
  wire('w6', ['r1k', '2'], ['r2k2', '1']),
  wire('w7', ['r1k', '2'], ['vm', 'V+']),
];

const components = [
  { id: 'bat', metadataId: 'battery-9v', properties: {} },
  { id: 'reg', metadataId: 'reg-7805', properties: {} },
  { id: 'r2k2', metadataId: 'resistor-2k2', properties: { value: '2200' } },
  { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
  { id: 'r1k', metadataId: 'resistor-1k', properties: { value: '1000' } },
];

const EXPECTED = (5 * 2200) / 3200; // 3.4375 V

describe('voltmeter on a board-less 7805 divider', () => {
  it('the probe map agrees with the netlist map, with no board to anchor ground', () => {
    const { pinNetMap } = buildNetlist({
      components,
      wires,
      boards: [],
      analysis: { kind: 'op' },
    });
    const probe = buildPinNetLookup(wires, [], [], []);
    for (const [key, net] of pinNetMap) {
      const [componentId, pinName] = key.split(':');
      expect(probe(componentId, pinName), `pin ${key}`).toBe(net);
    }
    // The regulator's GND pin alone must pin the return net to node "0".
    expect(probe('reg', 'GND')).toBe('0');
    expect(probe('bat', '−')).toBe('0');
  });

  it('reads ~3.44V at the divider midpoint', { timeout: 30_000 }, async () => {
    const { netlist, pinNetMap } = buildNetlist({
      components,
      wires,
      boards: [],
      analysis: { kind: 'op' },
    });
    const result = await runNetlist(netlist);
    const nodeVoltages: Record<string, number> = {};
    for (const name of result.variableNames) {
      const m = name.match(/^v\((.+)\)$/i);
      if (m) nodeVoltages[m[1]] = result.dcValue(name);
    }

    const solve = {
      nodeVoltages,
      branchCurrents: {},
      converged: true,
      error: null,
      solveMs: 0,
      submittedNetlist: netlist,
      pinNetMap,
      analysisMode: 'op' as const,
    };

    // Path A: the solver's own published map (what Voltmeter.tsx now uses).
    const viaSolverMap = readVoltmeter(
      { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
      (c, p) => pinNetMap.get(`${c}:${p}`) ?? null,
      solve,
    );
    expect(viaSolverMap.value).toBeCloseTo(EXPECTED, 2);

    // Path B: the rebuilt fallback, used before the first solve lands.
    const viaRebuild = readVoltmeter(
      { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
      buildPinNetLookup(wires, [], [], []),
      solve,
    );
    expect(viaRebuild.value).toBeCloseTo(EXPECTED, 2);
  });
});
