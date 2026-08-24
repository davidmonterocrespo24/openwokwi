/**
 * Ssd1306I2cElement — `<velxio-ssd1306-i2c-4pin>` Web Component.
 *
 * The common cheap 0.96" SSD1306 OLED **I2C module with only 4 pins**
 * (GND / VCC / SCL / SDA) — the counterpart to the 8-pin `wokwi-ssd1306`
 * breakout, and the layout most beginners actually have on their desk
 * (matches Wokwi's `board-ssd1306`). A velxio-local element because
 * `@wokwi/elements` only ships the 8-pin variant. See issue #215.
 *
 * Same rendering surface as `wokwi-ssd1306` so `SSD1306Core.syncElement`
 * (simulation/parts/ProtocolParts.ts) drives it unchanged:
 *   - `element.imageData` — a 128×64 ImageData (RGBA)
 *   - `element.redraw()`  — flushes imageData to the internal canvas
 *
 * Per CLAUDE.md §6a this MUST be a real Web Component — the wire system reads
 * `pinInfo` from the DOM node to place wire endpoints on the pin tips.
 */

const SCREEN_W = 128;
const SCREEN_H = 64;

// Body geometry (CSS px). Kept visually in the same family as wokwi-ssd1306
// (blue PCB, dark screen, corner mounting holes, star) but narrower — a 4-pin
// header instead of 8. Screen sits at (SCREEN_X, SCREEN_Y).
const BODY_W = 150;
const BODY_H = 118;
const SCREEN_X = 11;
const SCREEN_Y = 30;

// 4-pin 0.1" header, centred along the top edge. `x`/`y` are the pin tips the
// wire system snaps to.
const PIN_Y = 11;
const PIN_SPACING = 15;
const PIN_NAMES = ['GND', 'VCC', 'SCL', 'SDA'] as const;
const PIN_X0 = BODY_W / 2 - ((PIN_NAMES.length - 1) * PIN_SPACING) / 2;
// Ring colours echo the wokwi-ssd1306 pin styling.
const PIN_RING = ['#B4AEAB', '#C08540', '#009E9B', '#007ADB'];

function signalsFor(name: string) {
  if (name === 'GND') return [{ type: 'power', signal: 'GND' }];
  if (name === 'VCC') return [{ type: 'power', signal: 'VCC' }];
  if (name === 'SCL') return [{ type: 'i2c', signal: 'SCL' }];
  if (name === 'SDA') return [{ type: 'i2c', signal: 'SDA' }];
  return [];
}

