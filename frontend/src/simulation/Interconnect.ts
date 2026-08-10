/**
 * Cross-board interconnect router.
 *
 * Reactive subsystem that watches `useSimulatorStore.wires` and
 * `useSimulatorStore.boards` and propagates digital pin transitions
 * between boards along the wires the user drew. UART, I2C, SPI, and
 * SoftwareSerial protocols all "just work" on top of pin propagation
 * because each board's hardware peripherals decode the actual
 * transitions. For cross-process boards (ESP32 backend QEMU, Pi3B
 * QEMU) it additionally enables a byte-level shortcut on hardware
 * UART pins so that high-baud links don't drop bytes when the
 * WebSocket round-trip would be too slow for bit-level transport.
 *
 * Design:
 *   - Singleton `interconnect`. The store calls `bindBoard` /
 *     `unbindBoard` from `addBoard` / `removeBoard`, and the wires
 *     array drives route resolution via `updateWires`.
 *   - For browser-side simulators (AVR, RP2040, Esp32C3, RiscV) we
 *     subscribe to each board's `PinManager.onPinChange` and forward
 *     to the other endpoint's `setPinState`.
 *   - For ESP32 / Pi3B bridges, we install fan-out callbacks on
 *     `bridge.onPinChange` and `bridge.onSerialData` (overwriting
 *     the bridge's single-callback slot — the store's serial-monitor
 *     plumbing is preserved by chaining the previous callback).
 *   - Re-entrancy guard: a `Set` of `${boardId}:${pin}` keys flagged
 *     during synchronous propagation prevents the reverse hop from
 *     firing a feedback echo.
 */

import type { BoardKind } from '../types/board';
import type { Wire } from '../types/wire';
import { boardPinToNumber } from '../utils/boardPinMapping';
import { classifyPin, isUartWire } from '../utils/boardProtocols';

// ── Bridge / sim runtime references ──────────────────────────────────────────
//
// Provided by the store via setRuntimeAccessors() to avoid a circular
// import. The store exports `getBoardSimulator`, `getBoardPinManager`,
// `getBoardBridge`, `getEsp32Bridge` — we need them at runtime.

interface RuntimeAccessors {
  getBoardSimulator: (id: string) => any | undefined;
  getBoardPinManager: (id: string) => any | undefined;
  getBoardBridge: (id: string) => any | undefined; // Pi3B
  getEsp32Bridge: (id: string) => any | undefined;
  getStm32Bridge: (id: string) => any | undefined;
}

let runtime: RuntimeAccessors | null = null;

export function setInterconnectRuntime(r: RuntimeAccessors): void {
  runtime = r;
}

// ── Internal types ───────────────────────────────────────────────────────────

type BoardKindOrId = string;

interface BoardEntry {
  id: string;
  kind: BoardKind;
  /** Original onSerialData (so we don't clobber the store's serial-monitor) */
  origSerialCallback?: ((ch: string, uart?: number) => void) | null;
  /** Original bridge.onPinChange (so we don't clobber whatever the store wired) */
  origPinChangeCallback?: ((pin: number, state: boolean) => void) | null;
  /** Per-pin fan-out map (used for bridges where only one onPinChange slot exists) */
  pinChangeFanout: Map<number, Set<(state: boolean) => void>>;
  /** Per-uart fan-out for serial output bytes from this board */
  serialFanout: Map<number, Set<(ch: string) => void>>;
  /** Pin propagation listeners we installed on PinManager — call to unsubscribe */
  pinUnsubs: Array<() => void>;
}

interface RouteHandle {
  wireId: string;
  teardown: () => void;
}

const boards = new Map<string, BoardEntry>();
const routes = new Map<string, RouteHandle>();
const propagatingPins = new Set<string>(); // re-entrancy guard

/**
 * Cross-board I2C bridges installed when two boards share a wired
 * (SDA, SCL) pair on a given (busA, busB).  Keyed by a deterministic
 * "boardA:busA<->boardB:busB" string so we don't double-install when
 * `updateWires` is called repeatedly.  The value is the teardown that
 * detaches both halves of the bidirectional bridge.
 */
