/**
 * Split a wire at a point, minting a junction node — the pure math behind
 * both junction gestures (drop-a-wire-end-onto-a-wire and the node tool).
 *
 * Operates on the RENDERED polyline, not the stored waypoints: the renderer
 * inserts implicit corner points between non-axis-aligned stored pairs, and
 * splitting on the stored pairs would let the two halves re-elbow into a
 * different L-orientation than the shape on screen. Rendered points → split →
 * `renderedToWaypoints` preserves the drawn shape exactly.
 *
 * Returns plain objects; the store action applies them (and owns the undo
 * command). Keeping this pure keeps it unit-testable without a canvas.
 */

import type { Wire, WireEndpoint } from '../types/wire';
import {
  distToSegment,
  getRenderedPoints,
  projectOntoSegment,
  renderedToWaypoints,
  type RenderedSegment,
} from './wireHitDetection';
import { generateUUID } from './uuid';
import { JUNCTION_METADATA_ID, JUNCTION_PIN } from './junction';

/** DynamicComponent wrapper padding(4) + border(2): the element origin sits
 *  at (+6,+6) from the stored component position — same constant every pin
 *  consumer uses (updateWirePositions, calculatePinPosition callers). */
const WRAPPER_OFFSET = 6;
/** The junction's single pin is dead-center of its 10x10 element (5,5). */
const PIN_CENTER = 5;

export interface WireSplitResult {
  /** The node component to add. `properties.color` carries the split wire's
   *  color so the dot reads as part of the run. */
  junction: {
    id: string;
    metadataId: string;
    x: number;
    y: number;
    properties: Record<string, unknown>;
  };
  /** The split wire's first half: original start → junction. */
  wireA: Wire;
  /** The second half: junction → original end. */
  wireB: Wire;
  /** The junction's pin endpoint, ready for a closing wire to land on. */
  endpoint: WireEndpoint;
}

/**
 * Compute the split of `wire` at the rendered point nearest to (wx, wy).
 * Returns null when the point is not within `threshold` of any rendered
 * segment — the caller treats that as "no hit" and falls through.
 *
 * Never split a breadboard seating wire (`bb`): they are auto-generated,
 * invisible, and re-created whenever the part moves — a junction on one
 * would be orphaned by the next drag.
 */
export function computeWireSplit(
  wire: Wire,
  wx: number,
  wy: number,
  threshold: number,
): WireSplitResult | null {
  if (wire.bb) return null;

  const pts = getRenderedPoints(wire);
  // Nearest rendered segment by index — findSegmentNearPoint returns the
  // FIRST within threshold, but the split needs the closest one so a click
  // near a corner lands on the leg the user actually aimed at.
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distToSegment(wx, wy, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestDist > threshold) return null;

  const a = pts[bestIdx];
  const b = pts[bestIdx + 1];
  const seg: RenderedSegment = {
    x1: a.x, y1: a.y, x2: b.x, y2: b.y,
    axis: a.y === b.y ? 'horizontal' : 'vertical',
    storedPairIndex: 0, // unused here — we operate on rendered indices
  };
  const p = projectOntoSegment(seg, wx, wy);

  // Degenerate splits: the projected point coincides with one of the wire's
  // own endpoints (clicked right on a pin). A zero-length half would render
  // as a stub and confuse every consumer — reject and let the caller treat
  // it as a plain pin click.
  const EPS = 0.5;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (
    (Math.abs(p.x - first.x) < EPS && Math.abs(p.y - first.y) < EPS) ||
    (Math.abs(p.x - last.x) < EPS && Math.abs(p.y - last.y) < EPS)
  ) {
    return null;
  }

  const junctionId = `${JUNCTION_METADATA_ID}_${generateUUID()}`;
  const junction = {
    id: junctionId,
    metadataId: JUNCTION_METADATA_ID,
    // Stored position = pin position minus wrapper offset minus pin center,
    // so the pin (and the dot under it) lands exactly on the split point.
    x: p.x - WRAPPER_OFFSET - PIN_CENTER,
    y: p.y - WRAPPER_OFFSET - PIN_CENTER,
    properties: { color: wire.color } as Record<string, unknown>,
  };

  const endpoint: WireEndpoint = {
    componentId: junctionId,
    pinName: JUNCTION_PIN,
    x: p.x,
    y: p.y,
  };

  // Rendered points of each half share P; renderedToWaypoints simplifies the
  // collinear run through P away on the touching leg, keeping only true
  // corners — the on-screen shape is byte-identical to before the split.
  const ptsA = [...pts.slice(0, bestIdx + 1), p];
  const ptsB = [p, ...pts.slice(bestIdx + 1)];

  // generateUUID ids: the legacy `wire-${Date.now()}` scheme collides when
  // two wires are minted in the same millisecond — which is exactly what a
  // split does.
  const wireA: Wire = {
    id: `wire-${generateUUID()}`,
    start: wire.start,
    end: endpoint,
    waypoints: renderedToWaypoints(ptsA),
    color: wire.color,
    ...(wire.signalType ? { signalType: wire.signalType } : {}),
    // The halves' shape is exact by construction; letting the auto-router
    // re-shape them later could pull the path off the junction visually.
    autoRouted: false,
  };
  const wireB: Wire = {
    id: `wire-${generateUUID()}`,
    start: endpoint,
    end: wire.end,
    waypoints: renderedToWaypoints(ptsB),
    color: wire.color,
    ...(wire.signalType ? { signalType: wire.signalType } : {}),
    autoRouted: false,
  };

  return { junction, wireA, wireB, endpoint };
}
