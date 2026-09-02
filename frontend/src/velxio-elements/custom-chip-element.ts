/**
 * <velxio-custom-chip> — Web Component that renders a Velxio custom chip
 * (DIP-style chip body + labelled pins) on the Velxio canvas.
 *
 * Reads `chipJson` (JSON string with `pins: string[]`) from a property and
 * exposes a `pinInfo` getter that DynamicComponent + PinOverlay consume to
 * place wires.
 *
 * Pin layout: pins are split evenly between the left and right edges, in
 * order of declaration. Empty-string entries in `pins` skip a slot
 * (matches the Wokwi convention).
 */

import { normalizeChipPins } from '../simulation/customChips/chipJson';

const PIN_PITCH = 20;          // px between adjacent pins
const PIN_INSET = 0;           // pin x-offset from chip edge
const CHIP_PAD_Y = 14;         // top/bottom margin for first/last pin
const CHIP_MIN_W = 84;
const CHIP_MIN_H = 60;
/** Approx advance width of the 8px monospace pin-label glyphs. */
const CH_LABEL = 5.2;
/** Approx advance width of the 11px bold monospace name glyphs. */
const CH_NAME = 6.8;
/** Edge pad + gap before a pin label starts (labels draw at x = pin ± 10). */
const LABEL_PAD = 12;
/** Breathing room between the two label columns when they face each other. */
const CENTER_GAP = 14;
/** Height of the silkscreen band the chip name gets at the FOOT of the body.
 *  A band below the last pin row is the only place the name cannot collide
 *  with a pin label — and growing the body downward leaves every pin where
 *  it was, so no existing wire moves. */
const NAME_BAND = 17;

/** Truncate to a pixel budget with an ellipsis; the full text goes into a
 *  <title> so hover still reveals it. */
function fitText(text: string, maxPx: number, charPx: number): string {
  const maxChars = Math.max(1, Math.floor(maxPx / charPx));
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(1, maxChars - 1)) + '\u2026';
}

interface PinInfo {
  name: string;
  x: number;
  y: number;
  signals?: string[];
}

class VelxioCustomChip extends HTMLElement {
  private _chipJson: string =
    '{"name":"Custom Chip","pins":["IN","OUT","GND","VCC"]}';
  private _chipName: string = 'Custom Chip';
  private _pinInfo: PinInfo[] = [];

  static get observedAttributes(): string[] {
    return ['chip-json', 'chip-name', 'image'];
  }

  set chipJson(v: string) {
    this._chipJson = v ?? '';
    this._render();
  }
  get chipJson(): string {
    return this._chipJson;
  }

  set chipName(v: string) {
    this._chipName = v ?? 'Custom Chip';
    this._render();
  }
  get chipName(): string {
    return this._chipName;
  }

  private _image = '';

  /** Optional face image (a data: URL — png, jpeg or svg+xml). When set it
   *  covers the body, scaled to the chip's size; pins and their labels stay
   *  where they are so no wire ever moves. */
  set image(v: string) {
    const next = String(v ?? '');
    if (next === this._image) return;
    this._image = next;
    if (this.isConnected) this._render();
  }

  get image(): string {
    return this._image;
  }

  /** Contract consumed by DynamicComponent.tsx and PinOverlay.tsx. */
  get pinInfo(): PinInfo[] {
    return this._pinInfo;
  }

  attributeChangedCallback(name: string, _old: string, value: string): void {
    if (name === 'chip-json') this.chipJson = value;
    if (name === 'chip-name') this.chipName = value;
  }

  connectedCallback(): void {
    this._render();
  }

  /**
   * Parse the `pins` array. Each entry can be:
   *   - a string (Wokwi-compatible) — pin name, auto-laid out left/right.
   *   - an object {name, x, y} — explicit position relative to chip body.
   * Empty strings are slots to skip.
   */
  private _parsePins(): Array<{ name: string; x?: number; y?: number }> {
    try {
      const obj = JSON.parse(this._chipJson || '{}');
      return normalizeChipPins(obj.pins);
    } catch { /* ignore */ }
    return [];
  }