const i2cBridges = new Map<string, () => void>();

// ── Helpers ──────────────────────────────────────────────────────────────────

function isBrowserSim(boardKind: string): boolean {
  // Browser-side simulators expose a `setPinState` method directly on the
  // simulator instance (AVR, RP2040).  ESP32-C3 family was historically
  // here when Esp32C3Simulator ran in-browser, but per the store's
  // ESP32_RISCV_KINDS routing the c3 boards now go through the same
  // Esp32Bridge (qemu-system-riscv32 via libqemu-riscv32.dll) as the
  // Xtensa ESP32s — so they belong on the bridge side.
  return (
    boardKind === 'arduino-uno' ||
    boardKind === 'arduino-nano' ||
    boardKind === 'arduino-mega' ||
    boardKind === 'attiny85' ||
    boardKind === 'raspberry-pi-pico' ||
    boardKind === 'pi-pico-w'
  );
}

function isEsp32Bridge(boardKind: string): boolean {
  return (
    boardKind === 'esp32' ||
    boardKind === 'esp32-s3' ||
    boardKind === 'esp32-devkit-c-v4' ||
    boardKind === 'esp32-cam' ||
    boardKind === 'wemos-lolin32-lite' ||
    boardKind === 'xiao-esp32-s3' ||
    boardKind === 'arduino-nano-esp32' ||
    // RISC-V ESP32-C3 family — same Esp32Bridge plumbing, just a
    // different QEMU binary on the backend (libqemu-riscv32).
    boardKind === 'esp32-c3' ||
    boardKind === 'xiao-esp32-c3' ||
    boardKind === 'aitewinrobot-esp32c3-supermini' ||
    boardKind === 'xiao-c3' ||
    boardKind === 'c3-supermini'
  );
}

function isPi3Bridge(boardKind: string): boolean {
  // Pi Zero / 1 / 2 / 3 / 4 / 5 all use the same backend bridge
  // (QEMU virt + virtio-serial). Exclude raspberry-pi-pico (RP2040).
  return boardKind.startsWith('raspberry-pi-') && boardKind !== 'raspberry-pi-pico';
}

function isStm32Bridge(boardKind: string): boolean {
  // STM32 family via libqemu-arm (Stm32Bridge). Same single-slot
  // onPinChange/onSerialData + sendPinEvent/sendSerialBytes shape as Esp32Bridge.
  return boardKind === 'stm32-bluepill' || boardKind.startsWith('stm32-');
}

/** Resolve `(componentId, pinName)` to a `(boardId, pinNumber)` pair. */
function resolveEndpoint(
  componentId: string,
  pinName: string,
): { boardId: string; pin: number } | null {
  const entry = boards.get(componentId);
  if (!entry) return null;
  const pin = boardPinToNumber(entry.kind, pinName);
  if (pin === null || pin < 0) return null; // null = unknown; -1 = power
  return { boardId: componentId, pin };
}

// ── Pin propagation primitives ───────────────────────────────────────────────

/** Drive a pin state on the receiving board (one-way). */
function pushPinState(boardId: string, pin: number, state: boolean): void {
  if (!runtime) return;
  const entry = boards.get(boardId);
  if (!entry) return;

  // Re-entrancy guard
  const key = `${boardId}:${pin}`;
  if (propagatingPins.has(key)) return;
  propagatingPins.add(key);
  try {
    if (isBrowserSim(entry.kind)) {
      const sim = runtime.getBoardSimulator(boardId);
      if (sim?.setPinState) sim.setPinState(pin, state);
    } else if (isEsp32Bridge(entry.kind)) {
      const bridge = runtime.getEsp32Bridge(boardId);
      bridge?.sendPinEvent?.(pin, state);
    } else if (isStm32Bridge(entry.kind)) {
      const bridge = runtime.getStm32Bridge(boardId);
      bridge?.sendPinEvent?.(pin, state);
    } else if (isPi3Bridge(entry.kind)) {
      const bridge = runtime.getBoardBridge(boardId);
      bridge?.sendPinEvent?.(pin, state);
    }
  } finally {
    propagatingPins.delete(key);
  }
}

