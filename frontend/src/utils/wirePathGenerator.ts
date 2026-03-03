/**
 * Wire Path Generator
 *
 * Generates SVG path strings for wires with orthogonal routing (only horizontal/vertical segments).
 * Phase 1: Simple L-shape
 * Phase 2: Multi-segment with control points
 * Phase 3: A* pathfinding integration
 */

import type { Wire, WireControlPoint } from '../types/wire';

/**
 * Generates an SVG path string for a wire.
 * Routes wires using orthogonal paths (90-degree angles only).
 *
 * @param wire - The wire object containing endpoints and control points
 * @returns SVG path string (e.g., "M 10 20 L 30 20 L 30 50")
 */
export function generateWirePath(wire: Wire): string {
  const { start, end, controlPoints } = wire;

  if (controlPoints.length === 0) {
    // Phase 1: Simple L-shape routing
    return generateSimplePath(start.x, start.y, end.x, end.y);
  } else {
    // Phase 2: Multi-segment with control points
    return generateMultiSegmentPath(start, controlPoints, end);
  }
}

/**
 * Phase 1: Generates a simple L-shaped path between two points.
 * Prioritizes horizontal-first routing (goes horizontal, then vertical, then horizontal).
 *
 * Pattern:
 *   Start → [horizontal] → midpoint → [vertical] → midpoint → [horizontal] → End
 *
 * @param x1 - Start X coordinate
 * @param y1 - Start Y coordinate
 * @param x2 - End X coordinate
 * @param y2 - End Y coordinate
 * @returns SVG path string
 */
function generateSimplePath(x1: number, y1: number, x2: number, y2: number): string {
  // Calculate midpoint X (for L-shape bend)
  const midX = x1 + (x2 - x1) / 2;

  // Create horizontal-first L-shape path
  // Format: M x1,y1 L midX,y1 L midX,y2 L x2,y2
  return `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`;
}

/**
 * Phase 2: Generates path with multiple control points.
 * All segments are constrained to horizontal or vertical only (orthogonal routing).
 *
 * @param start - Start endpoint { x, y }
 * @param controlPoints - Array of control points
 * @param end - End endpoint { x, y }
 * @returns SVG path string
 */
function generateMultiSegmentPath(
  start: { x: number; y: number },
  controlPoints: WireControlPoint[],
  end: { x: number; y: number }
): string {
  let path = `M ${start.x} ${start.y}`;

  // Add control points with orthogonal constraint
  for (let i = 0; i < controlPoints.length; i++) {
    const cp = controlPoints[i];
    const prev = i === 0 ? start : controlPoints[i - 1];

    // Determine if we should go horizontal-first or vertical-first
    // Based on which axis has more distance to cover
    const dx = Math.abs(cp.x - prev.x);
    const dy = Math.abs(cp.y - prev.y);

    if (dx > dy) {
      // More horizontal movement - go horizontal first, then vertical
      path += ` L ${cp.x} ${prev.y} L ${cp.x} ${cp.y}`;
    } else {
      // More vertical movement - go vertical first, then horizontal
      path += ` L ${prev.x} ${cp.y} L ${cp.x} ${cp.y}`;
    }
  }

  // Connect last control point to end
  const lastPoint = controlPoints.length > 0 ? controlPoints[controlPoints.length - 1] : start;
  const dx = Math.abs(end.x - lastPoint.x);
  const dy = Math.abs(end.y - lastPoint.y);

  if (dx > dy) {
    path += ` L ${end.x} ${lastPoint.y} L ${end.x} ${end.y}`;
  } else {
    path += ` L ${lastPoint.x} ${end.y} L ${end.x} ${end.y}`;
  }

  return path;
}

/**
 * Calculates the total length of a wire path (useful for rendering and optimization).
 *
 * @param wire - The wire object
 * @returns Total path length in pixels
 */
export function calculateWireLength(wire: Wire): number {
  const { start, end, controlPoints } = wire;

  let totalLength = 0;
  let prevPoint = start;

  for (const cp of controlPoints) {
    totalLength += Math.abs(cp.x - prevPoint.x) + Math.abs(cp.y - prevPoint.y);
    prevPoint = cp;
  }

  totalLength += Math.abs(end.x - prevPoint.x) + Math.abs(end.y - prevPoint.y);

  return totalLength;
}
