export type BoardKind =
  | 'arduino-uno'
  | 'arduino-nano'
  | 'arduino-mega'
  | 'raspberry-pi-pico' // RP2040, browser emulation
  | 'pi-pico-w' // RP2040 + WiFi, browser emulation (WiFi ignored)
  | 'raspberry-pi-zero' // QEMU virt + Cortex-A7 (armhf), backend — looks-like Pi Zero
  | 'raspberry-pi-1'    // QEMU virt + Cortex-A7 (armhf), backend — looks-like Pi 1
  | 'raspberry-pi-2'    // QEMU virt + Cortex-A7 (armhf), backend
  | 'raspberry-pi-3' // QEMU virt + Cortex-A53, backend
  | 'raspberry-pi-4' // QEMU virt + Cortex-A72, backend
  | 'raspberry-pi-5' // QEMU virt + Cortex-A76, backend
  | 'esp32' // Xtensa LX6, QEMU backend
  | 'esp32-devkit-c-v4' // ESP32 DevKit C V4, QEMU (esp32)
  | 'esp32-cam' // ESP32-CAM, QEMU (esp32)
  | 'wemos-lolin32-lite' // Wemos Lolin32 Lite, QEMU (esp32)
  | 'esp32-s3' // Xtensa LX7, QEMU backend
  | 'xiao-esp32-s3' // Seeed XIAO ESP32-S3, QEMU (esp32-s3)
  | 'arduino-nano-esp32' // Arduino Nano ESP32 (S3), QEMU (esp32-s3)
  | 'esp32-c3' // RISC-V RV32IMC, QEMU backend
  | 'xiao-esp32-c3' // Seeed XIAO ESP32-C3, QEMU backend
  | 'aitewinrobot-esp32c3-supermini' // ESP32-C3 SuperMini, QEMU backend
  | 'stm32-bluepill' // STM32F103C8 (Cortex-M3), QEMU backend (libqemu-arm)
  | 'stm32-blackpill' // STM32F411CE (Cortex-M4), QEMU backend (libqemu-arm)
  | 'stm32-bluepill-f103cb' // STM32F103CB (Cortex-M3, 128KB), QEMU (F100 SoC)
  | 'stm32-blackpill-f401' // STM32F401CE (Cortex-M4), QEMU (F405 SoC)
  | 'stm32-f4-discovery' // STM32F407VG Discovery (Cortex-M4), QEMU (F405 SoC)
  | 'stm32-olimex-h405' // Olimex STM32-H405 (F405RG, Cortex-M4), QEMU
  | 'stm32-netduino-plus2' // Netduino Plus 2 (F405, Cortex-M4), QEMU
  | 'stm32-netduino2' // Netduino 2 (F205, Cortex-M3), QEMU (serial until F205 GPIO wired)
  | 'attiny85'; // AVR ATtiny85, browser emulation (avr8js)

export type LanguageMode = 'arduino' | 'micropython' | 'espidf';

/** True for every Raspberry Pi backed by the QEMU bridge (Zero, 1, 2, 3, 4, 5).
 *  Excludes the Pico boards (RP2040, browser emulation). */
export function isPiBoardKind(kind: BoardKind | string): boolean {
  return typeof kind === 'string' && kind.startsWith('raspberry-pi-')
    && kind !== 'raspberry-pi-pico';
}

/** True for STM32 boards backed by the QEMU bridge (libqemu-arm via
 *  stm32_lib_manager). */
export function isStm32BoardKind(kind: BoardKind | string): boolean {
  return typeof kind === 'string' && kind.startsWith('stm32-');
}

export const BOARD_SUPPORTS_MICROPYTHON = new Set<BoardKind>([
  'raspberry-pi-pico',
  'pi-pico-w',
  // ESP32 Xtensa (QEMU bridge)
  'esp32',
  'esp32-devkit-c-v4',
  'esp32-cam',
  'wemos-lolin32-lite',
  // ESP32-S3 Xtensa (QEMU bridge)
  'esp32-s3',
  'xiao-esp32-s3',
  'arduino-nano-esp32',
  // ESP32-C3 RISC-V (QEMU bridge)
  'esp32-c3',
  'xiao-esp32-c3',
  'aitewinrobot-esp32c3-supermini',
]);

