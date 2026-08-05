/**
 * <velxio-breadboard> — full-size 830-point solderless breadboard.
 *
 * 63 terminal-strip columns × two 5-hole banks (rows a-e top, f-j bottom)
 * plus four power rails (+/- top and bottom, 50 holes each in 5-hole groups).
 * Pin names follow the Wokwi convention (see utils/breadboardNets.ts):
 *   holes `${col}t.${a-e}` / `${col}b.${f-j}`, rails `tp.N` `tn.N` `bp.N` `bn.N`.
 *
 * Artwork: the Fritzing parts-library breadboard (CC-BY-SA 3.0 — see
 * frontend/public/component-svgs/fritzing/ATTRIBUTION.md), fetched from
 * /component-svgs/fritzing/breadboard-full.svg and scaled ×4/3 so the hole
 * pitch is the wokwi-standard 9.6 CSS px (Fritzing draws at 7.2). pinInfo is
 * computed from the Fritzing hole-grid formula, so wire endpoints land on
 * the drawn holes exactly. If the asset fails to load, a lightweight
 * programmatic SVG with identical geometry renders instead.
 *
 * Purely passive: the electrical joining of each column/rail happens in
 * NetlistBuilder + the digital trace via breadboardGroupKey — this element
 * only renders and exposes pinInfo. The pinInfo array is precomputed at
 * module load (830 entries) so the getter stays cheap for the pin overlay,
 * which re-reads it on every measure (see CLAUDE.md §6a).
 */

const SCALE = 4 / 3; // fritzing 7.2-unit pitch → 9.6 CSS px
const F_PITCH = 7.2;
const COLS = 63;
const RAIL_HOLES = 50; // 10 groups of 5

/* Fritzing breadboard2.svg hole grid (pre-scale units, measured from the
 * part's pin groups): terminal column 1 at x=10.92; rail hole 1 at x=25.33
 * with an extra pitch of gap after every 5 holes. Row letters in the artwork
 * run J(top)..A(bottom) for the strips — wokwi's a-e top bank maps onto
 * fritzing J..F — and the rails are Z/Y (top) + X/W (bottom), where the red
 * stripe marks the LOWER row of each pair (that row is +). */
const F_GRID_X0 = 10.92;
const F_RAIL_X0 = 25.33;
const F_ROW_Y: Record<string, number> = {
  a: 36.0, b: 43.2, c: 50.4, d: 57.6, e: 64.8,
  f: 86.4, g: 93.6, h: 100.8, i: 108.0, j: 115.2,
  tn: 7.2, tp: 14.4, bn: 136.8, bp: 144.0,
};
const F_WIDTH = 468.238;
const F_HEIGHT = 151.2;

export const BREADBOARD_WIDTH = F_WIDTH * SCALE;
export const BREADBOARD_HEIGHT = F_HEIGHT * SCALE;

function railXf(n: number): number {
  const idx = n - 1;
  return F_RAIL_X0 + (idx + Math.floor(idx / 5)) * F_PITCH;
}

export interface BreadboardPin {
  name: string;
  x: number;
  y: number;
  number: number;
  signals: [];
}

function buildPins(): BreadboardPin[] {
  const pins: BreadboardPin[] = [];
  let n = 1;
  for (const rail of ['tp', 'tn', 'bp', 'bn'] as const) {
    for (let i = 1; i <= RAIL_HOLES; i++) {
      pins.push({
        name: `${rail}.${i}`,
        x: railXf(i) * SCALE,
        y: F_ROW_Y[rail] * SCALE,
        number: n++,
        signals: [],
      });
    }
  }
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

const PINS: readonly BreadboardPin[] = buildPins();

/** Pure hole-grid export — lets snapping/seating logic and tests use the
 * exact same geometry as the rendered element without touching the DOM. */
export const BREADBOARD_PINS: readonly BreadboardPin[] = PINS;

/* Shared, module-level fetch of the Fritzing artwork (one request no matter
 * how many breadboards are on the canvas). Resolves to the raw <svg> markup
 * or null when unavailable (missing asset, offline dev edge cases). */
let artPromise: Promise<string | null> | null = null;
function fetchArt(): Promise<string | null> {
  if (!artPromise) {
    artPromise = fetch('/component-svgs/fritzing/breadboard-full.svg')
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null);
  }
  return artPromise;
}

/** Minimal programmatic fallback with the same geometry as the artwork. */
function buildFallbackSvg(): string {
  const w = BREADBOARD_WIDTH;
  const h = BREADBOARD_HEIGHT;
  const parts: string[] = [
    `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">`,
    `<rect x="0" y="0" width="${w}" height="${h}" rx="6" fill="#fbfaf7" stroke="#d8d4cc"/>`,
    `<rect x="4" y="${75.6 * SCALE - 8}" width="${w - 8}" height="16" rx="2" fill="#efece6"/>`,
  ];
  for (const p of PINS) {
    parts.push(
      `<rect x="${(p.x - 1.6).toFixed(1)}" y="${(p.y - 1.6).toFixed(1)}" width="3.2" height="3.2" rx="0.8" fill="#333"/>`,
    );
  }
  parts.push('</svg>');
  return parts.join('');
}

// DOM-free import guard: the hole-grid exports above are consumed by pure
// geometry code (breadboardSnap) and node-side tests, where HTMLElement
// does not exist. The stub is never instantiated outside a browser.
const HTMLElementBase: typeof HTMLElement =
  typeof HTMLElement !== 'undefined'
    ? HTMLElement
    : (class {} as unknown as typeof HTMLElement);

export class BreadboardElement extends HTMLElementBase {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    // Reserve the final size immediately so layout/wire endpoints are stable
    // while the artwork loads.
    this.style.display = 'inline-block';
    this.style.width = `${BREADBOARD_WIDTH}px`;
    this.style.height = `${BREADBOARD_HEIGHT}px`;
    fetchArt().then((svg) => {
      if (!this.isConnected) return;
      this.shadowRoot!.innerHTML = svg ?? buildFallbackSvg();
      const el = this.shadowRoot!.querySelector('svg');
      if (el) {
        el.setAttribute('width', String(BREADBOARD_WIDTH));
        el.setAttribute('height', String(BREADBOARD_HEIGHT));
      }
    });
  }

  get pinInfo() {
    return PINS as unknown as Array<{ name: string; x: number; y: number; number: number }>;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('velxio-breadboard')) {
  customElements.define('velxio-breadboard', BreadboardElement);
}
