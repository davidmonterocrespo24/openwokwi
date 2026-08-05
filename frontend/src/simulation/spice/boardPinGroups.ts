/**
 * Per-board pin classification: which pin names should be canonicalized
 * to the ground net ("0") or the Vcc rail, plus the default supply voltage.
 *
 * Extend this table as new boards are added.
 */
import type { BoardKind } from '../../types/board';

export interface BoardPinGroup {
  /** Supply voltage (V). */
  vcc: number;
  /** Pin names treated as ground. */
  gnd: string[];
  /** Pin names treated as the Vcc rail. */
  vcc_pins: string[];
}

type AllBoardKinds = BoardKind | 'default';

const STM32_GROUP: BoardPinGroup = {
  vcc: 3.3,
  gnd: ['GND', 'GND.1', 'GND.2', 'GND.3', 'GND.4'],
  vcc_pins: ['3V3', '3V3.1', '3V3.2', '5V', 'VBAT', 'VB'],
};

export const BOARD_PIN_GROUPS: Record<AllBoardKinds, BoardPinGroup> = {
  default: { vcc: 5, gnd: ['GND', 'GND.1', 'GND.2'], vcc_pins: ['5V', 'VCC'] },

  'arduino-uno': {
    vcc: 5,
    gnd: ['GND.1', 'GND.2', 'GND.3', 'GND'],
    vcc_pins: ['5V', 'VCC', '3.3V', 'AREF'],
  },
  'arduino-nano': {
    vcc: 5,
    gnd: ['GND.1', 'GND.2', 'GND'],
    vcc_pins: ['5V', 'VCC', '3V3', 'AREF'],
  },
  'arduino-mega': {
    vcc: 5,
    gnd: ['GND.1', 'GND.2', 'GND.3', 'GND.4', 'GND'],
    vcc_pins: ['5V', 'VCC', '3.3V', 'AREF'],
  },
  attiny85: { vcc: 5, gnd: ['GND'], vcc_pins: ['VCC'] },

  // STM32 family — 3.3 V logic. Bluepill silkscreens repeat bare GND/3V3.
  'stm32-bluepill': STM32_GROUP,
  'stm32-bluepill-f103cb': STM32_GROUP,
  'stm32-blackpill': STM32_GROUP,
  'stm32-blackpill-f401': STM32_GROUP,
  'stm32-f4-discovery': STM32_GROUP,
  'stm32-olimex-h405': STM32_GROUP,
  'stm32-netduino-plus2': STM32_GROUP,
  'stm32-netduino2': STM32_GROUP,

  'raspberry-pi-pico': {
    vcc: 3.3,
    gnd: ['GND.1', 'GND.2', 'GND.3', 'GND'],
    vcc_pins: ['3V3', 'VBUS', 'VSYS'],
  },
  'pi-pico-w': {
    vcc: 3.3,
    gnd: ['GND.1', 'GND.2', 'GND.3', 'GND'],
    vcc_pins: ['3V3', 'VBUS', 'VSYS'],
  },
  'raspberry-pi-3': { vcc: 5, gnd: ['GND'], vcc_pins: ['5V', '3V3'] },
  'raspberry-pi-4': { vcc: 5, gnd: ['GND'], vcc_pins: ['5V', '3V3'] },
  'raspberry-pi-5': { vcc: 5, gnd: ['GND'], vcc_pins: ['5V', '3V3'] },

  esp32: { vcc: 3.3, gnd: ['GND', 'GND.1', 'GND.2'], vcc_pins: ['3V3', 'VIN', '5V'] },
  'esp32-devkit-c-v4': { vcc: 3.3, gnd: ['GND', 'GND.1', 'GND.2'], vcc_pins: ['3V3', 'VIN', '5V'] },
  'esp32-cam': { vcc: 3.3, gnd: ['GND'], vcc_pins: ['3V3', '5V', '5V.1', 'VCC'] },
  'wemos-lolin32-lite': { vcc: 3.3, gnd: ['GND'], vcc_pins: ['3V3', '5V'] },
  'esp32-s3': { vcc: 3.3, gnd: ['GND', 'GND.1', 'GND.2'], vcc_pins: ['3V3', '3V3.1', '3V3.2', 'VIN', '5V'] },
  'xiao-esp32-s3': { vcc: 3.3, gnd: ['GND'], vcc_pins: ['3V3', '5V'] },
  'arduino-nano-esp32': { vcc: 3.3, gnd: ['GND'], vcc_pins: ['3V3', '5V', 'VUSB'] },
  'esp32-c3': {
    vcc: 3.3,
    gnd: ['GND', 'GND.1', 'GND.2'],
    // The ESP32-C3-DevKitM-1 exposes its supply as two 3V3 and two 5V pins
    // (3V3.1/3V3.2, 5V.1/5V.2) — there is no bare "3V3"/"5V" pin. GND pins are
    // caught by GROUND_PIN_RE's numeric-suffix branch, but VCC_PIN_RE has no
    // such branch (a dual motor-supply pin like L293D VCC2 must NOT collapse
    // onto the shared rail), so the numbered supply pins must be listed here
    // explicitly or they float at 0 V and any switch pulled up to 3V3 reads LOW.
    vcc_pins: ['3V3', '3V3.1', '3V3.2', 'VIN', '5V', '5V.1', '5V.2'],
  },
  'xiao-esp32-c3': { vcc: 3.3, gnd: ['GND'], vcc_pins: ['3V3', '5V'] },
  'aitewinrobot-esp32c3-supermini': { vcc: 3.3, gnd: ['GND'], vcc_pins: ['3V3', '5V'] },
};
