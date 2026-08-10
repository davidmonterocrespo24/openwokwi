/**
 * A Raspberry Pi header pad wired to an Arduino serial pin must be seen
 * as a UART link.
 *
 * The pads are LABELLED 'GPIO14' / 'GPIO15' — that is what the board art
 * shows and what every example wire uses. `normalizePinName` only accepted
 * physical pin numbers for the Pi, so parseInt('GPIO14') was NaN, the pin
 * classified as nothing, and Interconnect never built the route: a Pi
 * sending commands to an Arduino was talking into the void.
 */
import { describe, it, expect } from 'vitest';
import { classifyPin, isUartWire } from '../utils/boardProtocols';

describe('Raspberry Pi UART pins', () => {
  it('classifies the BCM-named header pads', () => {
    expect(classifyPin('raspberry-pi-3', 'GPIO14')).toEqual({ kind: 'uart-tx', uart: 0 });
    expect(classifyPin('raspberry-pi-3', 'GPIO15')).toEqual({ kind: 'uart-rx', uart: 0 });
    // Physical numbering keeps working (pin 8 = BCM14, pin 10 = BCM15).
    expect(classifyPin('raspberry-pi-3', '8')).toEqual({ kind: 'uart-tx', uart: 0 });
    expect(classifyPin('raspberry-pi-3', '10')).toEqual({ kind: 'uart-rx', uart: 0 });
  });

  it('recognises the Pi <-> Arduino cross-board wires', () => {
    expect(isUartWire('raspberry-pi-3', 'GPIO14', 'arduino-uno', '0')).toBeTruthy();
    expect(isUartWire('arduino-uno', '1', 'raspberry-pi-3', 'GPIO15')).toBeTruthy();
  });
});
