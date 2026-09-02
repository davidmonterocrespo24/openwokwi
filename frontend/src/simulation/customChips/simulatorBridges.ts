/**
 * Per-simulator bridge state for custom chips.
 *
 * Each simulator family exposes its peripherals differently:
 *   - AVR (avr8js)   — `simulator.usart` / `simulator.spi` / `simulator.i2cBus`
 *   - RP2040 (rp2040js) — `simulator.serialWriteByte` / `simulator.setSPIHandler` /
 *                         `simulator.addI2CDevice` (per-bus indexing)
 *   - ESP32 (QEMU shim) — `simulator.sendPinEvent` (no I2C/SPI/UART today)
 *
 * The bridges in this module install a single dispatcher per simulator that
 * fans out to every chip subscribed, regardless of family.
 */
import { SPIBus } from './SPIBus';

export type SimulatorKind = 'avr' | 'rp2040' | 'esp32' | 'unknown';

export function detectSimulatorKind(simulator: any): SimulatorKind {
  if (!simulator) return 'unknown';
  if (simulator.usart && simulator.spi && simulator.i2cBus) return 'avr';
  if (typeof simulator.addI2CDevice === 'function' && typeof simulator.setSPIHandler === 'function') {
    return 'rp2040';
  }
  if (typeof simulator.sendPinEvent === 'function') return 'esp32';
  return 'unknown';
}

export interface SimulatorBridges {
  /** Set of UART RX listeners (one per UART chip). */
  uartListeners: Set<(byte: number) => void>;
  /** Whether the UART dispatcher has already been wired to the simulator. */
  uartInstalled: boolean;
  /** Original onByteTransmit so non-chip listeners still receive bytes. */
  uartPreviousOnByteTransmit: ((byte: number) => void) | null;
  /** Pending bytes to inject into the AVR/RP2040 RX register, drained at
   *  ~baud rate by `uartDrainHandle`. Without this queue, chips that emit
   *  bursts (e.g. an i8080 printing a banner) overflow the 2-byte USART
   *  RX register and most bytes get silently dropped. */
  uartRxQueue: number[];
  /** setTimeout handle for the queue drainer (0 if not active). */
  uartDrainHandle: number;

  /** Shared SPI bus across all custom chips on this simulator. */
  spiBus: SPIBus;
  /** Whether the SPI dispatcher has already been wired. */
  spiInstalled: boolean;
  /** Original SPI byte handler (preserved for restore). */
  spiPreviousOnByte: ((byte: number) => void) | null;
}

const SIM_BRIDGES = new WeakMap<object, SimulatorBridges>();

/** Hard cap on the AVR RX FIFO (see avrUartTx) — at the 1 byte/ms drain
 *  rate this is ~4 s of backlog, plenty for bursts, bounded for firehoses. */
const MAX_UART_RX_QUEUE = 4096;

export function getSimulatorBridges(simulator: any): SimulatorBridges {
  let b = SIM_BRIDGES.get(simulator);
  if (!b) {
    b = {
      uartListeners: new Set(),
      uartInstalled: false,
      uartPreviousOnByteTransmit: null,
      uartRxQueue: [],
      uartDrainHandle: 0,
      spiBus: new SPIBus(),
      spiInstalled: false,
      spiPreviousOnByte: null,
    };
    SIM_BRIDGES.set(simulator, b);
  }
  return b;
}

// ── UART ────────────────────────────────────────────────────────────────────

/**
 * Install the UART TX-out dispatcher idempotently. Whatever family the
 * simulator belongs to, the dispatcher fans bytes out to every listener in
 * `uartListeners` (one per UART chip).
 */
export function ensureUartBridge(simulator: any): void {
  const b = getSimulatorBridges(simulator);
  if (b.uartInstalled) return;
  const kind = detectSimulatorKind(simulator);

  if (kind === 'avr' && simulator.usart) {
    b.uartPreviousOnByteTransmit = simulator.usart.onByteTransmit ?? null;
    const previous = b.uartPreviousOnByteTransmit;
    simulator.usart.onByteTransmit = (byte: number) => {
      if (previous) { try { previous(byte); } catch { /* swallow */ } }
      for (const listener of b.uartListeners) {
        try { listener(byte); } catch { /* swallow */ }
      }
    };
    b.uartInstalled = true;
    return;
  }

  if (kind === 'rp2040') {
    // RP2040 emits each TX byte through `onSerialData(char)` (a string).
    const previous = simulator.onSerialData;
    simulator.onSerialData = (charStr: string) => {
      if (previous) { try { previous(charStr); } catch { /* swallow */ } }
      const code = typeof charStr === 'string' ? charStr.charCodeAt(0) : Number(charStr);
      if (!Number.isFinite(code)) return;
      for (const listener of b.uartListeners) {
        try { listener(code & 0xff); } catch { /* swallow */ }
      }
    };
    b.uartInstalled = true;
    return;
  }
  // esp32/unknown: no client-side UART bridge today (QEMU has its own path).
}

