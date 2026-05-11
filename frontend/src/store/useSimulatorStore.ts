import { create } from 'zustand';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { RP2040Simulator } from '../simulation/RP2040Simulator';
import { Cyw43Bridge } from '../simulation/cyw43';
import { RiscVSimulator } from '../simulation/RiscVSimulator';
import { Esp32C3Simulator } from '../simulation/Esp32C3Simulator';
import { PinManager } from '../simulation/PinManager';
import { SignalRouter } from '../simulation/SignalRouter';
import { ledcSignalForChannel } from '../simulation/esp32-signals';
import {
  VirtualDS1307,
  VirtualTempSensor,
  I2CMemoryDevice,
  I2CBusManager,
  nullI2CMaster,
} from '../simulation/I2CBusManager';
import type { I2CDevice } from '../simulation/I2CBusManager';
import type { RP2040I2CDevice } from '../simulation/RP2040Simulator';
import type { Wire, WireInProgress, WireEndpoint } from '../types/wire';
import type { BoardKind, BoardInstance, LanguageMode } from '../types/board';
import { BOARD_SUPPORTS_MICROPYTHON, isPiBoardKind, isStm32BoardKind } from '../types/board';
import { boardGateDecision, proBoardFeatureName, triggerProUpgradePrompt } from '../lib/proBoardGate';
import { calculatePinPosition } from '../utils/pinPositionCalculator';
import { useOscilloscopeStore } from './useOscilloscopeStore';
import { RaspberryPi3Bridge } from '../simulation/RaspberryPi3Bridge';
import { Esp32Bridge } from '../simulation/Esp32Bridge';
import { Stm32Bridge, stm32PinNameToLinear } from '../simulation/Stm32Bridge';
import { STM32_LED } from '../components/velxio-components/Stm32BluePillElement';
import { useEditorStore } from './useEditorStore';
import { useVfsStore } from './useVfsStore';
import { buildProjectSdImage, decodeSdFiles, bytesToB64 } from '../utils/sdCardFiles';
import { boardPinToNumber, isBoardComponent } from '../utils/boardPinMapping';
import { autoWireColor, DEFAULT_WIRE_COLOR } from '../utils/wireUtils';
import { createSerialBatcher } from './serialBatcher';
import {
  bindBoard as icBindBoard,
  unbindBoard as icUnbindBoard,
  updateWires as icUpdateWires,
  setInterconnectRuntime,
} from '../simulation/Interconnect';

// ── Sensor pre-registration ──────────────────────────────────────────────────
// Maps component metadataId → { sensorType, dataPinName, propertyKeys }
// Used to pre-register sensors in the start_esp32 payload so the QEMU worker
// has them ready before the firmware starts executing (prevents race conditions).
const SENSOR_COMPONENT_MAP: Record<
  string,
  {
    sensorType: string;
    dataPinName: string;
    propertyKeys: string[];
    extraPins?: Record<string, string>; // extra pin mappings: prop name → component pin name
  }
> = {
  dht22: { sensorType: 'dht22', dataPinName: 'SDA', propertyKeys: ['temperature', 'humidity'] },
  'hc-sr04': {
    sensorType: 'hc-sr04',
    dataPinName: 'TRIG',
    propertyKeys: ['distance'],
    extraPins: { echo_pin: 'ECHO' },
  },
};

// ── I2C sensor pre-registration ───────────────────────────────────────────────
// I2C sensors use virtual pins (200 + i2c_addr) instead of real GPIO pins.
// They are identified by I2C address and do not need wire-resolution.
// `addrProp` is the component property that overrides the default address.
const I2C_SENSOR_MAP: Record<
  string,
  {
    sensorType: string;
    defaultAddr: number;
    addrProp?: string; // property key that holds the I2C address (e.g. 'address')
    addrIsBool?: boolean; // true when addrProp is a boolean flag (e.g. AD0 → 0x68/0x69)
    addrBoolHigh?: number; // address when the boolean flag is truthy
    propertyKeys?: string[]; // additional sensor values to forward (e.g. temperature, pressure)
  }
> = {
  mpu6050: {
    sensorType: 'mpu6050',
    defaultAddr: 0x68,
    addrProp: 'ad0',
    addrIsBool: true,
    addrBoolHigh: 0x69,
  },
  bmp280: {
    sensorType: 'bmp280',
    defaultAddr: 0x76,
    addrProp: 'address',
    propertyKeys: ['temperature', 'pressure'],
  },
  ds1307: { sensorType: 'ds1307', defaultAddr: 0x68 },
  ds3231: { sensorType: 'ds3231', defaultAddr: 0x68, propertyKeys: ['temperature'] },
  ssd1306: { sensorType: 'ssd1306', defaultAddr: 0x3c },
  pcf8574: { sensorType: 'pcf8574', defaultAddr: 0x27, addrProp: 'i2cAddress' },
};

// ── Legacy type aliases (keep external consumers working) ──────────────────
export type BoardType = 'arduino-uno' | 'arduino-nano' | 'arduino-mega' | 'raspberry-pi-pico';

export const BOARD_FQBN: Record<BoardType, string> = {
  'arduino-uno': 'arduino:avr:uno',
  'arduino-nano': 'arduino:avr:nano:cpu=atmega328',
  'arduino-mega': 'arduino:avr:mega',
  'raspberry-pi-pico': 'rp2040:rp2040:rpipico',
};

export const BOARD_LABELS: Record<BoardType, string> = {
  'arduino-uno': 'Arduino Uno',
  'arduino-nano': 'Arduino Nano',
  'arduino-mega': 'Arduino Mega 2560',
  'raspberry-pi-pico': 'Raspberry Pi Pico',
};

export const DEFAULT_BOARD_POSITION = { x: 50, y: 50 };
export const ARDUINO_POSITION = DEFAULT_BOARD_POSITION;

// ── Lightweight shim wrapping Esp32Bridge so component simulations (DHT22, etc.)
// can call setPinState / pinManager just like they would on a local simulator. ──
class Esp32BridgeShim {
  pinManager: PinManager;
  onSerialData: ((ch: string) => void) | null = null;
  onPinChangeWithTime: ((pin: number, state: boolean, timeMs: number) => void) | null = null;
  onBaudRateChange: ((baud: number) => void) | null = null;
  private bridge: Esp32Bridge;

  /**
   * Cross-board I2C surface — see AVRSimulator / RP2040Simulator for
   * the canonical pattern.  ESP32 sketches run in backend QEMU, so the
   * "primary" I2C path goes through the backend's libqemu-xtensa I2C
   * slaves and reaches the frontend as `i2c_event` / `i2c_transaction`
   * WebSocket messages.  But virtual devices attached to the ESP32
   * board on the canvas also live frontend-side as I2CDevice instances
   * — and Interconnect's bridge mechanism needs to reach them when a
   * peer board's master tries to read across an SDA+SCL wire.  So we
   * expose an I2CBusManager whose local devices mirror what
   * ProtocolParts registers via `registerSensor`.  The peer-master
   * direction works through this bus; the ESP32-master direction
   * still flows through the backend (where the firmware runs).
   */
  private i2cBusInstance: I2CBusManager;

  constructor(bridge: Esp32Bridge, pm: PinManager) {
    this.bridge = bridge;
    this.pinManager = pm;
    this.i2cBusInstance = new I2CBusManager(nullI2CMaster());

    // Wire the write-forwarding path: when the backend ProxySlave emits
    // a completed write transaction (one full STOP-bounded master phase
    // from the ESP32 firmware), look up the peer device on the local
    // device lookup map and replay the bytes through its writeByte()
    // contract.  Peer `I2CDevice` implementations (I2CMemoryDevice,
    // VirtualPCF8574, VirtualSSD1306, …) already encode the
    // pointer-byte + data semantics; we just hand off the sequence.
    bridge.onProxyI2cComplete = (addr: number, data: number[]) => {
      const dev = this._peerDeviceLookup.get(addr);
      if (!dev) return;
      try {
        for (const b of data) dev.writeByte(b);
        dev.stop?.();
      } catch (e) {
        console.warn(
          `[Esp32BridgeShim] proxy write replay failed for 0x${addr.toString(16)}`,
          e,
        );
      }
    };
  }

