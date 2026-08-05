/**
 * ProtocolParts.ts — Simulation for I2C, SPI, and custom-protocol components.
 *
 * Implements eight components that require specific communication stacks:
 *
 *  ssd1306      — I2C OLED display (0x3C). Full command/data decoder.
 *  ds1307       — I2C Real-Time Clock (0x68). Returns browser system time.
 *  mpu6050      — I2C 6-axis IMU (0x68/0x69). Full register map simulation.
 *  dht22        — Single-wire temp/humidity. Drives DATA pin after start signal.
 *  hx711        — 2-wire load cell amplifier. Clocks out 24-bit ADC value.
 *  ir-receiver  — NEC IR receiver. Click generates active-low pulse train.
 *  ir-remote    — NEC IR remote. Button click dispatches ir-signal event.
 *  microsd-card — SPI SD card. Responds to CMD0/CMD8/ACMD41/CMD58 init.
 *
 * NOTE — timing-sensitive protocols (dht22, ir-receiver, ir-remote):
 *   Full µs-accuracy requires CPU-loop integration. These simulate protocol
 *   intent and work with polling-based Arduino code; hardware-interrupt-based
 *   libraries (e.g. IRremote) need the exact cycle counts not available here.
 */

import { PartSimulationRegistry } from './PartSimulationRegistry';
import { VirtualDS1307, VirtualBMP280, VirtualDS3231, VirtualPCF8574 } from '../I2CBusManager';
import type { I2CDevice } from '../I2CBusManager';
import { HD44780Decoder } from '../HD44780Decoder';
import { registerSensorUpdate, unregisterSensorUpdate } from '../SensorUpdateRegistry';
import { useSimulatorStore } from '../../store/useSimulatorStore';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Remove a virtual I2C device from both AVR (i2cBus) and RP2040 simulators.
 */
function removeI2CDevice(simulator: any, address: number): void {
  simulator.i2cBus?.removeDevice(address);
  simulator.removeI2CDevice?.(address, 0);
  simulator.removeI2CDevice?.(address, 1);
}

// ─── SSD1306 OLED ────────────────────────────────────────────────────────────

/**
 * SSD1306Core — shared GDDRAM buffer, command decoder, and rendering logic.
 *
 * The SSD1306 command set is identical for I2C and SPI; only the transport
 * differs.  This core is used by both VirtualSSD1306 (I2C) and
 * attachSSD1306SPI (SPI).
 *
 * Supported commands:
 *  - 0x20 Set Memory Addressing Mode (horizontal / vertical / page)
 *  - 0x21 Set Column Address
 *  - 0x22 Set Page Address
 *  - 0x40–0x7F Set Display Start Line
 *  - 0xAF Display ON / 0xAE Display OFF
 *  - All other parameterized commands are parsed but ignored.
 */
class SSD1306Core {
  /** 1024-byte GDDRAM: 8 pages × 128 columns. Each byte = 8 vertical pixels. */
  readonly buffer = new Uint8Array(128 * 8);

  // GDDRAM cursor
  private col = 0;
  private page = 0;
  private colStart = 0;
  private colEnd = 127;
  private pageStart = 0;
  private pageEnd = 7;
  // 0=horizontal, 1=vertical, 2=page. SSD1306 power-on default is PAGE
  // addressing (datasheet 10b). Adafruit_SSD1306 overrides it to horizontal
  // via 0x20,0x00; page-mode drivers (Tiny4kOLED, U8g2 page buffer) rely on
  // this default and never send 0x20 — so the default MUST be 2 or their
  // setCursor (0xB0-0xB7 + 0x00-0x1F) renders garbled.
  private memMode = 2;

  // Multi-byte command accumulation
  private cmdBuf: number[] = [];
  private cmdWant = 0;

  /** How many parameter bytes does this command require? */
  static cmdParams(cmd: number): number {
    if (
      cmd === 0x20 ||
      cmd === 0x81 ||
      cmd === 0x8d ||
      cmd === 0xa8 ||
      cmd === 0xd3 ||
      cmd === 0xd5 ||
      cmd === 0xd8 ||
      cmd === 0xd9 ||
      cmd === 0xda ||
      cmd === 0xdb
    )
      return 1;
    if (cmd === 0x21 || cmd === 0x22) return 2;
    return 0;
  }

  /** Write a data byte to GDDRAM and advance cursor. */
  writeData(value: number): void {
    this.buffer[this.page * 128 + this.col] = value;
    this.advanceCursor();
  }

  /** Feed a command or parameter byte. Multi-byte commands are accumulated. */
  writeCommand(value: number): void {
    if (this.cmdWant > 0) {
      this.cmdBuf.push(value);
      this.cmdWant--;
      if (this.cmdWant === 0) this.applyCmd();
      return;
    }
    this.cmdBuf = [value];
    this.cmdWant = SSD1306Core.cmdParams(value);
    if (this.cmdWant === 0) this.applyCmd();
  }

  private applyCmd(): void {
    const [cmd, p1, p2] = this.cmdBuf;
    switch (cmd) {
      case 0x20:
        this.memMode = p1 & 0x03;
        break;
      case 0x21:
        this.colStart = p1 & 0x7f;
        this.colEnd = p2 & 0x7f;
        this.col = this.colStart;
        break;
      case 0x22:
        this.pageStart = p1 & 0x07;
        this.pageEnd = p2 & 0x07;
        this.page = this.pageStart;
        break;
      default:
        // Page-addressing-mode cursor commands (single-byte). Used by
        // Tiny4kOLED / U8g2 page buffer / classic SSD1306 drivers whose
        // setCursor() does NOT use the 0x21/0x22 column/page-range commands.
        if (cmd >= 0xb0 && cmd <= 0xb7) {
          // set page start address (B0..B7 → page 0..7)
          this.page = cmd & 0x07;
        } else if (cmd <= 0x0f) {
          // set lower column nibble (0x00..0x0F)
          this.col = (this.col & 0xf0) | (cmd & 0x0f);
        } else if (cmd >= 0x10 && cmd <= 0x1f) {
          // set higher column nibble (0x10..0x1F)
          this.col = (this.col & 0x0f) | ((cmd & 0x0f) << 4);
        } else if (cmd >= 0x40 && cmd <= 0x7f) {
          /* display start line — visual, skip */
        }
        break;
    }
  }

  private advanceCursor(): void {
    if (this.memMode === 0) {
      // horizontal addressing
      this.col++;
      if (this.col > this.colEnd) {
        this.col = this.colStart;
        this.page++;
        if (this.page > this.pageEnd) this.page = this.pageStart;
      }
    } else if (this.memMode === 1) {
      // vertical addressing
      this.page++;
      if (this.page > this.pageEnd) {
        this.page = this.pageStart;
        this.col++;
        if (this.col > this.colEnd) this.col = this.colStart;
      }
    } else {
      // page addressing
      this.col++;
      if (this.col > this.colEnd) this.col = this.colStart;
    }
  }

  /**
   * Push the 1-bit GDDRAM buffer to the wokwi-ssd1306 web component.
   *
   * wokwi-ssd1306 API:
   *   - `element.imageData` — a 128×64 ImageData (RGBA, 4 bytes/pixel)
   *   - `element.redraw()` — flushes imageData to the internal canvas
   */
  syncElement(element: HTMLElement): void {
    const el = element as any;
    if (!el) return;

    let imgData: ImageData | undefined = el.imageData;
    if (!imgData || imgData.width !== 128 || imgData.height !== 64) {
      try {
        imgData = new ImageData(128, 64);
      } catch {
        return;
      }
    }

    const px = imgData.data;

    for (let page = 0; page < 8; page++) {
      for (let col = 0; col < 128; col++) {
        const byte = this.buffer[page * 128 + col];
        for (let bit = 0; bit < 8; bit++) {
          const row = page * 8 + bit;
          const lit = (byte >> bit) & 1;
          const idx = (row * 128 + col) * 4;
          px[idx] = lit ? 200 : 0; // R
          px[idx + 1] = lit ? 230 : 0; // G
          px[idx + 2] = lit ? 255 : 0; // B
          px[idx + 3] = 255; // A
        }
      }
    }

    el.imageData = imgData;
    if (typeof el.redraw === 'function') el.redraw();
  }
}

