import { RP2040, GPIOPinState, ConsoleLogger, LogLevel, USBCDC } from 'rp2040js';
import type { RPI2C } from 'rp2040js';
import { PinManager } from './PinManager';
import { I2CBusManager, wireRpI2cToBus, nullI2CMaster } from './I2CBusManager';
import type { I2CDevice } from './I2CBusManager';
import { bootromB1 } from './rp2040-bootrom';
import { loadUF2, loadUserFiles, getFirmware } from './MicroPythonLoader';
import { type PioPeripheral, createPioPeripheral } from './PioPeripheral';
import { requestElectricalResolve } from './spice/electricalResolveHook';

/**
 * RP2040Simulator — Emulates Raspberry Pi Pico (RP2040) using rp2040js
 *
 * Features:
 * - ARM Cortex-M0+ dual-core Cortex-M0+ CPU at 125 MHz (single-core emulated)
 * - 30 GPIO pins (GPIO0-GPIO29)  xc fv       nn
 * - 2× UART, 2× SPI, 2× I2C
 * - ADC on GPIO26-GPIO29 (A0-A3) + internal temp sensor (ch4)
 * - PWM on any GPIO
 * - LED_BUILTIN on GPIO25
 * - Full bootrom B1 for proper boot sequence
 *
 * Arduino-pico pin mapping (Earle Philhower's core):
 *   D0  = GPIO0   … D29 = GPIO29
 *   A0  = GPIO26  … A3  = GPIO29
 *   LED_BUILTIN = GPIO25
 *   Default Serial  → UART0 (GPIO0=TX, GPIO1=RX)
 *   Default I2C     → I2C0  (GPIO4=SDA, GPIO5=SCL)
 *   Default SPI     → SPI0  (GPIO16=MISO, GPIO19=MOSI, GPIO18=SCK, GPIO17=CS)
 */

const F_CPU = 125_000_000; // 125 MHz
const CYCLE_NANOS = 1e9 / F_CPU; // nanoseconds per cycle (~8 ns)
const FPS = 60;
const CYCLES_PER_MS = F_CPU / 1000; // 125 000 cycles per simulated millisecond

/** Minimal structural view of the rp2040js clock we drive. */
interface SimClock {
  readonly nanosToNextAlarm: number;
  tick(nanos: number): void;
}

// Real-time scheduler.  The RP2040 core is ~8x heavier to emulate than the
// AVR (125 MHz vs 16 MHz), so a host that cannot execute 125 M instructions
// per second of wall-clock would otherwise run the simulation in slow motion:
// a `delay(1000)` blink renders every 4-5 s.  Two mechanisms keep sim-time
// locked to wall-time:
//   1. The frame budget is derived from the MEASURED wall-clock delta (like
//      AVRSimulator), not a fixed 1/60 s, so the sim never silently falls
//      behind the assumed 60 fps.
//   2. A `delay()` busy-wait spins reading the timer without putting the core
//      to sleep (no WFI), so the WFI fast-path never triggers and the emulator
//      grinds every idle cycle.  IdleSpinDetector recognises such a
//      side-effect-free spin and we advance the clock over it instead of
//      executing it — exactly what the WFI path already does for sleep().
const MAX_DELTA_MS = 50; // clamp the wall-clock delta (paused/backgrounded tab)
// When an idle spin is elided with no timer alarm to anchor the jump, advance
// at most this many cycles before letting the firmware re-check its deadline.
// Bounds the delay overshoot to ~1 ms; with an alarm pending we stop exactly
// at the alarm (no overshoot).
const IDLE_SLICE_CYCLES = CYCLES_PER_MS; // 1 ms

/**
 * Detects a side-effect-free busy-wait spin (e.g. arduino-pico `delay()`,
 * which polls the timer in a tight loop instead of sleeping).  Fed the PC
 * about to execute on every instruction; reads the GPIO snapshot lazily, only
 * when a backward branch closes a loop iteration, so the hot path stays cheap.
 *
 * Reports a spin only once the SAME loop has iterated `threshold` times with
 * NO GPIO change (input or output) — so a bit-bang loop (toggles a pin every
 * iteration) and an input-poll that just saw its pin move are never elided,
 * and neither is a loop that calls out (long forward jump resets the count).
 * A false positive is bounded-harmless: we only ever advance time up to the
 * wall-clock budget, never past the next timer alarm or scheduled pin change.
 */
export class IdleSpinDetector {
  private prevPc = -1;
  private loopTarget = -1;
  private iters = 0;
  private gpioAtLastIter = -1;

  constructor(
    private readonly threshold = 32,
    private readonly maxStride = 256,
  ) {}

  /**
   * @param pc   program counter about to execute
   * @param gpio thunk returning the current GPIO snapshot (called only on a
   *             backward branch, so the 30-pin scan stays off the hot path)
   * @returns true when a stable, side-effect-free spin is detected
   */
  observe(pc: number, gpio: () => number): boolean {
    const prev = this.prevPc;
    this.prevPc = pc;
    if (prev === -1) return false;

    if (pc < prev) {
      // Backward branch — one loop iteration just closed.
      const g = gpio();
      if (this.loopTarget !== pc) {
        // First time we land on this loop top (or the loop moved): start over.
        this.loopTarget = pc;
        this.gpioAtLastIter = g;
        this.iters = 1;
        return false;
      }
      if (g !== this.gpioAtLastIter) {
        // A pin changed during the iteration — real work (bit-bang) or an
        // input arrived.  Not idle; restart the count from this iteration.
        this.gpioAtLastIter = g;
        this.iters = 1;
        return false;
      }
      this.iters++;
      return this.iters >= this.threshold;
    }

    if (pc > prev + this.maxStride) {
      // Long forward jump (call / loop exit) — left the tight spin.
      this.reset();
    }
    return false;
  }

  /** Call right after eliding a slice so the firmware re-checks its deadline
   *  (executes the loop body again) before the next jump. */
  noteElided(): void {
    this.iters = 0;
  }

  reset(): void {
    this.prevPc = -1;
    this.loopTarget = -1;
    this.iters = 0;
    this.gpioAtLastIter = -1;
  }
}

/**
 * Backward-compatible alias for the unified `I2CDevice` shape used by
 * both AVR and RP2040 buses now that I2CBusManager is the canonical
 * abstraction.  Existing call sites that import `RP2040I2CDevice` keep
 * working without changes.
 */
export type RP2040I2CDevice = I2CDevice;