  setPinState(pin: number, state: boolean): void {
    this.bridge.sendPinEvent(pin, state);
  }
  getCurrentCycles(): number {
    return -1;
  }
  getClockHz(): number {
    return 240_000_000;
  }
  isRunning(): boolean {
    return this.bridge.connected;
  }
  serialWrite(text: string): void {
    this.bridge.sendSerialBytes(Array.from(new TextEncoder().encode(text)));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getADC(): any {
    return null;
  }

  /**
   * Set ADC value for an ESP32 GPIO pin.
   * ESP32 ADC1: GPIO 36-39 → CH0-3, GPIO 32-35 → CH4-7
   * Returns true if the pin is a valid ADC pin.
   */
  setAdcVoltage(pin: number, voltage: number): boolean {
    let channel = -1;
    if (pin >= 36 && pin <= 39)
      channel = pin - 36; // GPIO 36→CH0, 37→CH1, 38→CH2, 39→CH3
    else if (pin >= 32 && pin <= 35) channel = pin - 28; // GPIO 32→CH4, 33→CH5, 34→CH6, 35→CH7
    if (channel < 0) return false;
    const millivolts = Math.round(voltage * 1000);
    this.bridge.setAdc(channel, millivolts);
    return true;
  }

  /**
   * Push a 12-bit waveform LUT to QEMU for per-read ADC interpolation.
   * Call once per SPICE `.tran` solve; QEMU interpolates at every MMIO
   * read against its virtual clock. See `Esp32Bridge.setAdcWaveform`.
   *
   * `pin` follows the same GPIO→channel mapping as `setAdcVoltage`.
   * `samples` are 12-bit raw values (0-4095) aligned on a uniform grid.
   */
  setAdcWaveform(pin: number, samples: Uint16Array, periodNs: number): boolean {
    let channel = -1;
    if (pin >= 36 && pin <= 39) channel = pin - 36;
    else if (pin >= 32 && pin <= 35) channel = pin - 28;
    if (channel < 0) return false;
    this.bridge.setAdcWaveform(channel, samples, periodNs);
    return true;
  }
  getMCU(): null {
    return null;
  }
  start(): void {
    /* managed by bridge */
  }
  stop(): void {
    /* managed by bridge */
  }
  reset(): void {
    /* managed by bridge */
  }
  setSpeed(_s: number): void {
    /* no-op */
  }
  getSpeed(): number {
    return 1;
  }
  loadHex(_hex: string): void {
    /* no-op */
  }
  loadBinary(_b64: string): void {
    /* no-op */
  }

  // ── Generic sensor registration (board-agnostic API) ──────────────────────
  // ESP32 delegates sensor protocols to the backend QEMU.

  registerSensor(type: string, pin: number, properties: Record<string, unknown>): boolean {
    this.bridge.sendSensorAttach(type, pin, properties);
    return true; // backend handles the protocol
  }

  /**
   * Expose the underlying Esp32Bridge so simulation parts can subscribe to
   * board-specific WS events (e.g. `onEpaperUpdate` for the ePaper backend
   * rendering path). Hooks should restore any handler they overwrite.
   */
  getBridge(): Esp32Bridge {
    return this.bridge;
  }

  /**
   * Generic SPI bus adapter — same shape as AVRSimulator.spi so SPI-driven
   * parts (ILI9341, SD cards, custom chips…) can hook the bus without
   * caring whether they're on AVR, RP2040, or any of the ESP32 variants.
   * The MOSI byte arrives via the QEMU worker's spi_event WS message
   * (decoded in Esp32Bridge); MISO is driven by the worker's
   * `_spi_response` global, so `completeTransfer` is a no-op on ESP32.
   *
   * Lazy-initialised so the bridge subscription only happens once a part
   * actually accesses `.spi`.
   */
  private _spiAdapter: { onByte: ((mosi: number) => void) | null;
                         completeTransfer: (miso: number) => void } | null = null;
  get spi(): { onByte: ((mosi: number) => void) | null;
               completeTransfer: (miso: number) => void } {
    if (!this._spiAdapter) {
      const adapter = {
        onByte: null as ((mosi: number) => void) | null,
        completeTransfer: (_miso: number) => {
          /* ESP32 worker drives MISO via _spi_response — no-op here. */
        },
      };
      // Forward every per-byte WS event into whichever handler the part
      // installed. Single-listener channel — last writer wins.
      this.bridge.onSpiByte = (mosi: number) => {
        adapter.onByte?.(mosi);
      };
      this._spiAdapter = adapter;
    }
    return this._spiAdapter;
  }
  updateSensor(pin: number, properties: Record<string, unknown>): void {
    this.bridge.sendSensorUpdate(pin, properties);
  }
  unregisterSensor(pin: number): void {
    this.bridge.sendSensorDetach(pin);
  }

  // ── I2C write-only device relay (SSD1306, PCF8574) ───────────────────────
  private _i2cTransactionListeners = new Map<number, (data: number[]) => void>();

  addI2CTransactionListener(addr: number, fn: (data: number[]) => void): void {
    this._i2cTransactionListeners.set(addr, fn);
    this.bridge.onI2cTransaction = (a: number, data: number[]) => {
      this._i2cTransactionListeners.get(a)?.(data);
    };
  }

  removeI2CTransactionListener(addr: number): void {
    this._i2cTransactionListeners.delete(addr);
    if (this._i2cTransactionListeners.size === 0) {
      this.bridge.onI2cTransaction = null;
    }
  }

  // ── Cross-board I2C bus surface ─────────────────────────────────────────

  /**
   * Expose the I2CBusManager so Interconnect can install cross-board
   * bridges and ProtocolParts can register frontend-side virtual
   * devices.  ESP32 has 2 hardware I2C buses but we collapse them
   * onto a single front-end bus for now — the bus index is ignored.
   * Splitting per-bus would require teaching the backend to tag
   * `i2c_event` payloads with the originating bus number, which
   * the lib worker already does (`bus` field) but the frontend
   * shim doesn't yet route on.
   */
  getI2CBus(_bus: 0 | 1 = 0): I2CBusManager {
    return this.i2cBusInstance;
  }

  /**
   * Register a frontend-side virtual I2C device.  This mirrors the
   * backend's QEMU-side slave (kept in sync via `registerSensor` /
   * `updateSensor`) so peer boards reading across the I2C bridge
   * find the device.  ProtocolParts calls this on the ESP32 path
   * alongside the existing `registerSensor` + `addI2CTransactionListener`.
   */
  addI2CDevice(device: I2CDevice, _bus: 0 | 1 = 0): void {
    this.i2cBusInstance.addDevice(device);
  }

  /** Remove a previously-registered virtual device. */
  removeI2CDevice(addr: number, _bus: 0 | 1 = 0): void {
    this.i2cBusInstance.removeDevice(addr);
  }

  /**
   * Push register snapshots of a peer board's I2C devices into a
   * backend `ProxySlave` per address.  Called by Interconnect after a
   * cross-board I2C bridge is installed so the ESP32 firmware's Wire
   * master reads can find the peer's devices inside QEMU.
   *
   * Walks the peer bus AND its transitive bridges (BFS).  Each device
   * found at any reachable hop gets a ProxySlave on the backend.  All
   * addresses discovered through `peerBus` are tracked under that key,
   * so `clearProxiesForPeer(peerBus)` cleans up exactly what this call
   * installed without disturbing proxies from concurrent bridges
   * (e.g. when another wire pair also connects to this same ESP32).
   *
   * Devices that don't expose `dumpRegisters` (PCF8574, SSD1306,
   * LCD-I2C) are skipped — they receive state through the
   * write-forwarding path (proxy_i2c_complete event from the backend
   * ProxySlave) instead.
   */
  syncProxyFromPeer(peerBus: I2CBusManager): void {
    const ownedAddrs = this._proxiedByPeer.get(peerBus) ?? new Set<number>();

    // BFS over the peer's bridge graph.  Skip our own bus so we don't
    // mirror ourselves back via the return edge.
    const visited = new Set<I2CBusManager>([this.i2cBusInstance, peerBus]);
    const queue: I2CBusManager[] = [peerBus];

    while (queue.length > 0) {
      const bus = queue.shift()!;
      if (typeof bus.listDevices === 'function') {
        for (const device of bus.listDevices()) {
          // Track the live device reference for write-forwarding and
          // periodic resync.  Last writer wins on address collisions
          // (rare; the user wired two devices to the same address).
          this._peerDeviceLookup.set(device.address, device);
          if (typeof device.dumpRegisters !== 'function') continue;
          try {
            const regs = device.dumpRegisters();
            this.bridge.registerProxyI2c(device.address, regs);
            ownedAddrs.add(device.address);
            // Prime the resync hash so the first tick doesn't push a
            // redundant identical dump.
            this._lastDumpHash.set(
              device.address,
              Esp32BridgeShim._hashRegs(regs),
            );
          } catch (e) {
            console.warn(
              `[Esp32BridgeShim] syncProxyFromPeer dump failed for 0x${device.address.toString(16)}`,
              e,
            );
          }
        }
      }
      if (typeof bus.getBridges === 'function') {
        for (const next of bus.getBridges()) {
          if (visited.has(next)) continue;
          visited.add(next);
          queue.push(next);
        }
      }
    }

    if (ownedAddrs.size > 0) {
      this._proxiedByPeer.set(peerBus, ownedAddrs);
      this._ensureResyncTimer();
    }
  }

  /**
   * Tear down only the proxies that `syncProxyFromPeer(peerBus)`
   * installed.  Safe to call multiple times; idempotent.  Other
   * concurrent bridges (different peer buses) retain their proxies.
   */
  clearProxiesForPeer(peerBus: I2CBusManager): void {
    const owned = this._proxiedByPeer.get(peerBus);
    if (!owned) return;
    for (const addr of owned) {
      // Only unregister if no other peer also claims this address.
      let claimedElsewhere = false;
      for (const [other, set] of this._proxiedByPeer) {
        if (other !== peerBus && set.has(addr)) {
          claimedElsewhere = true;
          break;
        }
      }
      if (!claimedElsewhere) {
        this.bridge.unregisterProxyI2c(addr);
        this._peerDeviceLookup.delete(addr);
        this._lastDumpHash.delete(addr);
      }
    }
    this._proxiedByPeer.delete(peerBus);
    this._stopResyncTimerIfIdle();
  }

  /**
   * Tear down EVERY proxy slave we've installed.  Used on full board
   * stop / disconnect — `clearProxiesForPeer` is preferred for
   * single-wire-pair teardowns.
   */
  clearAllProxies(): void {
    for (const set of this._proxiedByPeer.values()) {
      for (const addr of set) this.bridge.unregisterProxyI2c(addr);
    }
    this._proxiedByPeer.clear();
    this._peerDeviceLookup.clear();
    this._lastDumpHash.clear();
    this._stopResyncTimerIfIdle();
  }

  /** Per-peer set of addresses we've mirrored.  Cleanup keyed by peer bus. */
  private _proxiedByPeer = new Map<I2CBusManager, Set<number>>();
  /** Address → live frontend device, for write-forwarding & periodic resync. */
  private _peerDeviceLookup = new Map<number, I2CDevice>();
  /** Periodic resync timer — runs while any proxy is live. */
  private _resyncTimer: ReturnType<typeof setInterval> | null = null;
  /** Cheap hash of the last dumped register set per address, to skip WS pushes when unchanged. */
  private _lastDumpHash = new Map<number, number>();

  /**
   * Periodic resync interval in ms.  250 ms strikes the balance
   * between WS bandwidth and human-perceivable RTC freshness; see
   * the architecture rationale in the plan file.  Exposed for tests
   * that want a faster cadence via fake timers.
   */
  static RESYNC_INTERVAL_MS = 250;

  private _ensureResyncTimer(): void {
    if (this._resyncTimer !== null) return;
    if (this._proxiedByPeer.size === 0) return;
    this._resyncTimer = setInterval(
      () => this._resyncTick(),
      Esp32BridgeShim.RESYNC_INTERVAL_MS,
    );
  }

  private _stopResyncTimerIfIdle(): void {
    if (this._proxiedByPeer.size === 0 && this._resyncTimer !== null) {
      clearInterval(this._resyncTimer);
      this._resyncTimer = null;
      this._lastDumpHash.clear();
    }
  }

  /**
   * Cheap XOR-stride hash over a 256-byte buffer.  Detects any byte
   * difference; collisions are theoretically possible but we don't
   * care — a missed update on a flaky hash just delays freshness by
   * one cycle.
   */
  private static _hashRegs(regs: Uint8Array): number {
    let h = regs.length & 0xff;
    for (let i = 0; i < regs.length; i += 16) {
      h = ((h << 5) - h + regs[i]) | 0;
    }
    for (let i = 0; i < Math.min(regs.length, 8); i++) {
      h = ((h << 5) - h + regs[i]) | 0;
    }
    return h;
  }

  private _resyncTick(): void {
    // Union of all proxied addresses across peers.
    const seen = new Set<number>();
    for (const set of this._proxiedByPeer.values()) {
      for (const addr of set) seen.add(addr);
    }
    for (const addr of seen) {
      const device = this._peerDeviceLookup.get(addr);
      if (!device || typeof device.dumpRegisters !== 'function') continue;
      let regs: Uint8Array;
      try {
        regs = device.dumpRegisters();
      } catch {
        continue;
      }
      const h = Esp32BridgeShim._hashRegs(regs);
      if (this._lastDumpHash.get(addr) === h) continue;
      this._lastDumpHash.set(addr, h);
      this.bridge.updateProxyI2c(addr, regs);
    }
  }
}

// ── LEDC duty handler ───────────────────────────────────────────────────
//
// Resolves a (channel, duty_pct) event from the worker into one or more
// (gpio_pin, duty_cycle) updates by consulting the per-board
// SignalRouter mirror. Replaces the legacy `ledc_update` path that
// embedded the gpio in the event and needed a per-channel memo + a
// PinManager.broadcastPwm fallback to survive the worker's gpio=-1
// race window.

function makeLedcDutyHandler(boardId: string) {
  return (duty: { channel: number; duty_pct: number }) => {
    const boardPm = pinManagerMap.get(boardId);
    const router = signalRouterMap.get(boardId);
    if (!boardPm || !router) return;
    const dutyCycle = duty.duty_pct / 100;
    const signalId = ledcSignalForChannel(duty.channel);
    const pins = router.pinsForSignal(signalId);
    // Multi-pin routing: one LEDC channel CAN legally drive multiple
    // pins via the GPIO Matrix (rare but documented in TRM). Iterate
    // all of them — each gets its own updatePwm call.
    for (const pin of pins) {
      boardPm.updatePwm(pin, dutyCycle);
    }
  };
}

function makeGpioRoutingHandler(boardId: string) {
  return (routing: { gpio: number; signal_id: number }) => {
    signalRouterMap.get(boardId)?.updateRouting(routing.gpio, routing.signal_id);
  };
}

function makeGpioRoutingClearHandler(boardId: string) {
  return (gpio: number) => {
    signalRouterMap.get(boardId)?.clearRouting(gpio);
  };
}

// ── Lightweight shim wrapping Stm32Bridge so PartSimulationRegistry parts
// (I2C displays, sensors, SPI panels) attach to an STM32 board the same way
// they attach to ESP32.  Like the STM32 firmware itself, every device model
// runs in the backend QEMU worker: `registerSensor` builds the QEMU-side I2C
// slave, write-only devices (SSD1306, PCF8574) stream their bytes back via
// `i2c_transaction`, and SPI panels read MOSI bytes off the `spi_batch`
// channel through the `.spi` adapter — identical surface to Esp32BridgeShim,
// minus the ESP32-only WiFi / proxy-resync machinery. ──────────────────────
class Stm32BridgeShim {
  pinManager: PinManager;
  onSerialData: ((ch: string) => void) | null = null;
  onPinChangeWithTime: ((pin: number, state: boolean, timeMs: number) => void) | null = null;
  onBaudRateChange: ((baud: number) => void) | null = null;
  private bridge: Stm32Bridge;
  private i2cBusInstance: I2CBusManager;
  private _i2cTransactionListeners = new Map<number, (data: number[]) => void>();

  constructor(bridge: Stm32Bridge, pm: PinManager) {
    this.bridge = bridge;
    this.pinManager = pm;
    this.i2cBusInstance = new I2CBusManager(nullI2CMaster());
  }

  // ── Lifecycle stubs (the store drives the real bridge via getStm32Bridge) ──
  start(): void {}
  stop(): void {}
  reset(): void {}
  setSpeed(_s: number): void {}
  getSpeed(): number { return 1; }
  loadHex(_hex: string): void {}
  loadBinary(_b64: string): void {}
  isRunning(): boolean { return this.bridge.connected; }

  /** Drive a GPIO input from a part. `pin` is the linear pin (port*16+pin). */
  setPinState(pin: number, state: boolean): void {
    this.bridge.sendPinEvent(pin, state);
  }

  // ── Generic sensor registration (delegated to the backend QEMU worker) ──
  registerSensor(type: string, pin: number, properties: Record<string, unknown>): boolean {
    this.bridge.sendSensorAttach(type, pin, properties);
    return true;
  }
  updateSensor(pin: number, properties: Record<string, unknown>): void {
    this.bridge.sendSensorUpdate(pin, properties);
  }
  unregisterSensor(pin: number): void {
    this.bridge.sendSensorDetach(pin);
  }

  /** Expose the bridge so SPI/ePaper parts can subscribe to backend frames. */
  getBridge(): Stm32Bridge {
    return this.bridge;
  }

  // ── I2C write-only device relay (SSD1306, PCF8574) ────────────────────────
  addI2CTransactionListener(addr: number, fn: (data: number[]) => void): void {
    this._i2cTransactionListeners.set(addr, fn);
    this.bridge.onI2cTransaction = (a: number, data: number[]) => {
      this._i2cTransactionListeners.get(a)?.(data);
    };
  }
  removeI2CTransactionListener(addr: number): void {
    this._i2cTransactionListeners.delete(addr);
    if (this._i2cTransactionListeners.size === 0) {
      this.bridge.onI2cTransaction = null;
    }
  }

  // ── Cross-board I2C bus surface (for Interconnect bridges) ────────────────
  getI2CBus(_bus: 0 | 1 = 0): I2CBusManager {
    return this.i2cBusInstance;
  }
  addI2CDevice(device: I2CDevice, _bus: 0 | 1 = 0): void {
    this.i2cBusInstance.addDevice(device);
  }
  removeI2CDevice(addr: number, _bus: 0 | 1 = 0): void {
    this.i2cBusInstance.removeDevice(addr);
  }

