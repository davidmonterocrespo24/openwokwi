/**
 * Esp32Bridge
 *
 * Manages the WebSocket connection from the frontend to the backend
 * QEMU manager for one ESP32/ESP32-S3/ESP32-C3 board instance.
 *
 * Protocol (JSON frames):
 *   Frontend → Backend
 *     { type: 'start_esp32',        data: { board: BoardKind, firmware_b64?: string } }
 *     { type: 'stop_esp32' }
 *     { type: 'load_firmware',      data: { firmware_b64: string } }
 *     { type: 'esp32_serial_input', data: { bytes: number[], uart?: number } }
 *     { type: 'esp32_gpio_in',      data: { pin: number, state: 0 | 1 } }
 *     { type: 'esp32_adc_set',      data: { channel: number, millivolts: number } }
 *     { type: 'esp32_i2c_response', data: { addr: number, response: number } }
 *     { type: 'esp32_spi_response', data: { response: number } }
 *     { type: 'esp32_sensor_attach', data: { sensor_type: string, pin: number, ... } }
 *     { type: 'esp32_sensor_update', data: { pin: number, ... } }
 *     { type: 'esp32_sensor_detach', data: { pin: number } }
 *
 *   Backend → Frontend
 *     { type: 'serial_output', data: { data: string, uart?: number } }
 *     { type: 'gpio_change',   data: { pin: number, state: 0 | 1 } }
 *     { type: 'gpio_dir',      data: { pin: number, dir: 0 | 1 } }
 *     { type: 'gpio_pull',     data: { pin: number, pull: 0 | 1 | 2 } }  // 0=none 1=up 2=down
 *     { type: 'ledc_duty',     data: { channel: number, duty_pct: number } }
 *     { type: 'gpio_routing',  data: { gpio: number, signal_id: number } }
 *     { type: 'gpio_routing_clear', data: { gpio: number } }
 *     { type: 'ws2812_update', data: { channel: number, pixels: [number, number, number][] } }
 *     { type: 'i2c_event',        data: { addr: number, data: number } }
 *     { type: 'i2c_transaction',  data: { addr: number, data: number[] } }
 *     { type: 'spi_event',        data: { data: number } }
 *     { type: 'system',        data: { event: string, ... } }
 *     { type: 'error',         data: { message: string } }
 */

import type { BoardKind } from '../types/board';
import { generateUUID } from '../utils/uuid';

/**
 * Map any ESP32-family board kind to the 3 base QEMU machine types understood
 * by the backend esp_qemu_manager.
 */
export function toQemuBoardType(kind: BoardKind): 'esp32' | 'esp32-s3' | 'esp32-c3' {
  if (kind === 'esp32-s3' || kind === 'xiao-esp32-s3' || kind === 'arduino-nano-esp32')
    return 'esp32-s3';
  if (kind === 'esp32-c3' || kind === 'xiao-esp32-c3' || kind === 'aitewinrobot-esp32c3-supermini')
    return 'esp32-c3';
  return 'esp32'; // esp32, esp32-devkit-c-v4, esp32-cam, wemos-lolin32-lite
}