export class RP2040Simulator {
  // Drive digital INPUT pins from the solved circuit (connectDigitalInputsToMcu)
  // instead of the legacy part-seed, so digitalRead() reflects the REAL wiring:
  // a pin tied to a rail reads that rail, a button-to-GND on an INPUT_PULLUP pin
  // reads idle-HIGH / pressed-LOW. The internal pull is surfaced from the pad
  // config in the GPIO listener below (see setupGpioListeners). Mirrors AVR /
  // ESP32. Event-driven parts with no SPICE model (rotary encoder, keypad) are
  // protected by the `sourcedNets` gate inside the connector.
  readonly spiceDrivenInputs = true;
  private rp2040: RP2040 | null = null;
  private running = false;
  private animationFrame: number | null = null;
  public pinManager: PinManager;
  private speed = 1.0;
  private gpioUnsubscribers: Array<() => void> = [];
  private flashCopy: Uint8Array | null = null;
  private totalCycles = 0;
  private scheduledPinChanges: Array<{ cycle: number; pin: number; state: boolean }> = [];
  private pioStepAccum = 0;
  private usbCDC: USBCDC | null = null;
  private micropythonMode = false;
  // Real-time scheduler state (see IdleSpinDetector + runFrameForTime).
  private lastTimestamp = 0;
  private readonly idleDetector = new IdleSpinDetector();

  // ── Generic PIO/gSPI bus peripheral (e.g. the pro WiFi co-processor). Null
  //    in OSS (no factory installed); attached for boards a factory supports.
  private pioPeripheral: PioPeripheral | null = null;
  private pioHookedFifos: Array<{ restore: () => void }> = [];
  // The board kind this simulator runs (set by attachPioPeripheral). A
  // 'pi-pico-w' boots the RPI_PICO_W firmware (with the `network` module)
  // regardless of whether a WiFi peripheral attached, so a Pico W sketch never
  // crashes with "ImportError: no module named 'network'" — even if the pro
  // factory hadn't installed yet when the board was added.
  private boardKind = '';

  /** Serial output callback — fires for each byte the Pico sends on UART0 (or USBCDC in MicroPython mode) */
  public onSerialData: ((char: string) => void) | null = null;

  /**
   * Generic SPI bus adapter — same shape as AVRSimulator.spi so SPI parts
   * (ILI9341, SD cards, custom chips) can hook the bus uniformly across
   * boards. Defaults to RP2040 SPI0; firmware that uses SPI1 will need to
   * wrap rp2040.spi[1] manually until we add a .spi1 alias.
   *
   * Lazy-initialised so the rp2040.spi[0].onTransmit is only overridden
   * once a part actually accesses .spi (avoiding clobbering the default
   * loopback handler if no SPI part is on the canvas).
   */
  private _spiAdapter: { onByte: ((mosi: number) => void) | null;
                         completeTransfer: (miso: number) => void } | null = null;
  public get spi(): { onByte: ((mosi: number) => void) | null;
                      completeTransfer: (miso: number) => void } {
    if (!this._spiAdapter) {
      const adapter = {
        onByte: null as ((mosi: number) => void) | null,
        completeTransfer: (miso: number) => {
          this.rp2040?.spi[0].completeTransmit(miso & 0xff);
        },
      };
      // Re-route SPI0's onTransmit through our adapter when initMCU /
      // initMicroPython runs. Until rp2040 is constructed (mcu=null) the
      // setter just stages the handler — we wire it in start().
      this._spiAdapter = adapter;
      if (this.rp2040) {
        this.rp2040.spi[0].onTransmit = (v: number) => adapter.onByte?.(v);
      }
    }
    return this._spiAdapter;
  }

  /**
   * Fires for every GPIO pin transition with a millisecond timestamp.
   * Used by the oscilloscope / logic analyzer.
   * timeMs is derived from the RP2040 cycle counter (cycles / F_CPU * 1000).
   */
  public onPinChangeWithTime: ((pin: number, state: boolean, timeMs: number) => void) | null = null;

  /**
   * Track whether the first byte has been transmitted on each UART since
   * the firmware booted.  Used to seed the oscilloscope baseline at idle
   * HIGH the first time a frame goes out, mirroring how real silicon
   * idles the TX line HIGH once UARTEN is asserted.
   */
  private uartTxSeeded: [boolean, boolean] = [false, false];

  /**
   * One `I2CBusManager` per hardware I2C controller (RP2040 has two:
   * I2C0/Wire and I2C1/Wire1).  Constructed up-front in the
   * simulator's constructor with a placeholder master so that cross-
   * board bridges + device registrations can land BEFORE firmware
   * loads.  The real RPI2C peripheral takes over in `wireI2C()` via
   * `attachMaster` + `wireRpI2cToBus`.
   */
  private i2cBuses: [I2CBusManager, I2CBusManager];

  constructor(pinManager: PinManager) {
    this.pinManager = pinManager;
    this.i2cBuses = [
      new I2CBusManager(nullI2CMaster()),
      new I2CBusManager(nullI2CMaster()),
    ];
  }

  /**
   * Load a compiled binary into the RP2040 flash memory.
   * Accepts a base64-encoded string of the raw .bin file output by arduino-cli.
   */
  loadBinary(base64: string): void {
    console.log('[RP2040] Loading binary...');

    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    console.log(`[RP2040] Binary size: ${bytes.length} bytes`);
    this.flashCopy = bytes;

    this.initMCU(bytes);
    console.log('[RP2040] CPU initialized with bootrom, UART, I2C, SPI, GPIO');
  }

  /** Same interface as AVRSimulator for store compatibility */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  loadHex(_hexContent: string): void {
    console.warn('[RP2040] loadHex() called on RP2040Simulator — use loadBinary() instead');
  }

