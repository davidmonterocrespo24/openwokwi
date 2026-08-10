/**
 * Online-only boards — the public "shop window".
 *
 * These boards are implemented by the hosted editor (velxio.com), where they
 * are free to use; their emulation engines and board wiring are not part of
 * the OSS tree. The OSS build knows only this list — name, art, a badge —
 * and renders advertisement cards in the picker that link to the online
 * editor.
 *
 * A build where a board actually exists (the hosted build registers the real
 * BoardKind) must NOT show its ad. Callers filter with `id in
 * BOARD_KIND_LABELS`: when the real kind is registered the ad disappears
 * automatically, so this list needs no per-build switches.
 */

export interface OnlineOnlyBoardAd {
  /** Stable id — matches the BoardKind the hosted build registers. */
  id: string;
  label: string;
  description: string;
  /** Inline SVG for the card thumbnail (rendered via innerHTML). */
  thumbnailSvg: string;
}

/** Where the ad cards send the user. */
export const ONLINE_EDITOR_URL = 'https://velxio.com';

/**
 * Ad suppression — the hosted overlay's escape hatch.
 *
 * The "ad disappears when the real thing registers" contract breaks down in
 * the hosted build itself: an item the overlay knows about but chose NOT to
 * register (launch embargo) must not fall back to an ad card that says
 * "available in the online editor" — the user is already IN the online
 * editor. The overlay calls this once at mount with every id it manages;
 * items it registers replace their ad anyway, items it embargoes simply
 * vanish. Pure OSS builds never call it, so ads behave exactly as before.
 */
const suppressedAdIds = new Set<string>();

export function suppressOnlineOnlyAds(ids: string[]): void {
  for (const id of ids) suppressedAdIds.add(id);
}

export function isOnlineOnlyAdSuppressed(id: string): boolean {
  return suppressedAdIds.has(id);
}

