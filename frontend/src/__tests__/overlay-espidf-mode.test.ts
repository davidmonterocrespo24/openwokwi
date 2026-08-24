/**
 * ESP-IDF language mode for OVERLAY boards.
 *
 * `BOARD_SUPPORTS_ESPIDF` is a literal set of OSS board kinds, and it is what
 * gates BOTH the toolbar's ESP-IDF option AND `setBoardLanguageMode`. An
 * overlay board (every Espressif devkit) was therefore unable to enter ESP-IDF
 * mode at all: `loadExample` called `setBoardLanguageMode(id, 'espidf')`, the
 * guard returned early, and an `languageMode: 'espidf'` gallery example opened
 * in Arduino mode with the toolbar reporting "Arduino C++". It happened to
 * still compile on boards whose sketch the backend could sniff as pure IDF
 * (`app_main` present) — but on the ESP32-C5 kit, which has no Arduino FQBN at
 * all, the run died in the browser at "No FQBN for board kind".
 *
 * So: `ProBoardDef.supportsEspIdf` registers the kind, and
 * `ProBoardDef.espidfFqbn` gives the IDF lane a target for a board with no
 * Arduino FQBN of its own. Pure Vitest — no QEMU, no network, no DOM.
 */

import { describe, it, expect } from 'vitest';
import { registerProBoards } from '../lib/proBoardRegistry';
import { useSimulatorStore } from '../store/useSimulatorStore';
import {
  BOARD_SUPPORTS_ESPIDF,
  BOARD_SUPPORTS_MICROPYTHON,
  fqbnForLanguage,
  type BoardKind,
} from '../types/board';

const IDF_ONLY = 'idf-test-c5' as BoardKind; // no Arduino core, ESP-IDF + MPY
const DUAL = 'idf-test-s3' as BoardKind; // Arduino and ESP-IDF both build
const ARDUINO_ONLY = 'idf-test-plain' as BoardKind;

registerProBoards([
  {
    kind: IDF_ONLY,
    label: 'IDF Test C5',
    fqbn: null,
    espidfFqbn: 'esp32:esp32:esp32c5',
    description: 'overlay board with no arduino core',
    tag: 'velxio-idf-test-c5',
    size: { w: 100, h: 100 },
    supportsMicroPython: true,
    supportsEspIdf: true,
    esp32Family: 'esp32-c5',
  },
  {
    kind: DUAL,
    label: 'IDF Test S3',
    fqbn: 'esp32:esp32:esp32s3',
    description: 'overlay board that builds both ways',
    tag: 'velxio-idf-test-s3',
    size: { w: 100, h: 100 },
    supportsMicroPython: true,
    supportsEspIdf: true,
    esp32Family: 'esp32-s3',
  },
  {
    kind: ARDUINO_ONLY,
    label: 'IDF Test Plain',
    fqbn: 'esp32:esp32:esp32',
    description: 'overlay board that never declared ESP-IDF',
    tag: 'velxio-idf-test-plain',
    size: { w: 100, h: 100 },
    supportsMicroPython: true,
    esp32Family: 'esp32',
  },
]);

describe('ProBoardDef.supportsEspIdf', () => {
  it('registers the kind so the toolbar and the store both see it', () => {
    expect(BOARD_SUPPORTS_ESPIDF.has(IDF_ONLY)).toBe(true);
    expect(BOARD_SUPPORTS_ESPIDF.has(DUAL)).toBe(true);
  });

  it('leaves a board that did not declare it alone', () => {
    expect(BOARD_SUPPORTS_ESPIDF.has(ARDUINO_ONLY)).toBe(false);
    // …while still being a MicroPython board, so the regression is scoped.
    expect(BOARD_SUPPORTS_MICROPYTHON.has(ARDUINO_ONLY)).toBe(true);
  });

  it('lets setBoardLanguageMode actually switch an overlay board to espidf', () => {
    const store = useSimulatorStore.getState();
    store.addBoard(DUAL, 0, 0);
    const board = useSimulatorStore.getState().boards.find((b) => b.boardKind === DUAL);
    expect(board).toBeDefined();
    useSimulatorStore.getState().setBoardLanguageMode(board!.id, 'espidf');
    expect(
      useSimulatorStore.getState().boards.find((b) => b.id === board!.id)?.languageMode,
    ).toBe('espidf');
  });

  it('still refuses espidf for a board that never declared it', () => {
    const store = useSimulatorStore.getState();
    store.addBoard(ARDUINO_ONLY, 0, 0);
    const board = useSimulatorStore
      .getState()
      .boards.find((b) => b.boardKind === ARDUINO_ONLY);
    useSimulatorStore.getState().setBoardLanguageMode(board!.id, 'espidf');
    expect(
      useSimulatorStore.getState().boards.find((b) => b.id === board!.id)?.languageMode,
    ).not.toBe('espidf');
  });
});

describe('fqbnForLanguage', () => {
  it('gives the IDF lane a target for a board with no Arduino FQBN', () => {
    expect(fqbnForLanguage(IDF_ONLY, 'espidf')).toBe('esp32:esp32:esp32c5');
    // Arduino stays impossible on that board — the mode has no core at all.
    expect(fqbnForLanguage(IDF_ONLY, 'arduino')).toBeNull();
    expect(fqbnForLanguage(IDF_ONLY, undefined)).toBeNull();
  });

  it('falls through to the Arduino FQBN when no espidf override exists', () => {
    expect(fqbnForLanguage(DUAL, 'espidf')).toBe('esp32:esp32:esp32s3');
    expect(fqbnForLanguage(DUAL, 'arduino')).toBe('esp32:esp32:esp32s3');
  });
});

describe('addBoard language seeding', () => {
  it('does not seed a board that cannot compile Arduino into arduino mode', () => {
    useSimulatorStore.getState().addBoard(IDF_ONLY, 0, 0);
    const board = useSimulatorStore.getState().boards.find((b) => b.boardKind === IDF_ONLY);
    expect(board?.languageMode).not.toBe('arduino');
    expect(board?.languageMode).toBe('micropython');
  });

  it('still seeds a normal board into arduino', () => {
    useSimulatorStore.getState().addBoard(ARDUINO_ONLY, 0, 0);
    const board = useSimulatorStore
      .getState()
      .boards.filter((b) => b.boardKind === ARDUINO_ONLY)
      .pop();
    expect(board?.languageMode).toBe('arduino');
  });
});
