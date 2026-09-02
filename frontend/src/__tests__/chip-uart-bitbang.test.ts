/**
 * Bit-banged chip UART TX → GPIO (custom-chips 2026-08, item C).
 *
 * The platform gap: a chip's vx_uart_write only reached the hardware USART,
 * so SoftwareSerial on any other GPIO received nothing. The banger renders
 * 8N1 frames as clock-scheduled pin transitions; these tests drive a fake
 * CPU clock and assert the exact line sequence.
 */
import { describe, it, expect, vi } from 'vitest';
import { createUartBitBanger } from '../simulation/customChips/uartBitBang';

function makeFakeSim() {
  const transitions: boolean[] = [];
  const pending: Array<() => void> = [];
  return {
    transitions,
    pending,
    sim: {
      clockFrequency: 16000000,
      setPinState: (_pin: number, state: boolean) => transitions.push(state),
      addClockEvent: (cb: () => void, _cycles: number) => {
        pending.push(cb);
        return true;
      },
    },
    /** Fire every scheduled event in order until quiescent. */
    run() {
      while (pending.length > 0) pending.shift()!();
    },
  };
}

describe('createUartBitBanger', () => {
  it('renders 0x55 as start + LSB-first data + stop', () => {
    const f = makeFakeSim();
    const banger = createUartBitBanger(f.sim, 4, 9600);
    f.transitions.length = 0; // discard the idle-high preamble
    banger.write(0x55);
    f.run();
    // 0x55 = 0b01010101 → LSB first: 1,0,1,0,1,0,1,0
    expect(f.transitions).toEqual([
      false, // start
      true, false, true, false, true, false, true, false,
      true, // stop
    ]);
  });

  it('idles the line high on creation and serializes back-to-back bytes', () => {
    const f = makeFakeSim();
    const banger = createUartBitBanger(f.sim, 4, 9600);
    expect(f.transitions).toEqual([true]); // idle preamble
    f.transitions.length = 0;
    banger.write(0x00);
    banger.write(0xff);
    f.run();
    // 0x00: start + 8 lows + stop; 0xFF: start + 8 highs + stop.
    expect(f.transitions).toEqual([
      false, ...Array(8).fill(false), true,
      false, ...Array(8).fill(true), true,
    ]);
  });

  it('caps the queue and warns once instead of growing without bound', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pending: Array<() => void> = [];
    const sim = {
      clockFrequency: 16000000,
      setPinState: () => {},
      // Never fire: the frame in flight blocks the queue from draining.
      addClockEvent: (cb: () => void) => { pending.push(cb); return true; },
    };
    const banger = createUartBitBanger(sim, 4, 9600);
    for (let i = 0; i < 5000; i++) banger.write(i & 0xff);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('stands down cleanly when the CPU disappears mid-frame', () => {
    const transitions: boolean[] = [];
    let alive = true;
    const pending: Array<() => void> = [];
    const sim = {
      clockFrequency: 16000000,
      setPinState: (_p: number, s: boolean) => transitions.push(s),
      addClockEvent: (cb: () => void) => {
        if (!alive) return false;
        pending.push(cb);
        return true;
      },
    };
    const banger = createUartBitBanger(sim, 4, 9600);
    transitions.length = 0;
    banger.write(0xa5);
    pending.shift()!(); // one bit fired
    alive = false; // Stop pressed: scheduling refused from here on
    while (pending.length > 0) pending.shift()!();
    // The line must END high (idle), never stuck mid-frame low.
    expect(transitions[transitions.length - 1]).toBe(true);
    banger.dispose();
  });
});