// ── Serial seam for boards driven from outside the sim/bridge pair ───────
//
// A QEMU-Linux board can also run its Python in the tab (no WebSocket, no
// bridge object). Such a board still has UART wires on the canvas, so it
// needs both directions of the routing: a sink to receive bytes, and a way
// to announce the ones it sends. Both are plain callbacks — nothing here
// knows what is on the other end.
const serialSinks = new Map<string, (ch: string, uart: number) => void>();

/** Receive UART bytes addressed to this board. Returns an unregister fn. */
export function registerSerialSink(
  boardId: string,
  sink: (ch: string, uart: number) => void,
): () => void {
  serialSinks.set(boardId, sink);
  return () => {
    if (serialSinks.get(boardId) === sink) serialSinks.delete(boardId);
  };
}

/** Announce a UART byte this board just transmitted, so the wires route it. */
export function feedBoardSerialOut(boardId: string, ch: string, uart = 0): void {
  const subs = boards.get(boardId)?.serialFanout.get(uart);
  if (subs) for (const cb of subs) cb(ch);
}

/** Push a UART byte into the receiving board's UART RX. */
function pushSerialByte(boardId: string, ch: string, uart: number): void {
  if (!runtime) return;
  const entry = boards.get(boardId);
  if (!entry) return;

  const sink = serialSinks.get(boardId);
  if (sink) {
    sink(ch, uart);
    return;
  }

  if (isBrowserSim(entry.kind)) {
    const sim = runtime.getBoardSimulator(boardId);
    // RP2040Simulator doesn't yet expose feedUart per-UART — fall back
    // to serialWrite (which feeds UART0) for uart === 0.
    if (sim?.feedUart) {
      sim.feedUart(uart, ch);
    } else if (uart === 0 && sim?.serialWrite) {
      sim.serialWrite(ch);
    }
  } else if (isEsp32Bridge(entry.kind)) {
    const bridge = runtime.getEsp32Bridge(boardId);
    bridge?.sendSerialBytes?.([ch.charCodeAt(0)], uart);
  } else if (isStm32Bridge(entry.kind)) {
    const bridge = runtime.getStm32Bridge(boardId);
    bridge?.sendSerialBytes?.([ch.charCodeAt(0)], uart);
  } else if (isPi3Bridge(entry.kind)) {
    const bridge = runtime.getBoardBridge(boardId) as
      | { sendUartBytes?: (b: number[]) => void; sendSerialBytes?: (b: number[]) => void }
      | undefined;
    // The header UART is a different pipe from the console: typing a
    // peer's bytes into the shell used to be the only option, and it
    // meant the guest's own boot chatter went out on the wire while the
    // data a script wrote never did.
    if (bridge?.sendUartBytes) bridge.sendUartBytes([ch.charCodeAt(0)]);
    else bridge?.sendSerialBytes?.([ch.charCodeAt(0)]);
  }
}

// ── Pin-change fan-in (browser sims) ─────────────────────────────────────────
//
// For browser sims we subscribe to PinManager.onPinChange directly per
// pin; PinManager handles fan-out internally so we don't need our own
// fanout map for these.

function installBrowserPinSubscription(
  fromBoardId: string,
  fromPin: number,
  toBoardId: string,
  toPin: number,
): () => void {
  if (!runtime) return () => {};
  const pm = runtime.getBoardPinManager(fromBoardId);
  if (!pm?.onPinChange) return () => {};
  const unsub = pm.onPinChange(fromPin, (_p: number, state: boolean) => {
    pushPinState(toBoardId, toPin, state);
  });
  return typeof unsub === 'function' ? unsub : () => {};
}

