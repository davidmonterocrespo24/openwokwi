/**
 * Regression test for the MCU-edge listener pin-name mismatch.
 *
 * connectMcuEdgesToService subscribes its per-pin listeners from the
 * netlist's pinNetMap, whose keys are the WIRE pin names ('2', 'A0',
 * 'GP4'…). It must map those names to PinManager pin numbers with the
 * SAME function the netlist collector (collectPinStates) uses. The old
 * code reverse-mapped pin NUMBERS to names instead — producing 'GPIO2'
 * on ESP32, which never matched the wire's '2' — so any mid-run
 * resubscription (triggered e.g. by the gpio_pull that pure ESP-IDF's
 * gpio_reset_pin reports) silently detached every listener and froze
 * LEDs while the firmware kept toggling the pin.
 */

import { describe, it, expect } from 'vitest';
import { pinNameToArduinoPin } from '../simulation/spice/collectPinStates';

describe('pinNameToArduinoPin — netlist name to PinManager pin', () => {
  it('maps plain numeric ESP32 wire names (the esp32-idf-blink case)', () => {
    expect(pinNameToArduinoPin('2', 'esp32')).toBe(2);
    expect(pinNameToArduinoPin('4', 'esp32')).toBe(4);
    expect(pinNameToArduinoPin('21', 'esp32')).toBe(21);
  });

  it('maps GPIO-prefixed names', () => {
    expect(pinNameToArduinoPin('GPIO32', 'esp32')).toBe(32);
    expect(pinNameToArduinoPin('GPIO2', 'esp32')).toBe(2);
  });

  it('maps Pico GP names', () => {
    expect(pinNameToArduinoPin('GP4', 'raspberry-pi-pico')).toBe(4);
  });

  it('maps Uno analog names', () => {
    expect(pinNameToArduinoPin('A0', 'arduino-uno')).toBe(14);
    expect(pinNameToArduinoPin('A5', 'arduino-uno')).toBe(19);
  });

  it('maps ATtiny85 port names', () => {
    expect(pinNameToArduinoPin('PB3', 'attiny85')).toBe(3);
  });

  it('rejects power pins so no listener attaches to rails', () => {
    expect(pinNameToArduinoPin('GND', 'esp32')).toBe(-1);
    expect(pinNameToArduinoPin('3V3', 'esp32')).toBe(-1);
    expect(pinNameToArduinoPin('GND', 'arduino-uno')).toBe(-1);
    expect(pinNameToArduinoPin('5V', 'arduino-uno')).toBe(-1);
  });
});