/**
 * Inject a byte into the simulator's RX path so the sketch's `Serial.read()`
 * returns it.
 *
 * For AVR we go through a JS-level FIFO + setTimeout drainer instead of
 * calling `simulator.usart.writeByte` directly. Two reasons:
 *
 *  1. The non-immediate form silently returns `false` for bytes that arrive
 *     while `rxBusyValue` is still set from the previous one — so chips
 *     that emit bursts (e.g. an i8080 print_string sequence) lose ~99% of
 *     their bytes.
 *  2. The immediate form overwrites `rxByte` directly without waiting for
 *     the AVR sketch to drain it — same outcome, only the last byte of
 *     each burst survives.
 *
 * The drainer attempts one non-immediate write per tick (1 ms apart). On
 * RXC busy / RXEN off it leaves the byte at the head of the queue and
 * retries on the next tick. RP2040 has its own internal buffering, so we
 * just forward to `serialWriteByte`.
 */
export function avrUartTx(simulator: any, byte: number): void {
  const kind = detectSimulatorKind(simulator);
  if (kind === 'avr') {
    // ATtiny85 has no hardware USART — silently drop instead of queueing
    // forever. Users wiring a UART chip to a tiny85 need SoftwareSerial,
    // which is a different bridge entirely (TODO).
    if (!simulator.usart || typeof simulator.usart.writeByte !== 'function') return;
    const b = getSimulatorBridges(simulator);
    // Bound the FIFO: a chip streaming while the sketch never reads (RX busy
    // forever) grew this array without limit — the browser tab died of
    // memory, not of CPU. Beyond the cap, drop new bytes and keep the oldest
    // so a sketch that starts reading late still sees the stream's head.
    if (b.uartRxQueue.length >= MAX_UART_RX_QUEUE) return;
    b.uartRxQueue.push(byte & 0xff);
    if (!b.uartDrainHandle) {
      const drain = () => {
        const b2 = getSimulatorBridges(simulator);
        if (b2.uartRxQueue.length === 0) {
          b2.uartDrainHandle = 0;
          return;
        }
        const next = b2.uartRxQueue[0];
        let accepted = false;
        try {
          accepted = simulator.usart?.writeByte?.(next) ?? false;
        } catch {
          accepted = false;
        }
        if (accepted) b2.uartRxQueue.shift();
        b2.uartDrainHandle = (setTimeout(drain, 1) as unknown) as number;
      };
      b.uartDrainHandle = (setTimeout(drain, 0) as unknown) as number;
    }
    return;
  }
  if (kind === 'rp2040' && typeof simulator.serialWriteByte === 'function') {
    try { simulator.serialWriteByte(byte); } catch { /* swallow */ }
  }
}

// ── SPI ─────────────────────────────────────────────────────────────────────

/**
 * Install the SPI master TX → SPIBus dispatcher idempotently. The chip's
 * SPIDevice (created in `vx_spi_attach`) ends up on `b.spiBus` and is picked
 * up automatically — no per-chip wiring needed beyond `bridges.spiBus`.
 */
export function ensureSpiBridge(simulator: any): void {
  const b = getSimulatorBridges(simulator);
  if (b.spiInstalled) return;
  const kind = detectSimulatorKind(simulator);

  if (kind === 'avr' && simulator.spi) {
    b.spiPreviousOnByte = simulator.spi.onByte ?? null;
    simulator.spi.onByte = (mosi: number) => {
      const miso = b.spiBus.transferByte(mosi);
      simulator.spi.completeTransfer(miso);
    };
    b.spiInstalled = true;
    return;
  }

  if (kind === 'rp2040' && typeof simulator.setSPIHandler === 'function') {
    // RP2040 has SPI0 and SPI1; we route both through the same bus so
    // CS-gated chips can live on either.
    for (const bus of [0, 1] as const) {
      try {
        simulator.setSPIHandler(bus, (mosi: number) => b.spiBus.transferByte(mosi));
      } catch { /* this bus may not be in use; ignore */ }
    }
    b.spiInstalled = true;
    return;
  }
}

// ── I2C adapter ─────────────────────────────────────────────────────────────

/**
 * Pick the right I2C bus object for the chip runtime to call `addDevice`/
 * `removeDevice` on. AVR exposes `simulator.i2cBus` directly; RP2040 needs
 * a tiny adapter to forward to its `addI2CDevice` (per-bus) API.
 *
 * Returns `null` if the simulator doesn't expose any I2C bus (ESP32 today).
 */
export function getI2CBus(simulator: any, bus: 0 | 1 = 0): {
  addDevice: (device: any) => void;
  removeDevice: (address: number) => void;
} | null {
  const kind = detectSimulatorKind(simulator);
  if (kind === 'avr' && simulator.i2cBus) {
    return simulator.i2cBus;
  }
  if (kind === 'rp2040' && typeof simulator.addI2CDevice === 'function') {
    return {
      addDevice: (device) => simulator.addI2CDevice(device, bus),
      removeDevice: (address) => simulator.removeI2CDevice?.(address, bus),
    };
  }
  return null;
}
