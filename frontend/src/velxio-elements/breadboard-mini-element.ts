/**
 * <velxio-breadboard-mini> — 170-point mini solderless breadboard.
 *
 * 17 terminal-strip columns × two 5-hole banks (rows a-e top, f-j bottom),
 * no power rails. Pin names follow the Wokwi convention:
 * `${col}t.${a-e}` / `${col}b.${f-j}` (see utils/breadboardNets.ts).
 *
 * Artwork: the Fritzing parts-library mini breadboard (CC-BY-SA 3.0 — see
 * frontend/public/component-svgs/fritzing/ATTRIBUTION.md), scaled ×4/3 so
 * the hole pitch is the wokwi-standard 9.6 CSS px. In this artwork row A is
 * already the top row, so wokwi letters map 1:1. Falls back to a
 * programmatic SVG with identical geometry if the asset can't load.
 *
 * Passive — internal column joining happens in NetlistBuilder / the digital
 * trace via breadboardGroupKey. pinInfo (170 entries) is precomputed at
 * module load so the getter stays cheap for the pin overlay.
 */

const SCALE = 4 / 3;
const F_PITCH = 7.2;
const COLS = 17;

/* Fritzing miniBreadboard.svg hole grid: column 1 at x=11.82; rows A-J at
 * y=19.86..99.06 (A topmost — same orientation as the wokwi letters). */
const F_GRID_X0 = 11.82;
const F_ROW_Y: Record<string, number> = {
  a: 19.86, b: 27.06, c: 34.26, d: 41.46, e: 48.66,
  f: 70.26, g: 77.46, h: 84.66, i: 91.86, j: 99.06,
};
const F_WIDTH = 129.839;
const F_HEIGHT = 100.914;

export const BREADBOARD_MINI_WIDTH = F_WIDTH * SCALE;
export const BREADBOARD_MINI_HEIGHT = F_HEIGHT * SCALE;

export interface BreadboardMiniPin {
  name: string;
  x: number;
  y: number;
  number: number;
  signals: [];
}

function buildPins(): BreadboardMiniPin[] {
  const pins: BreadboardMiniPin[] = [];
  let n = 1;
  for (let col = 1; col <= COLS; col++) {
    const x = (F_GRID_X0 + (col - 1) * F_PITCH) * SCALE;
    for (const row of ['a', 'b', 'c', 'd', 'e'] as const) {
      pins.push({ name: `${col}t.${row}`, x, y: F_ROW_Y[row] * SCALE, number: n++, signals: [] });
    }
    for (const row of ['f', 'g', 'h', 'i', 'j'] as const) {
      pins.push({ name: `${col}b.${row}`, x, y: F_ROW_Y[row] * SCALE, number: n++, signals: [] });
    }
  }
  return pins;
}

const PINS: readonly BreadboardMiniPin[] = buildPins();

/** Pure hole-grid export — same geometry as the rendered element, DOM-free. */
export const BREADBOARD_MINI_PINS: readonly BreadboardMiniPin[] = PINS;

let artPromise: Promise<string | null> | null = null;
function fetchArt(): Promise<string | null> {
  if (!artPromise) {
    artPromise = fetch('/component-svgs/fritzing/breadboard-mini.svg')
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null);
  }
  return artPromise;
}

function buildFallbackSvg(): string {
  const w = BREADBOARD_MINI_WIDTH;
  const h = BREADBOARD_MINI_HEIGHT;
  const parts: string[] = [
    `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">`,
    `<rect x="0" y="0" width="${w}" height="${h}" rx="5" fill="#ffffff" stroke="#d8d4cc"/>`,
    `<rect x="3" y="${59.46 * SCALE - 7}" width="${w - 6}" height="14" rx="2" fill="#efece6"/>`,
  ];
  for (const p of PINS) {
    parts.push(
      `<rect x="${(p.x - 1.6).toFixed(1)}" y="${(p.y - 1.6).toFixed(1)}" width="3.2" height="3.2" rx="0.8" fill="#333"/>`,
    );
  }
  parts.push('</svg>');
  return parts.join('');
}

// DOM-free import guard — see breadboard-element.ts.
const HTMLElementBase: typeof HTMLElement =
  typeof HTMLElement !== 'undefined'
    ? HTMLElement
    : (class {} as unknown as typeof HTMLElement);

export class BreadboardMiniElement extends HTMLElementBase {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.style.display = 'inline-block';
    this.style.width = `${BREADBOARD_MINI_WIDTH}px`;
    this.style.height = `${BREADBOARD_MINI_HEIGHT}px`;
    fetchArt().then((svg) => {
      if (!this.isConnected) return;
      this.shadowRoot!.innerHTML = svg ?? buildFallbackSvg();
      const el = this.shadowRoot!.querySelector('svg');
      if (el) {
        el.setAttribute('width', String(BREADBOARD_MINI_WIDTH));
        el.setAttribute('height', String(BREADBOARD_MINI_HEIGHT));
      }
    });
  }

  get pinInfo() {
    return PINS as unknown as Array<{ name: string; x: number; y: number; number: number }>;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('velxio-breadboard-mini')) {
  customElements.define('velxio-breadboard-mini', BreadboardMiniElement);
}
