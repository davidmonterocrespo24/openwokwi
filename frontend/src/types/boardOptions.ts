// Per-board ESP32 build options, mirroring the Arduino IDE Tools menu.
// Values get serialised inside the board entry of `boards_json` (no DB
// migration). The backend translates them into sdkconfig knobs and a
// generated partitions.csv at compile time.
//
// Non-ESP32 boards (AVR / RP2040 / Pi3) leave these undefined — the
// modal isn't exposed there.

import type { BoardKind } from './board';

export type ESP32PartitionScheme =
  | 'default'           // 1.2MB APP / 1.5MB SPIFFS (OTA)
  | 'defaults_ffat'     // 1.2MB APP / 1.5MB FATFS (OTA)
  | 'min_spiffs'        // 1.9MB APP / 190KB SPIFFS (OTA) — current Velxio default
  | 'no_ota'            // 2MB APP / 2MB SPIFFS
  | 'no_fs'             // 2MB APP x2, no filesystem
  | 'huge_app'          // 3MB APP / 1MB SPIFFS (no OTA)
  | 'min_ffat'          // 1.9MB APP / 190KB FATFS (OTA)
  | 'large_spiffs'      // 1.9MB APP / 1.4MB SPIFFS (no OTA)
  | 'rainmaker';        // 1.9MB APP x2 with rainmaker fctry (OTA)

export type ESP32CpuFreq = 240 | 160 | 80 | 40 | 20 | 10;
export type ESP32FlashMode = 'qio' | 'dio' | 'qout' | 'dout';
export type ESP32FlashSize = '4MB' | '8MB' | '16MB';
export type ESP32FlashFreq = '80' | '40';
export type ESP32PsramMode = 'disabled' | 'enabled' | 'opi';
export type ESP32CoreDebugLevel = 'none' | 'error' | 'warn' | 'info' | 'debug' | 'verbose';
export type ESP32CoreSelect = 0 | 1;

export interface ESP32BoardOptions {
  partitionScheme: ESP32PartitionScheme;
  cpuFreqMHz: ESP32CpuFreq;
  flashMode: ESP32FlashMode;
  flashSize: ESP32FlashSize;
  flashFreqMHz: ESP32FlashFreq;
  psram: ESP32PsramMode;
  coreDebugLevel: ESP32CoreDebugLevel;
  eraseFlashOnUpload: boolean;
  eventsRunOnCore: ESP32CoreSelect;
  arduinoRunsOnCore: ESP32CoreSelect;
}

// One uploaded file destined for the SPIFFS partition. `contentB64` is a
// raw base64 of the file bytes (no data: prefix). Used for both UI display
// and the compile request body.
export interface SpiffsFile {
  name: string;
  contentB64: string;
  size: number;
}

// Defaults match the historical `sdkconfig.defaults` baked into Velxio
// (DIO @ 40 MHz / 4 MB, min_spiffs, no PSRAM). Picking these as the
// fallback means projects saved before this feature compile bit-for-bit
// the same way after upgrade.
export const DEFAULT_ESP32_OPTIONS: ESP32BoardOptions = {
  partitionScheme: 'min_spiffs',
  cpuFreqMHz: 240,
  flashMode: 'dio',
  flashSize: '4MB',
  flashFreqMHz: '40',
  psram: 'disabled',
  coreDebugLevel: 'none',
  eraseFlashOnUpload: false,
  eventsRunOnCore: 1,
  arduinoRunsOnCore: 1,
};

const ESP32_S3_KINDS: ReadonlySet<BoardKind> = new Set([
  'esp32-s3',
  'xiao-esp32-s3',
  'arduino-nano-esp32',
]);

const ESP32_C3_KINDS: ReadonlySet<BoardKind> = new Set([
  'esp32-c3',
  'xiao-esp32-c3',
  'aitewinrobot-esp32c3-supermini',
  'cyd-esp32-2424s012',
]);

const ESP32_XTENSA_KINDS: ReadonlySet<BoardKind> = new Set([
  'esp32',
  'esp32-devkit-c-v4',
  'esp32-cam',
  'wemos-lolin32-lite',
]);

export function isEsp32Family(kind: BoardKind): boolean {
  return (
    ESP32_XTENSA_KINDS.has(kind) ||
    ESP32_S3_KINDS.has(kind) ||
    ESP32_C3_KINDS.has(kind)
  );
}

