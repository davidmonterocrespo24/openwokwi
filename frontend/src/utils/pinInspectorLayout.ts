/**
 * pinInspectorLayout — pure geometry for the Part Inspector's spatial pin view.
 *
 * Input: a part's pinInfo (element-local CSS px at scale 1 — the same numbers
 * the canvas snaps wires to) and its measured natural size. Output: where to
 * draw each pin dot and its label around a scaled preview of the part, so the
 * dialog can show "pins where they really are" for ANY part or board without
 * per-component data. That genericity is the point: pinInfo + size is the
 * whole input, so future parts work unmodified.
 *
 * No DOM, no React, deterministic — unit-tested in
 * __tests__/pin-inspector-layout.test.ts with real pin tables.
 */

export type PinEdge = 'left' | 'right' | 'top' | 'bottom' | 'interior';

export interface InspectorPinInput {
  name: string;
  x: number;
  y: number;
  signals?: Array<{ type?: string; signal?: string }>;
}

export type PinSignalKind =
  | 'i2c'
  | 'spi'
  | 'usart'
  | 'power-gnd'
  | 'power-vcc'
  | 'pwm'
  | 'analog'
  | 'other';

export interface LaidOutPin {
  name: string;
  edge: PinEdge;
  /** Scaled px, relative to the ART box top-left. */
  dotX: number;
  dotY: number;
  /** Scaled px, label anchor point, same origin. */
  labelX: number;
  labelY: number;
  /** True when the label was nudged away from its dot row/column. */
  needsLeader: boolean;
  signalKind: PinSignalKind;
}

export interface PinLayoutResult {
  /** Scale applied to the natural size. */
  scale: number;
  artWidth: number;
  artHeight: number;
  pins: LaidOutPin[];
  /** Gutter reserved on each side for labels; 0 when that side has no pins. */
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
}

export interface PinLayoutOptions {
  maxArtWidth?: number;
  maxArtHeight?: number;
  /** Minimum label spacing along an edge, px (left/right stacks). */
  minSpacing?: number;
  /** A pin farther than this fraction of the dimension from EVERY edge is interior. */
  interiorFrac?: number;
}

/** Horizontal gutter for left/right label columns (room for "GND2" etc.). */
const SIDE_GUTTER = 72;
/**
 * Vertical gutter for top/bottom labels. Those are drawn as VERTICAL text —
 * the way printed pinout diagrams do it — because horizontal ones do not fit:
 * an SSD1306 has 8 pins along a 240px edge, and at the ~36px a horizontal
 * "DATA" needs they demand 288px and spill out of the dialog. Vertical text
 * needs only the same spacing as a side column, and the gutter grows instead.
 */
const CAP_GUTTER = 52;
/** Small parts (a resistor is 107x11) are upscaled, but only this far. */
const MAX_UPSCALE = 2;

export function signalKindOf(pin: InspectorPinInput): PinSignalKind {
  const s = pin.signals?.[0];
  if (!s || typeof s !== 'object') return 'other';
  switch (s.type) {
    case 'i2c':
      return 'i2c';
    case 'spi':
      return 'spi';
    case 'usart':
      return 'usart';
    case 'pwm':
      return 'pwm';
    case 'analog':
      return 'analog';
    case 'power':
      return s.signal === 'GND' ? 'power-gnd' : 'power-vcc';
    default:
      return 'other';
  }
}

/**
 * Stack labels along one edge: process in position order and push each label
 * forward so no two sit closer than `spacing`. If the stack overruns the art,
 * shift it back as one block (clamped at 0) — this keeps a 15-pin column
 * centred on its side instead of trailing off the bottom.
 */
function stackLabels(
  positions: number[],
  spacing: number,
  extent: number,
): { out: number[]; nudged: boolean[] } {
  const order = positions.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  const placed: number[] = [];
  for (let k = 0; k < order.length; k++) {
    const want = order[k][0];
    placed.push(k === 0 ? want : Math.max(want, placed[k - 1] + spacing));
  }
  // Shift the whole stack up if it overran the art extent and there is room.
  const overrun = placed.length ? placed[placed.length - 1] - extent : 0;
  if (overrun > 0) {
    const room = placed[0]; // how far the first label can move toward 0
    const shift = Math.min(overrun, Math.max(0, room));
    for (let k = 0; k < placed.length; k++) placed[k] -= shift;
  }
  const out = new Array<number>(positions.length);
  const nudged = new Array<boolean>(positions.length);
  for (let k = 0; k < order.length; k++) {
    const i = order[k][1];
    out[i] = placed[k];
    nudged[i] = Math.abs(placed[k] - positions[i]) > 1;
  }
  return { out, nudged };
}