  // ── Generic SPI bus adapter (same shape as AVRSimulator.spi) ──────────────
  // SPI panels (ILI9341, SSD1306-SPI) hook `.spi.onByte`; STM32 runs SPI in
  // the backend, so the MOSI bytes arrive batched over `spi_batch` and we
  // replay them one at a time. MISO is driven by the worker, so
  // `completeTransfer` is a no-op (mirrors the ESP32 adapter).
  private _spiAdapter: {
    onByte: ((mosi: number) => void) | null;
    completeTransfer: (miso: number) => void;
  } | null = null;
  get spi(): {
    onByte: ((mosi: number) => void) | null;
    completeTransfer: (miso: number) => void;
  } {
    if (!this._spiAdapter) {
      const adapter = {
        onByte: null as ((mosi: number) => void) | null,
        completeTransfer: (_miso: number) => {},
      };
      this.bridge.onSpiBatch = (bytes: Uint8Array) => {
        for (const b of bytes) adapter.onByte?.(b);
      };
      this._spiAdapter = adapter;
    }
    return this._spiAdapter;
  }
}

// ── Runtime Maps (outside Zustand — not serialisable) ─────────────────────
const simulatorMap = new Map<
  string,
  AVRSimulator | RP2040Simulator | RiscVSimulator | Esp32C3Simulator | Esp32BridgeShim | Stm32BridgeShim
>();
const pinManagerMap = new Map<string, PinManager>();
// Per-board ESP32 GPIO Matrix mirror.  Populated for boards whose kind
// is an ESP32 variant (others don't have a GPIO Matrix in the same
// sense; AVR/RP2040 wire signals to pins directly without the IO_MUX).
// Lifecycle parallels pinManagerMap — created in addBoard / setBoardType
// / initSimulator, deleted in removeBoard / cleanup.
const signalRouterMap = new Map<string, SignalRouter>();
const bridgeMap = new Map<string, RaspberryPi3Bridge>();
const esp32BridgeMap = new Map<string, Esp32Bridge>();
// STM32 bridge — created lazily, only when isStm32BoardKind(boardKind).
const stm32BridgeMap = new Map<string, Stm32Bridge>();
// Pico W WiFi (CYW43439) bridge — created lazily, only when boardKind === 'pi-pico-w'.
const cyw43BridgeMap = new Map<string, Cyw43Bridge>();

export const getBoardSimulator = (id: string) => simulatorMap.get(id);
export const getBoardPinManager = (id: string) => pinManagerMap.get(id);
export const getBoardBridge = (id: string) => bridgeMap.get(id);
export const getEsp32Bridge = (id: string) => esp32BridgeMap.get(id);
export const getStm32Bridge = (id: string) => stm32BridgeMap.get(id);
export const getCyw43Bridge = (id: string) => cyw43BridgeMap.get(id);

// Xtensa-based ESP32 boards — use QEMU bridge (backend)
const ESP32_KINDS = new Set<BoardKind>([
  'esp32',
  'esp32-devkit-c-v4',
  'esp32-cam',
  'wemos-lolin32-lite',
  'esp32-s3',
  'xiao-esp32-s3',
  'arduino-nano-esp32',
]);

// RISC-V ESP32 boards — also use QEMU bridge (qemu-system-riscv32 -M esp32c3)
// The browser-side Esp32C3Simulator cannot handle the 150+ ROM functions ESP-IDF needs.
const ESP32_RISCV_KINDS = new Set<BoardKind>([
  'esp32-c3',
  'xiao-esp32-c3',
  'aitewinrobot-esp32c3-supermini',
]);

function isEsp32Kind(kind: BoardKind): boolean {
  return ESP32_KINDS.has(kind) || ESP32_RISCV_KINDS.has(kind);
}

function isRiscVEsp32Kind(kind: BoardKind): boolean {
  return ESP32_RISCV_KINDS.has(kind);
}

// ── Component type ────────────────────────────────────────────────────────
interface Component {
  id: string;
  metadataId: string;
  x: number;
  y: number;
  properties: Record<string, unknown>;
}

// ── Undo/redo history ────────────────────────────────────────────────────
/**
 * One entry on the canvas undo/redo stack.
 *
 *   description  — human-readable label shown as the undo/redo button
 *                  tooltip ("Undo: Move LED").
 *   execute()    — applied on redo. Should be idempotent against the
 *                  current state at redo time (the user may have undone
 *                  several steps then started a new branch).
 *   undo()       — reverts the change. Same idempotency contract.
 *
 * Commands that capture the inverse on construction (e.g. `recordMove`
 * captures fromX/fromY) are pushed with `applyNow:false` because the
 * mutation already happened — the command only needs to remember how to
 * undo/redo it later. Commands that ARE the canonical mutation (e.g.
 * `recordAddComponent`) are pushed with `applyNow:true` so a single call
 * both performs the action and stores the undo path.
 */
export interface CanvasCommand {
  description: string;
  execute(): void;
  undo(): void;
}

const HISTORY_MAX = 50;

// ── Store interface ───────────────────────────────────────────────────────
interface SimulatorState {
  // ── Multi-board state ───────────────────────────────────────────────────
  boards: BoardInstance[];
  activeBoardId: string | null;

  addBoard: (boardKind: BoardKind, x: number, y: number, explicitId?: string) => string;
  removeBoard: (boardId: string) => void;
  /** Reload the entire workspace from a saved project payload. Tears down
   *  all current boards, recreates them with their saved IDs (so wire
   *  endpoints remain valid), restores file groups, components, wires. */
  loadProjectState: (payload: {
    boards: BoardInstance[];
    fileGroups: Record<string, { name: string; content: string }[]>;
    components: Component[];
    wires: Wire[];
    activeBoardId: string | null;
  }) => void;
  updateBoard: (boardId: string, updates: Partial<BoardInstance>) => void;
  setBoardPosition: (pos: { x: number; y: number }, boardId?: string) => void;
  setActiveBoardId: (boardId: string) => void;
  compileBoardProgram: (boardId: string, program: string) => void;
  loadMicroPythonProgram: (
    boardId: string,
    files: Array<{ name: string; content: string }>,
  ) => Promise<void>;
  setBoardLanguageMode: (boardId: string, mode: LanguageMode) => void;
  startBoard: (boardId: string) => void;
  stopBoard: (boardId: string) => void;
  resetBoard: (boardId: string) => void;

  // ── Legacy single-board API (reads/writes activeBoardId board) ───────────
  /** @deprecated use boards[]/activeBoardId directly */
  boardType: BoardType;
  /** @deprecated use boards[x].x/y */
  boardPosition: { x: number; y: number };
  /** @deprecated use getBoardSimulator(activeBoardId) */
  simulator:
    | AVRSimulator
    | RP2040Simulator
    | RiscVSimulator
    | Esp32C3Simulator
    | Esp32BridgeShim
    | null;
  /** @deprecated use getBoardPinManager(activeBoardId) */
  pinManager: PinManager;
  running: boolean;
  compiledHex: string | null;
  hexEpoch: number;
  serialOutput: string;
  serialBaudRate: number;
  serialMonitorOpen: boolean;
  /** @deprecated use getBoardBridge(activeBoardId) */
  remoteConnected: boolean;
  remoteSocket: WebSocket | null;

  setBoardType: (type: BoardType) => void;
  initSimulator: () => void;
  loadHex: (hex: string) => void;
  loadBinary: (base64: string) => void;
  startSimulation: () => void;
  stopSimulation: () => void;
  resetSimulation: () => void;
  /** Bump hexEpoch to force every component part to re-attach (e.g. so a
   *  board-less custom chip picks up freshly compiled WASM). */
  restartParts: () => void;
  setCompiledHex: (hex: string) => void;
  setCompiledBinary: (base64: string) => void;
  setRunning: (running: boolean) => void;
  connectRemoteSimulator: (clientId: string) => void;
  disconnectRemoteSimulator: () => void;
  sendRemotePinEvent: (pin: string, state: number) => void;

  // ── ESP32 crash notification ─────────────────────────────────────────────
  esp32CrashBoardId: string | null;
  dismissEsp32Crash: () => void;

  // ── Components ──────────────────────────────────────────────────────────
  components: Component[];
  addComponent: (component: Component) => void;
  removeComponent: (id: string) => void;
  updateComponent: (id: string, updates: Partial<Component>) => void;
  updateComponentState: (id: string, state: boolean) => void;
  handleComponentEvent: (componentId: string, eventName: string, data?: unknown) => void;
  setComponents: (components: Component[]) => void;

  // ── Wires ───────────────────────────────────────────────────────────────
  wires: Wire[];
  selectedWireId: string | null;
  wireInProgress: WireInProgress | null;
  addWire: (wire: Wire) => void;
  removeWire: (wireId: string) => void;
  updateWire: (wireId: string, updates: Partial<Wire>) => void;
  setSelectedWire: (wireId: string | null) => void;
  setWires: (wires: Wire[]) => void;
  startWireCreation: (endpoint: WireEndpoint, color: string) => void;
  updateWireInProgress: (x: number, y: number) => void;
  addWireWaypoint: (x: number, y: number) => void;
  setWireInProgressColor: (color: string) => void;
  finishWireCreation: (endpoint: WireEndpoint) => void;
  cancelWireCreation: () => void;
  updateWirePositions: (componentId: string) => void;
  recalculateAllWirePositions: () => void;

  // ── Undo/redo ────────────────────────────────────────────────────────────
  /** Bounded ring buffer of canvas mutations (HISTORY_MAX = 50). */
  history: CanvasCommand[];
  /** Index of the last APPLIED command. -1 = empty / fully undone. */
  historyIndex: number;
  /** Push a command and (by default) execute it. Truncates the redo stack. */
  pushCommand: (cmd: CanvasCommand, opts?: { applyNow?: boolean }) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  /** Wipe the stack (called on project load / clear). */
  clearHistory: () => void;
  /**
   * Recorded canvas actions — these are the public API the UI and agent
   * tools should use to mutate the canvas. Each one wraps a raw mutator
   * with a CanvasCommand so the change is undoable. Drag-preview frames
   * still use the raw mutators (addComponent / updateComponent / addWire
   * / removeWire / updateWire) which DO NOT touch history.
   */
  recordAddComponent: (component: Component) => void;
  recordRemoveComponent: (id: string) => void;
  recordMove: (
    id: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
  ) => void;
  recordRotate: (id: string, prevRotation: number, nextRotation: number) => void;
  recordSetProperty: (id: string, key: string, prevValue: unknown, nextValue: unknown) => void;
  recordAddWire: (wire: Wire) => void;
  recordRemoveWire: (wireId: string) => void;
  recordUpdateWire: (
    wireId: string,
    prev: Partial<Wire>,
    next: Partial<Wire>,
    description?: string,
  ) => void;

