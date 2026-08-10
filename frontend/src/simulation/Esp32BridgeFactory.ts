/**
 * Esp32BridgeFactory — extension seam for substituting the ESP32 simulation
 * backend of a board.
 *
 * The store talks to an ESP32 board exclusively through the public surface of
 * `Esp32Bridge` (callbacks + connect/disconnect/loadFirmware/...). By default
 * that surface is backed by a WebSocket to the backend QEMU worker. An overlay
 * can install a factory returning an alternative implementation of the same
 * surface (e.g. an in-browser JS emulator) for the board kinds it supports;
 * returning null falls back to the stock QEMU bridge.
 *
 * In the open-source build no factory is installed, so `createEsp32Bridge`
 * always returns the QEMU-backed bridge. Mirrors the install-impl + safe
 * dispatch shape of `PioPeripheral.ts` / `src/lib/proBoardGate.ts`.
 */

import type { BoardKind } from '../types/board';
import { Esp32Bridge } from './Esp32Bridge';

/** Factory the overlay installs. Return null to fall back to QEMU. */
export type Esp32BridgeFactory = (boardId: string, boardKind: BoardKind) => Esp32Bridge | null;

let _factory: Esp32BridgeFactory | null = null;

/** Install (or clear with null) the bridge factory. Called once by the
 *  pro overlay's mountPro(); never called in OSS builds. */
export function installEsp32BridgeFactory(factory: Esp32BridgeFactory | null): void {
  _factory = factory;
}

/** True if a factory has been installed (pro build). */
export function hasEsp32BridgeFactory(): boolean {
  return _factory !== null;
}

/** Create the simulation bridge for an ESP32 board: the overlay's substitute
 *  when the factory accepts the board, else the stock QEMU WebSocket bridge.
 *  Never throws. */
export function createEsp32Bridge(boardId: string, boardKind: BoardKind): Esp32Bridge {
  if (_factory) {
    try {
      const bridge = _factory(boardId, boardKind);
      if (bridge) return bridge;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[esp32-bridge-factory] factory threw, falling back to QEMU:', e);
    }
  }
  return new Esp32Bridge(boardId, boardKind);
}
