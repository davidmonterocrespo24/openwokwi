/**
 * A pro board's supply rail.
 *
 * BOARD_PIN_GROUPS is keyed by the BoardKind union, so an overlay board could
 * never appear in it and fell through to `default`: 5 V, with supply pads named
 * "5V"/"VCC". Every RP2350 and ESP32-family board the overlay registers is a
 * 3.3 V part whose pad is called "3V3", so the whole netlist solved at the wrong
 * rail — silently. It surfaces as soon as anything analog is wired: a divider
 * off the 3V3 pad of a Pimoroni Pico Plus 2 W solved at 5 V, and a potentiometer
 * at half travel read 2.50 V where the hardware gives 1.65 V.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { registerProBoards, type ProBoardDef } from '../lib/proBoardRegistry';
import { boardPinGroupFor, BOARD_PIN_GROUPS } from '../simulation/spice/boardPinGroups';

const KIND = 'test-overlay-3v3-board';

describe('boardPinGroupFor', () => {
  beforeEach(() => {
    registerProBoards([
      {
        kind: KIND,
        label: '3V3 overlay board',
        fqbn: null,
        description: 'test',
        tag: 'velxio-test-3v3',
        size: { w: 10, h: 10 },
        power: {
          vcc: 3.3,
          gnd: ['GND', 'GND.1'],
          vcc_pins: ['3V3'],
          aux: { volts: 5, pins: ['VBUS', 'VSYS'] },
        },
      } as ProBoardDef,
    ]);
  });

  it('uses the rail a pro board declares, not the 5 V default', () => {
    const g = boardPinGroupFor(KIND);
    expect(g.vcc).toBe(3.3);
    expect(g.vcc_pins).toContain('3V3');
    expect(g.aux?.volts).toBe(5);
  });

  it('still answers for the boards the OSS table names', () => {
    expect(boardPinGroupFor('raspberry-pi-pico').vcc).toBe(3.3);
    expect(boardPinGroupFor('arduino-uno').vcc).toBe(5);
  });

  it('falls back to the default for a board nobody has described', () => {
    expect(boardPinGroupFor('some-unregistered-kind')).toBe(BOARD_PIN_GROUPS.default);
  });
});
