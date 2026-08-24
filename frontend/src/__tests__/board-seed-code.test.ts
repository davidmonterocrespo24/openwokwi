/**
 * Per-board seed code — what a freshly placed board starts with in the editor.
 *
 * The editor's family defaults (Arduino `LED_BUILTIN` blink, Pico `Pin(25)`
 * blink, Raspberry Pi `RPi.GPIO` script) do not run on a board that has no
 * such LED and its own vendor library: a placed M5Stack / UNIHIKER / Badger
 * used to open with code that could not work on it. A board declares its own
 * seed through ProBoardDef.defaultFiles, and addBoard / setBoardLanguageMode
 * must prefer it over the family default.
 *
 * Pure Vitest unit tests — no QEMU, no network, no DOM.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { registerProBoards, getBoardSeedFiles } from '../lib/proBoardRegistry';
import { useEditorStore } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import type { BoardKind } from '../types/board';

const SEEDED_ARDUINO = '// seeded arduino sketch';
const SEEDED_MPY = '# seeded micropython';
const SEEDED_PY = '# seeded guest script';

registerProBoards([
  {
    kind: 'seed-test-esp32',
    label: 'Seed Test ESP32',
    fqbn: 'esp32:esp32:esp32',
    description: 'test board that ships its own seed code',
    tag: 'velxio-seed-test-esp32',
    size: { w: 100, h: 100 },
    supportsMicroPython: true,
    esp32Family: 'esp32',
    defaultLibraries: ['SeedLib'],
    defaultFiles: {
      arduino: [{ name: 'sketch.ino', content: SEEDED_ARDUINO }],
      micropython: [{ name: 'main.py', content: SEEDED_MPY }],
    },
  },
  {
    kind: 'seed-test-linux',
    label: 'Seed Test Linux SBC',
    fqbn: null,
    description: 'test QEMU-Linux board that ships its own guest script',
    tag: 'velxio-seed-test-linux',
    size: { w: 100, h: 100 },
    piFamily: true,
    defaultFiles: { python: [{ name: 'script.py', content: SEEDED_PY }] },
  },
  {
    kind: 'seed-test-plain',
    label: 'Seed Test Plain',
    fqbn: 'esp32:esp32:esp32',
    description: 'test board with no seed of its own',
    tag: 'velxio-seed-test-plain',
    size: { w: 100, h: 100 },
    supportsMicroPython: true,
    esp32Family: 'esp32',
  },
]);

const groupFiles = (groupId: string) => useEditorStore.getState().getGroupFiles(groupId);

describe('getBoardSeedFiles', () => {
  it('returns the board’s own files for a declared mode', () => {
    expect(getBoardSeedFiles('seed-test-esp32', 'arduino')?.[0].content).toBe(SEEDED_ARDUINO);
    expect(getBoardSeedFiles('seed-test-esp32', 'micropython')?.[0].content).toBe(SEEDED_MPY);
    expect(getBoardSeedFiles('seed-test-linux', 'python')?.[0].content).toBe(SEEDED_PY);
  });

  it('returns undefined for an undeclared mode or an unknown board', () => {
    expect(getBoardSeedFiles('seed-test-esp32', 'espidf')).toBeUndefined();
    expect(getBoardSeedFiles('seed-test-plain', 'arduino')).toBeUndefined();
    expect(getBoardSeedFiles('arduino-uno', 'arduino')).toBeUndefined();
  });
});

describe('addBoard seeds the board’s own code', () => {
  beforeEach(() => {
    for (const b of [...useSimulatorStore.getState().boards]) {
      useSimulatorStore.getState().removeBoard(b.id);
    }
  });

  it('a placed board with a seed opens on its own sketch, not the blink default', () => {
    const id = useSimulatorStore.getState().addBoard('seed-test-esp32' as BoardKind, 0, 0);
    const files = groupFiles(`group-${id}`);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('sketch.ino');
    expect(files[0].content).toBe(SEEDED_ARDUINO);
  });

  it('the seed’s vendor libraries land in the board’s compile manifest', () => {
    const id = useSimulatorStore.getState().addBoard('seed-test-esp32' as BoardKind, 0, 0);
    const board = useSimulatorStore.getState().boards.find((b) => b.id === id);
    expect(board?.libraries).toEqual(['SeedLib']);
  });

  it('a QEMU-Linux board seeds its guest script instead of the RPi.GPIO default', () => {
    const id = useSimulatorStore.getState().addBoard('seed-test-linux' as BoardKind, 0, 0);
    const files = groupFiles(`group-${id}`);
    expect(files[0].name).toBe('script.py');
    expect(files[0].content).toBe(SEEDED_PY);
    expect(files[0].content).not.toContain('RPi.GPIO');
  });

  it('a board without a seed keeps the family default', () => {
    const id = useSimulatorStore.getState().addBoard('seed-test-plain' as BoardKind, 0, 0);
    const files = groupFiles(`group-${id}`);
    expect(files[0].name).toBe('sketch.ino');
    expect(files[0].content).toContain('LED_BUILTIN');
  });
});

describe('switching language mode re-seeds from the board', () => {
  beforeEach(() => {
    for (const b of [...useSimulatorStore.getState().boards]) {
      useSimulatorStore.getState().removeBoard(b.id);
    }
  });

  it('MicroPython mode uses the board’s own main.py', () => {
    const id = useSimulatorStore.getState().addBoard('seed-test-esp32' as BoardKind, 0, 0);
    useSimulatorStore.getState().setBoardLanguageMode(id, 'micropython');
    const files = groupFiles(`group-${id}`);
    expect(files[0].name).toBe('main.py');
    expect(files[0].content).toBe(SEEDED_MPY);
  });

  it('a seedless ESP32-family overlay board gets the ESP32 blink, not the Pico one', () => {
    // The fallback used to key off 'esp32' appearing in the group id, so an
    // overlay ESP32 whose kind has no 'esp32' in its name (m5stack-core,
    // cardputer-adv) was seeded the Pico's Pin(25) blink — a dead pin there.
    const id = useSimulatorStore.getState().addBoard('seed-test-plain' as BoardKind, 0, 0);
    useSimulatorStore.getState().setBoardLanguageMode(id, 'micropython');
    const files = groupFiles(`group-${id}`);
    expect(files[0].name).toBe('main.py');
    expect(files[0].content).toContain('Pin(2, Pin.OUT)');
  });
});