// ── Pin-change fan-in (bridges) ──────────────────────────────────────────────
//
// Bridges expose a single `onPinChange` slot. We take ownership of it
// once per board and fan out through `pinChangeFanout`.

function ensureBridgePinHook(entry: BoardEntry): void {
  if (!runtime) return;
  const bridge = isEsp32Bridge(entry.kind)
    ? runtime.getEsp32Bridge(entry.id)
    : isStm32Bridge(entry.kind)
      ? runtime.getStm32Bridge(entry.id)
      : runtime.getBoardBridge(entry.id);
  if (!bridge) return;

  // Already installed?
  if ((bridge as any).__icPinHookInstalled) return;
  (bridge as any).__icPinHookInstalled = true;

  // Save whatever was there before so we can chain it.
  entry.origPinChangeCallback = bridge.onPinChange ?? null;

  // Capture a stable "get current entry" closure — survives Interconnect
  // resets (where the entry object is replaced) by re-resolving via the
  // boards Map at call time.
  const boardId = entry.id;
  bridge.onPinChange = (pin: number, state: boolean) => {
    const liveEntry = boards.get(boardId);
    // First, let the existing callback (e.g. PinManager.triggerPinChange
    // installed by the store for sensor wiring) run.
    liveEntry?.origPinChangeCallback?.(pin, state);
    // Then fan out to all wired endpoints.
    const subs = liveEntry?.pinChangeFanout.get(pin);
    if (subs) for (const cb of subs) cb(state);
  };
}

function installBridgePinFanout(
  fromBoardId: string,
  fromPin: number,
  toBoardId: string,
  toPin: number,
): () => void {
  const entry = boards.get(fromBoardId);
  if (!entry) return () => {};
  ensureBridgePinHook(entry);
  let set = entry.pinChangeFanout.get(fromPin);
  if (!set) {
    set = new Set();
    entry.pinChangeFanout.set(fromPin, set);
  }
  const cb = (state: boolean) => pushPinState(toBoardId, toPin, state);
  set.add(cb);
  return () => {
    entry.pinChangeFanout.get(fromPin)?.delete(cb);
  };
}

// ── Serial fan-in (browser sims and bridges) ─────────────────────────────────

function ensureSerialHook(entry: BoardEntry): void {
  if (!runtime) return;

  const boardId = entry.id;

  // Browser sims: wrap sim.onSerialData
  if (isBrowserSim(entry.kind)) {
    const sim = runtime.getBoardSimulator(entry.id);
    if (!sim) return;
    if ((sim as any).__icSerialHookInstalled) return;
    (sim as any).__icSerialHookInstalled = true;
    entry.origSerialCallback = sim.onSerialData ?? null;
    sim.onSerialData = (ch: string, uart?: number) => {
      const liveEntry = boards.get(boardId);
      liveEntry?.origSerialCallback?.(ch, uart);
      // Browser sims (e.g. RP2040) currently lump UART0 + UART1 into the
      // same callback. Default to UART0 for routing.
      const u = uart ?? 0;
      const subs = liveEntry?.serialFanout.get(u);
      if (subs) for (const cb of subs) cb(ch);
    };
    return;
  }

  // Bridges: same pattern on bridge.onSerialData
  const bridge = isEsp32Bridge(entry.kind)
    ? runtime.getEsp32Bridge(entry.id)
    : isStm32Bridge(entry.kind)
      ? runtime.getStm32Bridge(entry.id)
      : runtime.getBoardBridge(entry.id);
  if (!bridge) return;

  // A QEMU-Linux board has TWO serial streams: the console (the shell)
  // and the header UART. Only the second one is on the wire — hooking the
  // console here would send the guest's boot chatter and shell prompt to
  // the peer board, which is what used to happen for lack of anything
  // better.
  const piBridge = bridge as unknown as { onUartTx?: ((t: string) => void) | null };
  if (isPi3Bridge(entry.kind) && 'onUartTx' in piBridge) {
    if ((bridge as unknown as { __icUartHook?: boolean }).__icUartHook) return;
    (bridge as unknown as { __icUartHook?: boolean }).__icUartHook = true;
    const prevUart = piBridge.onUartTx ?? null;
    piBridge.onUartTx = (text: string) => {
      prevUart?.(text);
      const subs = boards.get(boardId)?.serialFanout.get(0);
      if (subs) for (const ch of text) for (const cb of subs) cb(ch);
    };
    return;
  }
  if ((bridge as any).__icSerialHookInstalled) return;
  (bridge as any).__icSerialHookInstalled = true;
  entry.origSerialCallback = bridge.onSerialData ?? null;
  bridge.onSerialData = (ch: string, uart?: number) => {
    const liveEntry = boards.get(boardId);
    liveEntry?.origSerialCallback?.(ch, uart);
    const u = uart ?? 0;
    const subs = liveEntry?.serialFanout.get(u);
    if (subs) for (const cb of subs) cb(ch);
  };
}