  /** Read optional `display: { width, height }` from chip.json. */
  private _parseDisplay(): { width: number; height: number } | null {
    try {
      const obj = JSON.parse(this._chipJson || '{}');
      if (obj.display && typeof obj.display.width === 'number' && typeof obj.display.height === 'number') {
        return { width: obj.display.width, height: obj.display.height };
      }
    } catch { /* ignore */ }
    return null;
  }

  private _layout(
    pins: Array<{ name: string; x?: number; y?: number }>,
    display: { width: number; height: number } | null,
  ): {
    width: number;
    height: number;
    placed: Array<{ name: string; x: number; y: number }>;
  } {
    const explicit = pins.filter((p) => p.x !== undefined && p.y !== undefined);
    const auto = pins.filter((p) => p.x === undefined || p.y === undefined);

    const half = Math.ceil(auto.length / 2);
    const left = auto.slice(0, half);
    const right = auto.slice(half);
    const placed: Array<{ name: string; x: number; y: number }> = [];

    const tallest = Math.max(left.length, right.length);
    // Two independent width budgets, because the old single-longest-label
    // formula let OPPOSING labels grow toward each other and meet in the
    // middle: (1) both label columns plus a center gap; (2) the chip name,
    // which no longer shares a horizontal band with any label (see nameY
    // below) and therefore only competes with the body edges.
    const leftMax = Math.max(0, ...left.map((p) => p.name.length));
    const rightMax = Math.max(0, ...right.map((p) => p.name.length));
    let width = Math.max(
      CHIP_MIN_W,
      Math.ceil(LABEL_PAD * 2 + (leftMax + rightMax) * CH_LABEL + CENTER_GAP),
      Math.ceil(16 + Math.min(this._chipName.length, 24) * CH_NAME),
    );
    let height = Math.max(CHIP_MIN_H, CHIP_PAD_Y * 2 + Math.max(0, tallest - 1) * PIN_PITCH);
    // Reserve the name band under the last pin row (image chips print no
    // name, so they skip it). Pin y coordinates are unaffected.
    if (this._chipName && !this._image) {
      const lastPinY = CHIP_PAD_Y + Math.max(0, tallest - 1) * PIN_PITCH;
      height = Math.max(height, lastPinY + 10 + NAME_BAND);
    }

    // If a display is configured, expand the chip body to fit it.
    if (display) {
      width = Math.max(width, display.width + 16);
      height = Math.max(height, display.height + 30); // top label + display + bottom margin
    }

    for (const p of explicit) {
      if (p.x !== undefined && p.x + 8 > width) width = p.x + 8;
      if (p.y !== undefined && p.y + 8 > height) height = p.y + 8;
    }

    left.forEach((p, i) => {
      if (!p.name) return;
      placed.push({ name: p.name, x: PIN_INSET, y: CHIP_PAD_Y + i * PIN_PITCH });
    });
    right.forEach((p, i) => {
      if (!p.name) return;
      placed.push({ name: p.name, x: width - PIN_INSET, y: CHIP_PAD_Y + i * PIN_PITCH });
    });
    explicit.forEach((p) => {
      if (!p.name) return;
      placed.push({ name: p.name, x: p.x!, y: p.y! });
    });

    return { width, height, placed };
  }

  /** Internal canvas used to render framebuffer pixels (when display is configured). */
  private _displayCanvas: HTMLCanvasElement | null = null;

  /** Re-paint the framebuffer canvas with RGBA bytes from the chip. */
  paintFramebuffer(rgba: Uint8Array, width: number, height: number): void {
    if (!this._displayCanvas) return;
    const ctx = this._displayCanvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(width, height);
    img.data.set(rgba.subarray(0, width * height * 4));
    ctx.putImageData(img, 0, 0);
  }