  // ── Serial monitor ──────────────────────────────────────────────────────
  toggleSerialMonitor: () => void;
  serialWrite: (text: string) => void;
  serialWriteToBoard: (boardId: string, text: string) => void;
  clearSerialOutput: () => void;
  clearBoardSerialOutput: (boardId: string) => void;
}

// ── Helper: create a simulator for a given board kind ─────────────────────
function createSimulator(
  boardKind: BoardKind,
  pm: PinManager,
  onSerial: (ch: string) => void,
  onBaud: (baud: number) => void,
  onPinTime: (pin: number, state: boolean, t: number) => void,
): AVRSimulator | RP2040Simulator | RiscVSimulator | Esp32C3Simulator {
  let sim: AVRSimulator | RP2040Simulator | RiscVSimulator | Esp32C3Simulator;
  if (boardKind === 'arduino-mega') {
    sim = new AVRSimulator(pm, 'mega');
  } else if (boardKind === 'attiny85') {
    sim = new AVRSimulator(pm, 'tiny85');
  } else if (boardKind === 'raspberry-pi-pico' || boardKind === 'pi-pico-w') {
    sim = new RP2040Simulator(pm);
  } else if (isRiscVEsp32Kind(boardKind)) {
    // ESP32-C3 / XIAO-C3 / C3 SuperMini — browser-side RV32IMC emulator
    sim = new Esp32C3Simulator(pm);
  } else {
    // arduino-uno, arduino-nano
    sim = new AVRSimulator(pm, 'uno');
  }
  sim.onSerialData = onSerial;
  if (sim instanceof AVRSimulator) sim.onBaudRateChange = onBaud;
  sim.onPinChangeWithTime = onPinTime;
  return sim;
}

// ── Default initial board (Arduino Uno — same as old behaviour) ───────────
const INITIAL_BOARD_ID = 'arduino-uno';
const INITIAL_BOARD: BoardInstance = {
  id: INITIAL_BOARD_ID,
  boardKind: 'arduino-uno',
  x: DEFAULT_BOARD_POSITION.x,
  y: DEFAULT_BOARD_POSITION.y,
  running: false,
  compiledProgram: null,
  serialOutput: '',
  serialBaudRate: 0,
  serialMonitorOpen: false,
  activeFileGroupId: `group-${INITIAL_BOARD_ID}`,
  languageMode: 'arduino' as LanguageMode,
};

// ── Serial batching ───────────────────────────────────────────────────────
// USART callbacks fire once per byte. Sketches doing `Serial.println(x)` at
// ~200 Hz emit ~600 bytes/s, and a raw `set()` per byte overwhelms React's
// useSyncExternalStore reconciliation (→ "Maximum update depth exceeded").
// The batcher coalesces chunks per animation frame (≤60 Hz), grouped by board.
const { append: appendSerial } = createSerialBatcher((perBoard) => {
  useSimulatorStore.setState((s) => {
    let globalOut = s.serialOutput;
    const boards = s.boards.map((b) => {
      const chunk = perBoard.get(b.id);
      if (!chunk) return b;
      if (s.activeBoardId === b.id) globalOut += chunk;
      return { ...b, serialOutput: b.serialOutput + chunk };
    });
    return { boards, serialOutput: globalOut };
  });
});

// ── Store ─────────────────────────────────────────────────────────────────
export const useSimulatorStore = create<SimulatorState>((set, get) => {
  // Initialise runtime objects for the default board
  const initialPm = new PinManager();
  pinManagerMap.set(INITIAL_BOARD_ID, initialPm);

  function getOscilloscopeCallback(boardId: string) {
    return (pin: number, state: boolean, timeMs: number) => {
      const { channels, pushSample } = useOscilloscopeStore.getState();
      for (const ch of channels) {
        if (ch.boardId === boardId && ch.pin === pin) pushSample(ch.id, timeMs, state);
      }
    };
  }

  const initialSim = createSimulator(
    'arduino-uno',
    initialPm,
    (ch) => appendSerial(INITIAL_BOARD_ID, ch),
    (baud) => {
      set((s) => {
        const boards = s.boards.map((b) =>
          b.id === INITIAL_BOARD_ID ? { ...b, serialBaudRate: baud } : b,
        );
        const isActive = s.activeBoardId === INITIAL_BOARD_ID;
        return { boards, ...(isActive ? { serialBaudRate: baud } : {}) };
      });
    },
    getOscilloscopeCallback(INITIAL_BOARD_ID),
  );
  // Cross-board routing for the initial board is handled by the Interconnect
  // (registered after the store is created — see bottom of this file).
  simulatorMap.set(INITIAL_BOARD_ID, initialSim);

  // ── Legacy single-board PinManager (references initial board's pm) ───────
  const legacyPinManager = initialPm;

  return {
    // ── Multi-board state ─────────────────────────────────────────────────
    boards: [INITIAL_BOARD],
    activeBoardId: INITIAL_BOARD_ID,

    addBoard: (boardKind: BoardKind, x: number, y: number, explicitId?: string) => {
      let id: string;
      if (explicitId) {
        id = explicitId;
      } else {
        const existing = get().boards.filter((b) => b.boardKind === boardKind);
        id = existing.length === 0 ? boardKind : `${boardKind}-${existing.length + 1}`;
      }

      const pm = new PinManager();
      pinManagerMap.set(id, pm);

      const serialCallback = (ch: string) => appendSerial(id, ch);

      if (isPiBoardKind(boardKind)) {
        const bridge = new RaspberryPi3Bridge(id, boardKind);
        bridge.onSerialData = (ch: string) => {
          serialCallback(ch);
          // Cross-board routing now handled by Interconnect (see bind below).
        };
        bridge.onPinChange = (_gpioPin, _state) => {
          // Cross-board routing now handled by Interconnect (see bind below).
        };
        bridgeMap.set(id, bridge);
      } else if (isEsp32Kind(boardKind)) {
        const bridge = new Esp32Bridge(id, boardKind);
        bridge.onSerialData = serialCallback;
        bridge.onPinChange = (gpioPin, state) => {
          const boardPm = pinManagerMap.get(id);
          if (boardPm) boardPm.triggerPinChange(gpioPin, state, 'mcu');
          getOscilloscopeCallback(id)(gpioPin, state, performance.now());
        };
        // Wire scope sampling for ESP32 (GPIO transitions + synthesized
        // UART TX bits).  Mirrors what AVR/RP2040 simulators get for free
        // by passing the oscilloscope callback into createSimulator().
        bridge.onPinChangeWithTime = getOscilloscopeCallback(id);
        bridge.onCrash = () => {
          set({ esp32CrashBoardId: id });
        };
        bridge.onDisconnected = () => {
          set((s) => {
            const boards = s.boards.map((b) => (b.id === id ? { ...b, running: false } : b));
            const isActive = s.activeBoardId === id;
            return { boards, ...(isActive ? { running: false } : {}) };
          });
        };
        signalRouterMap.set(id, new SignalRouter());
        bridge.onLedcDuty = makeLedcDutyHandler(id);
        bridge.onGpioRouting = makeGpioRoutingHandler(id);
        bridge.onGpioRoutingClear = makeGpioRoutingClearHandler(id);
        bridge.onWs2812Update = (channel, pixels) => {
          // Forward WS2812 pixel data to any DOM element with id=`ws2812-{id}-{channel}`
          // (set by NeoPixel components rendered in SimulatorCanvas).
          // We fire a custom event that NeoPixel components can listen to.
          const eventTarget = document.getElementById(`ws2812-${id}-${channel}`);
          if (eventTarget) {
            eventTarget.dispatchEvent(new CustomEvent('ws2812-pixels', { detail: { pixels } }));
          }
        };
        bridge.onWifiStatus = (ws) => {
          set((s) => ({
            boards: s.boards.map((b) => (b.id === id ? { ...b, wifiStatus: ws } : b)),
          }));
        };
        bridge.onBleStatus = (bs) => {
          set((s) => ({
            boards: s.boards.map((b) => (b.id === id ? { ...b, bleStatus: bs } : b)),
          }));
        };
        esp32BridgeMap.set(id, bridge);
        // Provide a shim so PartSimulationRegistry components (DHT22, etc.)
        // can call setPinState / access pinManager on ESP32 boards.
        const shim = new Esp32BridgeShim(bridge, pm);
        shim.onSerialData = serialCallback;
        // If a shim already exists for this id (e.g. tests recreate the
        // same kind after reset), dispose any active proxies / timers
        // so the orphaned instance doesn't keep firing.
        const existingShim = simulatorMap.get(id) as any;
        if (existingShim?.clearAllProxies) {
          try { existingShim.clearAllProxies(); } catch { /* ignore */ }
        }
        simulatorMap.set(id, shim);
      } else if (isStm32BoardKind(boardKind)) {
        const bridge = new Stm32Bridge(id, boardKind);
        // Onboard-LED pin + polarity per board kind. Blue/Black Pill drive PC13
        // active-LOW; the F4 Discovery / Olimex / Netduino boards drive their LED
        // active-HIGH on a different port pin (see STM32_LED).
        const ledCfg = STM32_LED[boardKind] ?? { pin: 'PC13', activeLow: true };
        const ledLinear = stm32PinNameToLinear(ledCfg.pin);
        bridge.onSerialData = serialCallback;
        bridge.onPinChange = (gpioPin, state) => {
          const boardPm = pinManagerMap.get(id);
          if (boardPm) boardPm.triggerPinChange(gpioPin, state, 'mcu');
          if (gpioPin === ledLinear) {
            const dom = document.getElementById(id) as (HTMLElement & { led?: boolean }) | null;
            if (dom && 'led' in dom) dom.led = ledCfg.activeLow ? !state : !!state;
          }
        };
        bridge.onPinChangeWithTime = getOscilloscopeCallback(id);
        bridge.onDisconnected = () => {
          set((s) => {
            const boards = s.boards.map((b) => (b.id === id ? { ...b, running: false } : b));
            const isActive = s.activeBoardId === id;
            return { boards, ...(isActive ? { running: false } : {}) };
          });
        };
        stm32BridgeMap.set(id, bridge);
        // Shim so PartSimulationRegistry parts (I2C displays, sensors, SPI
        // panels) attach to this STM32 the same way they do on ESP32.
        simulatorMap.set(id, new Stm32BridgeShim(bridge, pm));
      } else {
        const sim = createSimulator(
          boardKind,
          pm,
          serialCallback,
          (baud) => {
            set((s) => {
              const boards = s.boards.map((b) =>
                b.id === id ? { ...b, serialBaudRate: baud } : b,
              );
              const isActive = s.activeBoardId === id;
              return { boards, ...(isActive ? { serialBaudRate: baud } : {}) };
            });
          },
          getOscilloscopeCallback(id),
        );
        // Cross-board routing now handled by Interconnect (see bind below).
        simulatorMap.set(id, sim);

        // ── Pico W: attach the CYW43 chip-side emulator + WS bridge ──
        // Mirrors the ESP32 path (esp32BridgeMap) so the board has the
        // same capability surface the rest of the app already understands.
        if (boardKind === 'pi-pico-w' && sim instanceof RP2040Simulator) {
          const bridge = new Cyw43Bridge(id);
          bridge.onWifiStatus = (ws) => {
            set((s) => ({
              boards: s.boards.map((b) => (b.id === id ? { ...b, wifiStatus: ws } : b)),
            }));
          };
          cyw43BridgeMap.set(id, bridge);
          sim.attachCyw43(bridge);
        }
      }

      const newBoard: BoardInstance = {
        id,
        boardKind,
        x,
        y,
        running: false,
        compiledProgram: null,
        serialOutput: '',
        serialBaudRate: 0,
        serialMonitorOpen: false,
        activeFileGroupId: `group-${id}`,
        languageMode: 'arduino',
      };

      set((s) => {
        // If there's no current active board (or the stored id doesn't point
        // to one that exists), promote the new board to active. Without this,
        // an agent that does add_board → compile_sketch fails on step 2 with
        // "no active board on the canvas" and has to spend a turn on
        // set_active_board. Manual placements via the UI already auto-active
        // through the picker; this just closes the API gap.
        const stillExists = s.boards.some((b) => b.id === s.activeBoardId);
        const nextActive = stillExists ? s.activeBoardId : id;
        return { boards: [...s.boards, newBoard], activeBoardId: nextActive };
      });
      // Create the editor file group for this board
      useEditorStore.getState().createFileGroup(`group-${id}`);
      // Init VFS for Raspberry Pi 3 boards
      if (isPiBoardKind(boardKind)) {
        useVfsStore.getState().initBoardVfs(id);
      }
      // ── Interconnect: register the board and rebuild routes ──────────
      icBindBoard(id, boardKind);
      icUpdateWires(get().wires);
      return id;
    },

    removeBoard: (boardId: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      getBoardSimulator(boardId)?.stop();
      simulatorMap.delete(boardId);
      pinManagerMap.delete(boardId);
      signalRouterMap.delete(boardId);
      const bridge = getBoardBridge(boardId);
      if (bridge) {
        bridge.disconnect();
        bridgeMap.delete(boardId);
      }
      const esp32Bridge = getEsp32Bridge(boardId);
      if (esp32Bridge) {
        esp32Bridge.disconnect();
        esp32BridgeMap.delete(boardId);
      }
      const stm32Bridge = getStm32Bridge(boardId);
      if (stm32Bridge) {
        stm32Bridge.disconnect();
        stm32BridgeMap.delete(boardId);
      }
      const cyw43Bridge = getCyw43Bridge(boardId);
      if (cyw43Bridge) {
        cyw43Bridge.disconnect();
        cyw43BridgeMap.delete(boardId);
      }
      const cyw43Sim = getBoardSimulator(boardId);
      if (cyw43Sim instanceof RP2040Simulator) cyw43Sim.detachCyw43();
      set((s) => {
        const boards = s.boards.filter((b) => b.id !== boardId);
        const activeBoardId =
          s.activeBoardId === boardId ? (boards[0]?.id ?? null) : s.activeBoardId;
        // Remove wires connected to this board
        const wires = s.wires.filter(
          (w) => w.start.componentId !== boardId && w.end.componentId !== boardId,
        );
        // Reconcile the flat `running` mirror. This flag tracks the ACTIVE
        // board's run state (see startBoard/stopBoard/setActiveBoardId's
        // `isActive` sync). Removing the active board reassigns
        // `activeBoardId` above, but used to leave `running` stale — so
        // deleting the running/active board left the UI stuck in a fake
        // "running" state, and SimulatorCanvas's auto-start effect (which
        // treats `running` as a master switch for remote boards) then spun
        // a sibling board up. Re-derive it from whatever board is active
        // now (false if none remain).
        const nextActive = activeBoardId
          ? boards.find((b) => b.id === activeBoardId) ?? null
          : null;
        const running = nextActive ? nextActive.running : false;
        return { boards, activeBoardId, wires, running };
      });
      // Clean up file group in editor store
      if (board) {
        useEditorStore.getState().deleteFileGroup(board.activeFileGroupId);
      }
      // ── Interconnect: drop board and rebuild routes ──────────────────
      icUnbindBoard(boardId);
      icUpdateWires(get().wires);
    },

    updateBoard: (boardId: string, updates: Partial<BoardInstance>) => {
      set((s) => ({
        boards: s.boards.map((b) => (b.id === boardId ? { ...b, ...updates } : b)),
      }));
    },

    loadProjectState: (payload) => {
      const { stopSimulation, removeBoard, addBoard, setComponents, setWires,
        setActiveBoardId, recalculateAllWirePositions } = get();
      // Tear down current state
      if (get().running) stopSimulation();
      const oldIds = get().boards.map((b) => b.id);
      oldIds.forEach((id) => removeBoard(id));

      // Recreate boards with their saved ids so wire endpoints (which embed
      // the literal board id) keep matching.
      payload.boards.forEach((b) => {
        addBoard(b.boardKind, b.x, b.y, b.id);
        // Apply the rest of the saved fields that addBoard doesn't set.
        const patch: Partial<BoardInstance> = {};
        if (b.languageMode && b.languageMode !== 'arduino') patch.languageMode = b.languageMode;
        if (b.name && b.name.trim()) patch.name = b.name;
        // P2.4 — restore per-board persisted fields that ride in boards_json.
        if (b.boardOptions) patch.boardOptions = b.boardOptions;
        if (b.spiffsFiles) patch.spiffsFiles = b.spiffsFiles;
        if (b.libraries && b.libraries.length) patch.libraries = b.libraries;
        if (Object.keys(patch).length > 0) {
          set((s) => ({
            boards: s.boards.map((bb) => (bb.id === b.id ? { ...bb, ...patch } : bb)),
          }));
        }
      });

      // Replace editor file groups atomically. Skip groups that already exist
      // (createFileGroup is a no-op for existing ids) — overwrite their files.
      useEditorStore.getState().replaceFileGroups(payload.fileGroups);

      // Components and wires
      setComponents(payload.components);
      setWires(payload.wires);

      // Active board: prefer the saved one, fall back to the first.
      const targetActive = payload.activeBoardId &&
        get().boards.find((b) => b.id === payload.activeBoardId)
        ? payload.activeBoardId
        : (get().boards[0]?.id ?? null);
      if (targetActive) setActiveBoardId(targetActive);

      // Wires need a frame for the wokwi-elements to mount in the DOM before
      // pinPositionCalculator can resolve their pinInfo.
      requestAnimationFrame(() => {
        recalculateAllWirePositions();
        icUpdateWires(get().wires);
      });
    },

    setBoardPosition: (pos: { x: number; y: number }, boardId?: string) => {
      const id = boardId ?? get().activeBoardId ?? INITIAL_BOARD_ID;
      set((s) => ({
        boardPosition: s.activeBoardId === id ? pos : s.boardPosition,
        boards: s.boards.map((b) => (b.id === id ? { ...b, x: pos.x, y: pos.y } : b)),
      }));
    },

    setActiveBoardId: (boardId: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;
      set({
        activeBoardId: boardId,
        // Sync legacy flat fields to this board's values
        boardType: (isPiBoardKind(board.boardKind)
          ? 'arduino-uno'
          : board.boardKind) as BoardType,
        boardPosition: { x: board.x, y: board.y },
        simulator: simulatorMap.get(boardId) ?? null,
        pinManager: pinManagerMap.get(boardId) ?? legacyPinManager,
        running: board.running,
        compiledHex: board.compiledProgram,
        serialOutput: board.serialOutput,
        serialBaudRate: board.serialBaudRate,
        serialMonitorOpen: board.serialMonitorOpen,
        remoteConnected:
          bridgeMap.get(boardId)?.connected ?? esp32BridgeMap.get(boardId)?.connected ?? false,
        remoteSocket: null,
      });
      // Switch the editor to this board's file group
      useEditorStore.getState().setActiveGroup(board.activeFileGroupId);
    },

    compileBoardProgram: (boardId: string, program: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) {
        console.warn(`[compileBoardProgram] board not found: ${boardId}`);
        return;
      }
      console.log(`[compileBoardProgram] ${boardId} kind=${board.boardKind} programLen=${program?.length ?? 0}`);

      if (isEsp32Kind(board.boardKind)) {
        // All ESP32 boards (Xtensa + RISC-V C3): send firmware to QEMU via bridge.
        // Note: isEsp32Kind() includes C3 boards, so they route through Esp32Bridge
        // for full WiFi/BLE emulation via qemu-system-riscv32.
        const esp32Bridge = getEsp32Bridge(boardId);
        if (esp32Bridge) esp32Bridge.loadFirmware(program);
      } else if (isStm32BoardKind(board.boardKind)) {
        // STM32: send the compiled .elf (base64) to QEMU via the bridge.
        getStm32Bridge(boardId)?.loadFirmware(program);
      } else if (isRiscVEsp32Kind(board.boardKind)) {
        // Fallback: browser-only RV32IMC emulation (no WiFi/BLE support).
        // Currently unreachable because isEsp32Kind() above includes C3 boards.
        const sim = getBoardSimulator(boardId);
        if (sim instanceof Esp32C3Simulator) {
          try {
            sim.loadFlashImage(program);
          } catch (err) {
            console.error(`[Esp32C3Simulator] loadFlashImage failed for ${boardId}:`, err);
            return;
          }
        }
      } else {
        const sim = getBoardSimulator(boardId);
        if (sim && !isPiBoardKind(board.boardKind)) {
          try {
            if (sim instanceof AVRSimulator) {
              sim.loadHex(program);
              sim.addI2CDevice(new VirtualDS1307());
              sim.addI2CDevice(new VirtualTempSensor());
              sim.addI2CDevice(new I2CMemoryDevice(0x50));
            } else if (sim instanceof RP2040Simulator) {
              sim.loadBinary(program);
              sim.addI2CDevice(new VirtualDS1307() as RP2040I2CDevice);
              sim.addI2CDevice(new VirtualTempSensor() as RP2040I2CDevice);
              sim.addI2CDevice(new I2CMemoryDevice(0x50) as RP2040I2CDevice);
            }
          } catch (err) {
            console.error(`compileBoardProgram(${boardId}):`, err);
            return;
          }
        }
      }

      set((s) => {
        const boards = s.boards.map((b) =>
          b.id === boardId ? { ...b, compiledProgram: program } : b,
        );
        const isActive = s.activeBoardId === boardId;
        return {
          boards,
          ...(isActive ? { compiledHex: program, hexEpoch: s.hexEpoch + 1 } : {}),
        };
      });
    },

    loadMicroPythonProgram: async (
      boardId: string,
      files: Array<{ name: string; content: string }>,
    ) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;
      if (!BOARD_SUPPORTS_MICROPYTHON.has(board.boardKind)) return;

      if (isEsp32Kind(board.boardKind)) {
        // ESP32 path: load MicroPython firmware via QEMU bridge, inject code via raw-paste REPL
        const { getEsp32Firmware, padToFlashSize, uint8ArrayToBase64 } =
          await import('../simulation/Esp32MicroPythonLoader');
        const esp32Bridge = getEsp32Bridge(boardId);
        if (!esp32Bridge) return;

        const firmware = await getEsp32Firmware(board.boardKind);
        const b64 = uint8ArrayToBase64(padToFlashSize(firmware, board.boardKind));
        esp32Bridge.loadFirmware(b64);

        // Queue code injection for after REPL boots. Multi-file projects:
        // every .py file other than the entry point gets materialized to the
        // MicroPython filesystem (via a prelude executed inside the same raw
        // REPL paste) before main.py runs, so `import mylib` resolves.
        // Without this, ESP32 projects with helper modules crashed at runtime
        // with ModuleNotFoundError.
        const mainFile = files.find((f) => f.name === 'main.py') ?? files[0];
        if (mainFile) {
          const auxFiles = files.filter(
            (f) => f !== mainFile && f.name.endsWith('.py'),
          );
          const preludeLines = auxFiles.map((f) => {
            // JSON.stringify produces an ASCII-safe Python-compatible
            // string literal (both languages share the same \n \r \t \" \\
            // escapes, and JSON does not emit any escape Python rejects).
            const lit = JSON.stringify(f.content);
            const path = JSON.stringify(f.name);
            return `with open(${path},'w') as _f:\n    _f.write(${lit})`;
          });

          // WiFi compat shim: replace `network`, `ntptime`, `urequests`
          // with smart stubs BEFORE user main.py imports them. The
          // picsimlab QEMU fork's esp32_wifi NIC emulation is sufficient
          // for Arduino's lightweight WiFi.h but not for MicroPython's
          // full esp_wifi_init path — calling `network.WLAN(STA_IF)`
          // hangs forever waiting for peripheral status bits QEMU never
          // sets, tripping the FreeRTOS task watchdog after ~26s.
          //
          // Smart stub behaviour (so examples like smart-ui-eyes WORK
          // end-to-end, not just degrade gracefully):
          //   wlan.isconnected() → True after first 2 calls (simulates
          //                        ~1 second connection)
          //   wlan.ifconfig() → plausible LAN IPs
          //   ntptime.settime() → sets machine.RTC to host's current
          //                       UTC so localtime() returns real time
          //   urequests.get(url) → returns a Response stub whose .json()
          //                        decodes a stubbed payload (weather
          //                        for openweathermap URLs, generic {}
          //                        otherwise). Backed by client-side
          //                        fixtures so the example screens show
          //                        useful data instead of "API Error".
          const now = new Date();
          const fakeWeatherCity = 'Simulator City';
          const wifiStub = [
            'import sys',
            'import json as _json',
            'try:',
            '    import machine as _machine',
            'except ImportError:',
            '    _machine = None',
            '',
            'class _StubWLAN:',
            '    def __init__(self, *a, **k):',
            '        self._calls = 0',
            '    def active(self, on=None): return True',
            '    def connect(self, ssid=None, pwd=None): pass',
            '    def disconnect(self): pass',
            '    def isconnected(self):',
            '        self._calls += 1',
            '        return self._calls > 2',
            '    def ifconfig(self, c=None): return ("10.0.2.15", "255.255.255.0", "10.0.2.2", "10.0.2.3")',
            '    def config(self, *a, **k): return b"velxio"',
            '    def status(self, *a): return 1010',
            '    def scan(self): return []',
            'class _StubNetwork:',
            '    STA_IF = 0',
            '    AP_IF = 1',
            '    WLAN = _StubWLAN',
            'sys.modules["network"] = _StubNetwork()',
            '',
            '# ntptime: pre-load RTC with host UTC so localtime() works.',
            `_VLX_BOOT_UTC = (${now.getUTCFullYear()}, ${now.getUTCMonth() + 1}, ${now.getUTCDate()}, ${now.getUTCDay() || 7}, ${now.getUTCHours()}, ${now.getUTCMinutes()}, ${now.getUTCSeconds()}, 0)`,
            'class _StubNTP:',
            '    host = "pool.ntp.org"',
            '    timeout = 1',
            '    @staticmethod',
            '    def settime():',
            '        if _machine is not None:',
            '            try: _machine.RTC().datetime(_VLX_BOOT_UTC)',
            '            except Exception: pass',
            '    @staticmethod',
            '    def time(): return 0',
            'sys.modules["ntptime"] = _StubNTP()',
            '',
            '# urequests: fake responses so examples that call HTTP APIs',
            '# show real-looking data on the OLED instead of "API Error".',
            `_VLX_WEATHER = {"main": {"temp": 22.5, "humidity": 58, "pressure": 1013}, "weather": [{"main": "Clouds", "description": "partly cloudy"}], "name": "${fakeWeatherCity}", "wind": {"speed": 3.4}}`,
            'class _StubResponse:',
            '    def __init__(self, payload):',
            '        self._payload = payload',
            '        self.status_code = 200',
            '        self.text = _json.dumps(payload)',
            '        self.content = self.text.encode()',
            '    def json(self): return self._payload',
            '    def close(self): pass',
            '    def __enter__(self): return self',
            '    def __exit__(self, *a): pass',
            'class _StubURequests:',
            '    @staticmethod',
            '    def _route(url):',
            '        u = url.lower()',
            '        if "openweathermap" in u or "weather" in u: return _VLX_WEATHER',
            '        if "ipify" in u or "myip" in u: return {"ip": "10.0.2.15"}',
            '        if "worldtimeapi" in u: return {"datetime": "2026-05-25T00:00:00+00:00"}',
            '        return {}',
            '    @staticmethod',
            '    def get(url, *a, **k): return _StubResponse(_StubURequests._route(url))',
            '    @staticmethod',
            '    def post(url, *a, **k): return _StubResponse({"ok": True})',
            '    @staticmethod',
            '    def head(url, *a, **k): return _StubResponse({})',
            'sys.modules["urequests"] = _StubURequests()',
            'sys.modules["requests"] = _StubURequests()',
          ].join('\n');

          const prelude = wifiStub + '\n' +
            (preludeLines.length ? preludeLines.join('\n') + '\n' : '');
          esp32Bridge.setPendingMicroPythonCode(prelude + mainFile.content);
        }
      } else {
        // RP2040 path: load firmware + filesystem in browser
        const sim = getBoardSimulator(boardId);
        if (!(sim instanceof RP2040Simulator)) return;
        await sim.loadMicroPython(files);
      }

      set((s) => {
        const boards = s.boards.map((b) =>
          b.id === boardId ? { ...b, compiledProgram: 'micropython-loaded' } : b,
        );
        const isActive = s.activeBoardId === boardId;
        return {
          boards,
          ...(isActive ? { compiledHex: 'micropython-loaded', hexEpoch: s.hexEpoch + 1 } : {}),
        };
      });
    },

    setBoardLanguageMode: (boardId: string, mode: LanguageMode) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;

      // Only allow MicroPython for supported boards
      if (mode === 'micropython' && !BOARD_SUPPORTS_MICROPYTHON.has(board.boardKind)) return;

      // Stop any running simulation
      if (board.running) get().stopBoard(boardId);

      // Clear compiled program since language changed
      set((s) => ({
        boards: s.boards.map((b) =>
          b.id === boardId ? { ...b, languageMode: mode, compiledProgram: null } : b,
        ),
      }));

      // Replace file group with appropriate default files and activate it
      const editorStore = useEditorStore.getState();
      editorStore.deleteFileGroup(board.activeFileGroupId);
      editorStore.createFileGroup(board.activeFileGroupId, mode);
      editorStore.setActiveGroup(board.activeFileGroupId);
    },

