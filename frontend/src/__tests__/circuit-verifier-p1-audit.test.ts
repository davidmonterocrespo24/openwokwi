/**
 * circuitVerifier — audit rules (2026-07): unpowered nets, missing return
 * path, relay coil voltage mismatch.
 *
 * Each case reproduces a REAL circuit shape the verifier previously blessed
 * with zero findings:
 *   (a) a battery with only its + pole wired (floating battery),
 *   (b) a MOSFET switching a load on a rail nothing powers,
 *   (c) a 12 V-coil relay fed from a 5 V supply,
 *   (d) a "power net" (VCC pins tied together) with no source behind it.
 *
 * All three rules are graph-based and run BEFORE the solve, so the
 * assertions hold even when ngspice cannot converge on the broken circuit.
 */
import { describe, it, expect } from 'vitest';
import { verifyCircuit } from '../simulation/verify/circuitVerifier';
import type { BuildNetlistInput } from '../simulation/spice/types';

// ── Building blocks (same shapes as circuit-verifier.test.ts) ─────────────

function pwr(id = 'src', volts = 5): BuildNetlistInput['components'][number] {
  return {
    id,
    metadataId: 'signal-generator',
    properties: { waveform: 'dc', offset: volts, amplitude: 0, frequency: 1 },
  };
}

function psu(id = 'psu', volts = 5): BuildNetlistInput['components'][number] {
  return { id, metadataId: 'power-supply', properties: { voltage: volts, currentLimit: 1 } };
}

function battery(id = 'bat'): BuildNetlistInput['components'][number] {
  return { id, metadataId: 'battery-9v', properties: {} };
}

function res(id: string, ohms: string): BuildNetlistInput['components'][number] {
  return { id, metadataId: 'resistor', properties: { value: ohms } };
}

function led(id: string, color = 'red'): BuildNetlistInput['components'][number] {
  return { id, metadataId: 'led', properties: { color } };
}

function relay(id: string, coilVolts: number): BuildNetlistInput['components'][number] {
  return { id, metadataId: 'relay', properties: { coil_voltage: coilVolts } };
}

function w(
  id: string,
  from: [string, string],
  to: [string, string],
): BuildNetlistInput['wires'][number] {
  return {
    id,
    start: { componentId: from[0], pinName: from[1] },
    end: { componentId: to[0], pinName: to[1] },
  };
}

function input(
  components: BuildNetlistInput['components'],
  wires: BuildNetlistInput['wires'],
  boards: BuildNetlistInput['boards'] = [],
): BuildNetlistInput {
  return { components, wires, boards, analysis: { kind: 'op' } };
}

const codesOf = (r: { warnings: { code: string }[] }) => r.warnings.map((x) => x.code);

// ── (a) Floating battery — no return path ─────────────────────────────────