function installSerialFanout(
  fromBoardId: string,
  fromUart: number,
  toBoardId: string,
  toUart: number,
): () => void {
  const entry = boards.get(fromBoardId);
  if (!entry) return () => {};
  ensureSerialHook(entry);
  let set = entry.serialFanout.get(fromUart);
  if (!set) {
    set = new Set();
    entry.serialFanout.set(fromUart, set);
  }
  const cb = (ch: string) => pushSerialByte(toBoardId, ch, toUart);
  set.add(cb);
  return () => {
    entry.serialFanout.get(fromUart)?.delete(cb);
  };
}

// ── Route building per wire ──────────────────────────────────────────────────

function buildRouteForWire(wire: Wire): RouteHandle | null {
  const aEntry = boards.get(wire.start.componentId);
  const bEntry = boards.get(wire.end.componentId);
  if (!aEntry || !bEntry) return null;

  const aRes = resolveEndpoint(wire.start.componentId, wire.start.pinName);
  const bRes = resolveEndpoint(wire.end.componentId, wire.end.pinName);
  if (!aRes || !bRes) return null;

  // Power pins / GND short-circuit (already filtered to >= 0 by resolveEndpoint).

  const teardowns: Array<() => void> = [];

  // ─ Digital pin propagation A → B ─────────────────────────────────────────
  if (isBrowserSim(aEntry.kind)) {
    teardowns.push(
      installBrowserPinSubscription(aEntry.id, aRes.pin, bEntry.id, bRes.pin),
    );
  } else {
    teardowns.push(installBridgePinFanout(aEntry.id, aRes.pin, bEntry.id, bRes.pin));
  }

  // ─ Digital pin propagation B → A ─────────────────────────────────────────
  if (isBrowserSim(bEntry.kind)) {
    teardowns.push(
      installBrowserPinSubscription(bEntry.id, bRes.pin, aEntry.id, aRes.pin),
    );
  } else {
    teardowns.push(installBridgePinFanout(bEntry.id, bRes.pin, aEntry.id, aRes.pin));
  }

  // ─ Optional UART byte-level shortcut ────────────────────────────────────
  // Enable when at least one side is a cross-process bridge (latency
  // would drop bit-level transport) AND when both pins classify as
  // matching UART TX/RX endpoints.
  const aIsCross = isEsp32Bridge(aEntry.kind) || isPi3Bridge(aEntry.kind);
  const bIsCross = isEsp32Bridge(bEntry.kind) || isPi3Bridge(bEntry.kind);
  const uartInfo = isUartWire(aEntry.kind, wire.start.pinName, bEntry.kind, wire.end.pinName);

  // Always wire the byte-level shortcut for hardware-UART pin pairs —
  // even browser-only cases benefit: AVR/RP2040 sims emit per-byte
  // events that cleanly arrive at the other side without depending on
  // bit-level pin replay timing.
  if (uartInfo) {
    const aRoleIsTx = classifyPin(aEntry.kind, wire.start.pinName).kind === 'uart-tx';
    const aUart = uartInfo.uartA;
    const bUart = uartInfo.uartB;
    if (aRoleIsTx) {
      // A.TX → B.RX
      teardowns.push(installSerialFanout(aEntry.id, aUart, bEntry.id, bUart));
    } else {
      // A.RX → B.TX (the wire's "start" was the RX side)
      teardowns.push(installSerialFanout(bEntry.id, bUart, aEntry.id, aUart));
    }
    void aIsCross;
    void bIsCross;
  }

  return {
    wireId: wire.id,
    teardown: () => {
      for (const t of teardowns) t();
    },
  };
}