/**
 * VirtualSSD1306 — I2C wrapper around SSD1306Core.
 *
 * Handles the I2C control byte (0x00 = command stream, 0x40 = data stream)
 * and delegates command/data writes to the shared core.
 */
class VirtualSSD1306 implements I2CDevice {
  address: number;
  private readonly core = new SSD1306Core();

  private ctrlByte = true;
  private isData = false;

  constructor(
    address: number,
    private element: HTMLElement,
  ) {
    this.address = address;
  }

  /** Expose core buffer for tests. */
  get buffer(): Uint8Array {
    return this.core.buffer;
  }

  writeByte(value: number): boolean {
    if (this.ctrlByte) {
      this.isData = (value & 0x40) !== 0;
      this.ctrlByte = false;
      return true;
    }
    if (this.isData) {
      this.core.writeData(value);
    } else {
      this.core.writeCommand(value);
    }
    return true;
  }

  readByte(): number {
    return 0xff;
  }

  stop(): void {
    this.ctrlByte = true;
    this.core.syncElement(this.element);
  }
}

/**
 * Attach SSD1306 in SPI mode — intercepts the AVR SPI bus.
 *
 * Follows the same pattern as ILI9341 (ComplexParts.ts): hook spi.onByte,
 * track DC pin state via PinManager, and render GDDRAM to the element.
 */
function attachSSD1306SPI(
  element: HTMLElement,
  simulator: any,
  getPin: (name: string) => number | null,
): () => void {
  const pinManager = simulator.pinManager;
  const spi = simulator.spi;
  if (!pinManager || !spi) return () => {};

  const core = new SSD1306Core();
  let dcState = false;
  const unsubs: (() => void)[] = [];

  // Track DC pin (LOW = command, HIGH = data)
  const pinDC = getPin('DC');
  if (pinDC !== null) {
    unsubs.push(
      pinManager.onPinChange(pinDC, (_: number, s: boolean) => {
        dcState = s;
      }),
    );
  }

  // Throttle rendering to ~60 fps
  let dirty = false;
  let rafId: number | null = null;
  const scheduleSync = () => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (dirty) {
        core.syncElement(element);
        dirty = false;
      }
    });
  };

  // Hook AVR SPI bus (onByte + completeTransfer)
  const prevOnByte = spi.onByte;
  spi.onByte = (value: number) => {
    if (!dcState) {
      core.writeCommand(value);
    } else {
      core.writeData(value);
      dirty = true;
      scheduleSync();
    }
    spi.completeTransfer(0xff);
  };

  return () => {
    spi.onByte = prevOnByte;
    if (rafId !== null) cancelAnimationFrame(rafId);
    unsubs.forEach((u) => u());
  };
}

/**
 * Internal: SSD1306 attach logic, parameterised over the wire protocol.
 * Called by the single `ssd1306` entry once the protocol has been resolved
 * (auto-detected from the wiring, or read from an explicit `protocol` property).
 */
function attachSSD1306(
  element: HTMLElement,
  simulator: unknown,
  getPin: (n: string) => number | null,
  protocol: 'i2c' | 'spi',
  i2cAddr = 0x3c,
): () => void {
  if (protocol === 'spi') {
    return attachSSD1306SPI(element, simulator, getPin);
  }
  const sim = simulator as any;
  const device = new VirtualSSD1306(i2cAddr, element);

  // The ESP32/STM32 bridge shims expose registerSensor (backend QEMU slave) +
  // addI2CTransactionListener (framebuffer bytes streamed back) AND addI2CDevice
  // (frontend bus for the cross-board Interconnect). AVR / RP2040 also carry a
  // registerSensor() stub that returns false, so they enter this branch too —
  // harmlessly: registerSensor no-ops, the absent addI2CTransactionListener is
  // skipped, and the real attach happens via the addI2CDevice mirror below.
  if (typeof sim.registerSensor === 'function') {
    // ── ESP32 / STM32 (and AVR/RP2040 via the addI2CDevice mirror) ──────────
    const virtualPin = 200 + i2cAddr;
    sim.registerSensor('ssd1306', virtualPin, { addr: i2cAddr });
    sim.addI2CTransactionListener?.(i2cAddr, (data: number[]) => {
      data.forEach((b: number) => device.writeByte(b));
      device.stop();
    });
    // Mirror on the frontend bus so peer boards reading across an
    // I2C bridge can also reach the device.
    sim.addI2CDevice?.(device);
    return () => {
      sim.unregisterSensor(virtualPin);
      sim.removeI2CTransactionListener?.(i2cAddr);
      sim.removeI2CDevice?.(i2cAddr, 0);
    };
  } else if (typeof sim.addI2CDevice === 'function') {
    // ── AVR / RP2040 path ──────────────────────────────────────────────────
    sim.addI2CDevice(device);
    return () => removeI2CDevice(sim, device.address);
  }
  return () => {};
}

/**
 * Which wire protocol did the user build?  A real SSD1306 breakout is ONE board
 * that talks either I2C or SPI depending on how it is wired.  The definitive
 * SPI-only signal is chip-select (CS): I2C never uses it.  (DC deliberately does
 * NOT count — on the 8-pin module DC doubles as the I2C address-select/SA0 line,
 * so many I2C circuits wire it too.)  So CS wired to a GPIO => SPI, otherwise
 * I2C.  This mirrors the physical part — one component, no protocol switch to
 * set, just wire it up.
 *
 * Pure wiring check: it deliberately does NOT read `simulator.spi`, whose getter
 * on some boards (RP2040, and the ESP32/STM32 bridge shims) lazily re-routes the
 * board SPI bus as a side effect and must not fire in I2C mode.
 */
function detectSSD1306Protocol(getPin: (n: string) => number | null): 'i2c' | 'spi' {
  return getPin('CS') !== null ? 'spi' : 'i2c';
}

/**
 * SSD1306 OLED — a single component that works on every board with an I2C or
 * SPI bus (AVR, RP2040, ESP32, STM32).  New projects just wire it up and the
 * protocol is auto-detected from the wiring like the physical module; a
 * `protocol` property, when present, pins it explicitly (projects migrated from
 * the old ssd1306-i2c / ssd1306-spi entries carry it so their behaviour is
 * preserved exactly).  Consolidates the old three picker entries into one
 * (issues #101 / #215).
 */
PartSimulationRegistry.register('ssd1306', {
  attachEvents: (element, simulator, getPin, componentId) => {
    const { components } = useSimulatorStore.getState();
    const comp = components.find((c) => c.id === componentId);
    const i2cAddr = parseI2cAddress(comp?.properties?.i2cAddress, 0x3c);
    const explicit = comp?.properties?.protocol;
    const protocol: 'i2c' | 'spi' =
      explicit === 'i2c' || explicit === 'spi' ? explicit : detectSSD1306Protocol(getPin);
    return attachSSD1306(element, simulator, getPin, protocol, i2cAddr);
  },
});

/**
 * SSD1306 OLED (I2C, 4-pin) — the cheap `velxio-ssd1306-i2c` module (GND/VCC/
 * SCL/SDA). Same display core as the 8-pin part but I2C-only by construction,
 * so there's no protocol to detect. Issue #215.
 */