/** Boards that can run pure ESP-IDF projects (app_main entry point, IDF
 *  APIs only — no Arduino core). The backend compiles them through the same
 *  ESP-IDF toolchain it already uses for ESP32 Arduino sketches, just
 *  without the arduino-esp32 component. ESP32 family only (issue #139). */
export const BOARD_SUPPORTS_ESPIDF = new Set<BoardKind>([
  // ESP32 Xtensa (QEMU bridge)
  'esp32',
  'esp32-devkit-c-v4',
  'esp32-cam',
  'wemos-lolin32-lite',
  // ESP32-S3 Xtensa (QEMU bridge)
  'esp32-s3',
  'xiao-esp32-s3',
  'arduino-nano-esp32',
  // ESP32-C3 RISC-V (QEMU bridge)
  'esp32-c3',
  'xiao-esp32-c3',
  'aitewinrobot-esp32c3-supermini',
]);

export interface WifiStatus {
  status: string; // 'initializing' | 'connected' | 'got_ip' | 'disconnected'
  ssid?: string;
  ip?: string;
}

export interface BleStatus {
  status: string; // 'initialized' | 'advertising'
}

export interface BoardInstance {
  id: string; // unique in canvas, e.g. 'arduino-uno', 'raspberry-pi-3'
  /** Optional user-given display name. Falls back to the kind label when
   *  empty. Lets the user tell two same-kind boards apart in the file
   *  explorer, the compile console, and the canvas selector. */
  name?: string;
  boardKind: BoardKind;
  x: number;
  y: number;
  running: boolean;
  // QEMU-Linux (Raspberry Pi 3/4/5/Zero/1/2) only. `running` flips true the
  // instant the user clicks Start (the WebSocket opens in ~1s), but the guest
  // Linux still takes 30-60s to reach a shell. `piBooted` flips true only when
  // the bridge sees the boot-complete marker, and drives the "Booting…" overlay
  // and gates file uploads. Undefined/false for non-Pi boards and pre-boot.
  piBooted?: boolean;
  compiledProgram: string | null; // hex for AVR/RP2040, null for Pi (runs Python)
  serialOutput: string;
  serialBaudRate: number;
  serialMonitorOpen: boolean;
  activeFileGroupId: string;
  languageMode: LanguageMode; // 'arduino' (default), 'micropython' or 'espidf'
  hasWifi?: boolean; // set by compiler — true when sketch uses WiFi
  wifiStatus?: WifiStatus;
  bleStatus?: BleStatus;
  // ESP32-only — populated when the user opens Board Options... on the
  // canvas context menu. Undefined for AVR / RP2040 / Pi3 and for
  // pre-feature saved projects (compiler falls back to defaults).
  // Types live in `./boardOptions` to avoid a circular import.
  boardOptions?: import('./boardOptions').ESP32BoardOptions;
  spiffsFiles?: import('./boardOptions').SpiffsFile[];
  // P2.4 — this board's declared library manifest (its velxio.json). The ESP32
  // compile scope: each board resolves ONLY its own declared libraries, so two
  // boards in the same project can use different (even conflicting) libraries
  // without clashing. Undefined for pre-feature boards (-> legacy scan-all).
  libraries?: string[];
}

