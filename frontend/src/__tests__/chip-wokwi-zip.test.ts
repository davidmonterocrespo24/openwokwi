// @vitest-environment jsdom
/**
 * Custom chips round-trip through the Wokwi zip format:
 * diagram part `chip-<name>` + sibling `<name>.chip.c` / `<name>.chip.json`.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  buildWokwiDiagram,
  importFromWokwiZip,
  assignChipExportNames,
  type VelxioComponent,
} from '../utils/wokwiZip';

const CHIP_C = '#include "wokwi-api.h"\nvoid chip_init(void) {}\n';
const CHIP_JSON = '{"name":"CO2 Sensor","pins":["VCC","GND","OUT"]}';

function chipComponent(): VelxioComponent {
  return {
    id: 'chip1',
    metadataId: 'custom-chip',
    x: 300,
    y: 200,
    properties: {
      chipName: 'CO2 Sensor',
      sourceC: CHIP_C,
      chipJson: CHIP_JSON,
      wasmBase64: 'HUGEBLOB',
      attrs: { ppm: 1200 },
    },
  };
}

describe('assignChipExportNames', () => {
  it('slugs the chip name and disambiguates duplicates', () => {
    const comps = [
      chipComponent(),
      { ...chipComponent(), id: 'chip2' },
      { ...chipComponent(), id: 'led1', metadataId: 'led' },
    ];
    const names = assignChipExportNames(comps);
    expect(names.get('chip1')).toBe('co2-sensor');
    expect(names.get('chip2')).toBe('co2-sensor-2');
    expect(names.has('led1')).toBe(false);
  });
});

describe('buildWokwiDiagram with custom chips', () => {
  it('writes a chip-<name> part carrying attr VALUES, never source blobs', () => {
    const diagram = buildWokwiDiagram([chipComponent()], [], 'arduino-uno');
    const part = diagram.parts.find((p) => p.id === 'chip1')!;
    expect(part.type).toBe('chip-co2-sensor');
    expect(part.attrs).toEqual({ ppm: 1200 });
    expect(JSON.stringify(part)).not.toContain('HUGEBLOB');
    expect(JSON.stringify(part)).not.toContain('chip_init');
  });
});

describe('importFromWokwiZip with custom chips', () => {
  async function makeZip(withSource = true): Promise<File> {
    const zip = new JSZip();
    zip.file('diagram.json', JSON.stringify({
      version: 1,
      author: 'test',
      editor: 'wokwi',
      parts: [
        { type: 'wokwi-arduino-uno', id: 'uno', top: 0, left: 0, attrs: {} },
        { type: 'chip-co2-sensor', id: 'chip1', top: 100, left: 200, attrs: { ppm: 900 } },
      ],
      connections: [['chip1:OUT', 'uno:A0', 'green', []]],
    }));
    zip.file('sketch.ino', 'void setup() {}\nvoid loop() {}\n');
    if (withSource) {
      zip.file('co2-sensor.chip.c', CHIP_C);
      zip.file('co2-sensor.chip.json', CHIP_JSON);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    return new File([blob], 'project.zip');
  }

  it('imports the chip with its sources; chip files stay out of the sketch list', async () => {
    const result = await importFromWokwiZip(await makeZip());
    const chip = result.components.find((c) => c.metadataId === 'custom-chip')!;
    expect(chip).toBeDefined();
    expect(chip.properties.chipName).toBe('co2-sensor');
    expect(chip.properties.sourceC).toBe(CHIP_C);
    expect(chip.properties.chipJson).toBe(CHIP_JSON);
    expect(chip.properties.wasmBase64).toBe('');
    expect((chip.properties.attrs as Record<string, number>).ppm).toBe(900);
    expect(result.files.map((f) => f.name)).toEqual(['sketch.ino']);
    // The chip's wire survived.
    expect(result.wires.some((w) => w.start.componentId === 'chip1' && w.start.pinName === 'OUT')).toBe(true);
  });

  it('warns when the chip source file is missing', async () => {
    const result = await importFromWokwiZip(await makeZip(false));
    expect(result.warnings.some((w) => w.includes('co2-sensor') && w.includes('chip.c'))).toBe(true);
    const chip = result.components.find((c) => c.metadataId === 'custom-chip')!;
    expect(chip.properties.sourceC).toBe('');
  });
});
