/**
 * circuitVerifier — unit tests against hand-crafted netlists that
 * deliberately violate each safety rule.
 *
 * Each test feeds the verifier the *normalised* shape that the live store
 * already uses (components + wires arrays), runs an actual ngspice solve,
 * and asserts that the right warning code surfaces.
 */
import { describe, it, expect } from 'vitest';
import { verifyCircuit } from '../simulation/verify/circuitVerifier';
import type { BuildNetlistInput } from '../simulation/spice/types';

// ── Building blocks ──────────────────────────────────────────────────────

function pwr(id = 'src', volts = 5): BuildNetlistInput['components'][number] {
  return {
    id,
    metadataId: 'signal-generator',
    properties: { waveform: 'dc', offset: volts, amplitude: 0, frequency: 1 },
  };
}

function res(id: string, ohms: string): BuildNetlistInput['components'][number] {
  return { id, metadataId: 'resistor', properties: { value: ohms } };
}

function led(id: string, color = 'red'): BuildNetlistInput['components'][number] {
  return { id, metadataId: 'led', properties: { color } };
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

// ── Tests ────────────────────────────────────────────────────────────────

describe('verifyCircuit — clean circuits report no errors', () => {
  it(
    'a 220Ω + red LED across 5 V is fine',
    { timeout: 30_000 },
    async () => {
      const input: BuildNetlistInput = {
        components: [pwr('src'), res('r1', '220'), led('led1')],
        wires: [
          w('w1', ['src', 'SIG'], ['r1', '1']),
          w('w2', ['r1', '2'], ['led1', 'A']),
          w('w3', ['led1', 'C'], ['src', 'GND']),
        ],
        boards: [],
        analysis: { kind: 'op' },
      };
      const result = await verifyCircuit(input);
      expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
      // No "led-no-current" warning either — 5V/220Ω is well above µA.
      expect(
        result.warnings.filter((w) => w.code !== 'solver-failed'),
      ).toEqual([]);
    },
  );
});

describe('verifyCircuit — short circuit detection', () => {
  it(
    'fires an error when 5V is wired straight to GND',
    { timeout: 30_000 },
    async () => {
      // Even with ESR-zero this represents a dead short — SPICE pushes huge
      // current through the source. Use a tiny series R so SPICE doesn't
      // produce a singular matrix, but well below 1Ω.
      const input: BuildNetlistInput = {
        components: [pwr('src'), res('rShort', '0.01')],
        wires: [
          w('w1', ['src', 'SIG'], ['rShort', '1']),
          w('w2', ['rShort', '2'], ['src', 'GND']),
        ],
        boards: [],
        analysis: { kind: 'op' },
      };
      const result = await verifyCircuit(input);
      const codes = result.errors.map((e) => e.code);
      expect(codes, JSON.stringify(result.errors)).toContain('short-circuit');
    },
  );
});

describe('verifyCircuit — LED overcurrent', () => {
  it(
    'fires an error when an LED is wired with too small a series resistor',
    { timeout: 30_000 },
    async () => {
      // 5V → 10Ω → LED (Vf ≈ 2V) → GND.  I ≈ (5-2)/10 = 300 mA — well above
      // the 20 mA absolute maximum.
      const input: BuildNetlistInput = {
        components: [pwr('src'), res('r1', '10'), led('led1')],
        wires: [
          w('w1', ['src', 'SIG'], ['r1', '1']),
          w('w2', ['r1', '2'], ['led1', 'A']),
          w('w3', ['led1', 'C'], ['src', 'GND']),
        ],
        boards: [],
        analysis: { kind: 'op' },
      };
      const result = await verifyCircuit(input);
      const codes = result.errors.map((e) => e.code);
      expect(codes, JSON.stringify(result.errors)).toContain('led-overcurrent');
      // The LED itself should be tagged.
      const ledErr = result.errors.find((e) => e.code === 'led-overcurrent');
      expect(ledErr?.componentId).toBe('led1');
    },
  );
});

describe('verifyCircuit — resistor over-power', () => {
  it(
    'fires a warning when a small resistor across 5 V dissipates too much',
    { timeout: 30_000 },
    async () => {
      // 5V across 10Ω → I = 0.5 A → P = 2.5 W. Way past the 1/4 W default.
      const input: BuildNetlistInput = {
        components: [pwr('src'), res('rHot', '10')],
        wires: [
          w('w1', ['src', 'SIG'], ['rHot', '1']),
          w('w2', ['rHot', '2'], ['src', 'GND']),
        ],
        boards: [],
        analysis: { kind: 'op' },
      };
      const result = await verifyCircuit(input);
      const warnCodes = result.warnings.map((e) => e.code);
      // Resistor over-power is a non-blocking warning (real-world physical
      // concern, not a sim error). Short-circuit and other safety issues
      // still hit `errors`.
      expect(warnCodes, JSON.stringify(result.warnings)).toContain('resistor-overpower');
    },
  );

  it(
    'respects a custom power property on the resistor',
    { timeout: 30_000 },
    async () => {
      // 5V across 10Ω with explicit 5W rating → no overpower warning.
      const r: BuildNetlistInput['components'][number] = {
        id: 'rBig',
        metadataId: 'resistor',
        properties: { value: '10', power: 5 },
      };
      const input: BuildNetlistInput = {
        components: [pwr('src'), r],
        wires: [
          w('w1', ['src', 'SIG'], ['rBig', '1']),
          w('w2', ['rBig', '2'], ['src', 'GND']),
        ],
        boards: [],
        analysis: { kind: 'op' },
      };
      const result = await verifyCircuit(input);
      const overpowerErr = result.errors.find((e) => e.code === 'resistor-overpower');
      const overpowerWarn = result.warnings.find((e) => e.code === 'resistor-overpower');
      expect(overpowerErr, JSON.stringify(result.errors)).toBeUndefined();
      expect(overpowerWarn, JSON.stringify(result.warnings)).toBeUndefined();
    },
  );
});

describe('verifyCircuit — threshold overrides', () => {
  it(
    'bumping shortCircuitAmps suppresses the short-circuit error',
    { timeout: 30_000 },
    async () => {
      const input: BuildNetlistInput = {
        components: [pwr('src'), res('rShort', '0.01')],
        wires: [
          w('w1', ['src', 'SIG'], ['rShort', '1']),
          w('w2', ['rShort', '2'], ['src', 'GND']),
        ],
        boards: [],
        analysis: { kind: 'op' },
      };
      const result = await verifyCircuit(input, { shortCircuitAmps: 1000 });
      const codes = result.errors.map((e) => e.code);
      expect(codes).not.toContain('short-circuit');
    },
  );
});

describe('verifyCircuit — over-voltage on rated parts', () => {
  function part(id: string, metadataId: string): BuildNetlistInput['components'][number] {
    return { id, metadataId, properties: {} };
  }

  it(
    'warns when a 3.3-5V module (SSD1306 VIN) is fed 9 V',
    { timeout: 30_000 },
    async () => {
      const input: BuildNetlistInput = {
        components: [pwr('src', 9), part('oled1', 'ssd1306')],
        wires: [
          w('w1', ['src', 'SIG'], ['oled1', 'VIN']),
          w('w2', ['oled1', 'GND'], ['src', 'GND']),
        ],
        boards: [],
        analysis: { kind: 'op' },
      };
      const result = await verifyCircuit(input);
      const ov = result.warnings.find((x) => x.code === 'over-voltage');
      expect(ov, JSON.stringify(result.warnings)).toBeDefined();
      expect(ov?.componentId).toBe('oled1');
      // over-voltage is non-blocking
      expect(result.errors.map((e) => e.code)).not.toContain('over-voltage');
    },
  );

  it(
    'does NOT warn when the same module is fed a safe 5 V on VIN',
    { timeout: 30_000 },
    async () => {
      const input: BuildNetlistInput = {
        components: [pwr('src', 5), part('oled2', 'ssd1306')],
        wires: [
          w('w1', ['src', 'SIG'], ['oled2', 'VIN']),
          w('w2', ['oled2', 'GND'], ['src', 'GND']),
        ],
        boards: [],
        analysis: { kind: 'op' },
      };
      const result = await verifyCircuit(input);
      expect(result.warnings.map((x) => x.code)).not.toContain('over-voltage');
    },
  );

  it(
    'warns when a strict 3.3 V pin (SSD1306 3V3) sits on a 5 V rail',
    { timeout: 30_000 },
    async () => {
      // VCC-like pin names (VCC/VDD/3V3/5V) canonicalise to the shared
      // `vcc_rail` net, which defaults to 5 V. A 10k load gives the rail a
      // real path to ground so the .op solves. The OLED's 3V3 pin (abs max
      // 3.6 V) on that 5 V rail must warn.
      const input: BuildNetlistInput = {
        components: [part('oled3', 'ssd1306'), res('rl', '10k')],
        wires: [
          w('w1', ['oled3', '3V3'], ['rl', '1']),
          w('w2', ['rl', '2'], ['oled3', 'GND']),
        ],
        boards: [],
        analysis: { kind: 'op' },
      };
      const result = await verifyCircuit(input);
      const ov = result.warnings.find((x) => x.code === 'over-voltage');
      expect(ov, JSON.stringify(result.warnings)).toBeDefined();
      expect(ov?.componentId).toBe('oled3');
    },
  );
});

describe('verifyCircuit — board over-voltage (graph-based)', () => {
  function board(id: string, boardKind: string): BuildNetlistInput['boards'][number] {
    return {
      id,
      boardKind,
      vcc: 3.3,
      pins: {},
      groundPinNames: ['GND', 'GND.1', 'GND.2'],
      vccPinNames: ['3V3', 'VIN', '5V'],
    };
  }

  it(
    'warns when a 9 V battery is wired to an ESP32 VIN pin',
    { timeout: 30_000 },
    async () => {
      const input: BuildNetlistInput = {
        components: [{ id: 'bat', metadataId: 'battery-9v', properties: {} }],
        wires: [
          { id: 'w1', start: { componentId: 'bat', pinName: '+' }, end: { componentId: 'esp32', pinName: 'VIN' } },
          { id: 'w2', start: { componentId: 'esp32', pinName: 'GND' }, end: { componentId: 'bat', pinName: '−' } },
        ],
        boards: [board('esp32', 'esp32')],
        analysis: { kind: 'op' },
      };
      const result = await verifyCircuit(input);
      const ov = result.warnings.find((w) => w.code === 'over-voltage' && w.componentId === 'esp32');
      expect(ov, JSON.stringify(result.warnings)).toBeDefined();
    },
  );

  it(
    'does NOT warn when an AA battery (1.5 V) powers the VIN pin',
    { timeout: 30_000 },
    async () => {
      const input: BuildNetlistInput = {
        components: [{ id: 'bat', metadataId: 'battery-aa', properties: {} }],
        wires: [
          { id: 'w1', start: { componentId: 'bat', pinName: '+' }, end: { componentId: 'esp32', pinName: 'VIN' } },
          { id: 'w2', start: { componentId: 'esp32', pinName: 'GND' }, end: { componentId: 'bat', pinName: '−' } },
        ],
        boards: [board('esp32', 'esp32')],
        analysis: { kind: 'op' },
      };
      const result = await verifyCircuit(input);
      expect(result.warnings.map((w) => w.code)).not.toContain('over-voltage');
    },
  );
});

describe('verifyCircuit — electrolytic capacitor', () => {
  function cap(id: string, voltage: string): BuildNetlistInput['components'][number] {
    return { id, metadataId: 'capacitor-electrolytic', properties: { value: '10u', voltage } };
  }

  it(
    'warns when the voltage across it exceeds its rating',
    { timeout: 30_000 },
    async () => {
      // 24 V across a 16 V cap.
      const input: BuildNetlistInput = {
        components: [pwr('src', 24), cap('c1', '16')],
        wires: [
          w('w1', ['src', 'SIG'], ['c1', '+']),
          w('w2', ['c1', '−'], ['src', 'GND']),
        ],
        boards: [],
        analysis: { kind: 'op' },
      };
      const result = await verifyCircuit(input);
      const ov = result.warnings.find((x) => x.code === 'over-voltage' && x.componentId === 'c1');
      expect(ov, JSON.stringify(result.warnings)).toBeDefined();
    },
  );

  it(
    'does NOT warn when within its rating',
    { timeout: 30_000 },
    async () => {
      const input: BuildNetlistInput = {
        components: [pwr('src', 5), cap('c2', '25')],
        wires: [
          w('w1', ['src', 'SIG'], ['c2', '+']),
          w('w2', ['c2', '−'], ['src', 'GND']),
        ],
        boards: [],
        analysis: { kind: 'op' },
      };
      const result = await verifyCircuit(input);
      expect(result.warnings.map((x) => x.code)).not.toContain('over-voltage');
      expect(result.warnings.map((x) => x.code)).not.toContain('reverse-polarity');
    },
  );

  it(
    'warns on reverse polarity',
    { timeout: 30_000 },
    async () => {
      // +5 V on the minus pin, plus pin to ground → reverse-biased.
      const input: BuildNetlistInput = {
        components: [pwr('src', 5), cap('c3', '25')],
        wires: [
          w('w1', ['src', 'SIG'], ['c3', '−']),
          w('w2', ['c3', '+'], ['src', 'GND']),
        ],
        boards: [],
        analysis: { kind: 'op' },
      };
      const result = await verifyCircuit(input);
      const rp = result.warnings.find((x) => x.code === 'reverse-polarity' && x.componentId === 'c3');
      expect(rp, JSON.stringify(result.warnings)).toBeDefined();
    },
  );
});

describe('verifyCircuit — wiring ERC (bad connections)', () => {
  it(
    'warns when a 2-terminal part is connected on only one side',
    { timeout: 30_000 },
    async () => {
      const input: BuildNetlistInput = {
        components: [pwr('src', 5), res('r1', '1k')],
        wires: [w('w1', ['src', 'SIG'], ['r1', '1'])], // r1 pin '2' left floating
        boards: [],
        analysis: { kind: 'op' },
      };
      const result = await verifyCircuit(input);
      const mc = result.warnings.find((x) => x.code === 'missing-connection' && x.componentId === 'r1');
      expect(mc, JSON.stringify(result.warnings)).toBeDefined();
    },
  );

  it(
    'does NOT warn when both terminals are wired',
    { timeout: 30_000 },
    async () => {
      const input: BuildNetlistInput = {
        components: [pwr('src', 5), res('r1', '1k')],
        wires: [
          w('w1', ['src', 'SIG'], ['r1', '1']),
          w('w2', ['r1', '2'], ['src', 'GND']),
        ],
        boards: [],
        analysis: { kind: 'op' },
      };
      const result = await verifyCircuit(input);
      expect(result.warnings.map((x) => x.code)).not.toContain('missing-connection');
    },
  );

  it(
    'warns when a powered module is missing its ground connection',
    { timeout: 30_000 },
    async () => {
      const input: BuildNetlistInput = {
        components: [pwr('src', 5), { id: 'o1', metadataId: 'ssd1306', properties: {} }],
        wires: [w('w1', ['src', 'SIG'], ['o1', 'VIN'])], // VIN wired, GND not
        boards: [],
        analysis: { kind: 'op' },
      };
      const result = await verifyCircuit(input);
      const mc = result.warnings.find((x) => x.code === 'missing-connection' && x.componentId === 'o1');
      expect(mc, JSON.stringify(result.warnings)).toBeDefined();
    },
  );

  it(
    '4-pin I2C SSD1306: warns when its VCC supply pin is not wired (B15b)',
    { timeout: 30_000 },
    async () => {
      const input: BuildNetlistInput = {
        components: [pwr('src', 5), { id: 'o4', metadataId: 'ssd1306-i2c-4pin', properties: {} }],
        wires: [
          w('w1', ['src', 'SIG'], ['o4', 'SCL']), // signal wired, VCC left floating
          w('w2', ['o4', 'GND'], ['src', 'GND']),
        ],
        boards: [],
        analysis: { kind: 'op' },
      };
      const result = await verifyCircuit(input);
      const mc = result.warnings.find((x) => x.code === 'missing-connection' && x.componentId === 'o4');
      expect(mc, JSON.stringify(result.warnings)).toBeDefined();
    },
  );

  it(
    '4-pin I2C SSD1306: no missing-connection when VCC and GND are wired',
    { timeout: 30_000 },
    async () => {
      const input: BuildNetlistInput = {
        components: [pwr('src', 5), { id: 'o4', metadataId: 'ssd1306-i2c-4pin', properties: {} }],
        wires: [
          w('w1', ['src', 'SIG'], ['o4', 'VCC']),
          w('w2', ['o4', 'GND'], ['src', 'GND']),
        ],
        boards: [],
        analysis: { kind: 'op' },
      };
      const result = await verifyCircuit(input);
      expect(result.warnings.map((x) => x.code)).not.toContain('missing-connection');
      // 5 V on the 6 V-rated VCC pin is fine.
      expect(result.warnings.map((x) => x.code)).not.toContain('over-voltage');
    },
  );

  it(
    'errors when a VCC pin is wired directly to a GND pin',
    { timeout: 30_000 },
    async () => {
      const input: BuildNetlistInput = {
        components: [{ id: 'o1', metadataId: 'ssd1306', properties: {} }],
        wires: [w('w1', ['o1', '3V3'], ['o1', 'GND'])], // VCC tied straight to GND
        boards: [],
        analysis: { kind: 'op' },
      };
      const result = await verifyCircuit(input);
      const codes = result.errors.map((e) => e.code);
      expect(codes, JSON.stringify(result.errors)).toContain('power-short');
    },
  );

  it(
    'warns when a part has both terminals on the same node (shorted out)',
    { timeout: 30_000 },
    async () => {
      const input: BuildNetlistInput = {
        components: [pwr('src', 5), res('r1', '1k')],
        wires: [
          w('w1', ['src', 'SIG'], ['r1', '1']),
          w('w2', ['src', 'SIG'], ['r1', '2']), // both terminals on the SIG net
        ],
        boards: [],
        analysis: { kind: 'op' },
      };
      const result = await verifyCircuit(input);
      const sc = result.warnings.find((x) => x.code === 'shorted-component' && x.componentId === 'r1');
      expect(sc, JSON.stringify(result.warnings)).toBeDefined();
    },
  );
});

// ── Sanity: shipping examples never trigger errors ─────────────────────────
// If any gallery example produces a verifier error, that's a bug in the
// example itself. Loop a handful of representative ones to catch
// regressions early.
import { digitalExamples } from '../data/examples-digital';
import { analogExamples } from '../data/examples-analog';

function toInput(ex: { components: any[]; wires: any[] }): BuildNetlistInput {
  return {
    components: ex.components.map((c: any) => ({
      id: c.id,
      metadataId: c.type.replace(/^(wokwi|velxio)-/, ''),
      properties: c.properties ?? {},
    })),
    wires: ex.wires.map((wire: any) => ({
      id: wire.id,
      start: { componentId: wire.start.componentId, pinName: wire.start.pinName },
      end: { componentId: wire.end.componentId, pinName: wire.end.pinName },
    })),
    boards: [],
    analysis: { kind: 'op' },
  };
}

// The audit rules (2026-07) are warnings, so the errors-only assertion would
// not catch a false positive — assert explicitly that no shipping example
// trips them.
const AUDIT_WARNING_CODES = new Set(['unpowered-net', 'no-return-path', 'voltage-mismatch']);

function galleryFindings(result: Awaited<ReturnType<typeof verifyCircuit>>): string[] {
  return [
    ...result.errors.map((e) => `${e.code}(${e.componentId ?? '-'})`),
    ...result.warnings
      .filter((w) => AUDIT_WARNING_CODES.has(w.code))
      .map((w) => `${w.code}(${w.componentId ?? '-'})`),
  ];
}

describe('verifyCircuit — shipping gallery examples are clean', () => {
  it(
    'every digital example passes pre-flight verification',
    { timeout: 180_000 },
    async () => {
      const failures: string[] = [];
      for (const ex of digitalExamples) {
        const findings = galleryFindings(await verifyCircuit(toInput(ex)));
        if (findings.length > 0) {
          failures.push(`${ex.id}: ${findings.join(', ')}`);
        }
      }
      expect(failures, failures.join('\n')).toEqual([]);
    },
  );

  it(
    'every analog example passes pre-flight verification',
    { timeout: 180_000 },
    async () => {
      const failures: string[] = [];
      for (const ex of analogExamples) {
        const findings = galleryFindings(await verifyCircuit(toInput(ex)));
        if (findings.length > 0) {
          failures.push(`${ex.id}: ${findings.join(', ')}`);
        }
      }
      expect(failures, failures.join('\n')).toEqual([]);
    },
  );
});
