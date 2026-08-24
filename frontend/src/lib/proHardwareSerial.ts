/**
 * Pro hardware-serial TX registry.
 *
 * The hardware serial monitor (pro overlay) mirrors a REAL board's UART
 * into the existing SerialMonitor. Incoming bytes need no seam — the
 * overlay appends them via `appendHardwareSerial` (useSimulatorStore).
 * Outgoing text does: `serialWriteToBoard` normally targets the board's
 * simulator, so while a hardware monitor is attached to a board, the
 * overlay installs an interceptor here and the user's input goes to the
 * physical port instead.
 *
 * Mirrors the other OSS->Pro seams (`proWebFlash.ts`, `proBoardGate.ts`).
 * No imports on purpose: the store consults this module, never the other
 * way around, so there is no cycle.
 */

type SerialTxInterceptor = (text: string) => void;

const _interceptors = new Map<string, SerialTxInterceptor>();

/**
 * Route a board's serial input to the given sink instead of its simulator.
 * Pass null to restore the default (simulator) routing. Installed by the
 * pro overlay while its hardware serial monitor is connected.
 */
export function installSerialTxInterceptor(
  boardId: string,
  fn: SerialTxInterceptor | null,
): void {
  if (fn) _interceptors.set(boardId, fn);
  else _interceptors.delete(boardId);
}

/** The interceptor for a board, or null when input should go to the sim. */
export function getSerialTxInterceptor(boardId: string): SerialTxInterceptor | null {
  return _interceptors.get(boardId) ?? null;
}
