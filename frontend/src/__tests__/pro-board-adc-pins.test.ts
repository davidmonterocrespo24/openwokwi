/**
 * The SPICE analog path and overlay boards.
 *
 * ADC_PIN_MAP and ADC_PIN_TO_GPIO in connectAnalogInputsToMcu are keyed by the
 * BoardKind union. An overlay board's kind is a runtime string that can never
 * join that union, so every pro board was skipped before a single volt was
 * injected — a divider or an LDR wired to one solved correctly in SPICE and
 * then had nowhere to go. Parts that inject directly (a potentiometer, through
 * partUtils) were unaffected, which is what made the gap easy to miss.
 *
 * A pro board now declares its own pads via ProBoardDef.adcPins.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { registerProBoards, getProBoard, type ProBoardDef } from '../lib/proBoardRegistry';

const KIND = 'test-overlay-adc-board';

describe('ProBoardDef.adcPins', () => {
  beforeEach(() => {
    registerProBoards([
      {
        kind: KIND,
        label: 'Overlay ADC board',
        fqbn: null,
        description: 'test',
        tag: 'velxio-test-adc',
        size: { w: 10, h: 10 },
        // The shape the Pimoroni Pico Plus 2 W uses: pads silked with a GP
        // number that are wired to a different, ADC-capable GPIO.
        pinToNumber: (name: string) => (name === 'GP26' ? 26 : null),
        adcPins: [{ pinName: 'GP26', channel: 0 }],
      } as ProBoardDef,
    ]);
  });

  it('is readable from the registry, which is what the SPICE path consults', () => {
    const def = getProBoard(KIND);
    expect(def?.adcPins).toEqual([{ pinName: 'GP26', channel: 0 }]);
  });

  it('carries the pad name a wire uses, not the GPIO behind it', () => {
    // connectAnalogInputsToMcu looks the net up by `${boardId}:${pinName}`, so
    // the name has to match pinInfo. Resolving it to a GPIO is pinToNumber's
    // job, and the two can disagree — that is the whole point on a board whose
    // pads are tied to a second GPIO.
    const def = getProBoard(KIND)!;
    const pin = def.adcPins![0];
    expect(pin.pinName).toBe('GP26');
    expect(def.pinToNumber!(pin.pinName)).toBe(26);
  });

  it('leaves a board that declares nothing without an analog path', () => {
    registerProBoards([
      {
        kind: 'test-overlay-no-adc',
        label: 'No ADC',
        fqbn: null,
        description: 'test',
        tag: 'velxio-test-noadc',
        size: { w: 10, h: 10 },
      } as ProBoardDef,
    ]);
    expect(getProBoard('test-overlay-no-adc')?.adcPins).toBeUndefined();
  });
});