  /**
   * Load MicroPython firmware + user .py files into RP2040 flash.
   * Uses USBCDC for serial (REPL) instead of UART.
   */
  async loadMicroPython(
    files: Array<{ name: string; content: string }>,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<void> {
    // A pi-pico-w boots the RPI_PICO_W firmware variant (network + driver +
    // bigger LittleFS) whether or not a WiFi peripheral attached — so a Pico W
    // sketch never crashes on `import network`. The pro overlay registers that
    // variant; in OSS it isn't registered and firmwareConfig() falls back to
    // 'pico' (a self-hosted Pico W has no WiFi anyway). The pioPeripheral check
    // stays as a belt-and-suspenders for any future factory-backed board.
    const variant =
      this.boardKind === 'pi-pico-w' || this.pioPeripheral ? 'pico-w' : 'pico';
    console.log(`[RP2040] Loading MicroPython firmware (${variant})...`);

    // 1. Get MicroPython UF2 firmware (cached in IndexedDB)
    const firmware = await getFirmware(variant, onProgress);

    // 2. Create fresh RP2040 instance
    this.rp2040 = new RP2040();
    this.rp2040.logger = new ConsoleLogger(LogLevel.Error, false);
    this.rp2040.loadBootrom(bootromB1);

    // 3. Load UF2 firmware into flash
    loadUF2(firmware, this.rp2040.flash);
    console.log(`[RP2040] MicroPython UF2 loaded (${firmware.length} bytes)`);

    // 4. Create LittleFS with user files and load into flash (variant-specific
    //    flash offset — the Pico W FS lives higher than the plain Pico's).
    await loadUserFiles(files, this.rp2040.flash, variant);
    console.log(`[RP2040] LittleFS loaded with ${files.length} file(s)`);

    // Keep a flash copy for reset
    this.flashCopy = new Uint8Array(this.rp2040.flash);

    // 5. Set up USBCDC for serial REPL (instead of UART)
    this.usbCDC = new USBCDC(this.rp2040.usbCtrl);
    this.usbCDC.onDeviceConnected = () => {
      // Send newline to trigger the REPL prompt
      this.usbCDC!.sendSerialByte('\r'.charCodeAt(0));
      this.usbCDC!.sendSerialByte('\n'.charCodeAt(0));
    };
    this.usbCDC.onSerialData = (buffer: Uint8Array) => {
      for (const byte of buffer) {
        if (this.onSerialData) {
          this.onSerialData(String.fromCharCode(byte));
        }
      }
    };

    // 6. Set PC to flash start
    this.rp2040.core.PC = 0x10000000;

    // 7. Wire peripherals (I2C, SPI, ADC, PIO, GPIO — same as Arduino mode)
    // But skip UART serial wiring since MicroPython uses USBCDC
    this.rp2040.uart[1].onByte = (value: number) => {
      if (this.onSerialData) this.onSerialData(String.fromCharCode(value));
    };
    this.wireI2C(0);
    this.wireI2C(1);
    // Default loopback for SPI0 — overridden by the generic .spi adapter
    // if a SPI part later accesses simulator.spi. The adapter routes
    // onTransmit into adapter.onByte and uses completeTransmit to drive
    // MISO when the part calls completeTransfer.
    this.rp2040.spi[0].onTransmit = (v: number) => {
      if (this._spiAdapter && this._spiAdapter.onByte) {
        this._spiAdapter.onByte(v);
      } else {
        this.rp2040!.spi[0].completeTransmit(v);
      }
    };
    this.rp2040.spi[1].onTransmit = (v: number) => {
      this.rp2040!.spi[1].completeTransmit(v);
    };
    this.rp2040.adc.channelValues[0] = 2048;
    this.rp2040.adc.channelValues[1] = 2048;
    this.rp2040.adc.channelValues[2] = 2048;
    this.rp2040.adc.channelValues[3] = 2048;
    this.rp2040.adc.channelValues[4] = 876;

    // Patch PIO (same as initMCU)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const pio of (this.rp2040 as any).pio) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pio.run = function (this: any) {
        if (this.runTimer) {
          clearTimeout(this.runTimer);
          this.runTimer = null;
        }
      };
    }
    this.pioStepAccum = 0;

    // The PIO-peripheral hooks were installed on the RP2040 instance that
    // existed at board-creation time. loadMicroPython just swapped in a fresh
    // RP2040, so those hooks now point at the discarded instance. Re-install
    // them on the new PIO FIFOs or the peripheral never sees the bus traffic.
    if (this.pioPeripheral) {
      this.pioHookedFifos = [];
      this.installPioPeripheralHooks();
    }