    startBoard: (boardId: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;

      // Pro gate (run backstop): catches STM32/Pi boards that entered the
      // canvas via an example or a loaded project (which bypass the picker's
      // add gate). Non-paid web users get the upgrade prompt instead of a run.
      if (boardGateDecision(board.boardKind) === 'block') {
        triggerProUpgradePrompt(proBoardFeatureName(board.boardKind));
        return;
      }

      if (isPiBoardKind(board.boardKind)) {
        getBoardBridge(boardId)?.connect();
      } else if (isEsp32Kind(board.boardKind)) {
        // Pre-register sensors connected to this board so the QEMU worker
        // has them ready before the firmware starts executing.
        const esp32Bridge = getEsp32Bridge(boardId);
        if (esp32Bridge) {
          const { components, wires } = get();
          const sensors: Array<Record<string, unknown>> = [];
          for (const comp of components) {
            const sensorDef = SENSOR_COMPONENT_MAP[comp.metadataId];
            if (!sensorDef) continue;
            // Find the wire connecting this component's data pin to the board
            for (const w of wires) {
              const compEndpoint =
                w.start.componentId === comp.id && w.start.pinName === sensorDef.dataPinName
                  ? w.start
                  : w.end.componentId === comp.id && w.end.pinName === sensorDef.dataPinName
                    ? w.end
                    : null;
              if (!compEndpoint) continue;
              const boardEndpoint = compEndpoint === w.start ? w.end : w.start;
              if (!isBoardComponent(boardEndpoint.componentId)) continue;
              // Resolve GPIO pin number
              const gpioPin = boardPinToNumber(board.boardKind, boardEndpoint.pinName);
              if (gpioPin === null || gpioPin < 0) continue;
              // Collect sensor properties from the component
              const props: Record<string, unknown> = {
                sensor_type: sensorDef.sensorType,
                pin: gpioPin,
              };
              for (const key of sensorDef.propertyKeys) {
                const val = comp.properties[key];
                if (val !== undefined) props[key] = typeof val === 'string' ? parseFloat(val) : val;
              }
              // Resolve extra pins (e.g. echo_pin for HC-SR04) from wires
              if (sensorDef.extraPins) {
                for (const [propName, compPinName] of Object.entries(sensorDef.extraPins)) {
                  for (const ew of wires) {
                    const epComp =
                      ew.start.componentId === comp.id && ew.start.pinName === compPinName
                        ? ew.start
                        : ew.end.componentId === comp.id && ew.end.pinName === compPinName
                          ? ew.end
                          : null;
                    if (!epComp) continue;
                    const epBoard = epComp === ew.start ? ew.end : ew.start;
                    if (!isBoardComponent(epBoard.componentId)) continue;
                    const extraGpio = boardPinToNumber(board.boardKind, epBoard.pinName);
                    if (extraGpio !== null && extraGpio >= 0) {
                      props[propName] = extraGpio;
                    }
                    break;
                  }
                }
              }
              sensors.push(props);
              break; // only one data pin per sensor
            }
          }

          // Pre-register I2C sensors (virtual pin = 200 + i2c_addr, no wire resolution needed)
          for (const comp of components) {
            const i2cDef = I2C_SENSOR_MAP[comp.metadataId];
            if (!i2cDef) continue;
            // Resolve I2C address from component property or use default
            let addr = i2cDef.defaultAddr;
            if (i2cDef.addrProp) {
              const rawAddr = comp.properties[i2cDef.addrProp];
              if (rawAddr !== undefined) {
                if (i2cDef.addrIsBool) {
                  // Boolean flag (e.g. AD0 on MPU-6050): truthy → high address
                  if (rawAddr === true || rawAddr === 'true' || rawAddr === '1') {
                    addr = i2cDef.addrBoolHigh ?? i2cDef.defaultAddr;
                  }
                } else {
                  const parsed =
                    typeof rawAddr === 'string'
                      ? rawAddr.startsWith('0x')
                        ? parseInt(rawAddr, 16)
                        : parseInt(rawAddr, 10)
                      : Number(rawAddr);
                  if (!isNaN(parsed)) addr = parsed;
                }
              }
            }
            const virtualPin = 200 + addr;
            const props: Record<string, unknown> = {
              sensor_type: i2cDef.sensorType,
              pin: virtualPin,
              addr,
            };
            for (const key of i2cDef.propertyKeys ?? []) {
              const val = comp.properties[key];
              if (val !== undefined) props[key] = typeof val === 'string' ? parseFloat(val) : val;
            }
            sensors.push(props);
          }

          esp32Bridge.setSensors(sensors);

          // Use WiFi flag set by the compiler (most reliable — avoids stale file group issues).
          // Fall back to scanning the active file group if the flag hasn't been set yet.
          let hasWifi = board.hasWifi;
          if (hasWifi === undefined) {
            const editorState = useEditorStore.getState();
            const rawFiles = editorState.fileGroups[board.activeFileGroupId];
            const boardFiles = rawFiles && rawFiles.length > 0 ? rawFiles : editorState.files;
            hasWifi = boardFiles.some(
              (f) =>
                f.content.includes('#include <WiFi.h>') ||
                f.content.includes('#include <esp_wifi.h>') ||
                f.content.includes('#include "WiFi.h"') ||
                f.content.includes('WiFi.begin(') ||
                // MicroPython patterns — without these the WiFi NIC is never
                // passed to QEMU, and `network.WLAN(STA_IF)` hangs forever
                // trying to init a peripheral that doesn't exist, eventually
                // tripping the FreeRTOS task watchdog (TG1WDT_SYS_RESET).
                /import\s+network\b/.test(f.content) ||
                /network\.WLAN/.test(f.content),
            );
          }
          esp32Bridge.wifiEnabled = hasWifi;

          // microSD — if a card is on the canvas, build a FAT16 image (project
          // files, plus any paid binary uploads stored on the part) and hand
          // it to the bridge so the QEMU worker can attach it as an SD-over-SPI
          // slave. No card -> clear any stale image from a previous run.
          const sdCard = components.find((c) => c.metadataId === 'microsd-card');
          if (sdCard) {
            try {
              const uploaded = decodeSdFiles(sdCard.properties.sdFiles);
              const image = buildProjectSdImage(useEditorStore.getState().files, uploaded);
              esp32Bridge.sdImageB64 = bytesToB64(image);
            } catch (e) {
              console.warn('[microsd] SD image build failed:', e);
              esp32Bridge.sdImageB64 = undefined;
            }
          } else {
            esp32Bridge.sdImageB64 = undefined;
          }

          // Ensure firmware is loaded into the bridge (handles page-refresh case
          // where _pendingFirmware is lost but compiledProgram is still in store).
          if (!esp32Bridge.hasFirmware() && board.compiledProgram) {
            esp32Bridge.loadFirmware(board.compiledProgram);
          }

          esp32Bridge.connect();
        }
      } else if (isStm32BoardKind(board.boardKind)) {
        const stm32Bridge = getStm32Bridge(boardId);
        if (stm32Bridge) {
          // Pre-register I2C devices (BMP280, MPU6050, SSD1306, …) so the QEMU
          // worker builds each slave on the bus BEFORE the firmware's Wire
          // master starts probing. Address-based — no wire resolution needed
          // (virtual pin = 200 + i2c_addr). Mirrors the ESP32 path.
          const { components } = get();
          const sensors: Array<Record<string, unknown>> = [];
          for (const comp of components) {
            const i2cDef = I2C_SENSOR_MAP[comp.metadataId];
            if (!i2cDef) continue;
            let addr = i2cDef.defaultAddr;
            if (i2cDef.addrProp) {
              const rawAddr = comp.properties[i2cDef.addrProp];
              if (rawAddr !== undefined) {
                if (i2cDef.addrIsBool) {
                  if (rawAddr === true || rawAddr === 'true' || rawAddr === '1') {
                    addr = i2cDef.addrBoolHigh ?? i2cDef.defaultAddr;
                  }
                } else {
                  const parsed =
                    typeof rawAddr === 'string'
                      ? rawAddr.startsWith('0x')
                        ? parseInt(rawAddr, 16)
                        : parseInt(rawAddr, 10)
                      : Number(rawAddr);
                  if (!isNaN(parsed)) addr = parsed;
                }
              }
            }
            const props: Record<string, unknown> = {
              sensor_type: i2cDef.sensorType,
              pin: 200 + addr,
              addr,
            };
            for (const key of i2cDef.propertyKeys ?? []) {
              const val = comp.properties[key];
              if (val !== undefined) props[key] = typeof val === 'string' ? parseFloat(val) : val;
            }
            sensors.push(props);
          }
          stm32Bridge.setSensors(sensors);

          if (!stm32Bridge.hasFirmware() && board.compiledProgram) {
            stm32Bridge.loadFirmware(board.compiledProgram);
          }
          stm32Bridge.connect();
        }
      } else {
        getBoardSimulator(boardId)?.start();
        // Pico W: open the network bridge here too, alongside the local
        // RP2040 sim. Auto-detect WiFi from the board's source files.
        if (board.boardKind === 'pi-pico-w') {
          const cyw43 = getCyw43Bridge(boardId);
          if (cyw43) {
            const editorState = useEditorStore.getState();
            const rawFiles = editorState.fileGroups[board.activeFileGroupId];
            const boardFiles =
              rawFiles && rawFiles.length > 0 ? rawFiles : editorState.files;
            const hasWifi = boardFiles.some(
              (f) =>
                /import\s+network\b/.test(f.content) ||
                /network\.WLAN/.test(f.content) ||
                /#include\s*[<"]WiFi\.h[>"]/.test(f.content) ||
                /WiFi\.begin\(/.test(f.content),
            );
            cyw43.wifiEnabled = hasWifi;
            cyw43.connect();
          }
        }
      }

      set((s) => {
        const boards = s.boards.map((b) =>
          b.id === boardId ? { ...b, running: true, serialMonitorOpen: true } : b,
        );
        const isActive = s.activeBoardId === boardId;
        return { boards, ...(isActive ? { running: true, serialMonitorOpen: true } : {}) };
      });
    },

    stopBoard: (boardId: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;

      if (isPiBoardKind(board.boardKind)) {
        getBoardBridge(boardId)?.disconnect();
      } else if (isEsp32Kind(board.boardKind)) {
        getEsp32Bridge(boardId)?.disconnect();
      } else if (isStm32BoardKind(board.boardKind)) {
        getStm32Bridge(boardId)?.disconnect();
      } else {
        // Stop is "cut power": pressing Run again must boot from setup()
        // not resume mid-loop, so reset the CPU to PC=0 here. Without
        // this the AVR keeps its program counter and the next Run picks
        // up wherever it left off — which is fine for Pause but wrong
        // for the physical Stop button users expect.
        getBoardSimulator(boardId)?.reset();
      }

      // Hard reset: clear cached pin states AND notify listeners so
      // multiplexed displays (7-segment, LED matrix, NeoPixel) clear
      // the frozen frame they were holding when power was cut, instead
      // of carrying it into the next run.
      getBoardPinManager(boardId)?.hardResetPinStates();

      set((s) => {
        const boards = s.boards.map((b) => (b.id === boardId ? { ...b, running: false } : b));
        const isActive = s.activeBoardId === boardId;
        return { boards, ...(isActive ? { running: false } : {}) };
      });
    },

    resetBoard: (boardId: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;

      if (isEsp32Kind(board.boardKind)) {
        // Reset ESP32: disconnect then reconnect the QEMU bridge
        const esp32Bridge = getEsp32Bridge(boardId);
        if (esp32Bridge?.connected) {
          esp32Bridge.disconnect();
          setTimeout(() => esp32Bridge.connect(), 500);
        }
      } else if (!isPiBoardKind(board.boardKind)) {
        const sim = getBoardSimulator(boardId);
        if (sim) {
          sim.reset();
          // Hard reboot: CPU back to PC=0, every pin floats, every
          // output classification dropped, and listeners notified so
          // visual components (7-segment, NeoPixel, LCD) clear their
          // stale frame instead of freezing on whatever was lit.
          // Same semantics as Stop — both behave like cutting power.
          getBoardPinManager(boardId)?.hardResetPinStates();
          // NOTE: do NOT reassign sim.onSerialData here. sim.reset()
          // recreates the USART but the new usart.onByteTransmit
          // already chains through `this.onSerialData`, which is the
          // wrapper Interconnect installed for cross-board UART. The
          // previous "re-wire" line was destroying that wrapper and
          // silently breaking sibling-board serial forwarding after
          // every Reset press.
          if (sim instanceof AVRSimulator) {
            sim.onBaudRateChange = (baud) => {
              set((s) => {
                const boards = s.boards.map((b) =>
                  b.id === boardId ? { ...b, serialBaudRate: baud } : b,
                );
                const isActive = s.activeBoardId === boardId;
                return { boards, ...(isActive ? { serialBaudRate: baud } : {}) };
              });
            };
          }
        }
      }

      set((s) => {
        const boards = s.boards.map((b) =>
          b.id === boardId ? { ...b, running: false, serialOutput: '', serialBaudRate: 0 } : b,
        );
        const isActive = s.activeBoardId === boardId;
        return {
          boards,
          ...(isActive ? { running: false, serialOutput: '', serialBaudRate: 0 } : {}),
        };
      });
    },

    // ── Legacy single-board API ───────────────────────────────────────────
    boardType: 'arduino-uno',
    boardPosition: { ...DEFAULT_BOARD_POSITION },
    simulator: initialSim,
    pinManager: legacyPinManager,
    running: false,
    compiledHex: null,
    hexEpoch: 0,
    serialOutput: '',
    serialBaudRate: 0,
    serialMonitorOpen: false,
    remoteConnected: false,
    remoteSocket: null,

    esp32CrashBoardId: null,
    dismissEsp32Crash: () => set({ esp32CrashBoardId: null }),

    setBoardType: (type: BoardType) => {
      const { activeBoardId, running, stopSimulation } = get();
      if (running) stopSimulation();

      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      const pm = getBoardPinManager(boardId) ?? legacyPinManager;

      // Stop and remove old simulator / bridge
      getBoardSimulator(boardId)?.stop();
      simulatorMap.delete(boardId);
      getEsp32Bridge(boardId)?.disconnect();
      esp32BridgeMap.delete(boardId);

      const serialCallback = (ch: string) => appendSerial(boardId, ch);

      if (isEsp32Kind(type as BoardKind)) {
        // ESP32: use bridge, not AVR simulator
        const bridge = new Esp32Bridge(boardId, type as BoardKind);
        bridge.onSerialData = serialCallback;
        bridge.onPinChange = (gpioPin, state) => {
          const boardPm = pinManagerMap.get(boardId);
          if (boardPm) boardPm.triggerPinChange(gpioPin, state, 'mcu');
          getOscilloscopeCallback(boardId)(gpioPin, state, performance.now());
        };
        bridge.onPinChangeWithTime = getOscilloscopeCallback(boardId);
        bridge.onCrash = () => {
          set({ esp32CrashBoardId: boardId });
        };
        bridge.onDisconnected = () => {
          set((s) => {
            const boards = s.boards.map((b) => (b.id === boardId ? { ...b, running: false } : b));
            const isActive = s.activeBoardId === boardId;
            return { boards, ...(isActive ? { running: false } : {}) };
          });
        };
        signalRouterMap.set(boardId, new SignalRouter());
        bridge.onLedcDuty = makeLedcDutyHandler(boardId);
        bridge.onGpioRouting = makeGpioRoutingHandler(boardId);
        bridge.onGpioRoutingClear = makeGpioRoutingClearHandler(boardId);
        bridge.onWs2812Update = (channel, pixels) => {
          const eventTarget = document.getElementById(`ws2812-${boardId}-${channel}`);
          if (eventTarget) {
            eventTarget.dispatchEvent(new CustomEvent('ws2812-pixels', { detail: { pixels } }));
          }
        };
        esp32BridgeMap.set(boardId, bridge);
        const shim = new Esp32BridgeShim(bridge, pm);
        shim.onSerialData = serialCallback;
        simulatorMap.set(boardId, shim);

        set((s) => ({
          boardType: type,
          simulator: shim as any,
          compiledHex: null,
          serialOutput: '',
          serialBaudRate: 0,
          boards: s.boards.map((b) =>
            b.id === boardId
              ? {
                  ...b,
                  boardKind: type as BoardKind,
                  compiledProgram: null,
                  serialOutput: '',
                  serialBaudRate: 0,
                }
              : b,
          ),
        }));
      } else {
        const sim = createSimulator(
          type as BoardKind,
          pm,
          serialCallback,
          (baud) =>
            set((s) => {
              const boards = s.boards.map((b) =>
                b.id === boardId ? { ...b, serialBaudRate: baud } : b,
              );
              const isActive = s.activeBoardId === boardId;
              return { boards, ...(isActive ? { serialBaudRate: baud } : {}) };
            }),
          getOscilloscopeCallback(boardId),
        );
        simulatorMap.set(boardId, sim);

        set((s) => ({
          boardType: type,
          simulator: sim,
          compiledHex: null,
          serialOutput: '',
          serialBaudRate: 0,
          boards: s.boards.map((b) =>
            b.id === boardId
              ? {
                  ...b,
                  boardKind: type as BoardKind,
                  compiledProgram: null,
                  serialOutput: '',
                  serialBaudRate: 0,
                }
              : b,
          ),
        }));
      }
      console.log(`Board switched to: ${type}`);
    },

    initSimulator: () => {
      const { boardType, activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      const pm = getBoardPinManager(boardId) ?? legacyPinManager;

      // Multi-board flows (addBoard, loadProjectState) already create
      // sims + register them in simulatorMap, AND Interconnect wraps
      // sim.onSerialData for cross-board UART forwarding. SimulatorCanvas
      // runs initSimulator() once on mount as a legacy single-board
      // "make sure a sim exists for the active board" helper. If we let
      // it through here when a sim ALREADY exists we wipe simulatorMap,
      // recreate the sim, and silently drop the Interconnect wrapper —
      // every cross-board wire stops forwarding bytes (Nano never sees
      // anything the Uno sends). Skip out early in that case.
      const existingSim = getBoardSimulator(boardId);
      if (existingSim) return;

      getEsp32Bridge(boardId)?.disconnect();
      esp32BridgeMap.delete(boardId);

      const serialCallback = (ch: string) => appendSerial(boardId, ch);

      if (isEsp32Kind(boardType as BoardKind)) {
        // ESP32: create bridge + shim (same as setBoardType)
        const bridge = new Esp32Bridge(boardId, boardType as BoardKind);
        bridge.onSerialData = serialCallback;
        bridge.onPinChange = (gpioPin, state) => {
          const boardPm = pinManagerMap.get(boardId);
          if (boardPm) boardPm.triggerPinChange(gpioPin, state, 'mcu');
          getOscilloscopeCallback(boardId)(gpioPin, state, performance.now());
        };
        bridge.onPinChangeWithTime = getOscilloscopeCallback(boardId);
        bridge.onCrash = () => {
          set({ esp32CrashBoardId: boardId });
        };
        bridge.onDisconnected = () => {
          set((s) => {
            const boards = s.boards.map((b) => (b.id === boardId ? { ...b, running: false } : b));
            const isActive = s.activeBoardId === boardId;
            return { boards, ...(isActive ? { running: false } : {}) };
          });
        };
        signalRouterMap.set(boardId, new SignalRouter());
        bridge.onLedcDuty = makeLedcDutyHandler(boardId);
        bridge.onGpioRouting = makeGpioRoutingHandler(boardId);
        bridge.onGpioRoutingClear = makeGpioRoutingClearHandler(boardId);
        bridge.onWs2812Update = (channel, pixels) => {
          const eventTarget = document.getElementById(`ws2812-${boardId}-${channel}`);
          if (eventTarget) {
            eventTarget.dispatchEvent(new CustomEvent('ws2812-pixels', { detail: { pixels } }));
          }
        };
        esp32BridgeMap.set(boardId, bridge);
        const shim = new Esp32BridgeShim(bridge, pm);
        shim.onSerialData = serialCallback;
        simulatorMap.set(boardId, shim);
        set({ simulator: shim as any, serialOutput: '', serialBaudRate: 0 });
      } else {
        const sim = createSimulator(
          boardType as BoardKind,
          pm,
          serialCallback,
          (baud) =>
            set((s) => {
              const boards = s.boards.map((b) =>
                b.id === boardId ? { ...b, serialBaudRate: baud } : b,
              );
              const isActive = s.activeBoardId === boardId;
              return { boards, ...(isActive ? { serialBaudRate: baud } : {}) };
            }),
          getOscilloscopeCallback(boardId),
        );
        simulatorMap.set(boardId, sim);
        set({ simulator: sim, serialOutput: '', serialBaudRate: 0 });
      }
      console.log(`Simulator initialized: ${boardType}`);
    },

    loadHex: (hex: string) => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      const sim = getBoardSimulator(boardId);
      if (sim && sim instanceof AVRSimulator) {
        try {
          sim.loadHex(hex);
          sim.addI2CDevice(new VirtualDS1307());
          sim.addI2CDevice(new VirtualTempSensor());
          sim.addI2CDevice(new I2CMemoryDevice(0x50));
          set((s) => ({ compiledHex: hex, hexEpoch: s.hexEpoch + 1 }));
          console.log('HEX file loaded successfully');
        } catch (error) {
          console.error('Failed to load HEX:', error);
        }
      } else {
        console.warn('loadHex: simulator not initialized or wrong board type');
      }
    },

    loadBinary: (base64: string) => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      const sim = getBoardSimulator(boardId);
      if (sim && sim instanceof RP2040Simulator) {
        try {
          sim.loadBinary(base64);
          sim.addI2CDevice(new VirtualDS1307() as RP2040I2CDevice);
          sim.addI2CDevice(new VirtualTempSensor() as RP2040I2CDevice);
          sim.addI2CDevice(new I2CMemoryDevice(0x50) as RP2040I2CDevice);
          set((s) => ({ compiledHex: base64, hexEpoch: s.hexEpoch + 1 }));
          console.log('Binary loaded into RP2040 successfully');
        } catch (error) {
          console.error('Failed to load binary:', error);
        }
      } else {
        console.warn('loadBinary: simulator not initialized or wrong board type');
      }
    },