export const BOARD_KIND_LABELS: Record<BoardKind, string> = {
  'arduino-uno': 'Arduino Uno',
  'arduino-nano': 'Arduino Nano',
  'arduino-mega': 'Arduino Mega 2560',
  'raspberry-pi-pico': 'Raspberry Pi Pico',
  'pi-pico-w': 'Raspberry Pi Pico W',
  'raspberry-pi-zero': 'Raspberry Pi Zero',
  'raspberry-pi-1': 'Raspberry Pi 1B+',
  'raspberry-pi-2': 'Raspberry Pi 2B',
  'raspberry-pi-3': 'Raspberry Pi 3B',
  'raspberry-pi-4': 'Raspberry Pi 4B',
  'raspberry-pi-5': 'Raspberry Pi 5',
  esp32: 'ESP32 DevKit V1',
  'esp32-devkit-c-v4': 'ESP32 DevKit C V4',
  'esp32-cam': 'ESP32-CAM',
  'wemos-lolin32-lite': 'Wemos Lolin32 Lite',
  'esp32-s3': 'ESP32-S3 DevKit',
  'xiao-esp32-s3': 'XIAO ESP32-S3',
  'arduino-nano-esp32': 'Arduino Nano ESP32',
  'esp32-c3': 'ESP32-C3 DevKit',
  'xiao-esp32-c3': 'XIAO ESP32-C3',
  'aitewinrobot-esp32c3-supermini': 'ESP32-C3 SuperMini',
  'stm32-bluepill': 'STM32 Blue Pill',
  'stm32-blackpill': 'STM32 Black Pill',
  'stm32-bluepill-f103cb': 'STM32 Blue Pill (F103CB)',
  'stm32-blackpill-f401': 'STM32 Black Pill (F401)',
  'stm32-f4-discovery': 'STM32F4 Discovery',
  'stm32-olimex-h405': 'Olimex STM32-H405',
  'stm32-netduino-plus2': 'Netduino Plus 2',
  'stm32-netduino2': 'Netduino 2',
  attiny85: 'ATtiny85',
};

/** Display name for a board instance: the user's custom name if set, else the
 *  kind label. Route every user-facing board label through this so renamed
 *  boards show their name everywhere (file explorer, compile console, canvas). */
export function boardDisplayName(board: Pick<BoardInstance, 'name' | 'boardKind'>): string {
  return board.name?.trim() || BOARD_KIND_LABELS[board.boardKind];
}

export const BOARD_KIND_FQBN: Record<BoardKind, string | null> = {
  'arduino-uno': 'arduino:avr:uno',
  'arduino-nano': 'arduino:avr:nano:cpu=atmega328',
  'arduino-mega': 'arduino:avr:mega',
  'raspberry-pi-pico': 'rp2040:rp2040:rpipico',
  'pi-pico-w': 'rp2040:rp2040:rpipicow',
  'raspberry-pi-zero': null,
  'raspberry-pi-1': null,
  'raspberry-pi-2': null,
  'raspberry-pi-3': null,
  'raspberry-pi-4': null,
  'raspberry-pi-5': null,
  esp32: 'esp32:esp32:esp32',
  'esp32-devkit-c-v4': 'esp32:esp32:esp32',
  'esp32-cam': 'esp32:esp32:esp32cam',
  'wemos-lolin32-lite': 'esp32:esp32:lolin32-lite',
  'esp32-s3': 'esp32:esp32:esp32s3',
  'xiao-esp32-s3': 'esp32:esp32:XIAO_ESP32S3',
  'arduino-nano-esp32': 'esp32:esp32:nano_nora',
  'esp32-c3': 'esp32:esp32:esp32c3',
  'xiao-esp32-c3': 'esp32:esp32:XIAO_ESP32C3',
  'aitewinrobot-esp32c3-supermini': 'esp32:esp32:esp32c3',
  'stm32-bluepill': 'STMicroelectronics:stm32:GenF1:pnum=BLUEPILL_F103C8',
  'stm32-blackpill': 'STMicroelectronics:stm32:GenF4:pnum=BLACKPILL_F411CE',
  'stm32-bluepill-f103cb': 'STMicroelectronics:stm32:GenF1:pnum=BLUEPILL_F103CB',
  'stm32-blackpill-f401': 'STMicroelectronics:stm32:GenF4:pnum=BLACKPILL_F401CE',
  'stm32-f4-discovery': 'STMicroelectronics:stm32:Disco:pnum=DISCO_F407VG',
  'stm32-olimex-h405': 'STMicroelectronics:stm32:GenF4:pnum=GENERIC_F405RGTX',
  'stm32-netduino-plus2': 'STMicroelectronics:stm32:GenF4:pnum=GENERIC_F405RGTX',
  'stm32-netduino2': 'STMicroelectronics:stm32:GenF2:pnum=GENERIC_F205RGTX',
  attiny85: 'ATTinyCore:avr:attinyx5:chip=85,clock=16pll',
};