PartSimulationRegistry.register('ssd1306-i2c-4pin', {
  attachEvents: (element, simulator, getPin, componentId) => {
    const { components } = useSimulatorStore.getState();
    const comp = components.find((c) => c.id === componentId);
    const i2cAddr = parseI2cAddress(comp?.properties?.i2cAddress, 0x3c);
    return attachSSD1306(element, simulator, getPin, 'i2c', i2cAddr);
  },
});

// ─── DS1307 RTC ──────────────────────────────────────────────────────────────

/**
 * DS1307 Real-Time Clock — uses the pre-built VirtualDS1307 from I2CBusManager.
 * Returns the browser's current system time in BCD format for registers 0–6.
 */
PartSimulationRegistry.register('ds1307', {
  attachEvents: (_element, simulator, _getPin) => {
    const sim = simulator as any;
    const rtc = new VirtualDS1307();

    if (typeof sim.registerSensor === 'function') {
      // ── ESP32 path: backend QEMU RTC slave + frontend bus mirror ────────
      const virtualPin = 200 + 0x68;
      sim.registerSensor('ds1307', virtualPin, { addr: 0x68 });
      sim.addI2CDevice?.(rtc);
      return () => {
        sim.unregisterSensor(virtualPin);
        sim.removeI2CDevice?.(rtc.address, 0);
      };
    } else if (typeof sim.addI2CDevice === 'function') {
      // ── AVR / RP2040 path ──────────────────────────────────────────────────
      sim.addI2CDevice(rtc);
      return () => removeI2CDevice(sim, rtc.address);
    }

    return () => {};
  },
});

// ─── MPU-6050 IMU ────────────────────────────────────────────────────────────

/**
 * Virtual MPU-6050 — 6-axis IMU register simulation at I2C address 0x68.
 *
 * Pre-loaded registers:
 *  0x75 WHO_AM_I = 0x68
 *  0x6B PWR_MGMT_1 = 0x00  (already awake — no need to write 0 to wake)
 *  0x3B–0x40 ACCEL XYZ = (0, 0, +1g = 0x4000) — device sitting flat
 *  0x41–0x42 TEMP_OUT   = ~25°C
 *  0x43–0x48 GYRO XYZ  = 0 (stationary)
 *
 * The sketch can write to set register pointer, then read sequentially.
 */
class VirtualMPU6050 implements I2CDevice {
  address: number;
  registers = new Uint8Array(256);
  private regPtr = 0;
  private firstByte = true;

  constructor(address: number) {
    this.address = address;

    // WHO_AM_I
    this.registers[0x75] = 0x68;
    // PWR_MGMT_1: device awake by default (0 = no sleep)
    this.registers[0x6b] = 0x00;

    // ACCEL: Z = +1g = +16384 (0x4000) at ±2g full-scale
    this.registers[0x3b] = 0x00; // ACCEL_XOUT_H
    this.registers[0x3c] = 0x00; // ACCEL_XOUT_L
    this.registers[0x3d] = 0x00; // ACCEL_YOUT_H
    this.registers[0x3e] = 0x00; // ACCEL_YOUT_L
    this.registers[0x3f] = 0x40; // ACCEL_ZOUT_H (0x4000 = +16384 = +1g)
    this.registers[0x40] = 0x00; // ACCEL_ZOUT_L

    // TEMP: T(°C) = TEMP_OUT / 340.0 + 36.53
    //  → TEMP_OUT = (25 - 36.53) × 340 ≈ -3920 = 0xF190
    const tempRaw = Math.round((25 - 36.53) * 340) & 0xffff;
    this.registers[0x41] = (tempRaw >> 8) & 0xff;
    this.registers[0x42] = tempRaw & 0xff;

    // GYRO: all zero (stationary)
    // 0x43–0x48 already 0 from Uint8Array initialization
  }

  writeByte(value: number): boolean {
    if (this.firstByte) {
      this.regPtr = value;
      this.firstByte = false;
    } else {
      this.registers[this.regPtr] = value;
      this.regPtr = (this.regPtr + 1) & 0xff;
    }
    return true;
  }

  readByte(): number {
    const val = this.registers[this.regPtr];
    this.regPtr = (this.regPtr + 1) & 0xff;
    return val;
  }

  stop(): void {
    this.firstByte = true;
  }
}

PartSimulationRegistry.register('mpu6050', {
  attachEvents: (element, simulator, _getPin, componentId) => {
    const sim = simulator as any;
    const el = element as any;
    // Respect AD0 pin: `el.ad0 = true` → address 0x69, else 0x68
    const addr = el.ad0 === true || el.ad0 === 'true' ? 0x69 : 0x68;

    if (typeof sim.registerSensor === 'function') {
      // ── ESP32 path: backend QEMU I2C slave + frontend bus mirror ────────
      const virtualPin = 200 + addr;
      const device = new VirtualMPU6050(addr);
      sim.registerSensor('mpu6050', virtualPin, { addr });
      sim.addI2CDevice?.(device);

      const writeI16 = (regH: number, raw: number) => {
        const v = Math.max(-32768, Math.min(32767, Math.round(raw))) & 0xffff;
        device.registers[regH] = (v >> 8) & 0xff;
        device.registers[regH + 1] = v & 0xff;
      };

      registerSensorUpdate(componentId, (values) => {
        sim.updateSensor(virtualPin, values);
        // Keep the frontend-side mirror in sync so peer-master bridge reads
        // see fresh values too.
        if ('accelX' in values) writeI16(0x3b, (values.accelX as number) * 16384);
        if ('accelY' in values) writeI16(0x3d, (values.accelY as number) * 16384);
        if ('accelZ' in values) writeI16(0x3f, (values.accelZ as number) * 16384);
        if ('gyroX' in values) writeI16(0x43, (values.gyroX as number) * 131);
        if ('gyroY' in values) writeI16(0x45, (values.gyroY as number) * 131);
        if ('gyroZ' in values) writeI16(0x47, (values.gyroZ as number) * 131);
        if ('temp' in values) writeI16(0x41, ((values.temp as number) - 36.53) * 340);
      });

      return () => {
        sim.unregisterSensor(virtualPin);
        sim.removeI2CDevice?.(addr, 0);
        unregisterSensorUpdate(componentId);
      };
    } else if (typeof sim.addI2CDevice === 'function') {
      // ── AVR / RP2040 path: virtual I2C device in JavaScript ──────────────
      const device = new VirtualMPU6050(addr);
      sim.addI2CDevice(device);

      const writeI16 = (regH: number, raw: number) => {
        const v = Math.max(-32768, Math.min(32767, Math.round(raw))) & 0xffff;
        device.registers[regH] = (v >> 8) & 0xff;
        device.registers[regH + 1] = v & 0xff;
      };

      registerSensorUpdate(componentId, (values) => {
        if ('accelX' in values) writeI16(0x3b, (values.accelX as number) * 16384);
        if ('accelY' in values) writeI16(0x3d, (values.accelY as number) * 16384);
        if ('accelZ' in values) writeI16(0x3f, (values.accelZ as number) * 16384);
        if ('gyroX' in values) writeI16(0x43, (values.gyroX as number) * 131);
        if ('gyroY' in values) writeI16(0x45, (values.gyroY as number) * 131);
        if ('gyroZ' in values) writeI16(0x47, (values.gyroZ as number) * 131);
        if ('temp' in values) writeI16(0x41, ((values.temp as number) - 36.53) * 340);
      });

      return () => {
        removeI2CDevice(sim, device.address);
        unregisterSensorUpdate(componentId);
      };
    }

    return () => {};
  },
});

// ─── DHT22 Temperature / Humidity Sensor ─────────────────────────────────────

