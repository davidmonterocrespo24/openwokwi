/**
 * proBoardRegistry — runtime registration seam for boards a private overlay
 * (velxio.com) ships outside the OSS tree.
 *
 * The OSS BoardKind union and its compiler-enforced Record maps stay exactly
 * as they are for the open boards. An overlay calls registerProBoards() at
 * mount with data-only definitions; registration patches the exported maps in
 * types/board.ts (labels / FQBN / MicroPython set) so every existing read site
 * keeps working untouched, and the handful of sites a map can't cover (canvas
 * render, pin-name mapping, simulator construction, firmware load) consult
 * getProBoard() as a fallback.
 *
 * The OSS build never registers anything here — like the proRoutes /
 * __velxio_pro_gate__ / registerComponentDoc seams, this module is dead code
 * until an overlay imports it. Board ad cards (ONLINE_ONLY_BOARD_ADS) hide
 * automatically for registered kinds: the picker filter checks
 * `ad.id in BOARD_KIND_LABELS`, and registration inserts the label.
 */
import type React from 'react';
import {
  BOARD_KIND_LABELS,
  BOARD_KIND_FQBN,
  BOARD_SUPPORTS_MICROPYTHON,
  registerPiFamilyKind,
  type BoardKind,
} from '../types/board';

/** Structural contract for an overlay-provided in-browser board simulator.
 *  Mirrors the surface the store already uses on RP2040Simulator — the store
 *  only ever duck-types these members for pro simulators. */
export interface ProBoardSimulator {
  /** Brand flag so the store can recognize overlay simulators without a class. */
  readonly isProBoardSimulator: true;
  onSerialData: ((ch: string) => void) | null;
  onPinChangeWithTime: ((pin: number, state: boolean, time: number) => void) | null;
  stop(): void;
  detachPioPeripheral?(): void;
}

export interface ProBoardDef {
  /** The board id — behaves like a BoardKind everywhere at runtime. */
  kind: string;
  label: string;
  /** arduino-cli FQBN, or null when the board has no backend compile. */
  fqbn: string | null;
  /** One-line picker description. */
  description: string;
  /** The board's custom-element tag. The overlay's import must have run
   *  customElements.define for it before the board is placed. */
  tag: string;
  /** True pixel size of the element (selection ring + pin overlays). */
  size: { w: number; h: number };
  supportsMicroPython?: boolean;
  /** ESP32 run-path routing: the base chip the board carries. Routes the run
   *  through the ESP32 bridge path and picks the machine/engine type. Omit for
   *  boards that provide createSimulator (RP2350 class) or AVR/RP2040. */
  esp32Family?: 'esp32' | 'esp32-s3' | 'esp32-c3' | 'esp32-c6';
  /** QEMU-Linux run-path routing: route this kind through the Raspberry Pi
   *  bridge (backend qemu WebSocket, VFS panel, boot terminal). The overlay
   *  must also register a matching backend profile for the kind. */
  piFamily?: boolean;
  /** One shell line sent to the guest right after it reaches the boot
   *  prompt (piFamily boards only). Lets a board de-brand the generic
   *  image, e.g. set its own hostname/PS1 and clear the stock motd. */
  guestSetup?: string;
  /** Home directory of the guest user for the VFS panel and uploads
   *  (piFamily boards only; default '/home/pi'). Boards whose guest logs
   *  in as root pass '/root'; these also drop the hello.sh sample. */
  guestHome?: string;
  /** Shell command run automatically after boot: the VFS is uploaded and
   *  this line executed, so a single click on Run boots, uploads and
   *  starts the user's script (piFamily boards only). */
  autoRun?: string;
  /** Suppress the guest's boot chatter in the terminal (piFamily boards
   *  only): the shared rootfs prints another product's banner/motd during
   *  boot, before guestSetup can re-brand it. With quietBoot the terminal
   *  shows a neutral Velxio boot-progress line instead and reveals the
   *  shell right before the auto-run command executes. */
  quietBoot?: boolean;
  /** Canvas renderer. Receives the placed board's props; return a React node.
   *  When omitted, the canvas renders `<tag id=... style=absolute@x,y>`. */
  render?: (props: { id: string; x: number; y: number; running: boolean }) => React.ReactNode;
  /** pinInfo name -> GPIO number (power/ground pins -> -1). Falls back to the
   *  generic numeric parse when omitted. Return null for "not mine". */
  pinToNumber?: (pinName: string) => number | null;
  /** In-browser simulator factory (e.g. the RP2350/Hazard3 emulator). The pm
   *  argument is the store's PinManager instance. */
  createSimulator?: (pm: unknown) => ProBoardSimulator;
  /** Load compiled firmware into a createSimulator() instance at run time —
   *  the overlay owns the whole sequence (PIO attach, binary load, demo I2C
   *  devices, ...). `program` is the compiled artifact exactly as the store
   *  holds it (base64/hex string, same value RP2040Simulator.loadBinary gets). */
  loadFirmware?: (
    sim: ProBoardSimulator,
    program: string,
    ctx: { boardKind: string; boardId: string },
  ) => void;
  /** Built-in bridge sensors registered without wiring (e.g. an on-board I2C
   *  keyboard): pushed into the ESP32 bridge's sensor config on every run. */
  builtInSensors?: Array<{ sensor_type: string; pin: number; addr?: number }>;
  /** Built-in microSD on a shared SPI bus: the CS pin the bridge must gate.
   *  (A standalone SD card component still overrides this to un-gated.) */
  builtInSdCsPin?: number;
  /** Board carries an on-board microphone whose bridge implements
   *  setMicrophoneSource (I2S RX sample injection): shows the canvas-header
   *  Mic toggle that streams the computer's microphone into it. */
  builtInMicrophone?: boolean;
  /** Board carries an IMU whose bridge implements setImuAcceleration /
   *  setImuGyro: shows the canvas-header tilt pad. Without it the emulated
   *  part faithfully reports the board lying flat for the whole run. */
  builtInImu?: boolean;
  /** Board reads a battery through its bridge (setBatteryVoltage): shows the
   *  canvas-header charge slider, so low-battery code paths can be reached. */
  builtInBattery?: boolean;
  /** Built-in peripheral attachment for a RUNNING board (LCD decoder onto the
   *  element's own canvas, speaker, on-board button/keyboard event forwarding).
   *  Called shortly after run start with the board's DOM element plus its
   *  simulator shim and ESP32 bridge (either may be null depending on the run
   *  path); must return a cleanup that detaches everything. */
  attachBuiltins?: (ctx: {
    el: HTMLElement;
    sim: unknown;
    bridge: unknown;
  }) => () => void;

