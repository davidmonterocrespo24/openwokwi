/**
 * ESP32 Web Components
 *
 * Uses board SVG assets for realistic rendering.
 * Pin positions are in mm × 5 px/mm.
 */

import { GENERATED_BOARD_CONFIGS } from './boardPins.generated';

// ADC pin map: GPIO → { adc bank, channel within bank, qemu chn index }
// chn is the index passed to qemu_picsimlab_set_apin():
//   0-7  → ADC1 channels 0-7  (GPIO 36,37,38,39,32,33,34,35)
//   8-17 → ADC2 channels 0-9  (GPIO 4,0,2,15,13,12,14,27,25,26)
export const ESP32_ADC_PIN_MAP: Record<number, { adc: 1 | 2; ch: number; chn: number }> = {
  36: { adc: 1, ch: 0, chn: 0 },
  37: { adc: 1, ch: 1, chn: 1 },
  38: { adc: 1, ch: 2, chn: 2 },
  39: { adc: 1, ch: 3, chn: 3 },
  32: { adc: 1, ch: 4, chn: 4 },
  33: { adc: 1, ch: 5, chn: 5 },
  34: { adc: 1, ch: 6, chn: 6 },
  35: { adc: 1, ch: 7, chn: 7 },
  4: { adc: 2, ch: 0, chn: 8 },
  0: { adc: 2, ch: 1, chn: 9 },
  2: { adc: 2, ch: 2, chn: 10 },
  15: { adc: 2, ch: 3, chn: 11 },
  13: { adc: 2, ch: 4, chn: 12 },
  12: { adc: 2, ch: 5, chn: 13 },
  14: { adc: 2, ch: 6, chn: 14 },
  27: { adc: 2, ch: 7, chn: 15 },
  25: { adc: 2, ch: 8, chn: 16 },
  26: { adc: 2, ch: 9, chn: 17 },
};

interface BoardConfig {
  svgUrl: string;
  w: number;
  h: number;
  pins: { name: string; x: number; y: number; target?: string }[];
}

const BOARD_CONFIGS: Record<string, BoardConfig> = GENERATED_BOARD_CONFIGS;

// ─── Custom element ───────────────────────────────────────────────────────────

class Esp32Element extends HTMLElement {
  static get observedAttributes() {
    return ['board-kind'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
  }
  attributeChangedCallback() {
    this.render();
  }

  private get config(): BoardConfig {
    const kind = this.getAttribute('board-kind') ?? 'esp32';
    return BOARD_CONFIGS[kind] ?? BOARD_CONFIGS['esp32'];
  }

  get pinInfo() {
    return this.config.pins;
  }

  private render() {
    if (!this.shadowRoot) return;
    const { svgUrl, w, h } = this.config;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: inline-block; line-height: 0; }
        img   { display: block; }
      </style>
      <img
        src="${svgUrl}"
        width="${w}"
        height="${h}"
        draggable="false"
        alt="ESP32 board"
      />
    `;
  }
}

if (!customElements.get('velxio-esp32')) {
  customElements.define('velxio-esp32', Esp32Element);
}