// ── Public API used by the store ─────────────────────────────────────────────

export function bindBoard(boardId: string, kind: BoardKind | string): void {
  if (boards.has(boardId)) return;
  boards.set(boardId, {
    id: boardId,
    kind: kind as BoardKind,
    pinChangeFanout: new Map(),
    serialFanout: new Map(),
    pinUnsubs: [],
  });
  // After binding, any wires referencing this board can be re-resolved.
  // The store will call updateWires() with the latest list.
}

export function unbindBoard(boardId: string): void {
  // Tear down any routes that touch this board
  for (const [wireId, route] of routes.entries()) {
    // We don't keep wire→endpoint mapping; clearing all routes that
    // mention this board requires a re-scan. The store calls
    // updateWires(currentWires) right after removeBoard which will
    // rebuild from scratch. Just drop the entry.
    void wireId;
    void route;
  }
  // Remove the board entry; subsequent updateWires() will re-resolve.
  boards.delete(boardId);
}

let lastWireSnapshot: string = '';

// ── Cross-board I2C bus bridges ─────────────────────────────────────────────
//
// On top of the bit-level GPIO propagation each wire already installs,
// when two boards have BOTH SDA and SCL wired together on a (busA,
// busB) pair we install a transaction-level bridge between their
// `I2CBusManager` instances.  This lets one board act as I2C master
// and the OTHER as the slave responder — something neither avr8js
// AVRTWI nor rp2040js RPI2C supports natively (both are master-only
// peripherals; they do not sample GPIO to decode an incoming
// transaction as a slave).
//
// The bridge is symmetric: either side may initiate.  Addresses are
// resolved against the peer's locally-registered virtual devices, so a
// PCF8574 (or any I2CDevice) registered on board B's bus is reachable
// from board A's master without any extra glue.

/** Group i2c-classified wires by (boardA, busA, boardB, busB) and pin role. */
function collectI2CWirePairs(
  wires: readonly Wire[],
): Map<
  string,
  {
    aBoard: string;
    aBus: number;
    bBoard: string;
    bBus: number;
    sda: boolean;
    scl: boolean;
  }
> {
  const groups = new Map<
    string,
    {
      aBoard: string;
      aBus: number;
      bBoard: string;
      bBus: number;
      sda: boolean;
      scl: boolean;
    }
  >();

  for (const w of wires) {
    const aEntry = boards.get(w.start.componentId);
    const bEntry = boards.get(w.end.componentId);
    if (!aEntry || !bEntry) continue;

    const aRole = classifyPin(aEntry.kind, w.start.pinName);
    const bRole = classifyPin(bEntry.kind, w.end.pinName);
    if (aRole.kind !== bRole.kind) continue;
    if (aRole.kind !== 'i2c-sda' && aRole.kind !== 'i2c-scl') continue;

    // Normalize ordering so (boardA < boardB) lexicographically.  The
    // bridge is symmetric, but the map key must be deterministic.
    const swap = aEntry.id > bEntry.id;
    const A = swap ? bEntry : aEntry;
    const B = swap ? aEntry : bEntry;
    const aRoleN = swap ? bRole : aRole;
    const bRoleN = swap ? aRole : bRole;

    if (aRoleN.kind !== 'i2c-sda' && aRoleN.kind !== 'i2c-scl') continue;
    const aBus =
      'bus' in aRoleN && typeof aRoleN.bus === 'number' ? aRoleN.bus : 0;
    const bBus =
      'bus' in bRoleN && typeof bRoleN.bus === 'number' ? bRoleN.bus : 0;

    const key = `${A.id}#${aBus}<->${B.id}#${bBus}`;
    let entry = groups.get(key);
    if (!entry) {
      entry = {
        aBoard: A.id,
        aBus,
        bBoard: B.id,
        bBus,
        sda: false,
        scl: false,
      };
      groups.set(key, entry);
    }
    if (aRoleN.kind === 'i2c-sda') entry.sda = true;
    else entry.scl = true;
  }

  return groups;
}