export const ONLINE_ONLY_BOARD_ADS: OnlineOnlyBoardAd[] = [
  {
    id: 'esp32-c6',
    label: 'ESP32-C6-DevKitC-1',
    description: 'RISC-V single-core, WiFi 6 + BLE + 802.15.4 — in-browser emulation',
    thumbnailSvg:
      '<svg width="72" height="72" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg">' +
      '<rect x="14" y="4" width="44" height="64" rx="4" fill="#1a1a1a"/>' +
      '<rect x="22" y="8" width="28" height="20" rx="2" fill="#b8bec6"/>' +
      '<rect x="26" y="12" width="20" height="12" fill="#2d3138"/>' +
      '<text x="36" y="21" text-anchor="middle" font-size="5" font-family="monospace" fill="#e8e8e8">C6</text>' +
      '<rect x="30" y="60" width="12" height="6" rx="1" fill="#8a8f96"/>' +
      '<g fill="#d4af37">' +
      '<rect x="15" y="32" width="3" height="3"/><rect x="15" y="38" width="3" height="3"/>' +
      '<rect x="15" y="44" width="3" height="3"/><rect x="15" y="50" width="3" height="3"/>' +
      '<rect x="54" y="32" width="3" height="3"/><rect x="54" y="38" width="3" height="3"/>' +
      '<rect x="54" y="44" width="3" height="3"/><rect x="54" y="50" width="3" height="3"/>' +
      '</g></svg>',
  },
  {
    id: 'm5stack-core',
    label: 'M5Stack Core Basic',
    description: 'ESP32 all-in-one: 2" LCD, 3 buttons, speaker, microSD',
    thumbnailSvg:
      '<svg width="72" height="72" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg">' +
      '<rect x="8" y="8" width="56" height="56" rx="8" fill="#3a3d42"/>' +
      '<rect x="14" y="14" width="44" height="32" rx="2" fill="#101418"/>' +
      '<rect x="17" y="17" width="38" height="26" fill="#1c6ea4"/>' +
      '<circle cx="24" cy="55" r="4" fill="#26282c"/><circle cx="36" cy="55" r="4" fill="#26282c"/>' +
      '<circle cx="48" cy="55" r="4" fill="#26282c"/></svg>',
  },
  {
    id: 'cardputer-adv',
    label: 'M5 Cardputer ADV',
    description: 'ESP32-S3 card computer: ST7789 LCD + 56-key keyboard',
    thumbnailSvg:
      '<svg width="72" height="72" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg">' +
      '<rect x="6" y="14" width="60" height="44" rx="5" fill="#e8e4dc"/>' +
      '<rect x="10" y="18" width="52" height="18" rx="2" fill="#101418"/>' +
      '<rect x="12" y="20" width="48" height="14" fill="#20242c"/>' +
      '<g fill="#c9c4ba">' +
      Array.from({ length: 3 }, (_, r) =>
        Array.from(
          { length: 12 },
          (_, c) => `<rect x="${11 + c * 4.2}" y="${40 + r * 5.5}" width="3.4" height="4.4" rx="0.8"/>`,
        ).join(''),
      ).join('') +
      '</g></svg>',
  },
  {
    id: 'pimoroni-pico-plus-2w',
    label: 'Pimoroni Pico Plus 2W',
    description: 'RP2350B dual-core RISC-V/ARM + WiFi, 16MB flash + 8MB PSRAM',
    thumbnailSvg:
      '<svg width="72" height="72" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg">' +
      '<rect x="22" y="4" width="28" height="64" rx="3" fill="#186329"/>' +
      '<rect x="28" y="10" width="16" height="12" rx="1" fill="#b8bec6"/>' +
      '<rect x="28" y="30" width="16" height="14" rx="2" fill="#101418"/>' +
      '<g fill="#d4af37">' +
      Array.from({ length: 8 }, (_, i) => `<rect x="23" y="${8 + i * 7}" width="3" height="3"/>`).join('') +
      Array.from({ length: 8 }, (_, i) => `<rect x="46" y="${8 + i * 7}" width="3" height="3"/>`).join('') +
      '</g></svg>',
  },
  {
    id: 'galactic-unicorn',
    label: 'Pimoroni Galactic Unicorn',
    description: 'RP2350 53×11 RGB LED matrix panel',
    thumbnailSvg:
      '<svg width="72" height="72" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg">' +
      '<rect x="4" y="22" width="64" height="28" rx="4" fill="#17181c"/>' +
      '<g>' +
      Array.from({ length: 5 }, (_, r) =>
        Array.from(
          { length: 14 },
          (_, c) =>
            `<circle cx="${9 + c * 4.2}" cy="${28 + r * 4.2}" r="1.4" fill="hsl(${(r * 14 + c) * 9},70%,55%)"/>`,
        ).join(''),
      ).join('') +
      '</g></svg>',
  },
  {
    id: 'badger-2350',
    label: 'Pimoroni Badger 2350',
    description: 'RP2350 wearable badge with 2.7" e-ink display',
    thumbnailSvg:
      '<svg width="72" height="72" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg">' +
      '<rect x="6" y="16" width="60" height="40" rx="4" fill="#17181c"/>' +
      '<rect x="12" y="21" width="48" height="30" fill="#f2f0ea"/>' +
      '<text x="36" y="38" text-anchor="middle" font-size="8" font-family="monospace" fill="#17181c">BADGER</text>' +
      '<circle cx="36" cy="12" r="2.5" fill="none" stroke="#3a3d42" stroke-width="2"/></svg>',
  },
{
    id: 'xiao-esp32s3-sense',
    label: 'XIAO ESP32S3 Sense',
    description: 'Thumb-size ESP32-S3 with camera + mic (Seeed Studio) - in-browser emulation',
    thumbnailSvg: '<svg width="72" height="72" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><rect x="18" y="8" width="36" height="56" rx="7" fill="#17181c" stroke="#d9822b" stroke-width="1.6"/><rect x="28" y="5" width="16" height="8" rx="2" fill="#b9bec7"/><rect x="27" y="26" width="18" height="14" rx="2" fill="#b9bec7"/><g fill="#d8b23a"><circle cx="20" cy="20" r="2"/><circle cx="20" cy="28" r="2"/><circle cx="20" cy="36" r="2"/><circle cx="20" cy="44" r="2"/><circle cx="20" cy="52" r="2"/><circle cx="52" cy="20" r="2"/><circle cx="52" cy="28" r="2"/><circle cx="52" cy="36" r="2"/><circle cx="52" cy="44" r="2"/><circle cx="52" cy="52" r="2"/></g><text x="36" y="59" text-anchor="middle" font-size="6" font-family="monospace" fill="#e8e8ec">S3</text></svg>',
  },
  {
    id: 'xiao-esp32c6',
    label: 'XIAO ESP32C6',
    description: 'Thumb-size ESP32-C6: WiFi 6, BLE, 802.15.4 (Seeed Studio) - in-browser emulation',
    thumbnailSvg: '<svg width="72" height="72" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><rect x="18" y="8" width="36" height="56" rx="7" fill="#17181c" stroke="#3f9d6b" stroke-width="1.6"/><rect x="28" y="5" width="16" height="8" rx="2" fill="#b9bec7"/><rect x="27" y="26" width="18" height="14" rx="2" fill="#b9bec7"/><g fill="#d8b23a"><circle cx="20" cy="20" r="2"/><circle cx="20" cy="28" r="2"/><circle cx="20" cy="36" r="2"/><circle cx="20" cy="44" r="2"/><circle cx="20" cy="52" r="2"/><circle cx="52" cy="20" r="2"/><circle cx="52" cy="28" r="2"/><circle cx="52" cy="36" r="2"/><circle cx="52" cy="44" r="2"/><circle cx="52" cy="52" r="2"/></g><text x="36" y="59" text-anchor="middle" font-size="6" font-family="monospace" fill="#e8e8ec">C6</text></svg>',
  },
  {
    id: 'xiao-rp2040',
    label: 'XIAO RP2040',
    description: 'Thumb-size RP2040 (Seeed Studio) - in-browser emulation',
    thumbnailSvg: '<svg width="72" height="72" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><rect x="18" y="8" width="36" height="56" rx="7" fill="#17181c" stroke="#4a7dbd" stroke-width="1.6"/><rect x="28" y="5" width="16" height="8" rx="2" fill="#b9bec7"/><rect x="27" y="26" width="18" height="14" rx="2" fill="#b9bec7"/><g fill="#d8b23a"><circle cx="20" cy="20" r="2"/><circle cx="20" cy="28" r="2"/><circle cx="20" cy="36" r="2"/><circle cx="20" cy="44" r="2"/><circle cx="20" cy="52" r="2"/><circle cx="52" cy="20" r="2"/><circle cx="52" cy="28" r="2"/><circle cx="52" cy="36" r="2"/><circle cx="52" cy="44" r="2"/><circle cx="52" cy="52" r="2"/></g><text x="36" y="59" text-anchor="middle" font-size="6" font-family="monospace" fill="#e8e8ec">RP</text></svg>',
  },
,
  {
    id: 'unihiker-m10',
    label: 'UNIHIKER M10',
    description: 'DFRobot IoT SBC: RK3308 Linux + 2.8" touchscreen (micro:bit edge) - available in the online editor',
    thumbnailSvg:
      '<svg width="72" height="72" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg">' +
      '<rect x="12" y="6" width="48" height="52" rx="5" fill="#12467f" stroke="#0d3767"/>' +
      '<rect x="18" y="12" width="36" height="30" rx="2" fill="#0d1b2e"/>' +
      '<text x="36" y="30" text-anchor="middle" font-size="6" font-family="monospace" fill="#4fc3f7">UNIHIKER</text>' +
      '<rect x="12" y="58" width="48" height="8" fill="#c9a227"/></svg>',
  }
];

