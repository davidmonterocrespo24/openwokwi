/**
 * GpsNeo6mElement.ts — `<velxio-gps-neo6m>` u-blox NEO-6M GPS module.
 *
 * Visual follows the common GY-GPS6MV2 breakout: blue PCB, u-blox chip,
 * stacked beige ceramic patch antenna and a 4-pin header (VCC / RX / TX /
 * GND) on the left edge.
 *
 * The behaviour (a 9600-baud NMEA stream — GPGGA + GPRMC every second —
 * pushed out of the TX pin into the wired board UART) lives in
 * `simulation/parts/GpsParts.ts`.
 *
 * Runtime surface used by the part:
 *   - `lat` / `lng` / `altitude` / `speed` properties (position fed into
 *     the NMEA sentences; synced from metadata defaults + property dialog
 *     by DynamicComponent, and live-updated via the SensorControlPanel).
 *   - `set pps(on)` — pulses the red PPS LED once per emitted NMEA cycle.
 *
 * Per CLAUDE.md §6a this MUST be a real Web Component — the wire system
 * reads `pinInfo` from the DOM node to place wire endpoints on pin tips.
 */

const BODY_W = 150;
const BODY_H = 100;

// Left-edge 0.1" header (GY-GPS6MV2 silkscreen order top→bottom).
const PIN_X = 9;
const PIN_SPACING = 18;
const PIN_Y0 = 23;
const PIN_NAMES = ['VCC', 'RX', 'TX', 'GND'] as const;
const PIN_RING = ['#C08540', '#8F5DBF', '#2E9E5B', '#B4AEAB'];

function signalsFor(name: string) {
  if (name === 'GND') return [{ type: 'power', signal: 'GND' }];
  if (name === 'VCC') return [{ type: 'power', signal: 'VCC' }];
  // The module's TX carries the NMEA stream towards the board's RX.
  if (name === 'TX') return [{ type: 'usart', signal: 'TX' }];
  if (name === 'RX') return [{ type: 'usart', signal: 'RX' }];
  return [];
}

class GpsNeo6mElement extends HTMLElement {
  /** Decimal-degree position encoded into the NMEA sentences. */
  lat = 40.4168;
  lng = -3.7038;
  /** Altitude above mean sea level, metres (GPGGA field 9). */
  altitude = 667;
  /** Speed over ground, knots (GPRMC field 7). */
  speed = 0;

  private _pps = false;

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

  /** PPS indicator — the part pulses this once per emitted NMEA cycle. */
  set pps(on: boolean) {
    this._pps = Boolean(on);
    const led = this.shadowRoot?.querySelector('[data-pps-led]');
    if (led) led.setAttribute('fill', this._pps ? '#FF3B30' : '#5A1512');
  }
  get pps(): boolean {
    return this._pps;
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

        <!-- Mounting holes -->
        <g fill="#59340A" stroke="#BE9B72" stroke-width="0.6">
          <circle cx="9" cy="9" r="4" />
          <circle cx="${BODY_W - 9}" cy="${BODY_H - 9}" r="4" />
        </g>

        <!-- Ceramic patch antenna (stacked on the right half) -->
        <rect x="${BODY_W - 66}" y="16" width="56" height="56" rx="3"
              fill="#D9CDA8" stroke="#B5A87F" />
        <rect x="${BODY_W - 52}" y="30" width="28" height="28"
              fill="#C7B98F" stroke="#B5A87F" stroke-width="0.6" />
        <circle cx="${BODY_W - 60}" cy="44" r="2.2" fill="#8F8468" />

        <!-- u-blox NEO-6M chip -->
        <rect x="34" y="24" width="40" height="26" rx="2" fill="#20242B" stroke="#3A3F48" />
        <text x="54" y="35" text-anchor="middle" font-family="monospace"
              font-size="6.5" fill="#DDD">u-blox</text>
        <text x="54" y="44" text-anchor="middle" font-family="monospace"
              font-size="6" fill="#999">NEO-6M</text>

        <!-- PPS fix LED -->
        <circle data-pps-led cx="40" cy="66" r="3.5"
                fill="${this._pps ? '#FF3B30' : '#5A1512'}" stroke="#2B0B09" stroke-width="0.6" />
        <text x="48" y="68.5" font-family="monospace" font-size="5.5" fill="#FFF">PPS</text>

        <text x="34" y="90" font-family="monospace" font-size="6" fill="#9BE1FF">GPS NEO-6M</text>
        <text x="34" y="97" font-family="monospace" font-size="4.5" fill="#9BE1FF">NMEA 9600 baud</text>

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

if (typeof customElements !== 'undefined' && !customElements.get('velxio-gps-neo6m')) {
  customElements.define('velxio-gps-neo6m', GpsNeo6mElement);
}

export type { GpsNeo6mElement };