    this.setupGpioListeners();
    this.micropythonMode = true;
    console.log('[RP2040] MicroPython ready');
  }

  /** Returns true if currently in MicroPython mode */
  isMicroPythonMode(): boolean {
    return this.micropythonMode;
  }

  // ── Pico W (CYW43439) attachment ────────────────────────────────────────

  /**
   * Attach a PIO/gSPI bus peripheral to this RP2040 instance (e.g. the pro
   * overlay's CYW43 WiFi co-processor). Should only be called once per board.
   * Idempotent — calling twice is a no-op. Returns null when no factory is
   * installed (OSS build) or the factory declines (unsupported board / a free
   * user) — in which case the board simulates as a plain Pico.
   *
   * The peripheral observes outbound PIO TX FIFO writes (which the driver
   * bit-bangs onto the gSPI bus) and feeds back synthesised reply words; the
   * fragile FIFO plumbing + GPIO24 host-wake lifecycle stay here.
   */
  attachPioPeripheral(boardKind: string, boardId: string): PioPeripheral | null {
    // Record the kind even when no peripheral attaches (free user / OSS /
    // factory-not-installed-yet) so loadMicroPython still picks the W firmware
    // for a pi-pico-w board.
    this.boardKind = boardKind;
    if (this.pioPeripheral) return this.pioPeripheral;
    const peripheral = createPioPeripheral(boardKind, boardId);
    if (!peripheral) return null;
    this.pioPeripheral = peripheral;

    // Drive WL_HOST_WAKE (GPIO24, active-high). The driver gates poll_device on
    // this pin until it has received its first packet, so without it the first
    // IOCTL response is never read and wifi_on stalls.
    peripheral.onHostWake((active: boolean) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      try { (this.rp2040 as any)?.gpio?.[24]?.setInputValue(active); } catch { /* noop */ }
    });

    this.installPioPeripheralHooks();
    return peripheral;
  }

  /** Detach the PIO peripheral (called from teardown). */
  detachPioPeripheral(): void {
    for (const h of this.pioHookedFifos) h.restore();
    this.pioHookedFifos = [];
    try { this.pioPeripheral?.detach?.(); } catch { /* noop */ }
    this.pioPeripheral = null;
  }

  /** Read access for tests / debug panels. */
  getPioPeripheral(): PioPeripheral | null { return this.pioPeripheral; }

  /**
   * Hook every PIO state machine's txFIFO/rxFIFO so the attached PIO
   * peripheral sees every word the driver bit-bangs onto the bus and its
   * reply words land in the RX FIFO without a real chip on the wire.
   */
  private installPioPeripheralHooks(): void {
    if (!this.rp2040 || !this.pioPeripheral) return;
    const peripheral = this.pioPeripheral;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pios: any[] = (this.rp2040 as any).pio;
    for (const pio of pios) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const sm of pio.machines as any[]) {
        const tx = sm.txFIFO;
        const rx = sm.rxFIFO;
        if (!tx || !rx) continue;
        // Make the TX FIFO NON-DROPPING (head-pointer queue). rp2040js's 4-deep
        // FIFO silently drops words once full, which truncates the 260-word F2
        // IOCTL writes (clm_load, the connect ioctls) so the chip never sees a
        // complete frame. Real hardware paces the DMA with DREQ and never drops.
        // To keep the ~224 KB firmware download cheap we still discard the bulk
        // of each firmware/backplane write (inDiscardableWriteData): the PIO
        // drains the few kept words, raises TXSTALL, and the driver moves on.
        const q: number[] = [];
        let head = 0;
        const origFull = Object.getOwnPropertyDescriptor(tx, 'full');
        const origEmpty = Object.getOwnPropertyDescriptor(tx, 'empty');
        const origItem = Object.getOwnPropertyDescriptor(tx, 'itemCount');
        const origPush: (v: number) => void = tx.push.bind(tx);
        const origPull: () => number = tx.pull.bind(tx);
        const origPeek = tx.peek?.bind(tx);
        const origReset = tx.reset?.bind(tx);
        Object.defineProperty(tx, 'full', { get: () => false, configurable: true });
        Object.defineProperty(tx, 'empty', { get: () => head >= q.length, configurable: true });
        Object.defineProperty(tx, 'itemCount', { get: () => q.length - head, configurable: true });
        tx.peek = () => (head < q.length ? q[head] : 0);
        tx.reset = () => { q.length = 0; head = 0; };
        tx.push = (value: number) => {
          if (peripheral.inDiscardableWriteData()) {
            if (q.length - head < 4) q.push(value >>> 0); // keep a few so the PIO TXSTALLs
            return;
          }
          // Feed the peripheral; commands that produce a response queue it
          // for on-demand delivery (see the rxFIFO.pull hook below).
          this.feedPioWord(value);
          q.push(value >>> 0);
        };
        tx.pull = () => {
          if (head >= q.length) return 0;
          const v = q[head++];
          if (head > 8192 && head * 2 > q.length) { q.splice(0, head); head = 0; } // compact
          return v;
        };
        this.pioHookedFifos.push({
          restore: () => {
            if (origFull) Object.defineProperty(tx, 'full', origFull); else delete tx.full;
            if (origEmpty) Object.defineProperty(tx, 'empty', origEmpty); else delete tx.empty;
            if (origItem) Object.defineProperty(tx, 'itemCount', origItem); else delete tx.itemCount;
            tx.push = origPush;
            tx.pull = origPull;
            if (origPeek) tx.peek = origPeek;
            if (origReset) tx.reset = origReset;
          },
        });
        // Reset the gSPI framing at each transfer boundary. cyw43_spi_transfer
        // does pio_sm_restart before pushing the count words, so this keeps the
        // sniffer deterministic even across the firmware-stream fast-path.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (typeof (sm as any).restart === 'function') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const origRestart: () => void = (sm as any).restart.bind(sm);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (sm as any).restart = () => { peripheral.resetFraming(); return origRestart(); };
          this.pioHookedFifos.push({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            restore: () => { (sm as any).restart = origRestart; },
          });
        }
        // Serve the chip's response when the driver's DMA actually reads the
        // RX FIFO. Pushing into the FIFO eagerly raced the async DMA/PIO and
        // the data arrived late or was lost; serving on pull keeps it in lock
        // step with the driver.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const origRxPull: () => number = (rx as any).pull.bind(rx);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (rx as any).pull = () =>
          this.pioRxQueue.length > 0 ? (this.pioRxQueue.shift() as number) : origRxPull();
        this.pioHookedFifos.push({
          restore: () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (rx as any).pull = origRxPull;
          },
        });
      }
    }
    // Re-sync WL_HOST_WAKE: loadMicroPython swaps in a fresh RP2040 (GPIO reset
    // to low) while the chip's frame queue — and thus its host-wake level —
    // persists. onHostWake only fires on changes, so push the current level now.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.rp2040 as any)?.gpio?.[24]?.setInputValue(peripheral.hostWakeLevel());
    } catch { /* noop */ }
  }

  private pioRxQueue: number[] = [];
  private feedPioWord(word: number): void {
    if (!this.pioPeripheral) return;
    for (const reply of this.pioPeripheral.feedWord(word)) {
      if (reply.length > 0) this.queuePioReply(reply);
    }
  }

  private queuePioReply(reply: Uint8Array): void {
    // 32-bit big-endian repacking with the same halfword swap the PIO
    // program does on input. We push host-byte-order words; the SM's
    // shift register puts them on the wire LSB-first per the gSPI spec.
    for (let i = 0; i + 4 <= reply.length; i += 4) {
      const w =
        ((reply[i + 3] << 24) | (reply[i + 2] << 16) | (reply[i + 1] << 8) | reply[i]) >>> 0;
      this.pioRxQueue.push(w);
    }
    if (reply.length % 4 !== 0) {
      // Pad to 4 bytes with zeros — the driver discards trailing bytes
      // it didn't request.
      const tail = reply.subarray(reply.length - (reply.length % 4));
      let w = 0;
      for (let i = 0; i < tail.length; i++) w |= tail[i] << (i * 8);
      this.pioRxQueue.push(w >>> 0);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getADC(): any {
    return this.rp2040?.adc ?? null;
  }

  /** Get underlying RP2040 instance (for advanced usage / tests) */
  getMCU(): RP2040 | null {
    return this.rp2040;
  }

  // ── Private initialization ───────────────────────────────────────────────

  private initMCU(programBytes: Uint8Array): void {
    this.rp2040 = new RP2040();

    // Suppress noisy internal logs (only show errors)
    this.rp2040.logger = new ConsoleLogger(LogLevel.Error, false);

    // Load RP2040 B1 bootrom — needed for proper boot sequence
    this.rp2040.loadBootrom(bootromB1);

    // Load binary into flash starting at offset 0 (maps to 0x10000000)
    this.rp2040.flash.set(programBytes, 0);

    // Set PC to flash start (boot vector)
    this.rp2040.core.PC = 0x10000000;

    // ── Wire UART0 (default Serial port for Arduino-Pico) ────────────
    let serialBuffer = '';
    this.rp2040.uart[0].onByte = (value: number) => {
      const ch = String.fromCharCode(value);
      serialBuffer += ch;
      if (ch === '\n') {
        console.log('[RP2040 UART0]', serialBuffer.trimEnd());
        serialBuffer = '';
      }
      if (this.onSerialData) {
        this.onSerialData(ch);
      }
      // Synthesize the bit-level waveform on the UART0 TX pin so an
      // oscilloscope on it sees a real frame — rp2040js doesn't drive the
      // GPIO when the UART transmits. See emitUartTxFrame().
      this.emitUartTxFrame(0, value);
    };

    // ── Wire UART1 (Serial1) — also forward to onSerialData for now ──
    this.rp2040.uart[1].onByte = (value: number) => {
      if (this.onSerialData) {
        this.onSerialData(String.fromCharCode(value));
      }
      this.emitUartTxFrame(1, value);
    };

    // ── Wire I2C0 and I2C1 ───────────────────────────────────────────
    this.wireI2C(0);
    this.wireI2C(1);

    // ── Wire SPI0 and SPI1 ────────────────────────────────────────────
    // SPI0 must check for a registered .spi adapter on every byte. If a
    // part on the canvas (ILI9341, custom chip, …) accessed simulator.spi
    // BEFORE this initMCU runs, the adapter is already staged but
    // _adapter.onByte points at the part's handler — we have to route
    // the byte through it. Without this, SPI parts see nothing and the
    // canvas stays black (real regression — Pico Doom shipped with this
    // bug for months because the same wiring in initMicroPython was
    // adapter-aware but this Arduino path wasn't).
    this.rp2040.spi[0].onTransmit = (v: number) => {
      if (this._spiAdapter && this._spiAdapter.onByte) {
        this._spiAdapter.onByte(v);
      } else {
        this.rp2040!.spi[0].completeTransmit(v);
      }
    };
    this.rp2040.spi[1].onTransmit = (value: number) => {
      this.rp2040!.spi[1].completeTransmit(value); // loopback
    };

    // ── Set default ADC values ───────────────────────────────────────
    // Channel 0-3: GPIO26-29, channel 4: internal temp sensor
    // Default to mid-range (~1.65V on 3.3V ref, 12-bit)
    this.rp2040.adc.channelValues[0] = 2048;
    this.rp2040.adc.channelValues[1] = 2048;
    this.rp2040.adc.channelValues[2] = 2048;
    this.rp2040.adc.channelValues[3] = 2048;
    // Internal temp sensor: T = 27 - (V - 0.706) / 0.001721
    // For 27°C: V = 0.706V → ADC = 0.706/3.3 * 4095 ≈ 876
    this.rp2040.adc.channelValues[4] = 876;

    // ── Patch PIO to use synchronous stepping instead of setTimeout ──
    // rp2040js PIO uses setTimeout(() => this.run(), 0) which deadlocks
    // when the CPU busy-waits for PIO FIFO space (e.g. pio_sm_put_blocking).
    // We step PIO synchronously in the execute loop instead.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const pio of (this.rp2040 as any).pio) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pio.run = function (this: any) {
        if (this.runTimer) {
          clearTimeout(this.runTimer);
          this.runTimer = null;
        }
        // No-op: execute loop calls pio.step() synchronously
      };
    }
    this.pioStepAccum = 0;

    // ── Set up GPIO listeners ────────────────────────────────────────
    this.setupGpioListeners();
  }

  /**
   * Resolve the GPIO index currently routed to a given UART's TX line.
   *
   * The RP2040 GPIO function-select register decides which signal each pad
   * carries; UART has FUNCSEL == 2.  Per datasheet, UART0_TX can land on
   * GP0 / GP12 / GP16 / GP28 and UART1_TX on GP4 / GP8 / GP20 / GP24.  We
   * walk the candidates and pick the first whose function select is UART.
   * If none is mapped (rare — the firmware hasn't called `Serial.begin()`
   * properly) fall back to the default for that UART (GP0 / GP4).
   */
  private rp2040UartTxPin(uartIdx: 0 | 1): number {
    const FUNCTION_UART = 2;
    const candidates = uartIdx === 0 ? [0, 12, 16, 28] : [4, 8, 20, 24];
    if (this.rp2040) {
      for (const g of candidates) {
        const pin = this.rp2040.gpio[g];
        if (pin && (pin as unknown as { functionSelect: number }).functionSelect === FUNCTION_UART) {
          return g;
        }
      }
    }
    return uartIdx === 0 ? 0 : 4;
  }

  /**
   * Synthesize a bit-level UART frame on the TX pin so the oscilloscope
   * sees a real waveform during `Serial.print` / `Serial1.print`.
   *
   * rp2040js's UART peripheral fires `onByte(value)` per transmitted byte
   * but never toggles the corresponding GPIO — the same gap closed in
   * AVRSimulator.emitUartTxFrame().  Here we do the same: build the frame
   * (start LOW + data LSB-first + stop HIGH) using the UART's live
   * `baudRate` and `bitsPerChar`, then push one transition per bit-change
   * through `onPinChangeWithTime` so the scope draws the waveform at the
   * actual silicon-equivalent baud rate.
   *
   * Time is taken from the RP2040 clock (nanos counter), matching the
   * existing GPIO-listener path in `setupGpioListeners()` — UART
   * waveforms therefore stack consistently with any other pin trace.
   */
  private emitUartTxFrame(uartIdx: 0 | 1, byte: number): void {
    if (!this.rp2040 || !this.onPinChangeWithTime) return;
    const uart = this.rp2040.uart[uartIdx];
    if (!uart) return;
    const baud = uart.baudRate;
    if (!baud || baud <= 0) return;

    const txPin = this.rp2040UartTxPin(uartIdx);
    const dataBits = uart.bitsPerChar;
    const clk = (this.rp2040 as unknown as { clock?: { nanos: number } }).clock;
    const startMs = clk ? clk.nanos / 1_000_000 : 0;
    const bitMs = 1000 / baud;

    // First frame after boot: seed an explicit idle HIGH one bit-period
    // before the start bit so the scope has a HIGH baseline to draw the
    // start-bit transition against.  Subsequent frames inherit the HIGH
    // baseline from the previous frame's stop bit.
    if (!this.uartTxSeeded[uartIdx]) {
      this.onPinChangeWithTime(txPin, true, Math.max(0, startMs - bitMs));
      this.uartTxSeeded[uartIdx] = true;
    }

    const bits: boolean[] = [false]; // start bit
    for (let i = 0; i < dataBits; i++) {
      bits.push(((byte >> i) & 1) !== 0);
    }
    bits.push(true); // stop bit (rp2040js doesn't expose 2-stop-bit selection
                     // cleanly; default to 1 — same behaviour as 8N1 sketches)

    let prevState = true;
    for (let i = 0; i < bits.length; i++) {
      if (bits[i] !== prevState) {
        this.onPinChangeWithTime(txPin, bits[i], startMs + i * bitMs);
        prevState = bits[i];
      }
    }
  }

  private wireI2C(bus: 0 | 1): void {
    if (!this.rp2040) return;
    const i2c: RPI2C = this.rp2040.i2c[bus];
    // Swap in the real RPI2C peripheral and route its per-callback
    // events into the existing bus manager.  Any devices + bridges
    // registered before the firmware loaded are preserved.
    const busManager = this.i2cBuses[bus];
    busManager.attachMaster(i2c);
    wireRpI2cToBus(i2c, busManager);
  }

  private setupGpioListeners(): void {
    this.gpioUnsubscribers.forEach((fn) => fn());
    this.gpioUnsubscribers = [];

    if (!this.rp2040) return;

    for (let gpioIdx = 0; gpioIdx < 30; gpioIdx++) {
      const pin = gpioIdx;
      const gpio = this.rp2040.gpio[gpioIdx];
      if (!gpio) continue;

      const unsub = gpio.addListener((state: GPIOPinState) => {
        // rp2040js reports the pin's MODE here, not its external value: Low/High
        // mean the MCU is driving the pad (outputEnable), while Input/
        // InputPullUp/InputPullDown/InputBusKeeper mean it's a high-Z input
        // whose pad pull config is encoded in the state. The listener only fires
        // on a mode/pull change (an external value change via setInputValue does
        // not alter `value` for an input pin), so we can split cleanly.
        if (state >= GPIOPinState.Input) {
          // INPUT pin. Surface the internal pull so NetlistBuilder stamps the
          // weak resistor; the actual logic level is injected from the SPICE
          // solve by connectDigitalInputsToMcu. We do NOT mark the pin as an MCU
          // output (triggerPinChange 'mcu'), or the connector would skip it.
          const pull =
            state === GPIOPinState.InputPullUp ? 1 : state === GPIOPinState.InputPullDown ? 2 : 0;
          this.pinManager.setPinPull(pin, pull);
          // Seed the idle level the pull alone would produce (rp2040js does not
          // auto-apply the pad pull to the readable input register). The
          // connector overrides this whenever the pin's net is actually sourced
          // (rail / button / divider); an unwired pulled input keeps this level.
          if (pull === 1) gpio.setInputValue(true);
          else if (pull === 2) gpio.setInputValue(false);
          requestElectricalResolve();
          return;
        }
        const isHigh = state === GPIOPinState.High;
        this.pinManager.triggerPinChange(pin, isHigh, 'mcu');
        if (this.onPinChangeWithTime && this.rp2040) {
          // IClock interface exposes `nanos` (not `timeUs`)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const clk = (this.rp2040 as any).clock;
          const timeMs = clk ? (clk.nanos as number) / 1_000_000 : 0;
          this.onPinChangeWithTime(pin, isHigh, timeMs);
        }
      });
      this.gpioUnsubscribers.push(unsub);
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  start(): void {
    if (this.running || !this.rp2040) {
      console.warn('[RP2040] Already running or not initialized');
      return;
    }

    this.running = true;
    this.lastTimestamp = 0;
    this.idleDetector.reset();
    console.log('[RP2040] Starting simulation at 125 MHz...');

    const execute = (timestamp: number) => {
      if (!this.running || !this.rp2040) return;

      // Derive this frame's cycle budget from the MEASURED wall-clock delta
      // (mirrors AVRSimulator) so the sim cannot silently run in slow motion
      // by assuming a perfect 60 fps. First frame falls back to one frame; the
      // upper clamp (paused/backgrounded tab) is applied in runFrameForTime.
      const deltaMs = this.lastTimestamp === 0 ? 1000 / FPS : timestamp - this.lastTimestamp;
      this.lastTimestamp = timestamp;

      try {
        this.runFrameForTime(deltaMs);
      } catch (error) {
        console.error('[RP2040] Simulation error:', error);
        this.stop();
        return;
      }

      this.animationFrame = requestAnimationFrame(execute);
    };

    this.animationFrame = requestAnimationFrame(execute);
  }

  /**
   * Run one frame's worth of simulation for `deltaMs` of wall-clock time.
   * Returns counters for tests. Keeps simulated time locked to wall-clock:
   * idle spins (busy-wait `delay()`) and WFI sleeps advance the clock instead
   * of executing every idle cycle, so timing stays correct even when the host
   * cannot emulate 125 MHz in real time. Exposed (not private) so the
   * real-time scheduler can be driven deterministically in tests without rAF.
   */
  runFrameForTime(deltaMs: number): { cyclesAdvanced: number; instructionsExecuted: number } {
    if (!this.rp2040) return { cyclesAdvanced: 0, instructionsExecuted: 0 };
    // Guard against NaN/negative deltas and clamp the upper bound so a single
    // frame never simulates more than MAX_DELTA_MS of CPU time (a paused or
    // backgrounded tab must not trigger a multi-second catch-up burst).
    let dt = deltaMs > 0 ? deltaMs : 1000 / FPS;
    if (dt > MAX_DELTA_MS) dt = MAX_DELTA_MS;
    const cyclesTarget = Math.max(1, Math.floor(CYCLES_PER_MS * dt * this.speed));
    const { core } = this.rp2040;
    const clock = (this.rp2040 as unknown as { clock?: SimClock }).clock ?? null;
    const pioDiv = this.getPIOClockDiv();
    const gpioSnapshot = () => this.rp2040!.gpioValues;

    let cyclesDone = 0;
    let instructionsExecuted = 0;
    while (cyclesDone < cyclesTarget) {
      if (core.waiting) {
        // CPU asleep (WFI/WFE): jump to the next timer alarm, but never past
        // this frame's wall-clock budget, so a long sleep advances at real
        // time across frames rather than leaping ahead.
        if (!clock || clock.nanosToNextAlarm <= 0) {
          this.stepPIO(); // nothing scheduled to wake it this frame
          break;
        }
        const jumped = this.advanceClock(cyclesTarget - cyclesDone, pioDiv, clock);
        if (jumped <= 0) break;
        cyclesDone += jumped;
      } else if (this.idleDetector.observe(core.PC, gpioSnapshot)) {
        // Detected a side-effect-free busy-wait spin (e.g. delay()): advance
        // the clock over it instead of grinding every cycle. Capped at the
        // next alarm/scheduled pin change inside advanceClock, and to a small
        // slice so the firmware re-checks its deadline (bounds overshoot).
        const budget = Math.min(cyclesTarget - cyclesDone, IDLE_SLICE_CYCLES);
        const jumped = this.advanceClock(budget, pioDiv, clock);
        if (jumped <= 0) {
          cyclesDone += this.execOne(core, clock, pioDiv);
          instructionsExecuted++;
        } else {
          cyclesDone += jumped;
          this.idleDetector.noteElided();
        }
      } else {
        cyclesDone += this.execOne(core, clock, pioDiv);
        instructionsExecuted++;
      }
    }
    return { cyclesAdvanced: cyclesDone, instructionsExecuted };
  }

  /** Execute one ARM instruction in the production loop, advancing the clock
   *  and stepping PIO. Returns the cycles it took. */
  private execOne(
    core: { executeInstruction(): number },
    clock: SimClock | null,
    pioDiv: number,
  ): number {
    const cycles: number = core.executeInstruction();
    if (clock) clock.tick(cycles * CYCLE_NANOS);
    this.totalCycles += cycles;
    this.pioStepAccum += cycles;
    while (this.pioStepAccum >= pioDiv) {
      this.pioStepAccum -= pioDiv;
      this.stepPIO();
    }
    this.flushScheduledPinChanges();
    return cycles;
  }

  /**
   * Advance the simulated clock by up to `budgetCycles` WITHOUT executing
   * instructions, stepping PIO at the PIO clock rate so GPIO timestamps stay
   * accurate. Never advances past the next timer alarm or the next scheduled
   * pin change (so those still fire at their exact simulated time). Returns
   * the number of cycles actually advanced.
   */
  private advanceClock(budgetCycles: number, pioDiv: number, clock: SimClock | null): number {
    if (budgetCycles <= 0 || !clock) return 0;
    const alarmNanos: number = clock.nanosToNextAlarm ?? 0;
    const alarmCycles = alarmNanos > 0 ? Math.ceil(alarmNanos / CYCLE_NANOS) : Infinity;
    const nextPin =
      this.scheduledPinChanges.length > 0
        ? this.scheduledPinChanges[0].cycle - this.totalCycles
        : Infinity;
    let jumped = Math.min(budgetCycles, alarmCycles, nextPin > 0 ? nextPin : Infinity);
    if (!Number.isFinite(jumped) || jumped <= 0) return 0;
    jumped = Math.ceil(jumped);

    const totalNanos = jumped * CYCLE_NANOS;
    const nanoPerPioStep = pioDiv * CYCLE_NANOS;
    const pioSteps = Math.min(Math.floor(jumped / pioDiv), 50000);
    let nanosStepped = 0;
    for (let i = 0; i < pioSteps; i++) {
      clock.tick(nanoPerPioStep);
      nanosStepped += nanoPerPioStep;
      this.stepPIO();
    }
    const remaining = totalNanos - nanosStepped;
    if (remaining > 0) clock.tick(remaining);
    this.totalCycles += jumped;
    this.flushScheduledPinChanges();
    return jumped;
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    // Force a new idle-HIGH seed on the next byte: the scope buffer is
    // typically cleared on stop/start, so the previous run's "seeded"
    // flag would suppress the baseline sample for the next session.
    this.uartTxSeeded = [false, false];
    this.lastTimestamp = 0;
    this.idleDetector.reset();
    console.log('[RP2040] Simulation stopped');
  }

  reset(): void {
    this.stop();
    this.totalCycles = 0;
    this.scheduledPinChanges = [];
    this.idleDetector.reset();
    if (this.rp2040 && this.flashCopy) {
      if (this.micropythonMode) {
        // In MicroPython mode, restore the full flash snapshot (UF2 + LittleFS)
        this.rp2040 = new RP2040();
        this.rp2040.logger = new ConsoleLogger(LogLevel.Error, false);
        this.rp2040.loadBootrom(bootromB1);
        this.rp2040.flash.set(this.flashCopy);
        this.rp2040.core.PC = 0x10000000;

        // Re-wire USBCDC
        this.usbCDC = new USBCDC(this.rp2040.usbCtrl);
        this.usbCDC.onDeviceConnected = () => {
          this.usbCDC!.sendSerialByte('\r'.charCodeAt(0));
          this.usbCDC!.sendSerialByte('\n'.charCodeAt(0));
        };
        this.usbCDC.onSerialData = (buffer: Uint8Array) => {
          for (const byte of buffer) {
            if (this.onSerialData) this.onSerialData(String.fromCharCode(byte));
          }
        };

        // Re-wire peripherals (skipping UART0 serial)
        this.rp2040.uart[1].onByte = (value: number) => {
          if (this.onSerialData) this.onSerialData(String.fromCharCode(value));
        };
        this.wireI2C(0);
        this.wireI2C(1);
        this.rp2040.spi[0].onTransmit = (v: number) => {
          this.rp2040!.spi[0].completeTransmit(v);
        };
        this.rp2040.spi[1].onTransmit = (v: number) => {
          this.rp2040!.spi[1].completeTransmit(v);
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const pio of (this.rp2040 as any).pio) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pio.run = function (this: any) {
            if (this.runTimer) {
              clearTimeout(this.runTimer);
              this.runTimer = null;
            }
          };
        }
        this.pioStepAccum = 0;
        this.setupGpioListeners();
      } else {
        this.initMCU(this.flashCopy);
      }
      console.log('[RP2040] CPU reset');
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0.1, Math.min(10.0, speed));
  }

  getSpeed(): number {
    return this.speed;
  }

  /** Returns the CPU clock frequency in Hz. */
  getClockHz(): number {
    return F_CPU;
  }

  /** Returns total CPU cycles executed since last reset/load. */
  getCurrentCycles(): number {
    return this.totalCycles;
  }

  /**
   * Schedule a GPIO pin state change at a specific future cycle count.
   * Enables cycle-accurate protocol simulation (e.g. HC-SR04 echo timing).
   */
  schedulePinChange(pin: number, state: boolean, atCycle: number): void {
    let i = this.scheduledPinChanges.length;
    while (i > 0 && this.scheduledPinChanges[i - 1].cycle > atCycle) i--;
    this.scheduledPinChanges.splice(i, 0, { cycle: atCycle, pin, state });
  }

  /** Get the PIO clock divider from the first enabled state machine. */
  private getPIOClockDiv(): number {
    if (!this.rp2040) return 64;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const pio of (this.rp2040 as any).pio) {
      if (pio.stopped) continue;
      for (const m of pio.machines) {
        if (m.enabled) {
          return Math.max(1, m.clockDivInt || 1);
        }
      }
    }
    return 64; // default
  }

  /** Step PIO state machines synchronously (prevents setTimeout deadlock). */
  private stepPIO(): void {
    if (!this.rp2040) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pio = (this.rp2040 as any).pio;
    if (pio[0] && !pio[0].stopped) pio[0].step();
    if (pio[1] && !pio[1].stopped) pio[1].step();
  }

  private flushScheduledPinChanges(): void {
    if (this.scheduledPinChanges.length === 0) return;
    while (
      this.scheduledPinChanges.length > 0 &&
      this.scheduledPinChanges[0].cycle <= this.totalCycles
    ) {
      const { pin, state } = this.scheduledPinChanges.shift()!;
      this.setPinState(pin, state);
    }
  }

  /**
   * Drive a GPIO pin externally (e.g. from a button or slider).
   * GPIO n = Arduino D(n) for Raspberry Pi Pico.
   */
  setPinState(arduinoPin: number, state: boolean): void {
    if (!this.rp2040) return;
    const gpio = this.rp2040.gpio[arduinoPin];
    if (gpio) {
      gpio.setInputValue(state);
    }
  }

  /**
   * Send text to UART0 RX (or USBCDC in MicroPython mode).
   */
  serialWrite(text: string): void {
    if (!this.rp2040) return;
    if (this.micropythonMode && this.usbCDC) {
      for (let i = 0; i < text.length; i++) {
        this.usbCDC.sendSerialByte(text.charCodeAt(i));
      }
    } else {
      for (let i = 0; i < text.length; i++) {
        this.rp2040.uart[0].feedByte(text.charCodeAt(i));
      }
    }
  }

  /**
   * Feed bytes into a hardware UART's RX from an external part (GPS module,
   * a wired peer board via Interconnect, …). Uniform seam across simulators
   * (`sim.feedUart(uart, data)`) — Interconnect already probes for it.
   *
   * RP2040 has two PL011 UARTs: uart 0 = Serial1 (GP0/GP1 on the Earle
   * Philhower core), uart 1 = Serial2 (GP8/GP9 by default). Unlike
   * `serialWrite`, this always targets the hardware UART — never the USB
   * CDC console — so it works the same in Arduino and MicroPython modes.
   *
   * @returns true when the bytes were delivered.
   */
  feedUart(uart: number, data: string): boolean {
    if (!this.rp2040) return false;
    const target = this.rp2040.uart[uart];
    if (!target) return false;
    for (let i = 0; i < data.length; i++) {
      target.feedByte(data.charCodeAt(i));
    }
    return true;
  }

  /**
   * Send a raw byte to the serial interface (for control characters like Ctrl+C).
   */
  serialWriteByte(byte: number): void {
    if (!this.rp2040) return;
    if (this.micropythonMode && this.usbCDC) {
      this.usbCDC.sendSerialByte(byte);
    } else {
      this.rp2040.uart[0].feedByte(byte);
    }
  }

  /**
   * Register a virtual I2C device on the specified bus (0 or 1).
   * Default bus 0 = Wire, bus 1 = Wire1.  Devices are added directly
   * to the bus manager (which exists from construction time, with a
   * placeholder master until the real RPI2C is wired in start()).
   */
  addI2CDevice(device: I2CDevice, bus: 0 | 1 = 0): void {
    this.i2cBuses[bus].addDevice(device);
  }

  /** Remove an I2C device by address from the given bus. */
  removeI2CDevice(address: number, bus: 0 | 1 = 0): void {
    this.i2cBuses[bus].removeDevice(address);
  }

  /**
   * Get the I2CBusManager for a given hardware bus (0 or 1).
   * Available from construction time so Interconnect can install
   * cross-board bridges before firmware loads.
   */
  getI2CBus(bus: 0 | 1 = 0): I2CBusManager {
    return this.i2cBuses[bus];
  }

  /**
   * Execute one ARM instruction synchronously and return the number
   * of CPU cycles it took.  Mirrors `AVRSimulator.step()` for tests
   * that need deterministic single-stepping outside the
   * `requestAnimationFrame` loop used in production.  No-op if the
   * firmware has not been loaded.
   *
   * Does NOT advance PIO or fire scheduled pin changes — for those
   * use the production `start()` loop or call `stepCycles(n)`.
   */
  step(): number {
    if (!this.rp2040) return 0;
    const core = this.rp2040.core;
    const clock = this.rp2040.clock;
    if (core.waiting) {
      // CPU is in WFE/WFI — advance clock to the next alarm so an
      // interrupt can wake it.  Without this, single-stepping a
      // waiting CPU spins indefinitely.
      const jump = clock?.nanosToNextAlarm ?? CYCLE_NANOS;
      if (jump > 0 && clock) clock.tick(jump);
      this.totalCycles += Math.ceil((jump || CYCLE_NANOS) / CYCLE_NANOS);
      return Math.ceil((jump || CYCLE_NANOS) / CYCLE_NANOS);
    }
    const cycles: number = core.executeInstruction();
    if (clock) clock.tick(cycles * CYCLE_NANOS);
    this.totalCycles += cycles;
    return cycles;
  }

  /**
   * Drive the CPU forward by approximately `targetCycles` cycles,
   * synchronously.  Useful for test harnesses that want bounded,
   * deterministic execution without depending on
   * `requestAnimationFrame`.  Returns the actual number of cycles
   * consumed (may exceed targetCycles by at most the cost of one
   * instruction).
   */
  stepCycles(targetCycles: number): number {
    let consumed = 0;
    while (consumed < targetCycles) {
      const c = this.step();
      if (c === 0) break; // firmware not loaded
      consumed += c;
    }
    return consumed;
  }

  /**
   * Set ADC channel value (0-4095 for 12-bit).
   * Channels 0-3 = GPIO26-29, channel 4 = internal temperature sensor.
   */
  setADCValue(channel: number, value: number): void {
    if (!this.rp2040) return;
    if (channel >= 0 && channel < 5) {
      this.rp2040.adc.channelValues[channel] = Math.max(0, Math.min(4095, value));
    }
  }

  /**
   * Set SPI onTransmit handler for a bus (0 or 1).
   * callback receives TX byte and must call completeTransmit on the SPI instance.
   */
  setSPIHandler(bus: 0 | 1, handler: (value: number) => number): void {
    if (!this.rp2040) return;
    const spi = this.rp2040.spi[bus];
    spi.onTransmit = (value: number) => {
      const response = handler(value);
      spi.completeTransmit(response);
    };
  }

  // ── Generic sensor registration (board-agnostic API) ──────────────────────
  // RP2040 handles all sensor protocols locally via schedulePinChange,
  // so these return false / no-op — the sensor runs its own frontend logic.

  registerSensor(_type: string, _pin: number, _props: Record<string, unknown>): boolean {
    return false;
  }
  updateSensor(_pin: number, _props: Record<string, unknown>): void {}
  unregisterSensor(_pin: number): void {}
}
