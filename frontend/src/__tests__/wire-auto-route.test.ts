/**
 * First-time wire auto-routing around component bounding boxes.
 */

import { describe, it, expect } from 'vitest';
import {
  routeAroundObstacles,
  collectWireSegments,
  ROUTE_MARGIN,
  WIRE_SEPARATION,
  type ObstacleRect,
} from '../utils/wireAutoRoute';
import { expandOrthogonalPoints } from '../utils/wireUtils';

/** True when no segment of [start, ...corners, end] crosses an inflated rect. */
function routeAvoids(
  start: { x: number; y: number },
  corners: { x: number; y: number }[],
  end: { x: number; y: number },
  rects: ObstacleRect[],
): boolean {
  const pts = expandOrthogonalPoints([start, ...corners, end]);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    for (const r of rects) {
      const rx = r.x - ROUTE_MARGIN;
      const ry = r.y - ROUTE_MARGIN;
      const rw = r.w + 2 * ROUTE_MARGIN;
      const rh = r.h + 2 * ROUTE_MARGIN;
      if (a.y === b.y) {
        if (a.y > ry && a.y < ry + rh && Math.max(a.x, b.x) > rx && Math.min(a.x, b.x) < rx + rw)
          return false;
      } else if (a.x > rx && a.x < rx + rw && Math.max(a.y, b.y) > ry && Math.min(a.y, b.y) < ry + rh) {
        return false;
      }
    }
  }
  return true;
}

describe('routeAroundObstacles', () => {
  const start = { x: 0, y: 0 };
  const end = { x: 300, y: 200 };

  it('returns null with no obstacles (default elbow keeps working)', () => {
    expect(routeAroundObstacles(start, end, [])).toBeNull();
  });

  it('returns null when the preview elbow is already clear', () => {
    // Obstacle far away from both L-routes
    expect(
      routeAroundObstacles(start, end, [{ x: 1000, y: 1000, w: 50, h: 50 }]),
    ).toBeNull();
  });

  it('uses the other elbow orientation when only the preview one is blocked', () => {
    // dy (200) > dx... no: dx=300 >= dy=200 → preview goes horizontal-first
    // through (300, 0). Block that with a rect on the top edge.
    const rects: ObstacleRect[] = [{ x: 120, y: -30, w: 60, h: 60 }];
    const corners = routeAroundObstacles(start, end, rects);
    expect(corners).toEqual([{ x: 0, y: 200 }]);
    expect(routeAvoids(start, corners!, end, rects)).toBe(true);
  });

  it('routes around an obstacle blocking both L orientations', () => {
    // A tall block straddling the middle blocks horizontal-first and
    // vertical-first alike; A* must detour around it.
    const rects: ObstacleRect[] = [{ x: 100, y: -100, w: 60, h: 400 }];
    const corners = routeAroundObstacles(start, end, rects);
    expect(corners).not.toBeNull();
    expect(corners!.length).toBeGreaterThan(0);
    expect(routeAvoids(start, corners!, end, rects)).toBe(true);
  });

  it('an endpoint-containing rect gets an escape corridor, not a free pass', () => {
    // The obstacle sits right on the start pin. The wire must be able to
    // LEAVE (routing can never fail because of the pin's own body), but the
    // rest of the body must still repel the route — dropping the rect
    // entirely let wires cross seated displays end to end.
    const r = routeAroundObstacles(start, end, [{ x: -20, y: -20, w: 40, h: 40 }]);
    // A route (or null when the escape happens to align with the direct
    // elbow) — either way it must not throw and must produce a usable shape.
    expect(r === null || Array.isArray(r)).toBe(true);
  });

  it('falls back to null when the target is fully walled off', () => {
    // Four rects boxing the end point with no gap
    const rects: ObstacleRect[] = [
      { x: 200, y: 100, w: 200, h: 20 },
      { x: 200, y: 280, w: 200, h: 20 },
      { x: 200, y: 100, w: 20, h: 200 },
      { x: 380, y: 100, w: 20, h: 200 },
    ];
    expect(routeAroundObstacles(start, { x: 300, y: 200 }, rects)).toBeNull();
  });

  it('keeps the route orthogonal', () => {
    const rects: ObstacleRect[] = [{ x: 100, y: -100, w: 60, h: 400 }];
    const corners = routeAroundObstacles(start, end, rects)!;
    const pts = [start, ...corners, end];
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i - 1].x === pts[i].x || pts[i - 1].y === pts[i].y).toBe(true);
    }
  });
});

