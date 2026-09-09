/**
 * Which AVR pads reach the ADC, and on which channel.
 *
 * `setAdcVoltage` is the single funnel every analog part goes through — the
 * potentiometer, the LDR, the NTC, the SPICE solver's per-channel writeback,
 * the custom-chip DAC. On AVR it accepted pins 14 to 19 and nothing else,
 * which is A0-A5 on an Uno. Two boards in the picker pay for that:
 *
 *  - the Arduino Nano breaks out A6 and A7 (pins 20 and 21). The ATmega328P
 *    in the Nano's TQFP package really has ADC6 and ADC7; only the DIP Uno
 *    lacks them, and the Uno element does not draw those pads at all.
 *  - the Arduino MEGA maps A0-A15 to pins 54-69. Every single one of them
 *    was out of range, so analog input on a Mega did nothing whatsoever.
 *
 * Both failed silently: `setAdcVoltage` returns false, nobody checks it, and
 * the sketch reads a steady zero from a knob that is visibly turning.
 */
import { describe, it, expect } from 'vitest';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import { setAdcVoltage } from '../simulation/parts/partUtils';

/** The empty program. The ADC peripheral is built by loadHex, not by the
 *  constructor, so a simulator that never loaded anything has no ADC to
 *  write to and every injection would fail for the wrong reason. */
const EMPTY_HEX = ':00000001FF\n';

function boot(variant: 'uno' | 'mega'): AVRSimulator {
  const sim = new AVRSimulator(new PinManager(), variant);
  sim.loadHex(EMPTY_HEX);
  return sim;
}

/** ADC channel value the part layer just wrote, or undefined. */
function channelOf(sim: AVRSimulator, channel: number): number | undefined {
  const adc = (sim as unknown as { getADC(): { channelValues: number[] } | null }).getADC();
  return adc?.channelValues[channel];
}

describe('AVR ADC pad mapping', () => {
  it('an Uno reaches A0-A5 on channels 0-5', () => {
    const sim = boot('uno');
    for (let i = 0; i < 6; i++) {
      expect(setAdcVoltage(sim, 14 + i, 1 + i * 0.1), `A${i}`).toBe(true);
      expect(channelOf(sim, i)).toBeCloseTo(1 + i * 0.1, 6);
    }
    sim.stop();
  });

  it("a Nano's A6 and A7 reach channels 6 and 7", () => {
    // boardPinMapping maps A6 -> 20 and A7 -> 21 for this family, and the
    // Nano element draws both pads, so a wire can land there.
    const sim = boot('uno');
    expect(setAdcVoltage(sim, 20, 2.5), 'A6').toBe(true);
    expect(channelOf(sim, 6)).toBeCloseTo(2.5, 6);
    expect(setAdcVoltage(sim, 21, 4.0), 'A7').toBe(true);
    expect(channelOf(sim, 7)).toBeCloseTo(4.0, 6);
    sim.stop();
  });

  it('a Mega reaches A0-A15 on channels 0-15', () => {
    const sim = boot('mega');
    for (let i = 0; i < 16; i++) {
      expect(setAdcVoltage(sim, 54 + i, 0.25 + i * 0.25), `A${i}`).toBe(true);
      expect(channelOf(sim, i)).toBeCloseTo(0.25 + i * 0.25, 6);
    }
    sim.stop();
  });

  it('a digital pad is still refused', () => {
    const sim = boot('uno');
    // D13 is not an analog input on any of these boards, and neither is the
    // gap between the two families' ranges.
    expect(setAdcVoltage(sim, 13, 3)).toBe(false);
    expect(setAdcVoltage(sim, 30, 3)).toBe(false);
    expect(setAdcVoltage(sim, 70, 3)).toBe(false);
    sim.stop();
  });
});