    startSimulation: () => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      get().startBoard(boardId);
    },

    restartParts: () => set((s) => ({ hexEpoch: s.hexEpoch + 1 })),

    stopSimulation: () => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      get().stopBoard(boardId);
    },

    resetSimulation: () => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      get().resetBoard(boardId);
    },

    setCompiledHex: (hex: string) => {
      set({ compiledHex: hex });
      get().loadHex(hex);
    },

    setCompiledBinary: (base64: string) => {
      set({ compiledHex: base64 });
      get().loadBinary(base64);
    },

    setRunning: (running: boolean) => set({ running }),

    connectRemoteSimulator: (clientId: string) => {
      // Legacy: connect a Pi bridge for the given clientId
      const boardId = clientId;
      let bridge = getBoardBridge(boardId);
      if (!bridge) {
        bridge = new RaspberryPi3Bridge(boardId);
        bridge.onSerialData = (ch) => appendSerial(boardId, ch);
        bridge.onPinChange = (gpioPin, state) => {
          const { wires } = get();
          const sim = getBoardSimulator(get().activeBoardId ?? INITIAL_BOARD_ID);
          if (!sim) return;
          const wire = wires.find(
            (w) =>
              (w.start.componentId.includes('raspberry-pi') &&
                w.start.pinName === String(gpioPin)) ||
              (w.end.componentId.includes('raspberry-pi') && w.end.pinName === String(gpioPin)),
          );
          if (wire) {
            const isArduinoStart = !wire.start.componentId.includes('raspberry-pi');
            const targetEndpoint = isArduinoStart ? wire.start : wire.end;
            const pinNum = parseInt(targetEndpoint.pinName, 10);
            if (!isNaN(pinNum)) sim.setPinState(pinNum, state);
          }
        };
        bridgeMap.set(boardId, bridge);
      }
      bridge.connect();
      set({ remoteConnected: true });
    },

    disconnectRemoteSimulator: () => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      getBoardBridge(boardId)?.disconnect();
      set({ remoteConnected: false, remoteSocket: null });
    },

    sendRemotePinEvent: (pin: string, state: number) => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      getBoardBridge(boardId)?.sendPinEvent(parseInt(pin, 10), state === 1);
    },

    // ── Components ────────────────────────────────────────────────────────
    // Default canvas shown on a bare /editor visit: an external LED on
    // pin 13 PROTECTED BY A 220Ω SERIES RESISTOR (the canonical Blink
    // wiring textbooks teach). Without the resistor the LED is a direct
    // short forward-biased between 5V and GND — real hardware blows the
    // diode, and the ngspice solver returns an indeterminate / NaN branch
    // current so the visual LED never lights up on the canvas either.
    // NOTE: component ids must NOT contain hyphens. ngspice (WASM build)
    // truncates branch-current vector names at '-', so a sense source
    // named V_led-builtin_sense yields the wrong key in branchCurrents
    // and the LED's update() loop never sees the diode current — the
    // node voltage is correct (the user sees ~1.84V on the wire) but the
    // visual brightness stays at zero. Underscore is safe.
    components: [
      {
        id: 'led_builtin',
        metadataId: 'led',
        x: 380,
        y: 100,
        properties: { color: 'red' },
      },
      {
        id: 'r_builtin',
        metadataId: 'resistor',
        x: 240,
        y: 130,
        properties: { value: '220' },
      },
    ],

    wires: [
      // Pin 13 → resistor pin 1 (current-limiting side).
      {
        id: 'wire_builtin_pin13',
        start: { componentId: 'arduino-uno', pinName: '13', x: 0, y: 0 },
        end: { componentId: 'r_builtin', pinName: '1', x: 0, y: 0 },
        waypoints: [],
        color: '#22c55e',
      },
      // Resistor pin 2 → LED anode.
      {
        id: 'wire_builtin_anode',
        start: { componentId: 'r_builtin', pinName: '2', x: 0, y: 0 },
        end: { componentId: 'led_builtin', pinName: 'A', x: 0, y: 0 },
        waypoints: [],
        color: '#22c55e',
      },
      // LED cathode → GND.
      {
        id: 'wire_builtin_cathode',
        start: { componentId: 'led_builtin', pinName: 'C', x: 0, y: 0 },
        end: { componentId: 'arduino-uno', pinName: 'GND.1', x: 0, y: 0 },
        waypoints: [],
        color: '#000000',
      },
    ],
    selectedWireId: null,
    wireInProgress: null,

    addComponent: (component) => set((state) => ({ components: [...state.components, component] })),

    removeComponent: (id) =>
      set((state) => ({
        components: state.components.filter((c) => c.id !== id),
        wires: state.wires.filter((w) => w.start.componentId !== id && w.end.componentId !== id),
      })),

    updateComponent: (id, updates) => {
      set((state) => ({
        components: state.components.map((c) => (c.id === id ? { ...c, ...updates } : c)),
      }));
      // Re-stamp wire endpoints when the geometry of the component changes:
      // position (x/y) OR rotation. Without this, rotating a component
      // leaves every wire anchored to the pre-rotation pin positions, so
      // the part visually disconnects from its cables.
      const rotationChanged =
        updates.properties && 'rotation' in updates.properties;
      if (updates.x !== undefined || updates.y !== undefined || rotationChanged) {
        get().updateWirePositions(id);
      }
    },

    updateComponentState: (id, state) => {
      set((prevState) => ({
        components: prevState.components.map((c) =>
          c.id === id ? { ...c, properties: { ...c.properties, state, value: state } } : c,
        ),
      }));
    },

    handleComponentEvent: (_componentId, _eventName, _data) => {},

    setComponents: (components) => {
      // Bulk replacement (project load / clear) — any pending undo/redo
      // would point at component IDs that no longer exist after this.
      set({ components, history: [], historyIndex: -1 });
    },

    addWire: (wire) => set((state) => ({ wires: [...state.wires, wire] })),

    removeWire: (wireId) =>
      set((state) => ({
        wires: state.wires.filter((w) => w.id !== wireId),
        selectedWireId: state.selectedWireId === wireId ? null : state.selectedWireId,
      })),

    updateWire: (wireId, updates) =>
      set((state) => ({
        wires: state.wires.map((w) => (w.id === wireId ? { ...w, ...updates } : w)),
      })),

    setSelectedWire: (wireId) => set({ selectedWireId: wireId }),

    setWires: (wires) =>
      set({
        // Ensure every wire has waypoints (backwards-compatible with saved projects)
        wires: wires.map((w) => ({ waypoints: [], ...w })),
        // Bulk replacement clears history for the same reason as setComponents.
        history: [],
        historyIndex: -1,
      }),

    startWireCreation: (endpoint, color) =>
      set({
        wireInProgress: {
          startEndpoint: endpoint,
          waypoints: [],
          color,
          currentX: endpoint.x,
          currentY: endpoint.y,
        },
      }),

    updateWireInProgress: (x, y) =>
      set((state) => {
        if (!state.wireInProgress) return state;
        return { wireInProgress: { ...state.wireInProgress, currentX: x, currentY: y } };
      }),

    addWireWaypoint: (x, y) =>
      set((state) => {
        if (!state.wireInProgress) return state;
        return {
          wireInProgress: {
            ...state.wireInProgress,
            waypoints: [...state.wireInProgress.waypoints, { x, y }],
          },
        };
      }),

    setWireInProgressColor: (color) =>
      set((state) => {
        if (!state.wireInProgress) return state;
        return { wireInProgress: { ...state.wireInProgress, color } };
      }),

    finishWireCreation: (endpoint) => {
      const state = get();
      if (!state.wireInProgress) return;
      const { startEndpoint, waypoints, color } = state.wireInProgress;

      // Finish wire: auto-detect color from pin name
      const finalColor = color === DEFAULT_WIRE_COLOR ? autoWireColor(endpoint.pinName) : color;

      const newWire: Wire = {
        id: `wire-${Date.now()}`,
        start: startEndpoint,
        end: endpoint,
        waypoints,
        color: finalColor,
      };
      set((state) => ({ wires: [...state.wires, newWire], wireInProgress: null }));
    },

    cancelWireCreation: () => set({ wireInProgress: null }),

    updateWirePositions: (componentId) => {
      set((state) => {
        const component = state.components.find((c) => c.id === componentId);
        // Check if this componentId matches a board id
        const board = state.boards.find((b) => b.id === componentId);
        // Components have a DynamicComponent wrapper with border:2px +
        // padding:4px on EVERY side → inner element sits at (+6, +6)
        // from the wrapper top-left. Earlier code used (+4, +6) — the
        // 2 px X bias rotated visibly with the component and looked
        // like wires came off the pins when rotated. Boards are
        // rendered directly without that wrapper, so no offset.
        const compX = component ? component.x + 6 : board ? board.x : state.boardPosition.x;
        const compY = component ? component.y + 6 : board ? board.y : state.boardPosition.y;
        // Boards never rotate; components carry their angle in properties.rotation.
        const rotation = component ? Number(component.properties?.rotation) || 0 : 0;

        const updatedWires = state.wires.map((wire) => {
          const updated = { ...wire };
          if (wire.start.componentId === componentId) {
            const pos = calculatePinPosition(
              componentId, wire.start.pinName, compX, compY, rotation,
            );
            if (pos) updated.start = { ...wire.start, x: pos.x, y: pos.y };
          }
          if (wire.end.componentId === componentId) {
            const pos = calculatePinPosition(
              componentId, wire.end.pinName, compX, compY, rotation,
            );
            if (pos) updated.end = { ...wire.end, x: pos.x, y: pos.y };
          }
          return updated;
        });
        return { wires: updatedWires };
      });
    },

    recalculateAllWirePositions: () => {
      const state = get();
      const updatedWires = state.wires.map((wire) => {
        const updated = { ...wire };

        // Resolve start — components have wrapper offset (6,6) on
        // both axes (padding:4 + border:2). Boards have no wrapper.
        const startComp = state.components.find((c) => c.id === wire.start.componentId);
        const startBoard = state.boards.find((b) => b.id === wire.start.componentId);
        const startX = startComp
          ? startComp.x + 6
          : startBoard
            ? startBoard.x
            : state.boardPosition.x;
        const startY = startComp
          ? startComp.y + 6
          : startBoard
            ? startBoard.y
            : state.boardPosition.y;
        const startRotation = startComp ? Number(startComp.properties?.rotation) || 0 : 0;
        const startPos = calculatePinPosition(
          wire.start.componentId,
          wire.start.pinName,
          startX,
          startY,
          startRotation,
        );
        updated.start = startPos
          ? { ...wire.start, x: startPos.x, y: startPos.y }
          : { ...wire.start, x: startX, y: startY };

        // Resolve end — same (6,6) wrapper offset as start above.
        const endComp = state.components.find((c) => c.id === wire.end.componentId);
        const endBoard = state.boards.find((b) => b.id === wire.end.componentId);
        const endX = endComp ? endComp.x + 6 : endBoard ? endBoard.x : state.boardPosition.x;
        const endY = endComp ? endComp.y + 6 : endBoard ? endBoard.y : state.boardPosition.y;
        const endRotation = endComp ? Number(endComp.properties?.rotation) || 0 : 0;
        const endPos = calculatePinPosition(
          wire.end.componentId, wire.end.pinName, endX, endY, endRotation,
        );
        updated.end = endPos
          ? { ...wire.end, x: endPos.x, y: endPos.y }
          : { ...wire.end, x: endX, y: endY };

        return updated;
      });
      set({ wires: updatedWires });
    },

    // ── Undo/redo ──────────────────────────────────────────────────────────
    history: [],
    historyIndex: -1,

    pushCommand: (cmd, opts) => {
      const applyNow = opts?.applyNow ?? true;
      if (applyNow) cmd.execute();
      set((state) => {
        // Truncate the redo branch — once you push a new command, the
        // entries you'd previously redone are abandoned.
        const truncated = state.history.slice(0, state.historyIndex + 1);
        let next = [...truncated, cmd];
        let nextIdx = next.length - 1;
        // Cap at HISTORY_MAX. When over, drop the oldest entry and shift
        // the index down so it still points at the just-pushed command.
        if (next.length > HISTORY_MAX) {
          const overflow = next.length - HISTORY_MAX;
          next = next.slice(overflow);
          nextIdx = next.length - 1;
        }
        return { history: next, historyIndex: nextIdx };
      });
    },

    undo: () => {
      const state = get();
      if (state.historyIndex < 0) return;
      const cmd = state.history[state.historyIndex];
      try {
        cmd.undo();
      } catch (err) {
        // A failing undo would otherwise leave the index pointing at a
        // half-applied command. Bail out cleanly.
        // eslint-disable-next-line no-console
        console.error('[history] undo failed:', cmd.description, err);
        return;
      }
      set({ historyIndex: state.historyIndex - 1 });
    },

    redo: () => {
      const state = get();
      if (state.historyIndex >= state.history.length - 1) return;
      const cmd = state.history[state.historyIndex + 1];
      try {
        cmd.execute();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[history] redo failed:', cmd.description, err);
        return;
      }
      set({ historyIndex: state.historyIndex + 1 });
    },

    canUndo: () => get().historyIndex >= 0,
    canRedo: () => {
      const s = get();
      return s.historyIndex < s.history.length - 1;
    },

    clearHistory: () => set({ history: [], historyIndex: -1 }),

    // ── Recorded canvas actions ────────────────────────────────────────────
    // Each `record*` builds a CanvasCommand that captures both directions
    // and pushes it. Naming intent: the user has *committed* a change
    // (drag-end, click finalised, agent tool execute) — distinct from the
    // raw mutators above which can be called per-frame during a drag.

    recordAddComponent: (component) => {
      get().pushCommand({
        description: `Add ${component.metadataId}`,
        execute: () =>
          set((s) => ({ components: [...s.components, component] })),
        undo: () =>
          set((s) => ({
            components: s.components.filter((c) => c.id !== component.id),
            // Mirror the cascade in removeComponent so a redo→undo round
            // trip of an add-then-wired pair stays consistent.
            wires: s.wires.filter(
              (w) =>
                w.start.componentId !== component.id && w.end.componentId !== component.id,
            ),
          })),
      });
    },

    recordRemoveComponent: (id) => {
      const state = get();
      const removed = state.components.find((c) => c.id === id);
      if (!removed) return;
      // Capture wires that will be cascaded too — undo must restore both
      // the component AND its wires together.
      const removedWires = state.wires.filter(
        (w) => w.start.componentId === id || w.end.componentId === id,
      );
      get().pushCommand({
        description: `Remove ${removed.metadataId}`,
        execute: () =>
          set((s) => ({
            components: s.components.filter((c) => c.id !== id),
            wires: s.wires.filter(
              (w) => w.start.componentId !== id && w.end.componentId !== id,
            ),
          })),
        undo: () =>
          set((s) => ({
            components: [...s.components, removed],
            wires: [...s.wires, ...removedWires],
          })),
      });
    },

    recordMove: (id, from, to) => {
      // The state is already at `to` (caller mutated during drag). We push
      // applyNow:false so we don't redundantly re-apply on first push;
      // execute()/undo() are only invoked on future redo/undo.
      get().pushCommand(
        {
          description: 'Move component',
          execute: () => {
            set((s) => ({
              components: s.components.map((c) =>
                c.id === id ? { ...c, x: to.x, y: to.y } : c,
              ),
            }));
            get().updateWirePositions(id);
          },
          undo: () => {
            set((s) => ({
              components: s.components.map((c) =>
                c.id === id ? { ...c, x: from.x, y: from.y } : c,
              ),
            }));
            get().updateWirePositions(id);
          },
        },
        { applyNow: false },
      );
    },

    recordRotate: (id, prevRotation, nextRotation) => {
      get().pushCommand(
        {
          description: 'Rotate component',
          execute: () => {
            set((s) => ({
              components: s.components.map((c) =>
                c.id === id
                  ? { ...c, properties: { ...c.properties, rotation: nextRotation } }
                  : c,
              ),
            }));
            // Wires must follow the part on undo / redo too, otherwise a
            // Ctrl+Z after a rotate would re-show the post-rotation pin
            // positions against the now-restored unrotated component.
            get().updateWirePositions(id);
          },
          undo: () => {
            set((s) => ({
              components: s.components.map((c) =>
                c.id === id
                  ? { ...c, properties: { ...c.properties, rotation: prevRotation } }
                  : c,
              ),
            }));
            get().updateWirePositions(id);
          },
        },
        { applyNow: false },
      );
    },

    recordSetProperty: (id, key, prevValue, nextValue) => {
      get().pushCommand(
        {
          description: `Change ${key}`,
          execute: () =>
            set((s) => ({
              components: s.components.map((c) =>
                c.id === id
                  ? { ...c, properties: { ...c.properties, [key]: nextValue } }
                  : c,
              ),
            })),
          undo: () =>
            set((s) => ({
              components: s.components.map((c) =>
                c.id === id
                  ? { ...c, properties: { ...c.properties, [key]: prevValue } }
                  : c,
              ),
            })),
        },
        { applyNow: false },
      );
    },

    recordAddWire: (wire) => {
      get().pushCommand({
        description: 'Add wire',
        execute: () => set((s) => ({ wires: [...s.wires, wire] })),
        undo: () =>
          set((s) => ({
            wires: s.wires.filter((w) => w.id !== wire.id),
            selectedWireId: s.selectedWireId === wire.id ? null : s.selectedWireId,
          })),
      });
    },

    recordRemoveWire: (wireId) => {
      const removed = get().wires.find((w) => w.id === wireId);
      if (!removed) return;
      get().pushCommand({
        description: 'Remove wire',
        execute: () =>
          set((s) => ({
            wires: s.wires.filter((w) => w.id !== wireId),
            selectedWireId: s.selectedWireId === wireId ? null : s.selectedWireId,
          })),
        undo: () => set((s) => ({ wires: [...s.wires, removed] })),
      });
    },

    recordUpdateWire: (wireId, prev, next, description = 'Update wire') => {
      get().pushCommand(
        {
          description,
          execute: () =>
            set((s) => ({
              wires: s.wires.map((w) => (w.id === wireId ? { ...w, ...next } : w)),
            })),
          undo: () =>
            set((s) => ({
              wires: s.wires.map((w) => (w.id === wireId ? { ...w, ...prev } : w)),
            })),
        },
        { applyNow: false },
      );
    },

    toggleSerialMonitor: () => set((s) => ({ serialMonitorOpen: !s.serialMonitorOpen })),

    serialWrite: (text: string) => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;

      if (isPiBoardKind(board.boardKind)) {
        const bridge = getBoardBridge(boardId);
        if (bridge) {
          for (let i = 0; i < text.length; i++) {
            bridge.sendSerialByte(text.charCodeAt(i));
          }
        }
      } else if (isEsp32Kind(board.boardKind)) {
        const esp32Bridge = getEsp32Bridge(boardId);
        if (esp32Bridge) {
          esp32Bridge.sendSerialBytes(Array.from(new TextEncoder().encode(text)));
        }
      } else {
        getBoardSimulator(boardId)?.serialWrite(text);
      }
    },

    clearSerialOutput: () => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      set((s) => ({
        serialOutput: '',
        boards: s.boards.map((b) => (b.id === boardId ? { ...b, serialOutput: '' } : b)),
      }));
    },

    serialWriteToBoard: (boardId: string, text: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;
      if (isPiBoardKind(board.boardKind)) {
        const bridge = getBoardBridge(boardId);
        if (bridge) {
          for (let i = 0; i < text.length; i++) {
            bridge.sendSerialByte(text.charCodeAt(i));
          }
        }
      } else if (isEsp32Kind(board.boardKind)) {
        const esp32Bridge = getEsp32Bridge(boardId);
        if (esp32Bridge) {
          esp32Bridge.sendSerialBytes(Array.from(new TextEncoder().encode(text)));
        }
      } else {
        getBoardSimulator(boardId)?.serialWrite(text);
      }
    },

    clearBoardSerialOutput: (boardId: string) => {
      const isActive = get().activeBoardId === boardId;
      set((s) => ({
        ...(isActive ? { serialOutput: '' } : {}),
        boards: s.boards.map((b) => (b.id === boardId ? { ...b, serialOutput: '' } : b)),
      }));
    },
  };
});