/**
 * DHT22 (AM2302) — single-wire bidirectional protocol.
 *
 * Protocol summary:
 *  1. MCU drives DATA LOW for ≥1 ms  (start signal)
 *  2. MCU releases DATA HIGH
 *  3. DHT22 drives: 80 µs LOW → 80 µs HIGH (response)
 *  4. DHT22 transmits 40 bits: each bit = 50 µs LOW + (26 µs=0 | 70 µs=1) HIGH
 *  5. Data layout: [humidity_H, humidity_L, temp_H, temp_L, checksum]
 *     Humidity in 0.1%, Temperature in 0.1°C (MSB = sign for temp)
 *
 * TIMING NOTE:
 *  Full µs-accuracy requires injecting pin changes inside the CPU execution
 *  loop. This implementation drives DATA via setPinState() after detecting the
 *  start sequence. It works with simple polling-based DHT22 code. The standard
 *  Arduino DHT library uses pulseIn() counts; exact cycle-accuracy is not
 *  achievable without modifying the AVR execution loop.
 *
 * Default values: 50.0% humidity, 25.0°C temperature.
 * These can be changed by setting element properties: `el.temperature`, `el.humidity`.
 */
function buildDHT22Payload(element: HTMLElement): Uint8Array {
  const el = element as any;
  const humidity = Math.round((el.humidity ?? 50.0) * 10); // tenths of %
  const temperature = Math.round((el.temperature ?? 25.0) * 10); // tenths of °C
  const h_H = (humidity >> 8) & 0xff;
  const h_L = humidity & 0xff;
  // Temperature sign bit is bit 15 of the 16-bit value
  const rawTemp = temperature < 0 ? (-temperature & 0x7fff) | 0x8000 : temperature & 0x7fff;
  const t_H = (rawTemp >> 8) & 0xff;
  const t_L = rawTemp & 0xff;
  const chk = (h_H + h_L + t_H + t_L) & 0xff;
  return new Uint8Array([h_H, h_L, t_H, t_L, chk]);
}

/**
 * Schedule the full DHT22 waveform on DATA using cycle-accurate pin changes.
 *
 * DHT22 protocol (after MCU releases DATA HIGH):
 *  - 80 µs LOW  → 80 µs HIGH  (response preamble)
 *  - 40 bits, each: 50 µs LOW + (26 µs HIGH = '0', 70 µs HIGH = '1')
 *  - Line released HIGH after last bit
 *
 * At 16 MHz: 1 µs = 16 cycles
 *  - 80 µs = 1280 cycles, 50 µs = 800 cycles, 26 µs = 416 cycles, 70 µs = 1120 cycles
 */
function scheduleDHT22Response(simulator: any, pin: number, element: HTMLElement): void {
  if (typeof simulator.schedulePinChange !== 'function') {
    // Fallback: synchronous drive (legacy / non-AVR simulators)
    const payload = buildDHT22Payload(element);
    simulator.setPinState(pin, false);
    simulator.setPinState(pin, true);
    for (const byte of payload) {
      for (let b = 7; b >= 0; b--) {
        const bit = (byte >> b) & 1;
        simulator.setPinState(pin, false);
        simulator.setPinState(pin, !!bit);
      }
    }
    simulator.setPinState(pin, true);
    return;
  }

  const payload = buildDHT22Payload(element);
  const now = simulator.getCurrentCycles() as number;

  // Scale timing by CPU clock — AVR runs at 16 MHz, RP2040 at 125 MHz.
  const clockHz: number =
    typeof simulator.getClockHz === 'function' ? simulator.getClockHz() : 16_000_000;
  const us = (microseconds: number) => Math.round((microseconds * clockHz) / 1_000_000);

  const RESPONSE_START = us(20); // DHT22 response start (~20 µs after MCU releases)
  const LOW80 = us(80); // 80 µs LOW preamble
  const HIGH80 = us(80); // 80 µs HIGH preamble
  const LOW50 = us(50); // 50 µs LOW marker before each bit
  const HIGH0 = us(26); // 26 µs HIGH → bit '0'
  const HIGH1 = us(70); // 70 µs HIGH → bit '1'

  let t = now + RESPONSE_START;

  // Preamble: 80 µs LOW
  simulator.schedulePinChange(pin, false, t);
  t += LOW80;
  // Preamble: 80 µs HIGH
  simulator.schedulePinChange(pin, true, t);
  t += HIGH80;

  // 40 data bits, MSB first — schedule LOW then advance, schedule HIGH then advance
  for (const byte of payload) {
    for (let b = 7; b >= 0; b--) {
      const bit = (byte >> b) & 1;
      simulator.schedulePinChange(pin, false, t);
      t += LOW50;
      simulator.schedulePinChange(pin, true, t);
      t += bit ? HIGH1 : HIGH0;
    }
  }

  // Final release
  simulator.schedulePinChange(pin, false, t);
  t += LOW50;
  simulator.schedulePinChange(pin, true, t);
}