  private _render(): void {
    const pins = this._parsePins();
    const display = this._parseDisplay();
    const { width, height, placed } = this._layout(pins, display);

    this._pinInfo = placed.map((p) => ({ name: p.name, x: p.x, y: p.y, signals: [] }));

    this.style.display = 'inline-block';
    this.style.width = `${width}px`;
    this.style.height = `${height}px`;

    // Each side's label may use its column up to the center gap; anything
    // longer gets an ellipsis and keeps its full name in a hover <title>.
    const labelBudget = Math.max(CH_LABEL * 2, (width - CENTER_GAP) / 2 - LABEL_PAD);
    // Over a face image the labels sit on artwork of unknown brightness, so
    // they go white with a dark outline drawn UNDER the glyphs (paint-order)
    // — legible on a photo of a breakout board as much as on a dark render.
    const labelFill = this._image ? '#fff' : '#aaa';
    const labelHalo = this._image
      ? ' stroke="#000" stroke-width="2.4" stroke-opacity="0.75" paint-order="stroke"'
      : '';
    const pinsSvg = placed
      .map((p) => {
        const labelX = p.x < width / 2 ? p.x + 10 : p.x - 10;
        const anchor = p.x < width / 2 ? 'start' : 'end';
        const shown = fitText(p.name, labelBudget, CH_LABEL);
        const title = shown === p.name ? '' : `<title>${escapeText(p.name)}</title>`;
        return (
          `<g>${title}<rect x="${p.x - 3}" y="${p.y - 3}" width="6" height="6" fill="#c0c0c0"/>` +
          `<text x="${labelX}" y="${p.y}" text-anchor="${anchor}" font-family="monospace" font-size="8" fill="${labelFill}" dominant-baseline="middle"${labelHalo}>${escapeText(shown)}</text></g>`
        );
      })
      .join('');

    // Center the display (if any) horizontally; pad it 16px from top so the
    // chip name sits above (or beside, in narrow chips).
    const displaySvg = display
      ? `<foreignObject x="${(width - display.width) / 2}" y="16" width="${display.width}" height="${display.height}">
           <canvas xmlns="http://www.w3.org/1999/xhtml" data-display="1"
                   width="${display.width}" height="${display.height}"
                   style="image-rendering:pixelated;background:#000;display:block"></canvas>
         </foreignObject>`
      : '';

    // The name lives in the silkscreen band at the FOOT of the body, clear of
    // every pin row. Centring it (height/2) put it exactly ON the middle row
    // whenever a side had an odd pin count, and inside the label band even
    // when it didn't — both halves of the overlap reports.
    const nameY = display ? 10 : height - NAME_BAND / 2 - 2;
    const shownName = fitText(this._chipName, width - 16, CH_NAME);
    // With a face image the body IS the artwork: the name would just sit on
    // top of it, so it moves to the hover title instead.
    const bandSvg =
      this._image || display
        ? ''
        : `<line x1="10" y1="${height - NAME_BAND - 2}" x2="${width - 10}" y2="${height - NAME_BAND - 2}" stroke="#2c2c2c" stroke-width="1"/>`;
    const nameSvg = this._image
      ? ''
      : `<text x="${width / 2}" y="${nameY}"
              text-anchor="middle" dominant-baseline="middle"
              font-family="monospace" font-size="${display ? 9 : 11}" fill="#e0e0e0"
              font-weight="bold">${escapeText(shownName)}</text>`;
    const imageSvg = this._image
      ? `<image href="${this._image.replace(/"/g, '&quot;')}" x="8" y="4"
                width="${width - 16}" height="${height - 8}"
                preserveAspectRatio="xMidYMid meet"/>`
      : '';
    this.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg"
           width="${width}" height="${height}"
           viewBox="0 0 ${width} ${height}">
        <title>${escapeText(this._chipName)}</title>
        <rect x="6" y="2" width="${width - 12}" height="${height - 4}"
              rx="3" ry="3"
              fill="#1a1a1a" stroke="#444" stroke-width="1.5"/>
        ${imageSvg}
        ${bandSvg}
        ${nameSvg}
        ${displaySvg}
        ${pinsSvg}
      </svg>
    `;

    this._displayCanvas = display
      ? (this.querySelector('canvas[data-display="1"]') as HTMLCanvasElement | null)
      : null;
  }
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

if (typeof customElements !== 'undefined' && !customElements.get('velxio-custom-chip')) {
  customElements.define('velxio-custom-chip', VelxioCustomChip);
}

// React JSX intrinsic typing
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'velxio-custom-chip': any;
    }
  }
}