// ── Helper: get the active board instance (convenience for consumers) ─────
export function getActiveBoard(): BoardInstance | null {
  const { boards, activeBoardId } = useSimulatorStore.getState();
  return boards.find((b) => b.id === activeBoardId) ?? null;
}

// ── Cross-board interconnect wiring ────────────────────────────────────────
//
// The Interconnect router subscribes to wire and board changes to propagate
// digital pin transitions and UART bytes between boards. We register the
// runtime accessors once, bind the initial board, and watch for store
// mutations.

setInterconnectRuntime({
  getBoardSimulator: (id: string) => simulatorMap.get(id),
  getBoardPinManager: (id: string) => pinManagerMap.get(id),
  getBoardBridge: (id: string) => bridgeMap.get(id),
  getEsp32Bridge: (id: string) => esp32BridgeMap.get(id),
  getStm32Bridge: (id: string) => stm32BridgeMap.get(id),
});

// Bind the initial Arduino Uno that ships with the store.
icBindBoard(INITIAL_BOARD_ID, 'arduino-uno');
icUpdateWires(useSimulatorStore.getState().wires);

// React to wire mutations from any source (drag, import, setState, ...).
let lastWiresRef: readonly Wire[] = useSimulatorStore.getState().wires;
let lastBoardsRef: readonly BoardInstance[] = useSimulatorStore.getState().boards;
useSimulatorStore.subscribe((state) => {
  const wiresChanged = state.wires !== lastWiresRef;
  const boardsChanged = state.boards !== lastBoardsRef;
  if (boardsChanged) {
    lastBoardsRef = state.boards;
    // Bind any boards that appeared in state but not yet in interconnect
    // (covers paths that bypass addBoard, e.g. import-from-zip, hot reload).
    for (const b of state.boards) icBindBoard(b.id, b.boardKind);
  }
  if (wiresChanged || boardsChanged) {
    lastWiresRef = state.wires;
    icUpdateWires(state.wires);
  }
});
