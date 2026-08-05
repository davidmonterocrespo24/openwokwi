/**
 * Tests for GitHub issue #139 — pure ESP-IDF language mode
 * https://github.com/davidmonterocrespo24/velxio/issues/139
 *
 * The ESP32 family gains a third entry in the language selector next to
 * Arduino C++ and MicroPython: "ESP-IDF". In that mode the user writes a
 * plain IDF project (app_main() entry point, FreeRTOS + driver APIs) and
 * the backend compiles it through the same ESP-IDF toolchain it already
 * uses for Arduino sketches — just without the arduino-esp32 component.
 *
 * Pure Vitest unit tests — no QEMU, no network, no DOM.
 */

import { describe, it, expect } from 'vitest';
import { BOARD_SUPPORTS_ESPIDF, BOARD_SUPPORTS_MICROPYTHON } from '../types/board';
import type { BoardKind } from '../types/board';
import { useEditorStore } from '../store/useEditorStore';
import { exampleProjects } from '../data/examples';

describe('issue #139 — BOARD_SUPPORTS_ESPIDF', () => {
  const ESP32_KINDS: BoardKind[] = [
    'esp32',
    'esp32-devkit-c-v4',
    'esp32-cam',
    'wemos-lolin32-lite',
    'esp32-s3',
    'xiao-esp32-s3',
    'arduino-nano-esp32',
    'esp32-c3',
    'xiao-esp32-c3',
    'aitewinrobot-esp32c3-supermini',
  ];

  for (const kind of ESP32_KINDS) {
    it(`${kind} supports ESP-IDF mode`, () => {
      expect(BOARD_SUPPORTS_ESPIDF.has(kind)).toBe(true);
    });
  }

  it('non-ESP32 boards do NOT support ESP-IDF mode', () => {
    const NON_ESP32: BoardKind[] = [
      'arduino-uno',
      'raspberry-pi-pico',
      'pi-pico-w',
      'raspberry-pi-3',
      'stm32-bluepill',
      'attiny85',
    ];
    for (const kind of NON_ESP32) {
      expect(BOARD_SUPPORTS_ESPIDF.has(kind)).toBe(false);
    }
  });

  it('every ESP-IDF board also offers the language selector (MicroPython set)', () => {
    // The toolbar renders the selector when BOARD_SUPPORTS_MICROPYTHON
    // matches and adds the ESP-IDF option when BOARD_SUPPORTS_ESPIDF also
    // matches — so every espidf-capable board must be in the outer set or
    // the option would be unreachable.
    for (const kind of BOARD_SUPPORTS_ESPIDF) {
      expect(BOARD_SUPPORTS_MICROPYTHON.has(kind)).toBe(true);
    }
  });
});

describe('issue #139 — espidf file group defaults', () => {
  it("createFileGroup(groupId, 'espidf') seeds main.c with app_main()", () => {
    const groupId = 'group-esp32-espidf-test';
    useEditorStore.getState().createFileGroup(groupId, 'espidf');
    const files = useEditorStore.getState().getGroupFiles(groupId);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('main.c');
    expect(files[0].content).toContain('app_main');
    expect(files[0].content).toContain('freertos/FreeRTOS.h');
    expect(files[0].content).toContain('driver/gpio.h');
    // Must NOT be an Arduino sketch — that's the whole point of the mode.
    expect(files[0].content).not.toContain('setup()');
    expect(files[0].content).not.toContain('Arduino.h');
    useEditorStore.getState().deleteFileGroup(groupId);
  });

  it("createFileGroup(groupId, 'arduino') still seeds sketch.ino (regression)", () => {
    const groupId = 'group-esp32-arduino-test';
    useEditorStore.getState().createFileGroup(groupId, 'arduino');
    const files = useEditorStore.getState().getGroupFiles(groupId);
    expect(files[0].name).toBe('sketch.ino');
    useEditorStore.getState().deleteFileGroup(groupId);
  });
});

describe('issue #139 — esp32-idf-blink gallery example', () => {
  const example = exampleProjects.find((e) => e.id === 'esp32-idf-blink');

  it('exists and targets an ESP32 board in espidf mode', () => {
    expect(example).toBeDefined();
    expect(example?.boardType).toBe('esp32');
    expect(example?.languageMode).toBe('espidf');
  });

  it('ships a main.c with an app_main() entry point', () => {
    const mainFile = example?.files?.find((f) => f.name === 'main.c');
    expect(mainFile).toBeDefined();
    expect(mainFile?.content).toContain('void app_main(void)');
    expect(mainFile?.content).not.toContain('Arduino.h');
  });
});