/**
 * Look up the `I2CBusManager` for `(boardId, bus)`.  Returns null
 * silently if the board does not expose `getI2CBus` (e.g. cross-process
 * bridges, RiscV, ESP32 backend), if the bus has not been constructed
 * yet (firmware not loaded), or if the runtime accessors are missing.
 */
function getI2CBusFor(boardId: string, bus: number): unknown {
  if (!runtime) return null;
  const sim = runtime.getBoardSimulator(boardId);
  if (!sim || typeof sim.getI2CBus !== 'function') return null;
  try {
    return sim.getI2CBus(bus as 0 | 1) ?? null;
  } catch {
    return null;
  }
}

/**
 * Reconcile the bridge map with the latest wire layout.  Installs new
 * bridges, tears down stale ones, and is idempotent against repeated
 * calls with the same wires.
 */
function updateI2CBridges(wires: readonly Wire[]): void {
  const desired = collectI2CWirePairs(wires);

  // Tear down bridges that no longer have both SDA and SCL wired.
  for (const [key, teardown] of [...i2cBridges.entries()]) {
    const want = desired.get(key);
    if (!want || !(want.sda && want.scl)) {
      teardown();
      i2cBridges.delete(key);
    }
  }

  // Install bridges that newly have both SDA and SCL wired.
  for (const [key, want] of desired.entries()) {
    if (!want.sda || !want.scl) continue;
    if (i2cBridges.has(key)) continue;

    const busA = getI2CBusFor(want.aBoard, want.aBus) as
      | {
          attachBridge(p: unknown): void;
          detachBridge(p: unknown): void;
        }
      | null;
    const busB = getI2CBusFor(want.bBoard, want.bBus) as
      | {
          attachBridge(p: unknown): void;
          detachBridge(p: unknown): void;
        }
      | null;
    if (!busA || !busB) continue; // one side does not expose a bus yet

    busA.attachBridge(busB);
    busB.attachBridge(busA);

    // ── Cross-architecture proxy sync ─────────────────────────────────────
    // When one side of the bridge is an ESP32 board, the I2CBusManager
    // alone is not enough: ESP32 firmware runs in backend QEMU, and its
    // Wire master reads land inside the QEMU thread synchronously.  A
    // WebSocket round-trip to look up the peer device per byte would
    // deadlock the I2C cycle.  Instead, snapshot the peer's local
    // devices into a backend `ProxySlave` per address — QEMU then
    // responds locally without leaving the worker.
    if (isEsp32Bridge(boards.get(want.aBoard)?.kind ?? '')) {
      const simA = runtime?.getBoardSimulator(want.aBoard);
      if (simA?.syncProxyFromPeer) {
        try { simA.syncProxyFromPeer(busB); } catch { /* ignore */ }
      }
    }
    if (isEsp32Bridge(boards.get(want.bBoard)?.kind ?? '')) {
      const simB = runtime?.getBoardSimulator(want.bBoard);
      if (simB?.syncProxyFromPeer) {
        try { simB.syncProxyFromPeer(busA); } catch { /* ignore */ }
      }
    }

    i2cBridges.set(key, () => {
      try {
        busA.detachBridge(busB);
      } catch {
        /* ignore */
      }
      try {
        busB.detachBridge(busA);
      } catch {
        /* ignore */
      }
      // Remove ONLY the proxy slaves this bridge installed.  Per-peer
      // teardown so concurrent bridges to the same ESP32 (e.g. ESP32
      // wired to both an Uno and a Pico simultaneously) retain their
      // own proxies — addresses owned by another peer survive.
      if (isEsp32Bridge(boards.get(want.aBoard)?.kind ?? '')) {
        const simA = runtime?.getBoardSimulator(want.aBoard);
        if (simA?.clearProxiesForPeer) {
          try { simA.clearProxiesForPeer(busB); } catch { /* ignore */ }
        }
      }
      if (isEsp32Bridge(boards.get(want.bBoard)?.kind ?? '')) {
        const simB = runtime?.getBoardSimulator(want.bBoard);
        if (simB?.clearProxiesForPeer) {
          try { simB.clearProxiesForPeer(busA); } catch { /* ignore */ }
        }
      }
    });
  }
}