  /** Sidebar / toolbar accents (fall back to a neutral chip icon). */
  icon?: string;
  color?: string;
}

const registry = new Map<string, ProBoardDef>();

// Registration happens when the overlay's dynamic import lands - potentially
// AFTER a consumer rendered and memoized its board list. Subscribers re-render
// on every registration (same contract as proRoutes / registerProExamples).
let version = 0;
const listeners = new Set<() => void>();

export function subscribeProBoards(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getProBoardsVersion(): number {
  return version;
}

export function registerProBoards(defs: ProBoardDef[]): void {
  for (const def of defs) {
    registry.set(def.kind, def);
    const kind = def.kind as BoardKind;
    // Patch the exported maps so every existing read site sees the board —
    // labels also make the picker's ONLINE ad for this kind disappear.
    (BOARD_KIND_LABELS as Record<string, string>)[kind] = def.label;
    (BOARD_KIND_FQBN as Record<string, string | null>)[kind] = def.fqbn;
    if (def.supportsMicroPython) BOARD_SUPPORTS_MICROPYTHON.add(kind);
    if (def.piFamily) registerPiFamilyKind(def.kind);
  }
  version++;
  for (const l of listeners) l();
}

export function getProBoard(kind: string): ProBoardDef | undefined {
  return registry.get(kind);
}

// ── Guest setup lines for boards the OSS tree already owns ───────────────
//
// A QEMU-Linux board that is NOT overlay-registered (the Raspberry Pi
// family) may still need a line run at the boot prompt — an overlay can
// mount something on the guest for it. Registering a whole ProBoardDef
// just to carry that string is the wrong tool: `getProBoard` is what
// BoardOnCanvas checks to decide whether to render the overlay's custom
// element instead of the OSS board art, so a stub def silently replaced
// the Pi's illustration with a bare schematic box and left the wires
// hanging at the corner. This registry carries the line and nothing else.
const guestSetups = new Map<string, string>();

export function registerGuestSetup(kind: string, line: string): void {
  guestSetups.set(kind, line);
}

/** The line to run at the guest's boot prompt: an overlay board's own
 *  `guestSetup` first, then anything registered for an OSS board kind. */
export function getGuestSetup(kind: string): string | undefined {
  return registry.get(kind)?.guestSetup ?? guestSetups.get(kind);
}

// ── Built-in peripheral attachment for boards the OSS tree already owns ──
//
// Same reasoning as the guest setups above: an overlay may need to wire
// something to a run of an OSS-rendered board — the Pi family has no
// built-in screen, but an overlay can route the guest's display frames to
// a panel wired on the canvas. Carrying that through a stub ProBoardDef
// would take over the board's artwork, so it gets its own registry.
type BuiltinsAttach = (ctx: {
  el: HTMLElement;
  sim: unknown;
  bridge: unknown;
}) => () => void;

const boardBuiltins = new Map<string, BuiltinsAttach>();

export function registerBoardBuiltins(kind: string, attach: BuiltinsAttach): void {
  boardBuiltins.set(kind, attach);
}

/** How to attach built-in peripherals for a board kind: an overlay board's
 *  own `attachBuiltins` first, then anything registered for an OSS kind. */
export function getBoardBuiltins(kind: string): BuiltinsAttach | undefined {
  return registry.get(kind)?.attachBuiltins ?? boardBuiltins.get(kind);
}

export function listProBoards(): ProBoardDef[] {
  return Array.from(registry.values());
}

export function isProBoardSimulator(sim: unknown): sim is ProBoardSimulator {
  return !!sim && (sim as { isProBoardSimulator?: boolean }).isProBoardSimulator === true;
}