/** Advertisement entry for a hosted-editor-only COMPONENT (picker part).
 *  Same contract as the board ads above: the OSS build renders a card that
 *  links to the online editor, and any build where the real component exists
 *  in the ComponentRegistry (the hosted overlay merges it in) must hide the
 *  ad — callers filter with `registry.getById(ad.id)`, so the ad disappears
 *  automatically and this list needs no per-build switches. */
export interface OnlineOnlyComponentAd {
  /** Stable id — matches the component metadata id the hosted build merges. */
  id: string;
  label: string;
  description: string;
  /** Picker category the ad card appears under (besides "all"). */
  category: string;
  /** Inline SVG for the card thumbnail (rendered via innerHTML). */
  thumbnailSvg: string;
}

export const ONLINE_ONLY_COMPONENT_ADS: OnlineOnlyComponentAd[] = [
  {
    id: 'm5stack-chain-8x8',
    label: 'M5Stack Chain RGB Matrix (8\u00d78)',
    description: '64 RGB LEDs, daisy-chainable \u2014 in-browser emulation',
    category: 'output',
    thumbnailSvg: "<svg width=\"64\" height=\"64\" viewBox=\"0 0 64 64\" xmlns=\"http://www.w3.org/2000/svg\"><defs><filter id=\"glow\" x=\"-50%\" y=\"-50%\" width=\"200%\" height=\"200%\"><feGaussianBlur stdDeviation=\"0.7\"/></filter></defs><polygon points=\"5.0,20.0 32.0,32.0 32.0,50.0 5.0,38.0\" fill=\"#1d1f23\"/><polygon points=\"32.0,32.0 59.0,20.0 59.0,38.0 32.0,50.0\" fill=\"#2a2d33\"/><line x1=\"10.9\" y1=\"25.6\" x2=\"10.9\" y2=\"38.6\" stroke=\"#111316\" stroke-width=\"1.4\" stroke-linecap=\"round\" opacity=\"0.7\"/><line x1=\"18.0\" y1=\"28.8\" x2=\"18.0\" y2=\"41.8\" stroke=\"#111316\" stroke-width=\"1.4\" stroke-linecap=\"round\" opacity=\"0.7\"/><line x1=\"25.0\" y1=\"31.9\" x2=\"25.0\" y2=\"44.9\" stroke=\"#111316\" stroke-width=\"1.4\" stroke-linecap=\"round\" opacity=\"0.7\"/><rect x=\"42.5\" y=\"38.0\" width=\"6\" height=\"4\" rx=\"1\" fill=\"#111316\" opacity=\"0.75\"/><polygon points=\"32.0,8.0 59.0,20.0 32.0,32.0 5.0,20.0\" fill=\"#3a3d42\"/><polygon points=\"32.0,9.4 55.8,20.0 32.0,30.6 8.2,20.0\" fill=\"#e9ecf1\"/><g filter=\"url(#glow)\"><polygon points=\"32.0,9.8 34.1,10.8 32.0,11.7 29.9,10.8\" fill=\"#f94545\" opacity=\"0.92\"/><polygon points=\"35.0,11.1 37.1,12.1 35.0,13.0 32.8,12.1\" fill=\"#f9cc45\" opacity=\"0.92\"/><polygon points=\"37.9,12.4 40.1,13.4 37.9,14.4 35.8,13.4\" fill=\"#9ff945\" opacity=\"0.92\"/><polygon points=\"40.9,13.8 43.0,14.7 40.9,15.7 38.8,14.7\" fill=\"#45f972\" opacity=\"0.92\"/><polygon points=\"43.9,15.1 46.0,16.0 43.9,17.0 41.7,16.0\" fill=\"#45f9f9\" opacity=\"0.92\"/><polygon points=\"46.9,16.4 49.0,17.4 46.9,18.3 44.7,17.4\" fill=\"#4572f9\" opacity=\"0.92\"/><polygon points=\"49.8,17.7 52.0,18.7 49.8,19.6 47.7,18.7\" fill=\"#9f45f9\" opacity=\"0.92\"/><polygon points=\"52.8,19.0 54.9,20.0 52.8,21.0 50.7,20.0\" fill=\"#f945cc\" opacity=\"0.92\"/><polygon points=\"29.0,11.1 31.2,12.1 29.0,13.0 26.9,12.1\" fill=\"#f95645\" opacity=\"0.92\"/><polygon points=\"32.0,12.4 34.1,13.4 32.0,14.4 29.9,13.4\" fill=\"#f9dd45\" opacity=\"0.92\"/><polygon points=\"35.0,13.8 37.1,14.7 35.0,15.7 32.8,14.7\" fill=\"#8ff945\" opacity=\"0.92\"/><polygon points=\"37.9,15.1 40.1,16.0 37.9,17.0 35.8,16.0\" fill=\"#45f983\" opacity=\"0.92\"/><polygon points=\"40.9,16.4 43.0,17.4 40.9,18.3 38.8,17.4\" fill=\"#45e9f9\" opacity=\"0.92\"/><polygon points=\"43.9,17.7 46.0,18.7 43.9,19.6 41.7,18.7\" fill=\"#4562f9\" opacity=\"0.92\"/><polygon points=\"46.9,19.0 49.0,20.0 46.9,21.0 44.7,20.0\" fill=\"#b045f9\" opacity=\"0.92\"/><polygon points=\"49.8,20.4 52.0,21.3 49.8,22.3 47.7,21.3\" fill=\"#f945bc\" opacity=\"0.92\"/><polygon points=\"26.1,12.4 28.2,13.4 26.1,14.4 23.9,13.4\" fill=\"#f96745\" opacity=\"0.92\"/><polygon points=\"29.0,13.8 31.2,14.7 29.0,15.7 26.9,14.7\" fill=\"#f9ee45\" opacity=\"0.92\"/><polygon points=\"32.0,15.1 34.1,16.0 32.0,17.0 29.9,16.0\" fill=\"#7ef945\" opacity=\"0.92\"/><polygon points=\"35.0,16.4 37.1,17.4 35.0,18.3 32.8,17.4\" fill=\"#45f994\" opacity=\"0.92\"/><polygon points=\"37.9,17.7 40.1,18.7 37.9,19.6 35.8,18.7\" fill=\"#45d8f9\" opacity=\"0.92\"/><polygon points=\"40.9,19.0 43.0,20.0 40.9,21.0 38.8,20.0\" fill=\"#4551f9\" opacity=\"0.92\"/><polygon points=\"43.9,20.4 46.0,21.3 43.9,22.3 41.7,21.3\" fill=\"#c145f9\" opacity=\"0.92\"/><polygon points=\"46.9,21.7 49.0,22.6 46.9,23.6 44.7,22.6\" fill=\"#f945ab\" opacity=\"0.92\"/><polygon points=\"23.1,13.8 25.2,14.7 23.1,15.7 21.0,14.7\" fill=\"#f97845\" opacity=\"0.92\"/><polygon points=\"26.1,15.1 28.2,16.0 26.1,17.0 23.9,16.0\" fill=\"#f4f945\" opacity=\"0.92\"/><polygon points=\"29.0,16.4 31.2,17.4 29.0,18.3 26.9,17.4\" fill=\"#6df945\" opacity=\"0.92\"/><polygon points=\"32.0,17.7 34.1,18.7 32.0,19.6 29.9,18.7\" fill=\"#45f9a5\" opacity=\"0.92\"/><polygon points=\"35.0,19.0 37.1,20.0 35.0,21.0 32.8,20.0\" fill=\"#45c7f9\" opacity=\"0.92\"/><polygon points=\"37.9,20.4 40.1,21.3 37.9,22.3 35.8,21.3\" fill=\"#4b45f9\" opacity=\"0.92\"/><polygon points=\"40.9,21.7 43.0,22.6 40.9,23.6 38.8,22.6\" fill=\"#d245f9\" opacity=\"0.92\"/><polygon points=\"43.9,23.0 46.0,24.0 43.9,24.9 41.7,24.0\" fill=\"#f9459a\" opacity=\"0.92\"/><polygon points=\"20.1,15.1 22.3,16.0 20.1,17.0 18.0,16.0\" fill=\"#f98945\" opacity=\"0.92\"/><polygon points=\"23.1,16.4 25.2,17.4 23.1,18.3 21.0,17.4\" fill=\"#e3f945\" opacity=\"0.92\"/><polygon points=\"26.1,17.7 28.2,18.7 26.1,19.6 23.9,18.7\" fill=\"#5cf945\" opacity=\"0.92\"/><polygon points=\"29.0,19.0 31.2,20.0 29.0,21.0 26.9,20.0\" fill=\"#45f9b6\" opacity=\"0.92\"/><polygon points=\"32.0,20.4 34.1,21.3 32.0,22.3 29.9,21.3\" fill=\"#45b6f9\" opacity=\"0.92\"/><polygon points=\"35.0,21.7 37.1,22.6 35.0,23.6 32.8,22.6\" fill=\"#5c45f9\" opacity=\"0.92\"/><polygon points=\"37.9,23.0 40.1,24.0 37.9,24.9 35.8,24.0\" fill=\"#e345f9\" opacity=\"0.92\"/><polygon points=\"40.9,24.3 43.0,25.3 40.9,26.2 38.8,25.3\" fill=\"#f94589\" opacity=\"0.92\"/><polygon points=\"17.2,16.4 19.3,17.4 17.1,18.3 15.0,17.4\" fill=\"#f99a45\" opacity=\"0.92\"/><polygon points=\"20.1,17.7 22.3,18.7 20.1,19.6 18.0,18.7\" fill=\"#d2f945\" opacity=\"0.92\"/><polygon points=\"23.1,19.0 25.2,20.0 23.1,21.0 21.0,20.0\" fill=\"#4bf945\" opacity=\"0.92\"/><polygon points=\"26.1,20.4 28.2,21.3 26.1,22.3 23.9,21.3\" fill=\"#45f9c7\" opacity=\"0.92\"/><polygon points=\"29.0,21.7 31.2,22.6 29.0,23.6 26.9,22.6\" fill=\"#45a5f9\" opacity=\"0.92\"/><polygon points=\"32.0,23.0 34.1,24.0 32.0,24.9 29.9,24.0\" fill=\"#6d45f9\" opacity=\"0.92\"/><polygon points=\"35.0,24.3 37.1,25.3 35.0,26.2 32.8,25.3\" fill=\"#f445f9\" opacity=\"0.92\"/><polygon points=\"37.9,25.6 40.1,26.6 37.9,27.6 35.8,26.6\" fill=\"#f94578\" opacity=\"0.92\"/><polygon points=\"14.2,17.7 16.3,18.7 14.2,19.6 12.0,18.7\" fill=\"#f9ab45\" opacity=\"0.92\"/><polygon points=\"17.1,19.0 19.3,20.0 17.1,21.0 15.0,20.0\" fill=\"#c1f945\" opacity=\"0.92\"/><polygon points=\"20.1,20.4 22.3,21.3 20.1,22.3 18.0,21.3\" fill=\"#45f951\" opacity=\"0.92\"/><polygon points=\"23.1,21.7 25.2,22.6 23.1,23.6 21.0,22.6\" fill=\"#45f9d8\" opacity=\"0.92\"/><polygon points=\"26.1,23.0 28.2,24.0 26.1,24.9 23.9,24.0\" fill=\"#4594f9\" opacity=\"0.92\"/><polygon points=\"29.0,24.3 31.2,25.3 29.0,26.2 26.9,25.3\" fill=\"#7e45f9\" opacity=\"0.92\"/><polygon points=\"32.0,25.6 34.1,26.6 32.0,27.6 29.9,26.6\" fill=\"#f945ee\" opacity=\"0.92\"/><polygon points=\"35.0,27.0 37.1,27.9 35.0,28.9 32.8,27.9\" fill=\"#f94567\" opacity=\"0.92\"/><polygon points=\"11.2,19.0 13.3,20.0 11.2,21.0 9.1,20.0\" fill=\"#f9bc45\" opacity=\"0.92\"/><polygon points=\"14.2,20.4 16.3,21.3 14.2,22.3 12.0,21.3\" fill=\"#b0f945\" opacity=\"0.92\"/><polygon points=\"17.2,21.7 19.3,22.6 17.1,23.6 15.0,22.6\" fill=\"#45f962\" opacity=\"0.92\"/><polygon points=\"20.1,23.0 22.3,24.0 20.1,24.9 18.0,24.0\" fill=\"#45f9e9\" opacity=\"0.92\"/><polygon points=\"23.1,24.3 25.2,25.3 23.1,26.2 21.0,25.3\" fill=\"#4583f9\" opacity=\"0.92\"/><polygon points=\"26.1,25.6 28.2,26.6 26.1,27.6 23.9,26.6\" fill=\"#8f45f9\" opacity=\"0.92\"/><polygon points=\"29.0,27.0 31.2,27.9 29.0,28.9 26.9,27.9\" fill=\"#f945dd\" opacity=\"0.92\"/><polygon points=\"32.0,28.3 34.1,29.2 32.0,30.2 29.9,29.2\" fill=\"#f94556\" opacity=\"0.92\"/></g></svg>",
  },
  {
    id: 'm5stack-chain-mono-8x8',
    label: 'M5Stack Chain Mono Matrix (8\u00d78, White)',
    description: '64 white LEDs, daisy-chainable \u2014 in-browser emulation',
    category: 'output',
    thumbnailSvg: "<svg width=\"64\" height=\"64\" viewBox=\"0 0 64 64\" xmlns=\"http://www.w3.org/2000/svg\"><defs><filter id=\"glow\" x=\"-50%\" y=\"-50%\" width=\"200%\" height=\"200%\"><feGaussianBlur stdDeviation=\"0.7\"/></filter></defs><polygon points=\"5.0,20.0 32.0,32.0 32.0,50.0 5.0,38.0\" fill=\"#a6aab2\"/><polygon points=\"32.0,32.0 59.0,20.0 59.0,38.0 32.0,50.0\" fill=\"#c1c5cd\"/><line x1=\"10.9\" y1=\"25.6\" x2=\"10.9\" y2=\"38.6\" stroke=\"#8b8f97\" stroke-width=\"1.4\" stroke-linecap=\"round\" opacity=\"0.7\"/><line x1=\"18.0\" y1=\"28.8\" x2=\"18.0\" y2=\"41.8\" stroke=\"#8b8f97\" stroke-width=\"1.4\" stroke-linecap=\"round\" opacity=\"0.7\"/><line x1=\"25.0\" y1=\"31.9\" x2=\"25.0\" y2=\"44.9\" stroke=\"#8b8f97\" stroke-width=\"1.4\" stroke-linecap=\"round\" opacity=\"0.7\"/><rect x=\"42.5\" y=\"38.0\" width=\"6\" height=\"4\" rx=\"1\" fill=\"#8b8f97\" opacity=\"0.75\"/><polygon points=\"32.0,8.0 59.0,20.0 32.0,32.0 5.0,20.0\" fill=\"#cfd2d8\"/><polygon points=\"32.0,9.4 55.8,20.0 32.0,30.6 8.2,20.0\" fill=\"#f5f6f9\"/><g filter=\"url(#glow)\"><polygon points=\"32.0,9.8 34.1,10.8 32.0,11.7 29.9,10.8\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"35.0,11.1 37.1,12.1 35.0,13.0 32.8,12.1\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"37.9,12.4 40.1,13.4 37.9,14.4 35.8,13.4\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"40.9,13.8 43.0,14.7 40.9,15.7 38.8,14.7\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"43.9,15.1 46.0,16.0 43.9,17.0 41.7,16.0\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"46.9,16.4 49.0,17.4 46.9,18.3 44.7,17.4\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"49.8,17.7 52.0,18.7 49.8,19.6 47.7,18.7\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"52.8,19.0 54.9,20.0 52.8,21.0 50.7,20.0\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"29.0,11.1 31.2,12.1 29.0,13.0 26.9,12.1\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"32.0,12.4 34.1,13.4 32.0,14.4 29.9,13.4\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"35.0,13.8 37.1,14.7 35.0,15.7 32.8,14.7\" fill=\"#aecdff\" opacity=\"1.0\"/><polygon points=\"37.9,15.1 40.1,16.0 37.9,17.0 35.8,16.0\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"40.9,16.4 43.0,17.4 40.9,18.3 38.8,17.4\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"43.9,17.7 46.0,18.7 43.9,19.6 41.7,18.7\" fill=\"#aecdff\" opacity=\"1.0\"/><polygon points=\"46.9,19.0 49.0,20.0 46.9,21.0 44.7,20.0\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"49.8,20.4 52.0,21.3 49.8,22.3 47.7,21.3\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"26.1,12.4 28.2,13.4 26.1,14.4 23.9,13.4\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"29.0,13.8 31.2,14.7 29.0,15.7 26.9,14.7\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"32.0,15.1 34.1,16.0 32.0,17.0 29.9,16.0\" fill=\"#aecdff\" opacity=\"1.0\"/><polygon points=\"35.0,16.4 37.1,17.4 35.0,18.3 32.8,17.4\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"37.9,17.7 40.1,18.7 37.9,19.6 35.8,18.7\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"40.9,19.0 43.0,20.0 40.9,21.0 38.8,20.0\" fill=\"#aecdff\" opacity=\"1.0\"/><polygon points=\"43.9,20.4 46.0,21.3 43.9,22.3 41.7,21.3\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"46.9,21.7 49.0,22.6 46.9,23.6 44.7,22.6\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"23.1,13.8 25.2,14.7 23.1,15.7 21.0,14.7\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"26.1,15.1 28.2,16.0 26.1,17.0 23.9,16.0\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"29.0,16.4 31.2,17.4 29.0,18.3 26.9,17.4\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"32.0,17.7 34.1,18.7 32.0,19.6 29.9,18.7\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"35.0,19.0 37.1,20.0 35.0,21.0 32.8,20.0\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"37.9,20.4 40.1,21.3 37.9,22.3 35.8,21.3\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"40.9,21.7 43.0,22.6 40.9,23.6 38.8,22.6\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"43.9,23.0 46.0,24.0 43.9,24.9 41.7,24.0\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"20.1,15.1 22.3,16.0 20.1,17.0 18.0,16.0\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"23.1,16.4 25.2,17.4 23.1,18.3 21.0,17.4\" fill=\"#aecdff\" opacity=\"1.0\"/><polygon points=\"26.1,17.7 28.2,18.7 26.1,19.6 23.9,18.7\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"29.0,19.0 31.2,20.0 29.0,21.0 26.9,20.0\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"32.0,20.4 34.1,21.3 32.0,22.3 29.9,21.3\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"35.0,21.7 37.1,22.6 35.0,23.6 32.8,22.6\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"37.9,23.0 40.1,24.0 37.9,24.9 35.8,24.0\" fill=\"#aecdff\" opacity=\"1.0\"/><polygon points=\"40.9,24.3 43.0,25.3 40.9,26.2 38.8,25.3\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"17.2,16.4 19.3,17.4 17.1,18.3 15.0,17.4\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"20.1,17.7 22.3,18.7 20.1,19.6 18.0,18.7\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"23.1,19.0 25.2,20.0 23.1,21.0 21.0,20.0\" fill=\"#aecdff\" opacity=\"1.0\"/><polygon points=\"26.1,20.4 28.2,21.3 26.1,22.3 23.9,21.3\" fill=\"#aecdff\" opacity=\"1.0\"/><polygon points=\"29.0,21.7 31.2,22.6 29.0,23.6 26.9,22.6\" fill=\"#aecdff\" opacity=\"1.0\"/><polygon points=\"32.0,23.0 34.1,24.0 32.0,24.9 29.9,24.0\" fill=\"#aecdff\" opacity=\"1.0\"/><polygon points=\"35.0,24.3 37.1,25.3 35.0,26.2 32.8,25.3\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"37.9,25.6 40.1,26.6 37.9,27.6 35.8,26.6\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"14.2,17.7 16.3,18.7 14.2,19.6 12.0,18.7\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"17.1,19.0 19.3,20.0 17.1,21.0 15.0,20.0\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"20.1,20.4 22.3,21.3 20.1,22.3 18.0,21.3\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"23.1,21.7 25.2,22.6 23.1,23.6 21.0,22.6\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"26.1,23.0 28.2,24.0 26.1,24.9 23.9,24.0\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"29.0,24.3 31.2,25.3 29.0,26.2 26.9,25.3\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"32.0,25.6 34.1,26.6 32.0,27.6 29.9,26.6\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"35.0,27.0 37.1,27.9 35.0,28.9 32.8,27.9\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"11.2,19.0 13.3,20.0 11.2,21.0 9.1,20.0\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"14.2,20.4 16.3,21.3 14.2,22.3 12.0,21.3\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"17.2,21.7 19.3,22.6 17.1,23.6 15.0,22.6\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"20.1,23.0 22.3,24.0 20.1,24.9 18.0,24.0\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"23.1,24.3 25.2,25.3 23.1,26.2 21.0,25.3\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"26.1,25.6 28.2,26.6 26.1,27.6 23.9,26.6\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"29.0,27.0 31.2,27.9 29.0,28.9 26.9,27.9\" fill=\"#cccfd6\" opacity=\"0.9\"/><polygon points=\"32.0,28.3 34.1,29.2 32.0,30.2 29.9,29.2\" fill=\"#cccfd6\" opacity=\"0.9\"/></g></svg>",
  },,
  {
    id: 'seeed-round-display',
    label: 'Round Display for XIAO (1.28", GC9A01)',
    description: 'Round GC9A01 240x240 touch LCD + RTC - available in the online editor',
    category: 'displays',
    thumbnailSvg: '<svg width="64" height="64" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><circle cx="32" cy="32" r="28" fill="#101114" stroke="#2c2e34" stroke-width="2"/><circle cx="32" cy="32" r="22" fill="#0b2d4f"/><circle cx="26" cy="26" r="5" fill="#2f76c4"/></svg>',
  },
  {
    id: 'grove-gesture-pag7660',
    label: 'Grove Smart IR Gesture (PAG7661QN)',
    description: 'IR camera gesture sensor on a XIAO carrier: seat a XIAO on its socket and read rotate/tap/grab/pinch/swipe over I2C - available in the online editor',
    category: 'input',
    thumbnailSvg: '<svg width="64" height="64" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect x="16" y="3" width="32" height="58" rx="5" fill="#1263a8" stroke="#0a3a66"/><circle cx="24" cy="13" r="4" fill="#3a2226"/><circle cx="40" cy="13" r="4" fill="#3a2226"/><rect x="21" y="20" width="22" height="20" rx="3" fill="#23262c" stroke="#454b56"/><circle cx="32" cy="30" r="7.5" fill="#33373f"/><circle cx="32" cy="30" r="5" fill="#0d0f13"/><circle cx="32" cy="30" r="3.4" fill="#17202f"/><circle cx="30.4" cy="28.4" r="1.3" fill="#9dbbe4"/><rect x="19" y="44" width="6" height="15" rx="1.5" fill="#15171c"/><rect x="39" y="44" width="6" height="15" rx="1.5" fill="#15171c"/><rect x="6" y="46" width="9" height="14" rx="2" fill="#eeeee9"/></svg>',
  },
  {
    id: 'respeaker-lite',
    label: 'ReSpeaker Lite (XMOS XU316)',
    description: 'Dual-mic array with a XIAO socket: live mic in, audio out, beamforming/AEC/NS model - online editor',
    category: 'sensors',
    thumbnailSvg: '<svg width="64" height="64" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect x="22" y="2" width="20" height="60" rx="3" fill="#16181d" stroke="#31353d" stroke-width="1"/><rect x="25" y="5" width="14" height="16" rx="2" fill="none" stroke="#3a3f4a" stroke-width="0.8" stroke-dasharray="2 1.5"/><g fill="#c8a02e"><rect x="24" y="7" width="2.6" height="2.2" rx="0.5"/><rect x="24" y="11" width="2.6" height="2.2" rx="0.5"/><rect x="24" y="15" width="2.6" height="2.2" rx="0.5"/><rect x="37.4" y="7" width="2.6" height="2.2" rx="0.5"/><rect x="37.4" y="11" width="2.6" height="2.2" rx="0.5"/><rect x="37.4" y="15" width="2.6" height="2.2" rx="0.5"/></g><path d="M32 24 L26 38 A9 9 0 0 0 38 38 Z" fill="#22c55e" fill-opacity="0.55" stroke="#7ff0b0" stroke-width="0.7"/><circle cx="25" cy="25" r="1.4" fill="#0c0d10" stroke="#4a4f59" stroke-width="0.7"/><circle cx="39" cy="25" r="1.4" fill="#0c0d10" stroke="#4a4f59" stroke-width="0.7"/><rect x="27" y="40" width="4.4" height="3.6" rx="0.8" fill="#c9c3b4"/><rect x="33" y="40" width="4.4" height="3.6" rx="0.8" fill="#c9c3b4"/><rect x="23.5" y="48" width="5" height="8" rx="1" fill="#d8963a"/><rect x="30" y="49" width="5" height="6.6" rx="0.8" fill="#e8e4d8"/><rect x="36.5" y="52" width="7" height="5" rx="2.2" fill="#aab0b8"/></svg>',
  }
];