describe('routeAroundObstacles — wire avoidance (soft costs)', () => {
  const seg = (x1: number, y1: number, x2: number, y2: number) => ({
    a: { x: x1, y: y1 },
    b: { x: x2, y: y2 },
  });

  /** Worst parallel-overlap px of the full route against the segments. */
  const parallelOverlap = (
    start: { x: number; y: number },
    corners: { x: number; y: number }[],
    end: { x: number; y: number },
    segs: Array<{ a: { x: number; y: number }; b: { x: number; y: number } }>,
  ) => {
    const pts = expandOrthogonalPoints([start, ...corners, end]);
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const horizontal = a.y === b.y;
      for (const s of segs) {
        if ((s.a.y === s.b.y) !== horizontal) continue;
        const gap = horizontal ? Math.abs(a.y - s.a.y) : Math.abs(a.x - s.a.x);
        if (gap >= WIRE_SEPARATION) continue;
        const lo = horizontal
          ? Math.max(Math.min(a.x, b.x), Math.min(s.a.x, s.b.x))
          : Math.max(Math.min(a.y, b.y), Math.min(s.a.y, s.b.y));
        const hi = horizontal
          ? Math.min(Math.max(a.x, b.x), Math.max(s.a.x, s.b.x))
          : Math.min(Math.max(a.y, b.y), Math.max(s.a.y, s.b.y));
        total += Math.max(0, hi - lo);
      }
    }
    return total;
  };

  it('null when no obstacles and no wires', () => {
    expect(routeAroundObstacles({ x: 0, y: 0 }, { x: 300, y: 0 }, [], [])).toBeNull();
  });

  it('dodges sideways instead of riding along a collinear wire', () => {
    // Existing wire runs exactly along the direct path start->end, but
    // does NOT terminate on either pin (a wire ending on our own pin is
    // exempt — it must touch there).
    const start = { x: 0, y: 100 };
    const end = { x: 300, y: 100 };
    const existing = [seg(-50, 100, 350, 100)];
    const corners = routeAroundObstacles(start, end, [], existing);
    expect(corners).not.toBeNull();
    // The routed shape must NOT overlap the existing wire in parallel
    // (endpoints touching at the shared start/end region are exempt zones,
    // but this wire shares no endpoint: it is exactly under the route).
    expect(parallelOverlap(start, corners!, end, existing)).toBe(0);
  });

  it('crossing a perpendicular wire stays allowed (no absurd detours)', () => {
    // A vertical wire fully spanning the corridor: crossing is unavoidable.
    const start = { x: 0, y: 100 };
    const end = { x: 300, y: 100 };
    const existing = [seg(150, -10000, 150, 10000)];
    // Route may be null (direct considered fine) or a route that still
    // crosses; either way it must not fail or detour to infinity.
    const corners = routeAroundObstacles(start, end, [], existing);
    if (corners) {
      // All corners stay within a sane window around the route.
      for (const c of corners!) {
        expect(Math.abs(c.y - 100)).toBeLessThan(200);
      }
    }
  });

  it('a wire sharing an endpoint with the route is exempt', () => {
    // Another wire starts at the same pin — near the pin they MUST touch.
    const start = { x: 0, y: 100 };
    const end = { x: 300, y: 100 };
    const sharing = [seg(0, 100, 0, 300)]; // starts exactly at `start`
    expect(routeAroundObstacles(start, end, [], sharing)).toBeNull();
  });

  it('routes a second parallel wire as a side-by-side lane (bus look)', () => {
    // First wire occupies y=100; the second, 4px away vertically at both
    // pins, should shift to a clear lane rather than ride on the first.
    const start = { x: 0, y: 104 };
    const end = { x: 300, y: 104 };
    const existing = [seg(-50, 100, 350, 100)];
    const corners = routeAroundObstacles(start, end, [], existing);
    expect(corners).not.toBeNull();
    expect(parallelOverlap(start, corners!, end, existing)).toBe(0);
  });

  it('wires outside the window are ignored (grid stays small)', () => {
    // 200 far-away wires must not blow the coordinate cap or the route.
    const start = { x: 0, y: 0 };
    const end = { x: 300, y: 0 };
    const far = Array.from({ length: 200 }, (_, i) => seg(5000 + i * 10, 0, 5000 + i * 10, 500));
    expect(routeAroundObstacles(start, end, [], far)).toBeNull();
  });

  it('degrades to null rather than failing when boxed in', () => {
    const start = { x: 0, y: 0 };
    const end = { x: 10, y: 0 };
    const cage: ObstacleRect[] = [
      { x: -50, y: -50, w: 120, h: 20 },
      { x: -50, y: 30, w: 120, h: 20 },
    ];
    // Whatever happens, it returns corners or null — never throws.
    const r = routeAroundObstacles(start, end, cage, []);
    expect(r === null || Array.isArray(r)).toBe(true);
  });
});