describe('no-return-path — floating / open-loop sources', () => {
  it('warns when a battery has only its + pole wired', { timeout: 30_000 }, async () => {
    const result = await verifyCircuit(
      input(
        [battery('bat1'), res('r1', '220'), led('led1')],
        [
          w('w1', ['bat1', '+'], ['r1', '1']),
          w('w2', ['r1', '2'], ['led1', 'A']),
          // led1 cathode and bat1 − both left floating — the audited shape.
        ],
      ),
    );
    const finding = result.warnings.find(
      (x) => x.code === 'no-return-path' && x.componentId === 'bat1',
    );
    expect(finding, JSON.stringify(result.warnings)).toBeDefined();
    expect(finding!.message).toContain('positive (+)');
  });

  it('warns when both poles are wired but the loop never closes', { timeout: 30_000 }, async () => {
    const result = await verifyCircuit(
      input(
        [battery('bat1'), res('r1', '220'), led('led1'), res('r2', '1k')],
        [
          w('w1', ['bat1', '+'], ['r1', '1']),
          w('w2', ['r1', '2'], ['led1', 'A']),
          // + side dead-ends at the LED; − side dead-ends at r2.
          w('w3', ['bat1', '−'], ['r2', '1']),
        ],
      ),
    );
    const finding = result.warnings.find(
      (x) => x.code === 'no-return-path' && x.componentId === 'bat1',
    );
    expect(finding, JSON.stringify(result.warnings)).toBeDefined();
    expect(finding!.message).toContain('no path back');
  });

  it('stays silent on a properly closed battery loop', { timeout: 30_000 }, async () => {
    const result = await verifyCircuit(
      input(
        [battery('bat1'), res('r1', '470'), led('led1')],
        [
          w('w1', ['bat1', '+'], ['r1', '1']),
          w('w2', ['r1', '2'], ['led1', 'A']),
          w('w3', ['led1', 'C'], ['bat1', '−']),
        ],
      ),
    );
    expect(codesOf(result), JSON.stringify(result.warnings)).not.toContain('no-return-path');
    expect(codesOf(result)).not.toContain('unpowered-net');
  });

  it('a load returning through the shared ground of a signal generator closes the loop', { timeout: 30_000 }, async () => {
    const result = await verifyCircuit(
      input(
        [pwr('src', 5), res('r1', '220'), led('led1')],
        [
          w('w1', ['src', 'SIG'], ['r1', '1']),
          w('w2', ['r1', '2'], ['led1', 'A']),
          w('w3', ['led1', 'C'], ['src', 'GND']),
        ],
      ),
    );
    expect(codesOf(result), JSON.stringify(result.warnings)).not.toContain('no-return-path');
    expect(codesOf(result)).not.toContain('unpowered-net');
  });
});

// ── (b) MOSFET switching a dead rail — unpowered net ──────────────────────

describe('unpowered-net — loads on a rail no source reaches', () => {
  it('warns for a load switched by a MOSFET whose high side is a dead rail', { timeout: 30_000 }, async () => {
    // The "otra cosa" branch (SIG → r1 → led1 → GND) works; the switched
    // branch hangs off a net nothing powers. The MOSFET gate is driven, its
    // source is grounded — previously this solved quietly to 0 A everywhere.
    const result = await verifyCircuit(
      input(
        [
          pwr('src', 5),
          res('r1', '220'),
          led('led1'),
          { id: 'm1', metadataId: 'mosfet-irf540', properties: {} },
          res('rload', '100'),
          led('led2'),
        ],
        [
          w('w1', ['src', 'SIG'], ['r1', '1']),
          w('w2', ['r1', '2'], ['led1', 'A']),
          w('w3', ['led1', 'C'], ['src', 'GND']),
          w('w4', ['m1', 'G'], ['src', 'SIG']),
          w('w5', ['m1', 'S'], ['src', 'GND']),
          w('w6', ['m1', 'D'], ['rload', '2']),
          w('w7', ['rload', '1'], ['led2', 'A']), // the "12V rail" — no source on it
          w('w8', ['led2', 'C'], ['m1', 'D']),
        ],
      ),
    );
    const finding = result.warnings.find((x) => x.code === 'unpowered-net');
    expect(finding, JSON.stringify(result.warnings)).toBeDefined();
    expect(finding!.message).toContain('No power source reaches');
  });

  it('warns when VCC pins are tied together with no source behind them (phantom rail)', { timeout: 30_000 }, async () => {
    // A healthy battery branch elsewhere, plus two modules whose VCC pins
    // feed each other — the audited "power net with no source".
    const result = await verifyCircuit(
      input(
        [
          battery('bat1'),
          res('r1', '470'),
          led('led1'),
          { id: 'dht', metadataId: 'dht22', properties: {} },
          { id: 'imu', metadataId: 'mpu6050', properties: {} },
        ],
        [
          w('w1', ['bat1', '+'], ['r1', '1']),
          w('w2', ['r1', '2'], ['led1', 'A']),
          w('w3', ['led1', 'C'], ['bat1', '−']),
          w('w4', ['dht', 'VCC'], ['imu', 'VCC']),
          w('w5', ['dht', 'GND'], ['bat1', '−']),
          w('w6', ['imu', 'GND'], ['bat1', '−']),
        ],
      ),
    );
    const unpowered = result.warnings.filter((x) => x.code === 'unpowered-net');
    expect(unpowered.length, JSON.stringify(result.warnings)).toBeGreaterThan(0);
    expect(
      unpowered.some((x) => x.componentId === 'dht' || x.componentId === 'imu'),
      JSON.stringify(unpowered),
    ).toBe(true);
  });

  it('stays silent when the module VCC actually reaches the battery', { timeout: 30_000 }, async () => {
    const result = await verifyCircuit(
      input(
        [battery('bat1'), { id: 'dht', metadataId: 'dht22', properties: {} }],
        [
          w('w1', ['bat1', '+'], ['dht', 'VCC']),
          w('w2', ['dht', 'GND'], ['bat1', '−']),
        ],
      ),
    );
    expect(codesOf(result), JSON.stringify(result.warnings)).not.toContain('unpowered-net');
  });
});

