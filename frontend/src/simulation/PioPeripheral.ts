/**
 * PioPeripheral — generic extension seam for a bit-banged-SPI/PIO peripheral
 * attached to an RP2040 board (e.g. a WiFi co-processor reached over gSPI).
 *
 * RP2040Simulator owns the fragile PIO-FIFO plumbing (the non-dropping TX
 * queue, the on-demand RX-pull, the sm.restart framing reset, the GPIO24
 * host-wake re-sync after loadMicroPython swaps the chip) and drives it
 * through this interface. A peripheral supplies only the *protocol*: it
 * observes each outbound 32-bit word and returns reply bytes the plumbing
 * repacks into the RX FIFO.
 *
 * This is deliberately generic (no product-specific names): any private SPI
 * peripheral can register a factory. In the open-source build no factory is
 * installed, so `createPioPeripheral` returns null and a pi-pico-w board
 * simulates as a plain Pico (no WiFi). The velxio.dev pro overlay registers
 * a CYW43439 implementation, gated behind a paid plan.
 *
 * Mirrors the install-impl + safe-dispatch + has-check shape of the pro
 * gates in `src/lib/proBoardGate.ts`.
 */

export interface PioPeripheral {
  /** Process one 32-bit word the firmware bit-banged onto the bus. Returns
   *  zero or more reply byte-blobs to repack into the RX FIFO.
   *
   *  `pioIndex`/`smIndex` say which state machine wrote it, where the host
   *  plumbing knows (the RP2350 hook passes them; the RP2040 one does not, so
   *  a peripheral that needs them must cope with undefined). A single-protocol
   *  peripheral can ignore both. */
  feedWord(word: number, pioIndex?: number, smIndex?: number): Uint8Array[];
  /** True while the firmware is streaming bulk data the peripheral wants the
   *  plumbing to DISCARD (keep only a few words so the PIO TXSTALLs). Words
   *  taken by this path are NOT fed to the peripheral. */
  inDiscardableWriteData(): boolean;
  /**
   * Optional: "I have already consumed this state machine's words; the PIO
   * does not need to shift them out."
   *
   * For a peripheral that models the far end of the wire directly — an LED
   * panel whose framebuffer we decode rather than watch arrive bit by bit —
   * running the PIO program is pure cost. A Pimoroni Unicorn spends about
   * 300,000 PIO cycles per refresh sitting in the program's BCD delay loops,
   * which buys nothing once the pixels have been read out of the FIFO word.
   *
   * When this returns true the plumbing feeds the peripheral as usual, then
   * drops the word instead of handing it to the PIO, and keeps TX DREQ
   * asserted so a DREQ-paced DMA still advances. Unlike
   * inDiscardableWriteData(), the peripheral still SEES every word — that is
   * the whole point.
   *
   * Called per state machine so a peripheral only claims the one it has
   * locked onto; another program on another SM keeps working normally.
   */
  consumesTxWords?(pioIndex: number, smIndex: number): boolean;
  /** Reset framing at a transfer boundary (the PIO sm.restart). */
  resetFraming(): void;
  /** Current host-wake level to drive onto GPIO24 (active-high). */
  hostWakeLevel(): boolean;
  /** Register the callback the peripheral fires when host-wake changes. */
  onHostWake(cb: (active: boolean) => void): void;
  /** Optional: called when the board's simulation starts (with the sketch
   *  files), so the peripheral can e.g. detect WiFi usage and connect. */
  onSimulationStart?(files: { content: string }[]): void;
  /** Optional teardown when the peripheral is detached. */
  detach?(): void;
}

/** Factory the overlay installs. Returns null for OSS / unsupported boards. */
export type PioPeripheralFactory =
  (boardKind: string, boardId: string) => PioPeripheral | null;

let _factory: PioPeripheralFactory | null = null;

/** Install (or clear with null) the peripheral factory. Called once by the
 *  pro overlay's mountPro(); never called in OSS builds. */
export function installPioPeripheralFactory(factory: PioPeripheralFactory | null): void {
  _factory = factory;
}

/** True if a factory has been installed (pro build). */
export function hasPioPeripheralFactory(): boolean {
  return _factory !== null;
}

/** Create a peripheral for the given board, or null if none applies (OSS,
 *  unsupported board, or the factory declined — e.g. a free user). Never throws. */
export function createPioPeripheral(boardKind: string, boardId: string): PioPeripheral | null {
  if (!_factory) return null;
  try {
    return _factory(boardKind, boardId);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[pio-peripheral] factory threw:', e);
    return null;
  }
}