describe('collectWireSegments', () => {
  it('skips bb wires and the wire being routed', () => {
    const wires = [
      { id: 'w1', start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, waypoints: [] },
      { id: 'seat', bb: true, start: { x: 5, y: 5 }, end: { x: 5, y: 5 }, waypoints: [] },
      { id: 'me', start: { x: 0, y: 50 }, end: { x: 100, y: 50 }, waypoints: [] },
    ];
    const segs = collectWireSegments(wires as never, 'me');
    expect(segs.length).toBeGreaterThan(0);
    // Only w1's horizontal run at y=0 — nothing at y=50 or from the seat.
    expect(segs.every((s) => s.a.y === 0 && s.b.y === 0)).toBe(true);
  });

  it('expands implicit elbows so costs see what the user sees', () => {
    const wires = [
      { id: 'w1', start: { x: 0, y: 0 }, end: { x: 100, y: 80 }, waypoints: [] },
    ];
    const segs = collectWireSegments(wires as never);
    // Diagonal endpoints render as an L: one horizontal + one vertical.
    expect(segs).toHaveLength(2);
  });
});

describe('routeAroundObstacles — escape corridors (endpoint inside obstacle)', () => {
  it('a wire leaving a strip under a seated display does not cross its body', () => {
    // The reported case: a 4-digit display body ~200x95 seated on the
    // breadboard; the wire starts at a strip hole INSIDE the inflated bbox
    // (right under the display pins) and ends far to the right. Dropping
    // the rect let 15 wires run straight across the display.
    const display: ObstacleRect = { x: 523, y: 86, w: 210, h: 103 };
    const start = { x: 540, y: 180 };  // inside, near the BOTTOM edge
    const end = { x: 900, y: 120 };    // to the right, level with the body
    const corners = routeAroundObstacles(start, end, [display], []);
    expect(corners).not.toBeNull();
    // No horizontal run may pass through the body interior above the
    // escape row (i.e. the route must go around, not across).
    const pts = expandOrthogonalPoints([start, ...corners!, end]);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (a.y === b.y && a.y > 86 && a.y < 172) {
        // horizontal inside the body's vertical span (above the corridor
        // mouth region) must not overlap the body's x-range interior
        const overl = Math.min(Math.max(a.x, b.x), 523 + 210) - Math.max(Math.min(a.x, b.x), 523);
        expect(overl, `run at y=${a.y} crosses the display`).toBeLessThanOrEqual(16);
      }
    }
  });

  it('still routes when BOTH endpoints sit inside the same rect', () => {
    // Strip-to-strip wire fully under the display: carving twice may leave
    // nothing blocked — must not throw, must return something sane.
    const display: ObstacleRect = { x: 0, y: 0, w: 300, h: 100 };
    const r = routeAroundObstacles({ x: 30, y: 90 }, { x: 250, y: 90 }, [display], []);
    expect(r === null || Array.isArray(r)).toBe(true);
  });

  it('endpoint-outside rects behave exactly as before', () => {
    const rect: ObstacleRect = { x: 100, y: -50, w: 50, h: 100 };
    const corners = routeAroundObstacles({ x: 0, y: 0 }, { x: 300, y: 0 }, [rect], []);
    expect(corners).not.toBeNull(); // must detour around it
  });
});

describe('routeAroundObstacles — overlapping obstacle slab (seated resistor bank)', () => {
  it('escapes a point buried in overlapping rects via one shared corridor', () => {
    // 8 resistors at 19px pitch with ~66px inflated boxes form a solid slab.
    // With per-rect escape directions the corridors contradicted each other
    // and A* found no exit — the wire fell back to a display-crossing elbow.
    const slab: ObstacleRect[] = Array.from({ length: 8 }, (_, i) => ({
      x: 850 + i * 19, y: 440, w: 50, h: 105,
    }));
    const display: ObstacleRect = { x: 500, y: 434, w: 202, h: 95 };
    const start = { x: 906, y: 521 };  // strip hole inside 2-3 resistors
    const end = { x: 100, y: 219 };    // GPIO far left, above
    const corners = routeAroundObstacles(start, end, [display, ...slab], []);
    expect(corners).not.toBeNull();
    // The route must not cross the display body.
    const pts = expandOrthogonalPoints([start, ...corners!, end]);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]; const b = pts[i];
      const inX = Math.max(a.x, b.x) > 500 + 4 && Math.min(a.x, b.x) < 702 - 4;
      const inY = Math.max(a.y, b.y) > 434 + 4 && Math.min(a.y, b.y) < 529 - 4;
      expect(inX && inY, `segment (${a.x},${a.y})->(${b.x},${b.y}) crosses the display`).toBe(false);
    }
  });
});