class Ssd1306I2cElement extends HTMLElement {
  private _imageData: ImageData = new ImageData(SCREEN_W, SCREEN_H);
  private ctx: CanvasRenderingContext2D | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.render();
    this.initContext();
  }

  /** Wire system reads this from the DOM — do NOT memoize. */
  get pinInfo() {
    return PIN_NAMES.map((name, i) => ({
      name,
      x: PIN_X0 + i * PIN_SPACING,
      y: PIN_Y,
      number: i + 1,
      signals: signalsFor(name),
    }));
  }

  get canvas(): HTMLCanvasElement | null {
    return this.shadowRoot?.querySelector('canvas') ?? null;
  }

  /** Accepts the ImageData pushed by SSD1306Core; ignores anything else (e.g. a
   *  stray string property assignment from the loader). */
  set imageData(v: ImageData) {
    if (v instanceof ImageData) this._imageData = v;
  }
  get imageData(): ImageData {
    return this._imageData;
  }

  /** Flush the current imageData to the canvas (called by SSD1306Core). */
  redraw(): void {
    if (!this.ctx) this.initContext();
    try {
      this.ctx?.putImageData(this._imageData, 0, 0);
    } catch {
      /* canvas not ready yet */
    }
  }

  private initContext(): void {
    const c = this.canvas;
    this.ctx = c?.getContext('2d') ?? null;
    this.ctx?.putImageData(this._imageData, 0, 0);
  }

  private render(): void {
    if (!this.shadowRoot) return;
    const holes = [
      [8, 8],
      [BODY_W - 8, 8],
      [8, BODY_H - 8],
      [BODY_W - 8, BODY_H - 8],
    ];
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: inline-block; line-height: 0; position: relative; }
        svg { display: block; user-select: none; -webkit-user-select: none; }
        canvas {
          position: absolute;
          left: ${SCREEN_X}px;
          top: ${SCREEN_Y}px;
          image-rendering: pixelated;
          pointer-events: none;
        }
      </style>
      <svg width="${BODY_W}" height="${BODY_H}" xmlns="http://www.w3.org/2000/svg">
        <!-- Blue PCB -->
        <rect stroke="#BE9B72" fill="#025CAF" x=".5" y=".5"
              width="${BODY_W - 1}" height="${BODY_H - 1}" rx="10" />

        <!-- Corner mounting holes -->
        <g fill="#59340A" stroke="#BE9B72" stroke-width="0.6">
          ${holes.map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="4.5" />`).join('')}
        </g>

        <!-- The OLED itself: on the real module the glass is a PANEL BONDED
             ONTO the PCB, not a hole in it - it overhangs the 128x64 active
             area on every side, sits slightly proud of the board, and carries
             a flex tail down to the driver. Drawing it as a bare dark rect
             made the part read as a cut-out rather than one integrated piece. -->
        <rect x="${SCREEN_X - 5}" y="${SCREEN_Y - 4}"
              width="${SCREEN_W + 10}" height="${SCREEN_H + 13}"
              rx="1.5" fill="#0C0E13" stroke="#3A3F4A" stroke-width="0.8" />
        <!-- glass bevel: the lit edge where the panel stands off the PCB -->
        <rect x="${SCREEN_X - 5}" y="${SCREEN_Y - 4}"
              width="${SCREEN_W + 10}" height="${SCREEN_H + 13}"
              rx="1.5" fill="none" stroke="#565C68" stroke-width="0.5" opacity="0.55" />
        <!-- flex tail from the glass to the driver, under the panel -->
        <rect x="${SCREEN_X + SCREEN_W / 2 - 22}" y="${SCREEN_Y + SCREEN_H + 8}"
              width="44" height="4" rx="1" fill="#8A6A2E" opacity="0.85" />
        <!-- 128 x 64 active area (the <canvas> paints exactly on top of this) -->
        <rect x="${SCREEN_X}" y="${SCREEN_Y}" width="${SCREEN_W}" height="${SCREEN_H}" fill="#05070A" />
        <!-- specular sheen across the glass, so it reads as a screen -->
        <path d="M${SCREEN_X - 5} ${SCREEN_Y + 6} L${SCREEN_X + SCREEN_W + 5} ${SCREEN_Y - 4}
                 L${SCREEN_X + SCREEN_W + 5} ${SCREEN_Y + 2} L${SCREEN_X - 5} ${SCREEN_Y + 13} Z"
              fill="#FFFFFF" opacity="0.045" pointer-events="none" />

        <!-- Star decoration, echoing the 8-pin part -->
        <path fill="#FFF" stroke="#FFF"
          d="M133 6.5l-1.4 2.6-3 .4 2.2 2-.53 2.83 2.75-1.34 2.75 1.34-.53-2.83 2.2-2-3-.4-1.4-2.6z" />

        <!-- 4-pin header + labels -->
        <g font-family="monospace" font-size="6" font-weight="300" fill="#FFF" text-anchor="middle">
          ${PIN_NAMES.map(
            (name, i) => `<text x="${PIN_X0 + i * PIN_SPACING}" y="${PIN_Y + 12}">${name}</text>`,
          ).join('')}
        </g>
        <g fill="#9D9D9A" stroke-width="0.4">
          ${PIN_NAMES.map(
            (_, i) =>
              `<circle stroke="${PIN_RING[i]}" cx="${PIN_X0 + i * PIN_SPACING}" cy="${PIN_Y}" r="3.5" />`,
          ).join('')}
        </g>
      </svg>
      <canvas width="${SCREEN_W}" height="${SCREEN_H}"></canvas>
    `;
  }
}

if (!customElements.get('velxio-ssd1306-i2c-4pin')) {
  customElements.define('velxio-ssd1306-i2c-4pin', Ssd1306I2cElement);
}

export type { Ssd1306I2cElement };