PartSimulationRegistry.register('dht22', {
  attachEvents: (element, simulator, getPin, componentId) => {
    // wokwi-dht22 element uses 'SDA' as the data pin name (not 'DATA')
    const pin = getPin('SDA') ?? getPin('DATA');
    if (pin === null) return () => {};

    // Ask the simulator if it handles sensor protocols natively (e.g. ESP32
    // delegates to backend QEMU).  If so, we only forward property updates.
    const el = element as any;
    const temperature = el.temperature ?? 25.0;
    const humidity = el.humidity ?? 50.0;

    const handledNatively =
      typeof (simulator as any).registerSensor === 'function' &&
      (simulator as any).registerSensor('dht22', pin, { temperature, humidity });

    if (handledNatively) {
      registerSensorUpdate(componentId, (values) => {
        if ('temperature' in values) el.temperature = values.temperature as number;
        if ('humidity' in values) el.humidity = values.humidity as number;
        (simulator as any).updateSensor(pin, {
          temperature: el.temperature ?? 25.0,
          humidity: el.humidity ?? 50.0,
        });
      });

      return () => {
        (simulator as any).unregisterSensor(pin);
        unregisterSensorUpdate(componentId);
      };
    }

    let wasLow = false;
    // Prevent DHT22's own scheduled pin changes from re-triggering the response.
    // After the MCU releases DATA HIGH and we begin responding, we ignore all
    // pin-change callbacks until the full waveform has been emitted.
    // DHT22 response is ~5 ms; gate for ~12.5 ms scaled to the CPU clock.

    const clockHz: number =
      typeof (simulator as any).getClockHz === 'function'
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (simulator as any).getClockHz()
        : 16_000_000;
    const RESPONSE_GATE_CYCLES = Math.round((12_500 * clockHz) / 1_000_000);
    let responseEndCycle = 0;
    let responseEndTimeMs = 0; // time-based fallback for ESP32 (no cycle counter)

    const getCycles = (): number =>
      typeof (simulator as any).getCurrentCycles === 'function'
        ? ((simulator as any).getCurrentCycles() as number)
        : -1;

    const unsub = (simulator as any).pinManager.onPinChange(pin, (_: number, state: boolean) => {
      // While DHT22 is driving the line, ignore our own scheduled changes.
      const now = getCycles();
      if (now >= 0 && now < responseEndCycle) return;
      // Time-based fallback for ESP32 (no cycle counter available)
      if (now < 0 && Date.now() < responseEndTimeMs) return;

      if (!state) {
        // MCU drove DATA LOW — start signal detected
        wasLow = true;
        return;
      }
      if (wasLow) {
        // MCU released DATA HIGH — begin DHT22 response
        wasLow = false;
        const cur = getCycles();
        responseEndCycle = cur >= 0 ? cur + RESPONSE_GATE_CYCLES : 0;
        responseEndTimeMs = Date.now() + 20; // 20ms gate for non-cycle simulators
        scheduleDHT22Response(simulator, pin, element);
      }
    });

    // Idle state: DATA HIGH (pulled up)
    simulator.setPinState(pin, true);

    // SensorControlPanel: update temperature / humidity on the element
    registerSensorUpdate(componentId, (values) => {
      const el = element as any;
      if ('temperature' in values) el.temperature = values.temperature as number;
      if ('humidity' in values) el.humidity = values.humidity as number;
    });

    return () => {
      unsub();
      simulator.setPinState(pin, true);
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── HX711 Load Cell Amplifier ────────────────────────────────────────────────

/**
 * HX711 — 24-bit ADC for load cells.
 *
 * Protocol:
 *  - DOUT LOW  = conversion ready
 *  - MCU reads 24 rising CLK edges → DOUT sends 24 bits MSB-first
 *  - 1 extra CLK pulse → gain 128 (channel A, default)
 *  - After 25th pulse falling edge: new conversion starts (DOUT → LOW after ~delay)
 *
 * Default weight: 100 g. Change via element.weight (grams).
 * Raw ADC = weight × 1000 (signed 24-bit two's complement).
 *
 * Taring: Arduino sketches typically call tare() first, which reads the
 * zero offset. This simulation always returns weight × 1000 as the raw value;
 * after taring with 0 g the sketch will correctly read any non-zero value.
 */
PartSimulationRegistry.register('hx711', {
  attachEvents: (element, simulator, getPin) => {
    const pinSCK = getPin('SCK');
    const pinDOUT = getPin('DOUT');
    if (pinSCK === null || pinDOUT === null) return () => {};

    let rawValue = rawFromWeight(element);
    let bitCount = 0;
    let finishing = false;

    function rawFromWeight(el: HTMLElement): number {
      const w = (el as any).weight ?? 100; // grams
      const raw = Math.round(w * 1000); // 24-bit fixed-point
      return Math.max(-8_388_608, Math.min(8_388_607, raw)) & 0xff_ffff;
    }

    // DOUT LOW = next conversion ready
    simulator.setPinState(pinDOUT, false);

    const unsub = (simulator as any).pinManager.onPinChange(
      pinSCK,
      (_: number, rising: boolean) => {
        if (rising) {
          // Rising edge: output the current bit (MSB first), then advance
          if (bitCount < 24) {
            const bit = (rawValue >> (23 - bitCount)) & 1;
            simulator.setPinState(pinDOUT, bit === 1);
            bitCount++;
          } else {
            // 25th pulse → gain select. DOUT driven HIGH (end of word)
            simulator.setPinState(pinDOUT, true);
            finishing = true;
          }
        } else {
          // Falling edge after the 25th pulse → conversion complete
          if (finishing) {
            finishing = false;
            bitCount = 0;
            rawValue = rawFromWeight(element);
            // DOUT LOW = new conversion ready (simulate ~10 ms conversion time)
            setTimeout(() => simulator.setPinState(pinDOUT, false), 10);
          }
        }
      },
    );

    return () => {
      unsub();
      simulator.setPinState(pinDOUT, true); // DOUT HIGH = device idle / power down
    };
  },
});

// ─── IR Receiver ─────────────────────────────────────────────────────────────

/**
 * IR receiver (e.g. VS1838B) — responds to clicks by generating an NEC
 * protocol pulse train on the DATA/OUT pin (active-low: LOW = IR burst).
 *
 * NEC frame on the demodulated output:
 *   9 ms LOW  + 4.5 ms HIGH  (preamble)
 *   8-bit address (MSB first) + 8-bit ~address
 *   8-bit command (MSB first) + 8-bit ~command
 *   Final 562 µs LOW  ("end burst")
 *
 * Default: address 0x00, command 0x45 (NEC remote "POWER" button equivalent).
 * Change by setting `element.irAddress` and `element.irCommand`.
 *
 * TIMING: Each ms-level delay is implemented via setTimeout. This chains
 * ~70 callbacks (35 bits × 2 edges each). Because the simulation runs in
 * requestAnimationFrame batches (~16 ms), the timing will be stretched but
 * the logical transitions are correct for polling-based IR decoders.
 */

function necBitSequence(address: number, command: number): number[] {
  /* Returns interleaved [duration_ms, level, ...] pairs for NEC frame.
     level: 1 = LINE HIGH (no IR / space), 0 = LINE LOW (IR burst / mark) */
  const frames: number[] = [];

  function push(duration: number, level: number) {
    frames.push(duration, level);
  }

  // Preamble
  push(9, 0); // 9 ms mark
  push(4.5, 1); // 4.5 ms space

  // Build 32 bits: addr, ~addr, cmd, ~cmd
  const bytes = [address & 0xff, ~address & 0xff, command & 0xff, ~command & 0xff];
  for (const byte of bytes) {
    for (let b = 0; b < 8; b++) {
      // LSB first for NEC
      const bit = (byte >> b) & 1;
      push(0.562, 0); // 562 µs mark (same for 0 and 1)
      push(bit ? 1.687 : 0.562, 1); // space: 1687 µs=1, 562 µs=0
    }
  }

  // Final burst
  push(0.562, 0);

  return frames;
}

function driveNECSequence(simulator: any, pin: number, address: number, command: number): void {
  const frames = necBitSequence(address, command);
  let i = 0;

  function next(): void {
    if (i >= frames.length) {
      simulator.setPinState(pin, true); // idle HIGH
      return;
    }
    const duration = frames[i++];
    const level = frames[i++];
    simulator.setPinState(pin, level === 1); // active-low: LOW=burst, HIGH=space
    setTimeout(next, duration);
  }

  next();
}

PartSimulationRegistry.register('ir-receiver', {
  attachEvents: (element, simulator, getPin) => {
    const pin = getPin('OUT') ?? getPin('DATA');
    if (pin === null) return () => {};

    // Idle: pin HIGH (no IR)
    simulator.setPinState(pin, true);

    const onClick = () => {
      const el = element as any;
      const address = (el.irAddress ?? 0x00) & 0xff;
      const command = (el.irCommand ?? 0x45) & 0xff;
      driveNECSequence(simulator, pin, address, command);
    };

    element.addEventListener('click', onClick);
    return () => {
      element.removeEventListener('click', onClick);
      simulator.setPinState(pin, true);
    };
  },
});

// ─── IR Remote ───────────────────────────────────────────────────────────────

/**
 * IR remote control — each button click:
 *  1. Fires an `ir-signal` CustomEvent on the element with {address, command}
 *  2. Drives the IR output pin (if connected) with the NEC pulse sequence
 *
 * Button → command mapping (NEC standard SHARP-style remote):
 *   0–9 → commands 0x16, 0x0C, 0x18, 0x5E, 0x08, 0x1C, 0x5A, 0x42, 0x52, 0x4A
 *   VOL+→0x40, VOL-→0x00, CH+→0x48, CH-→0x0D, POWER→0x45, MUTE→0x09
 *
 * The element should dispatch `button-press` events with `detail.key` naming
 * the button (matches typical wokwi IR remote element events). We listen for
 * both 'button-press' from the element model and 'click' as fallback.
 */
const IR_REMOTE_COMMANDS: Record<string, number> = {
  '0': 0x16,
  '1': 0x0c,
  '2': 0x18,
  '3': 0x5e,
  '4': 0x08,
  '5': 0x1c,
  '6': 0x5a,
  '7': 0x42,
  '8': 0x52,
  '9': 0x4a,
  'vol+': 0x40,
  'vol-': 0x00,
  'ch+': 0x48,
  'ch-': 0x0d,
  power: 0x45,
  mute: 0x09,
  ok: 0x1b,
  up: 0x46,
  down: 0x15,
  left: 0x44,
  right: 0x43,
};

PartSimulationRegistry.register('ir-remote', {
  attachEvents: (element, simulator, getPin) => {
    const pin = getPin('IR') ?? getPin('OUT');

    // Idle HIGH if pin connected
    if (pin !== null) simulator.setPinState(pin, true);

    const el = element as any;
    const address = (el.irAddress ?? 0x00) & 0xff;

    const onButtonPress = (e: Event) => {
      const key = ((e as CustomEvent).detail?.key ?? '').toLowerCase();
      const command = (IR_REMOTE_COMMANDS[key] ?? 0x45) & 0xff;
      element.dispatchEvent(
        new CustomEvent('ir-signal', {
          bubbles: true,
          detail: { address, command, key },
        }),
      );
      if (pin !== null) driveNECSequence(simulator, pin, address, command);
    };

    const onClick = () => {
      // Fallback for plain click — send POWER code
      const command = 0x45;
      element.dispatchEvent(
        new CustomEvent('ir-signal', {
          bubbles: true,
          detail: { address, command, key: 'power' },
        }),
      );
      if (pin !== null) driveNECSequence(simulator, pin, address, command);
    };

    element.addEventListener('button-press', onButtonPress);
    element.addEventListener('click', onClick);

    return () => {
      element.removeEventListener('button-press', onButtonPress);
      element.removeEventListener('click', onClick);
      if (pin !== null) simulator.setPinState(pin, true);
    };
  },
});

// ─── MicroSD Card ─────────────────────────────────────────────────────────────

/**
 * MicroSD card — generic SD-over-SPI device with a real backing store.
 *
 * Hooks the hardware SPI peripheral (simulator.spi) — works for AVR and RP2040
 * (both expose the `.spi` adapter). ESP32 runs in QEMU and is a separate path.
 *
 * Implements the SD v2 / SDHC command set the SD.h / SdFat libraries use, so it
 * works generically with any card configuration (not a one-card hack):
 *   - Init/info: CMD0, CMD8 (R7), CMD55+ACMD41, CMD58 (OCR, CCS=1 SDHC),
 *     CMD9 (CSD v2 reflecting SD_CARD_BYTES), CMD10 (CID), CMD13, CMD16.
 *   - Read:  CMD17 (single), CMD18 (multiple, until CMD12) — served from store.
 *   - Write: CMD24 (single), CMD25 (multiple, until stop token 0xFD) — the data
 *     block that follows the command is captured and stored.
 *
 * Addressing: the card advertises SDHC (CCS=1), so CMD17/24 args are BLOCK
 * indices (not byte offsets). Backing store is a sparse Map of 512-byte sectors.
 *
 * An optional pre-built FAT image can be injected via element.sdImageData (the
 * file-upload / auto-copy feature lands files there). The response queue drains
 * one byte per SPI transfer; idle line reads 0xFF.
 */
const SD_BLOCK_SIZE = 512;
// Fixed card capacity (mirrors Wokwi's "no size attribute" model). The backing
// store is SPARSE — only written/loaded blocks allocate — so the advertised
// capacity is free in RAM. Adjustable here; not exposed to the user.
const SD_CARD_BYTES = 64 * 1024 * 1024; // 64 MB
const SD_C_SIZE = Math.floor(SD_CARD_BYTES / (512 * 1024)) - 1; // CSD v2 C_SIZE

PartSimulationRegistry.register('microsd-card', {
  attachEvents: (element, simulator, _getPin) => {
    const spi = (simulator as any).spi;
    if (!spi) return () => {};
    const el = element as any;

    // ── Backing store: sparse map of blockIndex -> 512-byte sector ──────────
    const store = new Map<number, Uint8Array>();
    const readBlock = (idx: number): Uint8Array =>
      store.get(idx) ?? new Uint8Array(SD_BLOCK_SIZE); // unwritten = zeros
    const writeBlock = (idx: number, data: ArrayLike<number>): void => {
      const blk = new Uint8Array(SD_BLOCK_SIZE);
      blk.set(Array.from(data).slice(0, SD_BLOCK_SIZE));
      store.set(idx, blk);
    };

    // Optional pre-built FAT image (Phase 2 sets element.sdImageData). Loaded
    // into the store block-by-block so the firmware can mount + read it.
    (() => {
      const raw = el.sdImageData;
      if (!raw) return;
      const bytes: Uint8Array | null =
        raw instanceof Uint8Array ? raw
        : raw instanceof ArrayBuffer ? new Uint8Array(raw)
        : Array.isArray(raw) ? Uint8Array.from(raw)
        : null;
      if (!bytes) return;
      for (let i = 0; i * SD_BLOCK_SIZE < bytes.length; i++) {
        const slice = bytes.subarray(i * SD_BLOCK_SIZE, (i + 1) * SD_BLOCK_SIZE);
        // Skip all-zero blocks so the store stays sparse (they read back as
        // zeros anyway) — a multi-MB FAT image only allocates its used blocks.
        if (slice.some((b) => b !== 0)) writeBlock(i, slice);
      }
    })();

    // ── 16-byte CSD (v2.0, high-capacity) reflecting SD_CARD_BYTES ──────────
    const buildCSD = (): number[] => [
      0x40, 0x0e, 0x00, 0x32, 0x5b, 0x59, 0x00,
      (SD_C_SIZE >> 16) & 0x3f, (SD_C_SIZE >> 8) & 0xff, SD_C_SIZE & 0xff,
      0x7f, 0x80, 0x0a, 0x40, 0x00, 0x01,
    ];
    // ── 16-byte CID (manufacturer info; values are cosmetic) ────────────────
    const buildCID = (): number[] => [
      0x01, 0x56, 0x58, 0x56, 0x45, 0x4c, 0x58, 0x53, // mfr, "VX", "VELXS"
      0x10, 0x00, 0x00, 0x00, 0x01, 0x01, 0x60, 0x01,
    ];

    // ── SD SPI protocol state machine ───────────────────────────────────────
    const respQueue: number[] = [];
    let cmdBuf: number[] = [];
    let expectingAcmd = false;
    // Phases: 'cmd' (idle/command), and the write data path after CMD24/25.
    let phase: 'cmd' | 'wait-token' | 'recv-data' | 'recv-crc' = 'cmd';
    let dataBuf: number[] = [];
    let crcLeft = 0;
    let writeAddr = 0;
    let multiWrite = false;
    // CMD18 continuous read: keep streaming blocks until CMD12.
    let multiRead = false;
    let readAddr = 0;

    /** Queue a data block as the firmware reads it: token + 512 bytes + CRC. */
    const pushDataBlock = (bytes: ArrayLike<number>): void => {
      respQueue.push(0xfe); // start-block token
      for (let i = 0; i < SD_BLOCK_SIZE; i++) respQueue.push((bytes as any)[i] ?? 0);
      respQueue.push(0xff, 0xff); // CRC (ignored by SPI mode)
    };
    /** Queue R1 + a short (<=16 byte) data block (CSD/CID). */
    const pushShortData = (bytes: number[]): void => {
      respQueue.push(0x00, 0xfe, ...bytes, 0xff, 0xff);
    };

    const processCmd = (raw: number[]): void => {
      const cmd = raw[0] & 0x3f;
      const arg = ((raw[1] << 24) | (raw[2] << 16) | (raw[3] << 8) | raw[4]) >>> 0;
      const isAcmd = expectingAcmd;
      expectingAcmd = false;

      if (isAcmd) {
        if (cmd === 41) { respQueue.push(0x00); return; } // ACMD41 — ready
        if (cmd === 13) { respQueue.push(0x00, 0x00); return; } // ACMD13 SD status (R2)
        // fall through for other ACMDs
      }

      switch (cmd) {
        case 0: respQueue.push(0x01); break; // GO_IDLE -> idle
        case 8: respQueue.push(0x01, 0x00, 0x00, 0x01, 0xaa); break; // SEND_IF_COND (R7)
        case 9: pushShortData(buildCSD()); break; // SEND_CSD
        case 10: pushShortData(buildCID()); break; // SEND_CID
        case 12: multiRead = false; respQueue.push(0x00, 0x00, 0xff); break; // STOP_TRANSMISSION
        case 13: respQueue.push(0x00, 0x00); break; // SEND_STATUS (R2)
        case 16: respQueue.push(0x00); break; // SET_BLOCKLEN (fixed 512)
        // Standard-capacity (SDSC) byte addressing: CMD17/18/24/25 args are BYTE
        // offsets (block*512), not block indices. The Arduino SD library uses
        // this even when the card advertises SDHC, so we present SDSC (CMD58
        // CCS=0) and translate `arg >> 9` -> block. SDSC covers up to 2 GB,
        // plenty for our small card; every SD library supports it.
        case 17: respQueue.push(0x00); pushDataBlock(readBlock(arg >> 9)); break; // READ_SINGLE
        case 18: // READ_MULTIPLE — stream until CMD12
          respQueue.push(0x00);
          readAddr = arg >> 9; multiRead = true;
          pushDataBlock(readBlock(readAddr)); readAddr++;
          break;
        case 24: // WRITE_SINGLE — data block follows
          respQueue.push(0x00); writeAddr = arg >> 9; multiWrite = false; phase = 'wait-token';
          break;
        case 25: // WRITE_MULTIPLE — data blocks follow until stop token
          respQueue.push(0x00); writeAddr = arg >> 9; multiWrite = true; phase = 'wait-token';
          break;
        case 55: respQueue.push(0x01); expectingAcmd = true; break; // APP_CMD prefix
        case 58: respQueue.push(0x00, 0x80, 0xff, 0x80, 0x00); break; // READ_OCR (powered, CCS=0 SDSC)
        default: respQueue.push(0x00); // accept unhandled commands
      }
    };

    const prevOnByte = spi.onByte as ((b: number) => void) | null | undefined;

    spi.onByte = (byte: number) => {
      // Full-duplex: the MISO shifted out for THIS transfer was prepared by
      // earlier bytes, so reply FIRST (from the queue as it stood before this
      // byte), THEN consume this MOSI byte to prepare future MISO. This gives
      // the 1-byte (Ncr) command->response latency real SD cards have — the
      // host reads R1 on the 0xFF clocks it sends AFTER the 6 command bytes,
      // not on the last command byte. Replying after processing broke SD.begin.
      spi.completeTransfer?.(respQueue.length > 0 ? respQueue.shift()! : 0xff);

      switch (phase) {
        case 'cmd':
          if (cmdBuf.length === 0 && (byte & 0xc0) === 0x40) {
            cmdBuf = [byte]; // command start (bit7=0, bit6=1)
          } else if (cmdBuf.length > 0) {
            cmdBuf.push(byte);
            if (cmdBuf.length === 6) { processCmd(cmdBuf); cmdBuf = []; }
          } else if (multiRead && respQueue.length === 0) {
            // Continuous read: refill the next block while the host clocks 0xFF.
            pushDataBlock(readBlock(readAddr)); readAddr++;
          }
          break;
        case 'wait-token':
          if (byte === 0xfe || byte === 0xfc) { phase = 'recv-data'; dataBuf = []; }
          else if (byte === 0xfd) { multiWrite = false; phase = 'cmd'; respQueue.push(0x00); }
          // else 0xFF gap — keep waiting
          break;
        case 'recv-data':
          dataBuf.push(byte);
          if (dataBuf.length === SD_BLOCK_SIZE) { phase = 'recv-crc'; crcLeft = 2; }
          break;
        case 'recv-crc':
          if (--crcLeft === 0) {
            writeBlock(writeAddr, dataBuf);
            writeAddr++;
            respQueue.push(0x05); // data-response: accepted
            phase = multiWrite ? 'wait-token' : 'cmd';
          }
          break;
      }
    };

    return () => {
      spi.onByte = prevOnByte ?? null;
      respQueue.length = 0;
      cmdBuf = [];
      store.clear();
    };
  },
});

// ─── BMP280 Barometric Pressure / Temperature Sensor ─────────────────────────

/**
 * BMP280 — I2C barometric pressure + temperature sensor.
 *
 * Addresses:
 *   0x76 (SDO pin pulled LOW, default)
 *   0x77 (SDO pin pulled HIGH — set element.address = '0x77')
 *
 * The element may expose `temperature` (°C) and `pressure` (hPa) properties
 * that are read on attach and forwarded to the virtual device.
 *
 * The virtual device uses the BMP280 datasheet calibration example to compute
 * raw ADC values for any desired temperature/pressure combination, so Arduino
 * sketches using Adafruit_BMP280 or Bosch's reference driver receive correct
 * compensated readings.
 */
PartSimulationRegistry.register('bmp280', {
  attachEvents: (element, simulator, _getPin, componentId) => {
    const sim = simulator as any;
    const el = element as any;
    const addr = el.address === '0x77' || el.address === 0x77 ? 0x77 : 0x76;
    const initTemp = el.temperature !== undefined ? parseFloat(el.temperature) : 25.0;
    const initPressure = el.pressure !== undefined ? parseFloat(el.pressure) : 1013.25;

    if (typeof sim.registerSensor === 'function') {
      // ── ESP32 path: backend BMP280 slave + frontend bus mirror ──────────
      const virtualPin = 200 + addr;
      const dev = new VirtualBMP280(addr);
      dev.temperatureC = initTemp;
      dev.pressureHPa = initPressure;
      sim.registerSensor('bmp280', virtualPin, { addr, temperature: initTemp, pressure: initPressure });
      sim.addI2CDevice?.(dev);

      registerSensorUpdate(componentId, (values) => {
        sim.updateSensor(virtualPin, values);
        if ('temperature' in values) dev.temperatureC = values.temperature as number;
        if ('pressure' in values) dev.pressureHPa = values.pressure as number;
      });

      return () => {
        sim.unregisterSensor(virtualPin);
        sim.removeI2CDevice?.(addr, 0);
        unregisterSensorUpdate(componentId);
      };
    } else if (typeof sim.addI2CDevice === 'function') {
      // ── AVR / RP2040 path ──────────────────────────────────────────────────
      const dev = new VirtualBMP280(addr);
      dev.temperatureC = initTemp;
      dev.pressureHPa = initPressure;
      sim.addI2CDevice(dev);

      registerSensorUpdate(componentId, (values) => {
        if ('temperature' in values) dev.temperatureC = values.temperature as number;
        if ('pressure' in values) dev.pressureHPa = values.pressure as number;
      });

      return () => {
        removeI2CDevice(sim, dev.address);
        unregisterSensorUpdate(componentId);
      };
    }

    return () => {};
  },
});

// ─── DS3231 Real-Time Clock ───────────────────────────────────────────────────

/**
 * DS3231 — I2C RTC with on-chip temperature sensor (address 0x68).
 *
 * Returns the browser's current system time as BCD in registers 0x00–0x06,
 * identical to DS1307 for the time registers. Additionally exposes:
 *   0x0E  Control register
 *   0x0F  Status register (OSF cleared)
 *   0x11  Temperature MSB (integer °C, signed)
 *   0x12  Temperature LSB (fractional, 0.25°C per bit in bits 7:6)
 *
 * Ambient temperature defaults to 25°C; override via `element.temperature`.
 */
PartSimulationRegistry.register('ds3231', {
  attachEvents: (element, simulator, _getPin, componentId) => {
    const sim = simulator as any;
    const el = element as any;
    const initTemp = el.temperature !== undefined ? parseFloat(el.temperature) : 25.0;

    if (typeof sim.registerSensor === 'function') {
      // ── ESP32 path: backend DS3231 slave + frontend bus mirror ──────────
      const virtualPin = 200 + 0x68;
      const dev = new VirtualDS3231();
      dev.temperatureC = initTemp;
      sim.registerSensor('ds3231', virtualPin, { addr: 0x68, temperature: initTemp });
      sim.addI2CDevice?.(dev);
      registerSensorUpdate(componentId, (values) => {
        sim.updateSensor(virtualPin, values);
        if ('temperature' in values) dev.temperatureC = values.temperature as number;
      });
      return () => {
        sim.unregisterSensor(virtualPin);
        sim.removeI2CDevice?.(dev.address, 0);
        unregisterSensorUpdate(componentId);
      };
    } else if (typeof sim.addI2CDevice === 'function') {
      // ── AVR / RP2040 path ──────────────────────────────────────────────────
      const dev = new VirtualDS3231();
      dev.temperatureC = initTemp;
      sim.addI2CDevice(dev);
      registerSensorUpdate(componentId, (values) => {
        if ('temperature' in values) dev.temperatureC = values.temperature as number;
      });
      return () => {
        removeI2CDevice(sim, dev.address);
        unregisterSensorUpdate(componentId);
      };
    }

    return () => {};
  },
});

// ─── PCF8574 I/O Expander ────────────────────────────────────────────────────

/**
 * PCF8574 — I2C 8-bit quasi-bidirectional I/O expander.
 *
 * Default address: 0x27 (all three address pins HIGH — typical LCD backpack).
 * Override with `element.i2cAddress` (e.g. '0x20', '0x3F').
 *
 * `element.portState` (0–255) sets the external input state visible to the
 * Arduino on a read. Defaults to 0xFF (all pins pulled high / floating input).
 *
 * Writes from the Arduino update `dev.outputLatch` and fire `dev.onWrite`
 * which sets `element.value` so wokwi-LCD-I2C or similar elements can render.
 */
PartSimulationRegistry.register('pcf8574', {
  attachEvents: (element, simulator, _getPin) => {
    const sim = simulator as any;
    const el = element as any;

    // Parse address from element property (accepts '0x27', '39', or numeric)
    let addr = 0x27;
    if (el.i2cAddress !== undefined) {
      const raw = String(el.i2cAddress).trim();
      const parsed =
        raw.startsWith('0x') || raw.startsWith('0X') ? parseInt(raw, 16) : parseInt(raw, 10);
      if (!isNaN(parsed)) addr = parsed;
    }

    const dev = new VirtualPCF8574(addr);
    if (el.portState !== undefined) dev.portState = Number(el.portState) & 0xff;
    dev.onWrite = (value: number) => {
      el.value = value;
    };

    if (typeof sim.registerSensor === 'function') {
      // ── ESP32 path: backend slave + frontend bus mirror ─────────────────
      const virtualPin = 200 + addr;
      sim.registerSensor('pcf8574', virtualPin, { addr });
      sim.addI2CTransactionListener?.(addr, (data: number[]) => {
        if (data.length > 0) dev.writeByte(data[0]);
      });
      sim.addI2CDevice?.(dev);
      return () => {
        sim.unregisterSensor(virtualPin);
        sim.removeI2CTransactionListener?.(addr);
        sim.removeI2CDevice?.(addr, 0);
      };
    } else if (typeof sim.addI2CDevice === 'function') {
      // ── AVR / RP2040 path ──────────────────────────────────────────────────
      sim.addI2CDevice(dev);
      return () => removeI2CDevice(sim, dev.address);
    }

    return () => {};
  },
});

// ─── LCD1602 / LCD2004 with I2C backpack (PCF8574 + HD44780) ────────────────

/**
 * Common parser for an I2C address property coming from a wokwi-element
 * (the metadata exposes `i2cAddress` as a text control; users type
 * "0x27", "39", or just the raw number).
 */
function parseI2cAddress(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'number' && !isNaN(raw)) return raw & 0x7f;
  const s = String(raw).trim();
  if (!s) return fallback;
  const parsed = s.toLowerCase().startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10);
  return isNaN(parsed) ? fallback : parsed & 0x7f;
}

/**
 * Build a part attach function for an LCD with an I2C backpack.  The
 * same logic applies to LCD1602 (16×2) and LCD2004 (20×4); only the
 * geometry differs.
 *
 * On attach:
 *  1. Force the underlying `wokwi-lcd1602` / `wokwi-lcd2004` element
 *     into I2C-pinout mode (`pins='i2c'`) so the user sees the
 *     correct 4-pin backpack header.
 *  2. Pre-fill `characters` with spaces so the screen is clean before
 *     the sketch issues its first Clear command.
 *  3. Create a `VirtualPCF8574` at the configured address.
 *  4. Pipe `pcf.onWrite` → `HD44780Decoder.feedPCF8574Byte`.
 *  5. Reflect the decoder's `characters` + `backlight` snapshots back
 *     onto the element's reactive properties.
 *
 * Works on AVR, RP2040, and the ESP32 backend (same trifurcation
 * pattern as other I2C parts above).
 */
function makeI2cLcdAttach(cols: number, rows: number) {
  return (
    element: HTMLElement,
    simulator: unknown,
    _getPin: (name: string) => number | null,
  ): (() => void) => {
    const sim = simulator as any;
    const el = element as any;

    const addr = parseI2cAddress(el.i2cAddress ?? el.address, 0x27);

    // Switch the underlying LCD element to I2C pin mode + a clean
    // characters buffer.  The host wokwi element re-renders on
    // attribute change.
    try {
      el.pins = 'i2c';
    } catch {
      /* read-only on some implementations — ignore */
    }
    const blankGrid = new Uint8Array(cols * rows).fill(0x20);
    el.characters = blankGrid;
    if (el.backlight === undefined) el.backlight = true;

    const decoder = new HD44780Decoder({ cols, rows });
    decoder.onCharsChange = (chars) => {
      // wokwi-lcd1602 accepts both number[] and Uint8Array.  Use Uint8Array
      // so Lit's change detection sees a new reference.
      el.characters = Uint8Array.from(chars);
    };
    decoder.onBacklightChange = (on) => {
      el.backlight = on;
    };
    decoder.onCursorChange = (snap) => {
      el.cursorX = snap.cursorCol;
      el.cursorY = snap.cursorRow;
      el.cursor = snap.cursorOn;
      el.blink = snap.cursorBlink;
    };

    const pcf = new VirtualPCF8574(addr);
    pcf.onWrite = (v: number) => decoder.feedPCF8574Byte(v);

    if (typeof sim.registerSensor === 'function') {
      // ── ESP32 path: backend QEMU PCF8574 slave forwards transactions
      //    back to us, and the same VirtualPCF8574 is also on the frontend
      //    bus so peer boards can reach it via the I2C bridge. ─────────
      const virtualPin = 200 + addr;
      sim.registerSensor('pcf8574', virtualPin, { addr });
      sim.addI2CTransactionListener?.(addr, (data: number[]) => {
        for (const b of data) decoder.feedPCF8574Byte(b);
      });
      sim.addI2CDevice?.(pcf);
      return () => {
        sim.unregisterSensor(virtualPin);
        sim.removeI2CTransactionListener?.(addr);
        sim.removeI2CDevice?.(addr, 0);
        decoder.reset();
      };
    } else if (typeof sim.addI2CDevice === 'function') {
      // ── AVR / RP2040 path ────────────────────────────────────────────
      sim.addI2CDevice(pcf);
      return () => {
        removeI2CDevice(sim, pcf.address);
        decoder.reset();
      };
    }

    return () => decoder.reset();
  };
}

/**
 * LCD 16×2 with PCF8574 I2C backpack — the classic "I2C LCD" you buy
 * in a single piece on AliExpress.  Default address 0x27.
 */
PartSimulationRegistry.register('lcd1602-i2c', {
  attachEvents: makeI2cLcdAttach(16, 2),
});

/**
 * LCD 20×4 with PCF8574 I2C backpack.  Same protocol; uses the 2004
 * DDRAM row offsets (0x00, 0x40, 0x14, 0x54).
 */
PartSimulationRegistry.register('lcd2004-i2c', {
  attachEvents: makeI2cLcdAttach(20, 4),
});