const API_BASE = (): string => {
  // The desktop shell injects the sidecar URL at runtime (random port) via
  // window.__VELXIO_API_BASE__; honor it first so the QEMU-board WebSocket
  // reaches the local Python sidecar instead of the build-time / dev
  // default. Without this, ESP32 / Pi / STM32 simulations never start in
  // the desktop app (the WS dialed localhost:8001, not the sidecar port).
  if (typeof window !== 'undefined') {
    const injected = (window as { __VELXIO_API_BASE__?: string }).__VELXIO_API_BASE__;
    if (typeof injected === 'string' && injected) {
      return injected.replace(/\/+$/, '');
    }
  }
  return (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8001/api';
};

/** Returns a stable UUID for this browser tab (persists across reloads, resets on new tab). */
export function getTabSessionId(): string {
  // sessionStorage is not available in Node/test environments
  if (typeof sessionStorage === 'undefined') return generateUUID();
  const KEY = 'velxio-tab-id';
  let id = sessionStorage.getItem(KEY);
  if (!id) {
    id = generateUUID();
    sessionStorage.setItem(KEY, id);
  }
  return id;
}

export interface Ws2812Pixel {
  r: number;
  g: number;
  b: number;
}
/** LEDC duty event — channel + duty only. The frontend resolves
 *  channel→signal_id→pin via its SignalRouter mirror. */
export interface LedcDuty {
  channel: number;
  duty_pct: number;
}
/** GPIO Matrix routing event — `gpio_out_sel[gpio]` was set to
 *  `signal_id`.  Maintained by the backend SignalRouter; emitted on
 *  every observed change so the frontend mirror stays in lock-step. */
export interface GpioRouting {
  gpio: number;
  signal_id: number;
}
export interface WifiStatus {
  status: string;
  ssid?: string;
  ip?: string;
}
export interface BleStatus {
  status: string;
}

export class Esp32Bridge {
  readonly boardId: string;
  readonly boardKind: BoardKind;

  /** Set to true before connect() to enable WiFi NIC in QEMU. */
  wifiEnabled = false;

  /**
   * Base64 FAT16 image for an on-canvas microSD card, set before connect().
   * Undefined when no card is present. Forwarded to the worker, which attaches
   * it as a synchronous SD-over-SPI slave (esp32_sd_slave.SdSpiSlave).
   */
  sdImageB64: string | undefined = undefined;

  // Callbacks wired up by useSimulatorStore
  onSerialData: ((char: string, uart?: number) => void) | null = null;
  onPinChange: ((gpioPin: number, state: boolean) => void) | null = null;
  /**
   * Timestamped version of onPinChange — wired to the oscilloscope so the
   * scope can render ESP32 GPIO activity at the same resolution as AVR /
   * RP2040 boards.  Also receives the synthesized UART TX frame bits from
   * `emitUartTxFrame` so a scope on GPIO1 / GPIO43 / etc. shows real bit-
   * level UART waveforms during `Serial.print`, matching real silicon.
   *
   * QEMU virtual time isn't exposed cleanly across the WebSocket, so the
   * timestamps come from `performance.now()` (wall-clock).  At 1× sim
   * speed this matches the AVR / RP2040 simulator-time within ~1 ms which
   * is invisible on any practical sweep.
   */
  onPinChangeWithTime: ((gpioPin: number, state: boolean, timeMs: number) => void) | null = null;
  onPinDir: ((gpioPin: number, dir: 0 | 1) => void) | null = null;
  /** Internal pull config the guest programmed into IO_MUX (INPUT_PULLUP /
   *  INPUT_PULLDOWN). 0 = none, 1 = pull-up, 2 = pull-down. The frontend
   *  netlist adds the matching weak resistor so idle inputs read the right
   *  level (real ESP32 internal pulls aren't otherwise visible to SPICE). */
  onPinPull: ((gpioPin: number, pull: 0 | 1 | 2) => void) | null = null;
  /**
   * Override baud rate used to space synthesized UART bits.  QEMU
   * transmits bytes "instantly" so the backend doesn't surface a real
   * baud rate, but for the scope to show a realistic frame we need a
   * bit period.  Defaults to 115200 (Arduino default).  The store
   * updates this when the firmware's `Serial.begin(N)` is observable.
   */
  uartBaudRate: number = 115200;
  /** Wired by the store to `makeLedcDutyHandler` which routes
   *  channel→pin via the per-board SignalRouter mirror. */
  onLedcDuty: ((duty: LedcDuty) => void) | null = null;
  /** Fires whenever the backend observes a write to `gpio_out_sel[N]`.
   *  The store's handler updates the per-board SignalRouter mirror so
   *  subsequent `onLedcDuty` events can resolve channel→pin correctly. */
  onGpioRouting: ((routing: GpioRouting) => void) | null = null;
  /** Pin is no longer routed to any peripheral (firmware reset the
   *  matrix entry). */
  onGpioRoutingClear: ((gpio: number) => void) | null = null;
  onWs2812Update: ((channel: number, pixels: Ws2812Pixel[]) => void) | null = null;
  /**
   * ePaper SSD168x backend rendering. Backend decodes SPI traffic in
   * `Ssd168xEpaperSlave` and emits this event on every 0x20
   * MASTER_ACTIVATION with a base64-encoded palette buffer (1 byte/pixel:
   * 0=black, 1=white, 2=red). One subscriber per `componentId`; multiple
   * panels on the same board are routed by ID.
   */
  onEpaperUpdate:
    | ((
        componentId: string,
        frame: { width: number; height: number; b64: string; refreshMs: number },
      ) => void)
    | null = null;
  onI2cEvent: ((addr: number, data: number) => void) | null = null;
  onI2cTransaction: ((addr: number, data: number[]) => void) | null = null;
  /**
   * Fires when the backend's `ProxySlave` emits a completed write
   * transaction (one full master write phase, terminated by STOP or
   * repeated-START).  Used by Interconnect / Esp32BridgeShim to
   * replay the bytes onto the actual frontend peer device so its
   * state stays consistent with what the ESP32 firmware "wrote".
   */
  onProxyI2cComplete: ((addr: number, data: number[]) => void) | null = null;
  onSpiEvent: ((data: number) => void) | null = null;
  /** Same as onSpiEvent but more explicit (a single MOSI byte). */
  onSpiByte: ((mosi: number) => void) | null = null;
  /** Fires on every CS line change emitted by the SoC's SPI peripheral.
   * `csIdx` is the index of the CS pin within the SPI bus (0-3 typical),
   * `low` is true when CS goes LOW (slave selected), false when HIGH. */
  onSpiCsChange: ((csIdx: number, low: boolean) => void) | null = null;
  onConnected: (() => void) | null = null;
  onDisconnected: (() => void) | null = null;
  onError: ((msg: string) => void) | null = null;
  onSystemEvent: ((event: string, data: Record<string, unknown>) => void) | null = null;
  onCrash: ((data: Record<string, unknown>) => void) | null = null;
  onWifiStatus: ((status: WifiStatus) => void) | null = null;
  onBleStatus: ((status: BleStatus) => void) | null = null;

  private socket: WebSocket | null = null;
  private _connected = false;
  private _pendingFirmware: string | null = null;
  private _pendingSensors: Array<Record<string, unknown>> = [];

  // MicroPython REPL injection — 4-stage state machine
  //   idle → banner_seen → prompt_seen → raw_repl_entered → done
  // Each stage waits for a specific string in the serial buffer before
  // proceeding.  This avoids the race where code is sent before raw REPL
  // mode is confirmed and ends up echoed by the normal REPL.
  private _pendingMicroPythonCode: string | null = null;
  private _serialBuffer = '';
  private _replState: 'idle' | 'banner_seen' | 'prompt_seen' | 'raw_repl_entered' = 'idle';
  micropythonMode = false;

  constructor(boardId: string, boardKind: BoardKind) {
    this.boardId = boardId;
    this.boardKind = boardKind;
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Default UART0 TX GPIO for each ESP32 family variant.  The actual pin
   * is selectable via the GPIO Matrix at runtime, but exposing the live
   * matrix state across the WebSocket isn't worth it — these defaults
   * match what the IO_MUX picks up for the standard `Serial` port and
   * are what every Arduino-ESP32 sketch ends up using unless the user
   * explicitly remaps via `Serial.setPins()`.
   */
  private uart0TxPin(): number {
    switch (this.boardKind) {
      case 'esp32-s3':
      case 'xiao-esp32-s3':
      case 'arduino-nano-esp32':
        return 43;
      case 'esp32-c3':
      case 'xiao-esp32-c3':
      case 'aitewinrobot-esp32c3-supermini':
        return 21;
      default:
        // esp32, esp32-devkit-c-v4, esp32-cam, wemos-lolin32-lite, …
        return 1;
    }
  }

  /**
   * Bit-level UART frame synthesis on the TX GPIO.  QEMU's UART
   * peripheral transmits bytes "instantly" at the virtual-time layer
   * and never toggles the SoC pad — same gap closed in AVRSimulator
   * and RP2040Simulator.  We rebuild the standard 8N1 frame (start
   * LOW + 8 data LSB-first + stop HIGH) at `this.uartBaudRate`, stamp
   * each transition with wall-clock-spaced timestamps starting now,
   * and push them through `onPinChangeWithTime` so the oscilloscope
   * draws the waveform a real ESP32 would put on the pin.
   *
   * Only UART0 is synthesized today — UART1 / UART2 would need their
   * own per-board GPIO mapping which Velxio doesn't currently track.
   */
  private emitUartTxFrame(byte: number, uart: number = 0): void {
    if (uart !== 0) return; // UART0 only for now
    if (!this.onPinChangeWithTime) return;
    const baud = this.uartBaudRate || 115200;
    if (baud <= 0) return;

    const txPin = this.uart0TxPin();
    const bitMs = 1000 / baud;
    const startMs = performance.now();

    // Seed idle HIGH right before the start bit so the scope renders the
    // start-bit transition against a HIGH baseline, matching how the line
    // sits between bytes on real hardware.
    this.onPinChangeWithTime(txPin, true, Math.max(0, startMs - bitMs));

    // 8N1: start LOW, then 8 data bits LSB-first, then stop HIGH.
    const bits: boolean[] = [false];
    for (let i = 0; i < 8; i++) bits.push(((byte >> i) & 1) !== 0);
    bits.push(true);

    let prev = true;
    for (let i = 0; i < bits.length; i++) {
      if (bits[i] !== prev) {
        this.onPinChangeWithTime(txPin, bits[i], startMs + i * bitMs);
        prev = bits[i];
      }
    }
  }

  get clientId(): string {
    return getTabSessionId() + '::' + this.boardId;
  }

  connect(): void {
    // Force a clean reconnect. The old guard here was
    //   if (this.socket && readyState !== CLOSED) return;
    // which made connect() a SILENT NO-OP whenever a socket lingered in any
    // non-CLOSED state (CONNECTING / OPEN / CLOSING). That's exactly the
    // "el agente terminó, di Run y no funcionó; recargué y sí" bug: the
    // agent's run_simulation left a live/half-dead socket, the backend QEMU
    // session had ended, and the user's Run → startBoard → connect() returned
    // without doing anything. A page reload worked only because it built a
    // fresh bridge. Tearing the zombie socket down and opening a new one to
    // the same session key is exactly what that reload does — the backend
    // already handles a new WS replacing an existing session (that's why
    // reload works), so it's safe to do it without the reload.
    if (this.socket) {
      try {
        this.socket.onopen = null;
        this.socket.onmessage = null;
        this.socket.onclose = null;
        this.socket.onerror = null;
        this.socket.close();
      } catch {
        /* already closing/closed */
      }
      this.socket = null;
      this._connected = false;
    }

    const base = API_BASE();
    const wsProtocol = base.startsWith('https') ? 'wss:' : 'ws:';
    const sessionId = getTabSessionId();
    const wsUrl =
      base.replace(/^https?:/, wsProtocol) +
      `/simulation/ws/${encodeURIComponent(sessionId + '::' + this.boardId)}`;

    const socket = new WebSocket(wsUrl);
    this.socket = socket;

    socket.onopen = () => {
      this._connected = true;
      console.log(
        `[Esp32Bridge:${this.boardId}] WebSocket connected → sending start_esp32 (firmware: ${this._pendingFirmware ? `${Math.round((this._pendingFirmware.length * 0.75) / 1024)}KB` : 'none'})`,
      );
      this.onConnected?.();
      this._send({
        type: 'start_esp32',
        data: {
          board: toQemuBoardType(this.boardKind),
          ...(this._pendingFirmware ? { firmware_b64: this._pendingFirmware } : {}),
          sensors: this._pendingSensors,
          wifi_enabled: this.wifiEnabled,
          ...(this.sdImageB64 ? { sd_card: { image_b64: this.sdImageB64 } } : {}),
        },
      });
    };

    socket.onmessage = (event: MessageEvent) => {
      let msg: { type: string; data: Record<string, unknown> };
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'serial_output': {
          const text = (msg.data.data as string) ?? '';
          const uart = msg.data.uart as number | undefined;
          if (this.onSerialData) {
            for (const ch of text) this.onSerialData(ch, uart);
          }
          // Synthesize the per-byte UART waveform on the TX GPIO so the
          // oscilloscope shows a real frame, matching how a real ESP32
          // drives the pin.  Falls back to UART0 when no uart index is
          // provided (which is the case for all current backend events).
          if (this.onPinChangeWithTime) {
            for (let i = 0; i < text.length; i++) {
              this.emitUartTxFrame(text.charCodeAt(i) & 0xff, uart ?? 0);
            }
          }
          // MicroPython REPL injection — 4-stage state machine.
          // Each stage waits for a confirmed string in the serial buffer before
          // advancing, so we never send code before raw REPL mode is verified.
          if (this._pendingMicroPythonCode || this._replState !== 'idle') {
            this._serialBuffer += text;

            // Stage 1: banner "Type help()" → poke UART with \r to flush ">>> "
            // The >>> prompt has no \n so the backend UART buffer holds it until
            // we send a byte that causes another write.
            if (this._replState === 'idle' && this._serialBuffer.includes('Type "help()"')) {
              this._replState = 'banner_seen';
              console.log('[Esp32Bridge] Stage 1: banner seen → poking UART with \\r');
              setTimeout(() => {
                this._send({ type: 'esp32_serial_input', data: { bytes: [0x0d] } });
              }, 800);
            }

            // Stage 2: ">>>" → send Ctrl+A to enter raw REPL
            if (this._replState === 'banner_seen' && this._serialBuffer.includes('>>>')) {
              this._replState = 'prompt_seen';
              this._serialBuffer = '';
              console.log('[Esp32Bridge] Stage 2: >>> seen → sending Ctrl+A');
              setTimeout(() => {
                this._send({ type: 'esp32_serial_input', data: { bytes: [0x01] } });
              }, 200);
            }

            // Stage 3: "raw REPL" confirmation → now safe to send code
            if (this._replState === 'prompt_seen' && this._serialBuffer.includes('raw REPL')) {
              this._replState = 'raw_repl_entered';
              const code = this._pendingMicroPythonCode!;
              this._pendingMicroPythonCode = null;
              this._serialBuffer = '';
              console.log('[Esp32Bridge] Stage 3: raw REPL confirmed → sending code');
              setTimeout(() => this._sendCodeInRawRepl(code), 200);
            }

            // Keep buffer from growing unboundedly
            if (this._serialBuffer.length > 8192) {
              this._serialBuffer = this._serialBuffer.slice(-1024);
            }
          }
          break;
        }
        case 'gpio_change': {
          const pin = msg.data.pin as number;
          const state = (msg.data.state as number) === 1;
          // No per-transition logging here: gpio_change fires on every edge
          // (e.g. each SPI clock pulse on a display-heavy sketch), so logging
          // it floods the console and measurably throttles the main thread and
          // simulation throughput. Keep only the functional callbacks below.
          this.onPinChange?.(pin, state);
          // Also feed the scope path so ESP32 digital pin activity shows
          // up on the oscilloscope at parity with AVR / RP2040 boards.
          // Wall-clock timestamp is good enough at 1× sim speed; QEMU
          // virtual time isn't surfaced across the WebSocket today.
          this.onPinChangeWithTime?.(pin, state, performance.now());
          break;
        }
        case 'gpio_dir': {
          const pin = msg.data.pin as number;
          const dir = msg.data.dir as 0 | 1;
          this.onPinDir?.(pin, dir);
          break;
        }
        case 'gpio_pull': {
          const pin = msg.data.pin as number;
          const pull = msg.data.pull as 0 | 1 | 2;
          this.onPinPull?.(pin, pull);
          break;
        }
        case 'ledc_duty': {
          this.onLedcDuty?.(msg.data as unknown as LedcDuty);
          break;
        }
        case 'gpio_routing': {
          this.onGpioRouting?.(msg.data as unknown as GpioRouting);
          break;
        }
        case 'gpio_routing_clear': {
          this.onGpioRoutingClear?.(msg.data.gpio as number);
          break;
        }
        case 'ws2812_update': {
          const channel = msg.data.channel as number;
          const raw = msg.data.pixels as [number, number, number][];
          const pixels: Ws2812Pixel[] = raw.map(([r, g, b]) => ({ r, g, b }));
          this.onWs2812Update?.(channel, pixels);
          break;
        }
        case 'epaper_update': {
          const componentId = msg.data.component_id as string;
          this.onEpaperUpdate?.(componentId, {
            width: msg.data.width as number,
            height: msg.data.height as number,
            b64: msg.data.frame_b64 as string,
            refreshMs: (msg.data.refresh_ms as number) ?? 50,
          });
          break;
        }
        case 'i2c_event': {
          const addr = msg.data.addr as number;
          const data = msg.data.data as number;
          this.onI2cEvent?.(addr, data);
          break;
        }
        case 'i2c_transaction': {
          const addr = msg.data.addr as number;
          const data = msg.data.data as number[];
          this.onI2cTransaction?.(addr, data);
          break;
        }
        case 'proxy_i2c_complete': {
          // Backend `ProxySlave` saw a full I2C write transaction from
          // the ESP32 firmware and is forwarding the bytes back so the
          // frontend can replay them on the actual peer device.  The
          // peer's `I2CDevice.writeByte` handles its own state machine
          // (pointer-byte first, then data) — we just hand off the
          // sequence in order.
          const addr = msg.data.addr as number;
          const data = msg.data.data as number[];
          this.onProxyI2cComplete?.(addr, data);
          break;
        }
        case 'spi_batch': {
          // Worker batches consecutive MOSI bytes from a single SPI
          // transaction into one base64-encoded message. Replays each
          // byte through the same callbacks the per-byte spi_event path
          // uses — parts that subscribed to onSpiByte don't notice. See
          // backend/app/services/esp32_worker.py::_on_spi_event for the
          // batching policy (flush on CS HIGH or buffer cap).
          const b64 = msg.data.b64 as string;
          if (b64) {
            const bin = atob(b64);
            const handler = this.onSpiByte ?? this.onSpiEvent;
            if (handler) {
              for (let i = 0; i < bin.length; i++) {
                const m = bin.charCodeAt(i);
                handler(m);
              }
            }
          }
          break;
        }
        case 'spi_event': {
          // Worker emits {bus, event, response}. The 'event' field encodes:
          //   event = mosi << 8        (op = event & 0xFF == 0x00) → byte transfer
          //   event = ((cs<<1)|level) << 8 | 0x01 (op == 0x01)     → CS line change
          // See backend/app/services/esp32_worker.py::_on_spi_event.
          //
          // After the batching change, the byte transfer path goes
          // through 'spi_batch' instead. This branch now only fires for
          // CS-line changes (op == 0x01), but we keep the byte branch
          // for backwards compatibility with older worker builds.
          const event = msg.data.event as number;
          const op    = (event ?? 0) & 0xFF;
          if (op === 0x00) {
            const mosi = (event >> 8) & 0xFF;
            this.onSpiEvent?.(mosi);
            this.onSpiByte?.(mosi);
          } else if (op === 0x01) {
            const csIdx = (event >> 9) & 0x3;
            const level = (event >> 8) & 0x1;
            this.onSpiCsChange?.(csIdx, level === 1);
          }
          // Backwards-compat path for callers reading the old `data` field.
          if (msg.data.data !== undefined) {
            this.onSpiEvent?.(msg.data.data as number);
          }
          break;
        }
        case 'system': {
          const evt = msg.data.event as string;
          console.log(`[Esp32Bridge:${this.boardId}] system event: ${evt}`, msg.data);
          if (evt === 'crash') {
            this.onCrash?.(msg.data);
          }
          this.onSystemEvent?.(evt, msg.data);
          break;
        }
        case 'wifi_status': {
          const wifiStatus = msg.data as unknown as WifiStatus;
          console.log(
            `[Esp32Bridge:${this.boardId}] wifi_status: ${wifiStatus.status} ssid=${wifiStatus.ssid ?? ''} ip=${wifiStatus.ip ?? ''}`,
          );
          this.onWifiStatus?.(wifiStatus);
          break;
        }
        case 'ble_status': {
          const bleStatus = msg.data as unknown as BleStatus;
          console.log(`[Esp32Bridge:${this.boardId}] ble_status: ${bleStatus.status}`);
          this.onBleStatus?.(bleStatus);
          break;
        }
        case 'error':
          console.error(`[Esp32Bridge:${this.boardId}] error: ${msg.data.message as string}`);
          this.onError?.(msg.data.message as string);
          break;
      }
    };

    socket.onclose = (ev) => {
      console.log(`[Esp32Bridge:${this.boardId}] WebSocket closed (code=${ev?.code ?? '?'})`);
      this._connected = false;
      this.socket = null;
      this.onDisconnected?.();
    };

    socket.onerror = (ev) => {
      console.error(`[Esp32Bridge:${this.boardId}] WebSocket error`, ev);
      this.onError?.('WebSocket error');
    };
  }

  disconnect(): void {
    if (this.socket) {
      this._send({ type: 'stop_esp32' });
      this.socket.close();
      this.socket = null;
    }
    this._connected = false;
  }

  /**
   * Pre-register sensors so they are included in the start_esp32 payload.
   * This ensures sensors are ready in the QEMU worker BEFORE the firmware
   * begins executing, preventing race conditions where pulseIn() times out
   * because the sensor handler hasn't been registered yet.
   *
   * MERGE semantics (upsert by `pin`): pre-existing entries with a different
   * pin are kept, entries with the same pin are replaced.  An earlier
   * implementation did `this._pendingSensors = sensors` (full replace) which
   * blew away anything PartSimulationRegistry handlers had already
   * registered via `sendSensorAttach` (e.g. the ePaper SPI slaves on
   * virtual pins) the moment `startBoard` later called `setSensors` with
   * only the wire-resolved sensors it knew about (DHT22, HC-SR04, …).
   * That dropped the ePaper slave registration on every Run click, and the
   * 5.65" UC8159c panel sat unresponsive while its firmware busy-waited.
   */
  setSensors(sensors: Array<Record<string, unknown>>): void {
    const merged = this._pendingSensors.slice();
    for (const s of sensors) {
      const pin = s['pin'];
      const idx = merged.findIndex((e) => e['pin'] === pin);
      if (idx >= 0) merged[idx] = s;
      else merged.push(s);
    }
    this._pendingSensors = merged;
  }

  /** Returns true if a firmware has been loaded and is ready to send. */
  hasFirmware(): boolean {
    return this._pendingFirmware !== null && this._pendingFirmware !== '';
  }

  /**
   * Load a compiled firmware (base64-encoded .bin) into the running ESP32.
   * If not yet connected, the firmware will be sent on next connect().
   */
  loadFirmware(firmwareBase64: string): void {
    this._pendingFirmware = firmwareBase64;
    if (this._connected) {
      this._send({ type: 'load_firmware', data: { firmware_b64: firmwareBase64 } });
    }
  }

  /** Send a byte to the ESP32 UART0 (or UART1/2) */
  sendSerialByte(byte: number, uart = 0): void {
    this._send({ type: 'esp32_serial_input', data: { bytes: [byte], uart } });
  }

  /** Send multiple bytes at once */
  sendSerialBytes(bytes: number[], uart = 0): void {
    if (bytes.length === 0) return;
    this._send({ type: 'esp32_serial_input', data: { bytes, uart } });
  }

  /** Drive a GPIO pin from an external source (e.g. connected Arduino) */
  sendPinEvent(gpioPin: number, state: boolean): void {
    this._send({ type: 'esp32_gpio_in', data: { pin: gpioPin, state: state ? 1 : 0 } });
  }

  /** Set an ADC channel voltage (millivolts, 0–3300) */
  setAdc(channel: number, millivolts: number): void {
    this._send({ type: 'esp32_adc_set', data: { channel, millivolts } });
  }

  /**
   * Push a periodic waveform LUT for an ADC channel. The backend forwards
   * the samples to QEMU, which interpolates them against its virtual clock
   * on every MMIO ADC read — matching the per-read fidelity AVR and RP2040
   * get via `onADCRead` monkey-patching.
   *
   *   samples: 12-bit raw values (0-4095) aligned on a uniform time grid
   *   periodNs: full period of the LUT in nanoseconds
   *
   * Samples are sent as base64-encoded uint16 little-endian. Clearing the
   * waveform (returning to DC `setAdc` behavior) is done by passing an
   * empty `samples` array.
   */
  setAdcWaveform(channel: number, samples: Uint16Array, periodNs: number): void {
    // Encode little-endian uint16 → base64 (transport-safe for JSON stdin/WS).
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 =
      typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
    this._send({
      type: 'esp32_adc_waveform',
      data: { channel, samples_u12_b64: base64, period_ns: periodNs },
    });
  }

  /** Clear a previously-pushed ADC waveform, reverting to DC `setAdc`. */
  clearAdcWaveform(channel: number): void {
    this._send({
      type: 'esp32_adc_waveform',
      data: { channel, samples_u12_b64: '', period_ns: 0 },
    });
  }

  /** Configure the byte an I2C device at addr returns */
  setI2cResponse(addr: number, response: number): void {
    this._send({ type: 'esp32_i2c_response', data: { addr, response } });
  }

  // ── Cross-board I2C proxy ─────────────────────────────────────────────────
  // The backend hosts a `ProxySlave` at each registered address that responds
  // with the register dump pushed by the frontend.  Used when an ESP32 is
  // wired to another board's I2C bus and that peer board owns a virtual
  // device — the ESP32 firmware needs to read it synchronously inside QEMU,
  // which a WebSocket round-trip per byte can't deliver.  The proxy snapshot
  // is good enough for chip-id reads, calibration constants, and any device
  // whose state changes slowly relative to the ESP32 firmware's poll cadence.

  /**
   * Install a proxy I2C slave at `addr` initialised with the given register
   * dump (up to 256 bytes).  Pushed lazily — buffered until WS opens.
   */
  registerProxyI2c(addr: number, registers: Uint8Array): void {
    const regs_b64 = btoa(String.fromCharCode(...registers));
    this._send({
      type: 'esp32_proxy_i2c_register',
      data: { addr: addr & 0x7f, regs_b64 },
    });
  }

  /** Refresh the register state of an existing proxy slave at `addr`. */
  updateProxyI2c(addr: number, registers: Uint8Array): void {
    const regs_b64 = btoa(String.fromCharCode(...registers));
    this._send({
      type: 'esp32_proxy_i2c_update',
      data: { addr: addr & 0x7f, regs_b64 },
    });
  }

  /** Remove the proxy slave at `addr` (called on bridge teardown). */
  unregisterProxyI2c(addr: number): void {
    this._send({
      type: 'esp32_proxy_i2c_unregister',
      data: { addr: addr & 0x7f },
    });
  }

  /** Configure the MISO byte returned during an SPI transaction */
  setSpiResponse(response: number): void {
    this._send({ type: 'esp32_spi_response', data: { response } });
  }

  // ── Generic sensor protocol offloading ────────────────────────────────────
  // Sensors call these to delegate their protocol to the backend QEMU.
  // The sensor type (e.g. 'dht22', 'hc-sr04') tells the backend which
  // protocol handler to use.  Sensor-specific properties (temperature,
  // humidity, distance …) are passed as a generic Record.

  /** Register a sensor on a GPIO pin — backend handles its protocol */
  sendSensorAttach(sensorType: string, pin: number, properties: Record<string, unknown>): void {
    // Buffer into _pendingSensors so it is included in start_esp32 if sent
    // before the WebSocket opens (the common case when attachEvents fires
    // before the user clicks Run).
    const entry = { sensor_type: sensorType, pin, ...properties };
    const existing = this._pendingSensors.findIndex((s) => s['pin'] === pin);
    if (existing >= 0) {
      this._pendingSensors[existing] = entry;
    } else {
      this._pendingSensors.push(entry);
    }
    // Also send immediately if already connected (re-attach on hot reload)
    if (this._connected) {
      this._send({ type: 'esp32_sensor_attach', data: entry });
    }
  }

  /** Update sensor properties (temperature, humidity, distance, etc.) */
  sendSensorUpdate(pin: number, properties: Record<string, unknown>): void {
    // Keep _pendingSensors in sync so reconnects get current values
    const idx = this._pendingSensors.findIndex((s) => s['pin'] === pin);
    if (idx >= 0) {
      this._pendingSensors[idx] = { ...this._pendingSensors[idx], ...properties };
    }
    this._send({ type: 'esp32_sensor_update', data: { pin, ...properties } });
  }

  /** Detach a sensor from a GPIO pin */
  sendSensorDetach(pin: number): void {
    this._pendingSensors = this._pendingSensors.filter((s) => s['pin'] !== pin);
    this._send({ type: 'esp32_sensor_detach', data: { pin } });
  }

  // ── ESP32-CAM webcam injection ────────────────────────────────────────────
  /** Tell the backend a frame source is connected (call once when the user
   *  grants webcam permission). */
  sendCameraAttach(): void {
    this._send({ type: 'esp32_camera_attach', data: { board: 'esp32-cam' } });
  }

  /** Push one JPEG frame from the browser webcam to the emulator. The
   *  backend forwards it via ctypes to the QEMU OV2640+I²S device, which
   *  delivers the bytes to the firmware's DMA buffer.
   *
   *  Encoding: base64 in JSON. ~10–14 KB per QVGA frame at quality 0.6.
   *  At 10 fps that's ~120 KB/s — trivial over local WS. */
  sendCameraFrame(jpegBytes: ArrayBuffer | Uint8Array,
                  width = 320, height = 240): void {
    const u8 = jpegBytes instanceof Uint8Array
      ? jpegBytes
      : new Uint8Array(jpegBytes);
    // btoa needs a binary string; build one in 32 KB chunks to avoid
    // "argument size limit" issues with very large frames.
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < u8.length; i += chunkSize) {
      binary += String.fromCharCode(...u8.subarray(i, i + chunkSize));
    }
    const b64 = btoa(binary);
    this._send({
      type: 'esp32_camera_frame',
      data: { fmt: 'jpeg', w: width, h: height, b64 },
    });
  }

  /** Drop the queued frame. Call when the user stops the webcam. */
  sendCameraDetach(): void {
    this._send({ type: 'esp32_camera_detach', data: {} });
  }

  /**
   * Queue user MicroPython code for injection after the REPL boots.
   * The code will be sent via raw-paste protocol once `>>>` is detected.
   */
  setPendingMicroPythonCode(code: string): void {
    this._pendingMicroPythonCode = code;
    this._serialBuffer = '';
    this._replState = 'idle';
    this.micropythonMode = true;
  }

  /** Check if this bridge is in MicroPython mode */
  isMicroPythonMode(): boolean {
    return this.micropythonMode;
  }

  /**
   * Send code bytes to QEMU UART, then Ctrl+D to execute.
   * Called ONLY after "raw REPL; CTRL-B to exit" has been confirmed in the
   * serial buffer (stage 3), so we are guaranteed to be in raw REPL mode.
   */
  /**
   * Sanitize MicroPython source code before sending to the raw REPL.
   *
   * MicroPython v1.20 on ESP32 uses a byte-oriented tokenizer that doesn't
   * handle non-ASCII bytes in source code.  Multi-byte UTF-8 sequences
   * (e.g. Spanish accents: á=\xC3\xA1, ú=\xC3\xBA) in comments confuse the
   * tokenizer and produce SyntaxError at the wrong line.
   *
   * Safe to strip non-ASCII only from comments because:
   *  - String literals with non-ASCII would already fail on MicroPython's
   *    default build (no wide-unicode support on ESP32).
   *  - Identifiers must be ASCII.
   */
  private static _sanitizeForRepl(code: string): string {
    // 1. Strip UTF-8 BOM if present
    let s = code.startsWith('\uFEFF') ? code.slice(1) : code;
    // 2. Normalize line endings to LF
    s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // 3. Replace non-ASCII in line-comments with '?' so the line is preserved
    s = s.replace(/^([ \t]*#.*)$/gm, (line) => line.replace(/[^\x00-\x7F]/g, '?'));
    // 4. Replace non-ASCII in inline comments (after code on the same line)
    s = s.replace(/([ \t]+#.*)$/gm, (comment) => comment.replace(/[^\x00-\x7F]/g, '?'));
    return s;
  }

  private _sendCodeInRawRepl(code: string): void {
    const sanitized = Esp32Bridge._sanitizeForRepl(code);
    console.log(
      `[Esp32Bridge:${this.boardId}] Sending ${sanitized.length} bytes to raw REPL + Ctrl+D`,
    );
    if (sanitized !== code) {
      console.log(
        `[Esp32Bridge:${this.boardId}] Code was sanitized (non-ASCII in comments stripped)`,
      );
    }
    const codeBytes = Array.from(new TextEncoder().encode(sanitized));
    console.log(
      `[Esp32Bridge:${this.boardId}] Sending ${codeBytes.length} bytes in chunks to raw REPL`,
    );

    // The ESP32 UART RX FIFO is 128 bytes in hardware (and in QEMU's emulation).
    // Sending >128 bytes in one qemu_picsimlab_uart_receive() call overflows the
    // FIFO — the extra bytes are silently dropped, corrupting the injected code
    // (e.g. "time.sleep" becomes "ti" causing NameError).
    // Use ≤64-byte chunks with a 150 ms gap so QEMU drains the FIFO between sends.
    const CHUNK_SIZE = 64;
    const CHUNK_DELAY_MS = 150;
    let offset = 0;

    const sendChunk = () => {
      if (offset >= codeBytes.length) {
        // All bytes delivered — wait for QEMU to finish processing the last chunk
        setTimeout(() => {
          this.sendSerialBytes([0x04]); // Ctrl+D → compile & execute
          this._replState = 'idle';
          console.log(`[Esp32Bridge:${this.boardId}] Ctrl+D sent — code executing`);
        }, 300);
        return;
      }
      const chunk = codeBytes.slice(offset, offset + CHUNK_SIZE);
      this.sendSerialBytes(chunk);
      offset += CHUNK_SIZE;
      setTimeout(sendChunk, CHUNK_DELAY_MS);
    };
    sendChunk();
  }

  private _send(payload: unknown): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }
}
