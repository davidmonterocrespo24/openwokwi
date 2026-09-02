/**
 * Bit-banged UART TX onto a plain GPIO (custom-chips 2026-08).
 *
 * A chip's vx_uart_write only ever reached the board's HARDWARE USART RX —
 * wiring the chip's TX to any other GPIO (the SoftwareSerial idiom every
 * Arduino tutorial uses) delivered nothing. This banger renders each byte as
 * real 8N1 line transitions on that GPIO, scheduled on the AVR CPU clock, so
 * SoftwareSerial's pin-change sampling sees a genuine frame.
 *
 * One banger per (chip, TX pin), created at part attach and disposed with it.
 * Scheduling dies with the CPU on Stop — the disposed flag keeps a stale
 * clock event from touching the next run's line.
 */

interface BitBangSim {
  addClockEvent?(callback: () => void, cycles: number): boolean;
  setPinState?(pin: number, state: boolean): void;
  clockFrequency?: number;
}

/** Bytes waiting for the line, per banger. A chip streaming into a GPIO the
 *  sketch never listens to must not grow memory without bound (the NMEA
 *  freeze scenario) — beyond the cap new bytes are dropped, oldest kept, so
 *  a late listener still sees the stream's beginning. */
const MAX_QUEUE = 4096;

export interface UartBitBanger {
  write(byte: number): void;
  dispose(): void;
}

export function createUartBitBanger(
  simulator: BitBangSim,
  boardPin: number,
  baudRate: number,
  label = 'chip',
): UartBitBanger {
  const freq = simulator.clockFrequency ?? 16000000;
  const baud = baudRate > 0 ? baudRate : 9600;
  const cyclesPerBit = Math.max(1, Math.round(freq / baud));
  const queue: number[] = [];
  let sending = false;
  let disposed = false;
  let warnedOverflow = false;

  const setLine = (level: boolean) => {
    try {
      simulator.setPinState?.(boardPin, level);
    } catch { /* board not ready */ }
  };

  // UART line idles HIGH — a receiver that attaches later must not read a
  // floating/low line as a permanent start bit.
  setLine(true);

  const sendNext = () => {
    if (disposed || sending) return;
    const byte = queue.shift();
    if (byte === undefined) return;
    sending = true;
    // 8N1: start (low), 8 data bits LSB-first, stop (high).
    const bits: boolean[] = [false];
    for (let i = 0; i < 8; i++) bits.push(((byte >> i) & 1) === 1);
    bits.push(true);

    let index = 0;
    const fireBit = () => {
      if (disposed) return;
      setLine(bits[index]);
      index++;
      const scheduled = simulator.addClockEvent?.(
        index < bits.length
          ? fireBit
          : () => {
              // Stop bit has been held for a full bit time — next byte.
              sending = false;
              if (!disposed) sendNext();
            },
        cyclesPerBit,
      );
      if (!scheduled) {
        // CPU gone (Stop mid-frame): leave the line idle and stand down.
        setLine(true);
        sending = false;
      }
    };
    fireBit();
  };

  return {
    write(byte: number): void {
      if (disposed) return;
      if (queue.length >= MAX_QUEUE) {
        if (!warnedOverflow) {
          warnedOverflow = true;
          console.warn(
            `[${label}] bit-bang TX queue full (${MAX_QUEUE} bytes) on pin ${boardPin} — ` +
              'dropping new bytes; is the sketch reading this stream?',
          );
        }
        return;
      }
      queue.push(byte & 0xff);
      sendNext();
    },
    dispose(): void {
      disposed = true;
      queue.length = 0;
    },
  };
}