// ── (c) Relay coil voltage vs supply ──────────────────────────────────────

describe('voltage-mismatch — relay coil vs the rail that feeds it', () => {
  it('warns when a 12 V coil is fed from a 5 V supply', { timeout: 30_000 }, async () => {
    const result = await verifyCircuit(
      input(
        [psu('psu1', 5), relay('k1', 12), res('rl', '100')],
        [
          w('w1', ['psu1', '+'], ['k1', 'COIL+']),
          w('w2', ['k1', 'COIL-'], ['psu1', '-']),
          w('w3', ['psu1', '+'], ['k1', 'COM']),
          w('w4', ['k1', 'NO'], ['rl', '1']),
          w('w5', ['rl', '2'], ['psu1', '-']),
        ],
      ),
    );
    const finding = result.warnings.find(
      (x) => x.code === 'voltage-mismatch' && x.componentId === 'k1',
    );
    expect(finding, JSON.stringify(result.warnings)).toBeDefined();
    // Both values must be visible to the user.
    expect(finding!.message).toContain('12.0 V');
    expect(finding!.message).toContain('5.0 V');
    expect(finding!.metric).toBe(5);
  });

  it('warns when a 5 V coil is overdriven from 12 V', { timeout: 30_000 }, async () => {
    const result = await verifyCircuit(
      input(
        [psu('psu1', 12), relay('k1', 5)],
        [
          w('w1', ['psu1', '+'], ['k1', 'COIL+']),
          w('w2', ['k1', 'COIL-'], ['psu1', '-']),
          w('w3', ['psu1', '+'], ['k1', 'COM']),
        ],
      ),
    );
    const finding = result.warnings.find(
      (x) => x.code === 'voltage-mismatch' && x.componentId === 'k1',
    );
    expect(finding, JSON.stringify(result.warnings)).toBeDefined();
    expect(finding!.message).toContain('overheat');
  });

  it('stays silent when coil and supply match', { timeout: 30_000 }, async () => {
    const result = await verifyCircuit(
      input(
        [psu('psu1', 5), relay('k1', 5)],
        [
          w('w1', ['psu1', '+'], ['k1', 'COIL+']),
          w('w2', ['k1', 'COIL-'], ['psu1', '-']),
          w('w3', ['psu1', '+'], ['k1', 'COM']),
        ],
      ),
    );
    expect(codesOf(result), JSON.stringify(result.warnings)).not.toContain('voltage-mismatch');
  });

  it('finds the supply through a series switch (region fallback)', { timeout: 30_000 }, async () => {
    // Coil+ reaches the 5 V supply only through a pushbutton, so no supply
    // sits DIRECTLY on the coil nets — the rule falls back to the coil's
    // power region to discover the nominal voltage.
    const result = await verifyCircuit(
      input(
        [psu('psu1', 5), relay('k1', 12), { id: 'btn', metadataId: 'pushbutton', properties: {} }],
        [
          w('w1', ['psu1', '+'], ['btn', '1.l']),
          w('w2', ['btn', '2.r'], ['k1', 'COIL+']),
          w('w3', ['k1', 'COIL-'], ['psu1', '-']),
          w('w4', ['psu1', '+'], ['k1', 'COM']),
        ],
      ),
    );
    const finding = result.warnings.find(
      (x) => x.code === 'voltage-mismatch' && x.componentId === 'k1',
    );
    expect(finding, JSON.stringify(result.warnings)).toBeDefined();
    expect(finding!.metric).toBe(5);
  });
});
