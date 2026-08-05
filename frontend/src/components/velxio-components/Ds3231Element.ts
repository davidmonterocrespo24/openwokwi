/**
 * Ds3231Element.ts — `<velxio-ds3231>` DS3231 precision RTC module.
 *
 * wokwi-elements ships a DS1307 breakout but no DS3231, so we draw our own.
 * The visual follows the ubiquitous 4-pin DS3231 breakout (blue PCB, SOIC-16
 * chip, backup coin cell): a left-edge header with GND / VCC / SDA / SCL —
 * the same wiring surface as the wokwi DS1307 minus its unused SQW pin.
 *
 * The I2C behaviour lives in `simulation/I2CBusManager.ts::VirtualDS3231`
 * (address 0x68, DS1307-compatible time registers 0x00-0x06 plus control
 * 0x0E / status 0x0F / temperature 0x11-0x12) and is attached by the
 * `ds3231` entry in `simulation/parts/ProtocolParts.ts`.
 *
 * Per CLAUDE.md §6a this MUST be a real Web Component — the wire system
 * reads `pinInfo` from the DOM node to place wire endpoints on pin tips.
 */

const BODY_W = 140;
const BODY_H = 84;

// Left-edge 0.1" header. `x`/`y` are the pin tips the wire system snaps to.
const PIN_X = 9;
const PIN_SPACING = 18;
const PIN_Y0 = 15;
const PIN_NAMES = ['GND', 'VCC', 'SDA', 'SCL'] as const;
// Ring colours follow the wokwi DS1307 / velxio SSD1306 pin styling.
const PIN_RING = ['#B4AEAB', '#C08540', '#007ADB', '#009E9B'];

function signalsFor(name: string) {
  if (name === 'GND') return [{ type: 'power', signal: 'GND' }];
  if (name === 'VCC') return [{ type: 'power', signal: 'VCC' }];
  if (name === 'SDA') return [{ type: 'i2c', signal: 'SDA' }];
  if (name === 'SCL') return [{ type: 'i2c', signal: 'SCL' }];
  return [];
}

class Ds3231Element extends HTMLElement {
  /** On-chip temperature in °C — mirrored into the simulated 0x11/0x12 regs. */
  temperature = 25;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.render();
  }

  /** Wire system reads this from the DOM — do NOT memoize. */
  get pinInfo() {
    return PIN_NAMES.map((name, i) => ({
      name,
      x: PIN_X,
      y: PIN_Y0 + i * PIN_SPACING,
      number: i + 1,
      signals: signalsFor(name),
    }));
  }

  private render(): void {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: inline-block; line-height: 0; }
        svg { display: block; user-select: none; -webkit-user-select: none; }
      </style>
      <svg width="${BODY_W}" height="${BODY_H}" xmlns="http://www.w3.org/2000/svg">
        <!-- Blue PCB -->
        <rect stroke="#BE9B72" fill="#025CAF" x=".5" y=".5"
              width="${BODY_W - 1}" height="${BODY_H - 1}" rx="8" />

        <!-- Corner mounting holes (right side; the left edge carries the header) -->
        <g fill="#59340A" stroke="#BE9B72" stroke-width="0.6">
          <circle cx="${BODY_W - 9}" cy="9" r="4" />
          <circle cx="${BODY_W - 9}" cy="${BODY_H - 9}" r="4" />
        </g>

        <!-- Backup coin cell (CR2032) -->
        <circle cx="${BODY_W - 38}" cy="${BODY_H / 2}" r="26" fill="#C9C9C4" stroke="#8F8F8A" />
        <circle cx="${BODY_W - 38}" cy="${BODY_H / 2}" r="20" fill="#DBDBD6" stroke="#B0B0AA" stroke-width="0.6" />
        <text x="${BODY_W - 38}" y="${BODY_H / 2 + 2}" text-anchor="middle"
              font-family="monospace" font-size="7" fill="#77776F">CR2032</text>

        <!-- DS3231 SOIC-16 package -->
        <rect x="40" y="20" width="42" height="44" rx="2" fill="#1C1C1C" stroke="#3A3A3A" />
        <g fill="#9D9D9A">
          ${[0, 1, 2, 3, 4, 5, 6, 7]
            .map(
              (i) => `
            <rect x="36" y="${22 + i * 5.4}" width="4" height="3" />
            <rect x="82" y="${22 + i * 5.4}" width="4" height="3" />`,
            )
            .join('')}
        </g>
        <text x="61" y="40" text-anchor="middle" font-family="monospace"
              font-size="7" fill="#DDD">DS3231</text>
        <text x="61" y="49" text-anchor="middle" font-family="monospace"
              font-size="5" fill="#999">RTC + TEMP</text>

        <!-- 4-pin header + labels -->
        <g font-family="monospace" font-size="6.5" font-weight="300" fill="#FFF">
          ${PIN_NAMES.map(
            (name, i) =>
              `<text x="${PIN_X + 8}" y="${PIN_Y0 + i * PIN_SPACING + 2}">${name}</text>`,
          ).join('')}
        </g>
        <g fill="#9D9D9A" stroke-width="0.4">
          ${PIN_NAMES.map(
            (_, i) =>
              `<circle stroke="${PIN_RING[i]}" cx="${PIN_X}" cy="${PIN_Y0 + i * PIN_SPACING}" r="3.5" />`,
          ).join('')}
        </g>
      </svg>
    `;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('velxio-ds3231')) {
  customElements.define('velxio-ds3231', Ds3231Element);
}

export type { Ds3231Element };