// PSRAM availability by family:
//   - Classic ESP32: optional, "enabled" only
//   - ESP32-S3: optional, "enabled" or "opi" (octal)
//   - ESP32-C3: no PSRAM support at all — section hidden in UI
export function boardSupportsPsram(kind: BoardKind): boolean {
  return ESP32_XTENSA_KINDS.has(kind) || ESP32_S3_KINDS.has(kind);
}

export function boardSupportsOpiPsram(kind: BoardKind): boolean {
  return ESP32_S3_KINDS.has(kind);
}

export function getDefaultOptionsForKind(kind: BoardKind): ESP32BoardOptions {
  if (!isEsp32Family(kind)) return { ...DEFAULT_ESP32_OPTIONS };
  const defaults = { ...DEFAULT_ESP32_OPTIONS };
  // C3 has no PSRAM controller — clear the field so a stale 'enabled'
  // value from an upgraded project doesn't reach the backend.
  if (ESP32_C3_KINDS.has(kind)) defaults.psram = 'disabled';
  return defaults;
}

// Human-readable label for a partition scheme. Used in the modal dropdown
// so users see "min_spiffs - 1.9MB APP / 190KB SPIFFS (OTA)" instead of
// the bare key.
export const PARTITION_SCHEME_LABELS: Record<ESP32PartitionScheme, string> = {
  default: 'Default 4MB with spiffs (1.2MB APP / 1.5MB SPIFFS)',
  defaults_ffat: 'Default 4MB with ffat (1.2MB APP / 1.5MB FATFS)',
  min_spiffs: 'Minimal SPIFFS (1.9MB APP with OTA / 190KB SPIFFS)',
  min_ffat: 'Minimal FATFS (1.9MB APP with OTA / 190KB FATFS)',
  no_ota: 'No OTA (2MB APP / 2MB SPIFFS)',
  no_fs: 'No FS 4MB (2MB APP x2)',
  huge_app: 'Huge APP (3MB No OTA / 1MB SPIFFS)',
  large_spiffs: 'Large SPIFFS (1.9MB APP / 1.4MB SPIFFS)',
  rainmaker: 'RainMaker 4MB',
};

// SPIFFS (or FATFS) capacity in bytes for each scheme. Used in the upload
// panel to show "Total: X / Y KB" and to block oversize uploads.
// Returns 0 for schemes with no filesystem partition.
export const PARTITION_SCHEME_FS_SIZE: Record<ESP32PartitionScheme, number> = {
  default: 0x16f000,        // 1.5 MB
  defaults_ffat: 0x16f000,
  min_spiffs: 0x2f000,      // 190 KB
  min_ffat: 0x2f000,
  no_ota: 0x200000,         // 2 MB
  no_fs: 0,
  huge_app: 0x100000,       // 1 MB
  large_spiffs: 0x166000,   // ~1.4 MB
  rainmaker: 0x6000,        // ~24 KB nvs/fctry only
};

// Display-only metadata for the CPU-frequency selector.
export const CPU_FREQ_OPTIONS: { value: ESP32CpuFreq; label: string }[] = [
  { value: 240, label: '240MHz (WiFi/BT)' },
  { value: 160, label: '160MHz' },
  { value: 80, label: '80MHz' },
  { value: 40, label: '40MHz' },
  { value: 20, label: '20MHz' },
  { value: 10, label: '10MHz' },
];

export const FLASH_MODE_OPTIONS: { value: ESP32FlashMode; label: string }[] = [
  { value: 'qio', label: 'QIO' },
  { value: 'dio', label: 'DIO' },
  { value: 'qout', label: 'QOUT' },
  { value: 'dout', label: 'DOUT' },
];

export const FLASH_SIZE_OPTIONS: { value: ESP32FlashSize; label: string }[] = [
  { value: '4MB', label: '4MB (32Mb)' },
  { value: '8MB', label: '8MB (64Mb) - experimental' },
  { value: '16MB', label: '16MB (128Mb) - experimental' },
];

export const FLASH_FREQ_OPTIONS: { value: ESP32FlashFreq; label: string }[] = [
  { value: '80', label: '80MHz' },
  { value: '40', label: '40MHz' },
];

export const DEBUG_LEVEL_OPTIONS: { value: ESP32CoreDebugLevel; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'error', label: 'Error' },
  { value: 'warn', label: 'Warn' },
  { value: 'info', label: 'Info' },
  { value: 'debug', label: 'Debug' },
  { value: 'verbose', label: 'Verbose' },
];

export const CORE_SELECT_OPTIONS: { value: ESP32CoreSelect; label: string }[] = [
  { value: 0, label: 'Core 0' },
  { value: 1, label: 'Core 1' },
];