export function layoutInspectorPins(
  pins: InspectorPinInput[],
  natural: { width: number; height: number },
  opts: PinLayoutOptions = {},
): PinLayoutResult {
  const maxW = opts.maxArtWidth ?? 260;
  const maxH = opts.maxArtHeight ?? 260;
  const minSpacing = opts.minSpacing ?? 16;
  const interiorFrac = opts.interiorFrac ?? 0.18;

  const w = Math.max(1, natural.width);
  const h = Math.max(1, natural.height);
  const scale = Math.min(maxW / w, maxH / h, MAX_UPSCALE);
  const W = w * scale;
  const H = h * scale;

  // Classify each pin.
  //
  // Nearest-edge alone is wrong for real parts, and got caught by the
  // ReSpeaker Lite: its XIAO socket is two INSET columns (x=50.5 and 126.5 on
  // a 178-wide body) plus two rows of breakout pads. Every one of those sat
  // far enough from all four edges to be called "interior", which printed no
  // label — the pins were on screen as dots and looked missing. And a plain
  // nearest-edge rule scatters a column's end pins to the top/bottom gutter.
  //
  // So: find the LINES first. Pins sharing an x form a vertical column, pins
  // sharing a y form a horizontal row; a column belongs to the side of the
  // body it sits on, however far inset it is, and a leader line joins its
  // labels to the dots. Only a pin that belongs to no line falls back to its
  // nearest edge. Every pin gets a printed label — that is the contract.
  const TOL = 6 * scale; // pads within this are the same column/row
  const cluster = (vals: number[]): number[][] => {
    const idx = vals.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const groups: number[][] = [];
    let cur: number[] = [];
    let last = NaN;
    for (const [v, i] of idx) {
      if (cur.length && Math.abs(v - last) > TOL) {
        groups.push(cur);
        cur = [];
      }
      cur.push(i);
      last = v;
    }
    if (cur.length) groups.push(cur);
    return groups;
  };

  const xs = pins.map((p) => p.x * scale);
  const ys = pins.map((p) => p.y * scale);
  const side = new Array<PinEdge | null>(pins.length).fill(null);

  /** Largest gap between consecutive values — a real header has small ones. */
  const maxGap = (vals: number[]): number => {
    const s = [...vals].sort((a, b) => a - b);
    let m = 0;
    for (let i = 1; i < s.length; i++) m = Math.max(m, s[i] - s[i - 1]);
    return m;
  };

  // Vertical columns win first: they are the dominant shape on breakout
  // boards, shields and every DIP part. A column must be a RUN of pads, which
  // is why it needs three of them and small gaps: an Arduino Uno has two
  // opposite headers with six x values shared between them, and reading those
  // pairs as columns threw most of the board's pins into the side gutters
  // with a fan of leader lines across the art.
  const colGroups: Array<{ idx: number[]; c: number }> = [];
  for (const g of cluster(xs)) {
    if (g.length < 3) continue;
    const gys = g.map((i) => ys[i]);
    if (Math.max(...gys) - Math.min(...gys) < TOL) continue; // a row, not a column
    if (maxGap(gys) > 0.4 * H) continue; // opposite ends of the body, not a run
    colGroups.push({ idx: g, c: g.reduce((s, i) => s + xs[i], 0) / g.length });
  }
  // A dual-row pin header (the Pi's 40-pin GPIO, rotated into two adjacent
  // columns) must NOT dump both lines into one gutter — 40 interleaved
  // labels never fit one side. Printed pinout posters split such a pair:
  // first line's labels left, second line's right, leaders crossing the art.
  const isHeaderPair = (a: { idx: number[]; c: number }, b: { idx: number[]; c: number }) =>
    Math.abs(a.c - b.c) <= 5 * TOL && a.idx.length + b.idx.length >= 16;
  if (colGroups.length === 2 && isHeaderPair(colGroups[0], colGroups[1])) {
    const [a, b] =
      colGroups[0].c <= colGroups[1].c
        ? [colGroups[0], colGroups[1]]
        : [colGroups[1], colGroups[0]];
    for (const i of a.idx) side[i] = 'left';
    for (const i of b.idx) side[i] = 'right';
  } else {
    for (const g of colGroups) {
      const e: PinEdge = g.c <= W / 2 ? 'left' : 'right';
      for (const i of g.idx) side[i] = e;
    }
  }
  // Then horizontal rows, for whatever is still unassigned (headers).
  const rowGroups: Array<{ idx: number[]; c: number }> = [];
  for (const g of cluster(ys)) {
    const free = g.filter((i) => side[i] === null);
    if (free.length < 2) continue;
    const gxs = free.map((i) => xs[i]);
    if (Math.max(...gxs) - Math.min(...gxs) < TOL) continue;
    if (maxGap(gxs) > 0.4 * W) continue;
    rowGroups.push({ idx: free, c: free.reduce((s, i) => s + ys[i], 0) / free.length });
  }
  // Same poster-style split for an unrotated dual-row header (top/bottom).
  if (rowGroups.length === 2 && isHeaderPair(rowGroups[0], rowGroups[1])) {
    const [a, b] =
      rowGroups[0].c <= rowGroups[1].c
        ? [rowGroups[0], rowGroups[1]]
        : [rowGroups[1], rowGroups[0]];
    for (const i of a.idx) side[i] = 'top';
    for (const i of b.idx) side[i] = 'bottom';
  } else {
    for (const g of rowGroups) {
      const e: PinEdge = g.c <= H / 2 ? 'top' : 'bottom';
      for (const i of g.idx) side[i] = e;
    }
  }

  const classified = pins.map((pin, i) => {
    const x = xs[i];
    const y = ys[i];
    let edge = side[i];
    if (!edge) {
      // A lone pad: nearest edge.
      const d = [
        ['left', x],
        ['right', W - x],
        ['top', y],
        ['bottom', H - y],
      ] as Array<[PinEdge, number]>;
      d.sort((a, b) => a[1] - b[1]);
      edge = d[0][0];
    }
    return { pin, x, y, edge };
  });
  // interiorFrac is retained in the options for callers that want the old
  // behaviour; the line-first classifier makes it unnecessary here.
  void interiorFrac;

  // Lay labels per edge. Left/right stack along y; top/bottom along x
  // (with wider spacing — their labels are horizontal text).
  const laid: LaidOutPin[] = new Array(pins.length);
  const byEdge = (e: PinEdge) =>
    classified.map((c, i) => [c, i] as const).filter(([c]) => c.edge === e);

  for (const edge of ['left', 'right'] as const) {
    const group = byEdge(edge);
    const { out, nudged } = stackLabels(
      group.map(([c]) => c.y),
      minSpacing,
      H,
    );
    group.forEach(([c, i], k) => {
      laid[i] = {
        name: c.pin.name,
        edge,
        dotX: c.x,
        dotY: c.y,
        labelX: edge === 'left' ? -8 : W + 8,
        labelY: out[k],
        needsLeader: nudged[k],
        signalKind: signalKindOf(c.pin),
      };
    });
  }
  for (const edge of ['top', 'bottom'] as const) {
    const group = byEdge(edge);
    const { out, nudged } = stackLabels(
      group.map(([c]) => c.x),
      minSpacing,
      W,
    );
    group.forEach(([c, i], k) => {
      laid[i] = {
        name: c.pin.name,
        edge,
        dotX: c.x,
        dotY: c.y,
        labelX: out[k],
        labelY: edge === 'top' ? -8 : H + 8,
        needsLeader: nudged[k],
        signalKind: signalKindOf(c.pin),
      };
    });
  }
  // A leader is also needed whenever the DOT is inset from its gutter, even
  // if the label sits on the dot's own row: without it an inset column's
  // labels look unattached to anything.
  for (const p of laid) {
    if (!p) continue;
    if (p.edge === 'left' && p.dotX > 6) p.needsLeader = true;
    else if (p.edge === 'right' && p.dotX < W - 6) p.needsLeader = true;
    else if (p.edge === 'top' && p.dotY > 6) p.needsLeader = true;
    else if (p.edge === 'bottom' && p.dotY < H - 6) p.needsLeader = true;
  }

  const has = (e: PinEdge) => classified.some((c) => c.edge === e);
  let padLeft = has('left') ? SIDE_GUTTER : 0;
  let padRight = has('right') ? SIDE_GUTTER : 0;
  let padTop = has('top') ? CAP_GUTTER : 0;
  let padBottom = has('bottom') ? CAP_GUTTER : 0;

  // A stack taller than the art must not be clipped. A ReSpeaker's left side
  // carries 13 labels: at the minimum spacing that is 208 px against a 190 px
  // body, so the column necessarily runs past both ends and the first and
  // last labels were cut off. Grow the gutters to whatever the labels
  // actually occupy — the box follows the content, not the other way round.
  const HALF_LINE = 7; // half a label's line box, plus a hair of margin
  for (const p of laid) {
    if (!p) continue;
    if (p.edge === 'left' || p.edge === 'right') {
      padTop = Math.max(padTop, HALF_LINE - p.labelY);
      padBottom = Math.max(padBottom, p.labelY + HALF_LINE - H);
    } else {
      // Vertical text on the caps: its extent along x is the line box.
      padLeft = Math.max(padLeft, HALF_LINE - p.labelX);
      padRight = Math.max(padRight, p.labelX + HALF_LINE - W);
    }
  }

  return {
    scale,
    artWidth: W,
    artHeight: H,
    pins: laid,
    padLeft: Math.max(0, Math.round(padLeft)),
    padRight: Math.max(0, Math.round(padRight)),
    padTop: Math.max(0, Math.round(padTop)),
    padBottom: Math.max(0, Math.round(padBottom)),
  };
}