/**
 * Idempotent: rebuilds route table to match the supplied wires array.
 * Called by the store on every wire mutation and also on board
 * add/remove.
 */
export function updateWires(wires: readonly Wire[]): void {
  // Quick skip if nothing changed (compare by composite identity).
  const sig = wires
    .map(
      (w) =>
        `${w.id}|${w.start.componentId}:${w.start.pinName}|${w.end.componentId}:${w.end.pinName}`,
    )
    .join(',');
  if (sig === lastWireSnapshot && wires.length === routes.size) {
    // Nothing changed in the routing-relevant fields.
    return;
  }
  lastWireSnapshot = sig;

  // Tear down all existing routes first (simplest correct strategy).
  for (const r of routes.values()) r.teardown();
  routes.clear();

  // Build fresh routes for each wire whose endpoints both resolve.
  for (const w of wires) {
    const r = buildRouteForWire(w);
    if (r) routes.set(w.id, r);
  }

  // After per-wire pin/UART routes are in place, reconcile the
  // higher-level I2C bridges that need BOTH SDA and SCL present.
  updateI2CBridges(wires);
}

/**
 * Called by the store when a board's simulator finishes initialising
 * (firmware loaded, peripherals constructed). At that point the
 * I2CBusManager finally exists, so we re-evaluate which bridges can
 * be installed.  Safe to call repeatedly.
 */
export function notifyBoardReady(_boardId: string, wires: readonly Wire[]): void {
  updateI2CBridges(wires);
}

/**
 * Re-attempt the serial hook for a board whose sim/bridge did not exist
 * when the routes were built. Routes are installed at page load; a Pi's
 * bridge is created at Run — so the TX hook silently no-opped and the
 * guest's UART bytes never reached the wire. The store calls this when
 * the bridge connects; ensureSerialHook is idempotent via its flag.
 */
export function reensureSerialHooks(boardId: string): void {
  const entry = boards.get(boardId);
  if (!entry || entry.serialFanout.size === 0) return;
  // The hook lives on the sim/bridge INSTANCE and marks it with a flag.
  // A fresh instance carries no flag, so ensureSerialHook installs on it;
  // this call is what makes that happen after a compile or a reconnect.
  ensureSerialHook(entry);
}

/** For tests: reset all internal state. */
export function resetInterconnect(): void {
  for (const r of routes.values()) r.teardown();
  routes.clear();
  for (const teardown of i2cBridges.values()) teardown();
  i2cBridges.clear();
  for (const e of boards.values()) {
    e.pinChangeFanout.clear();
    e.serialFanout.clear();
    for (const u of e.pinUnsubs) u();
    e.pinUnsubs = [];
  }
  boards.clear();
  propagatingPins.clear();
  lastWireSnapshot = '';
}

/** Diagnostic: return route count (for tests). */
export function getRouteCount(): number {
  return routes.size;
}

export function getBoundBoardIds(): string[] {
  return Array.from(boards.keys());
}
