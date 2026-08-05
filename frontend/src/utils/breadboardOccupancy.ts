/**
 * Breadboard hole-occupancy rules ("vocabulario"):
 *
 *   - each HOLE (pin) holds at most ONE wire end — a seated component leg
 *     counts as occupying its hole;
 *   - a terminal-strip ROW (5 holes) is one net, so two wires landing in
 *     different holes of the same row are connected — that's the legal way
 *     to fan out;
 *   - clicking a hole occupied by a (visible) wire selects that wire
 *     instead of starting a new one — otherwise wires whose whole length
 *     lies over hole overlays are impossible to select.
 *
 * These helpers are pure over the wires list + pin names so they're
 * unit-testable without a DOM.
 */

import type { Wire } from '../types/wire';
import { breadboardGroupKey } from './breadboardNets';

/**
 * The topmost VISIBLE wire with an endpoint exactly on (componentId, pinName),
 * or null. Invisible `bb` seating wires are never returned — they're not
 * user-interactive — but see `holeIsOccupied` for occupancy checks.
 */
export function findWireAtHole(
  wires: Wire[],
  componentId: string,
  pinName: string,
): Wire | null {
  for (let i = wires.length - 1; i >= 0; i--) {
    const w = wires[i];
    if (w.bb) continue;
    if (
      (w.start.componentId === componentId && w.start.pinName === pinName) ||
      (w.end.componentId === componentId && w.end.pinName === pinName)
    ) {
      return w;
    }
  }
  return null;
}

/**
 * True when any wire end — including an invisible seating wire (a seated
 * component leg) — already lives in this hole.
 */
export function holeIsOccupied(wires: Wire[], componentId: string, pinName: string): boolean {
  return wires.some(
    (w) =>
      (w.start.componentId === componentId && w.start.pinName === pinName) ||
      (w.end.componentId === componentId && w.end.pinName === pinName),
  );
}

/**
 * Resolve the hole a NEW wire end should land in, honouring one-wire-per-hole:
 * returns `pinName` itself when free, else the nearest FREE hole in the same
 * internal group (5-hole strip / power rail) — electrically identical, so the
 * connection intent is preserved. Falls back to the original hole when the
 * whole group is occupied (stacking is still electrically traced).
 *
 * `allPinNames` is the breadboard element's full pin list (from pinInfo);
 * "nearest" is by index distance within the group, which matches physical
 * adjacency for both strips and rails.
 */
export function resolveFreeHole(
  metadataId: string,
  componentId: string,
  pinName: string,
  wires: Wire[],
  allPinNames: string[],
): string {
  if (!holeIsOccupied(wires, componentId, pinName)) return pinName;
  const group = breadboardGroupKey(metadataId, pinName);
  if (!group) return pinName;
  const clickedIdx = allPinNames.indexOf(pinName);
  const candidates = allPinNames
    .filter(
      (name) =>
        name !== pinName &&
        breadboardGroupKey(metadataId, name) === group &&
        !holeIsOccupied(wires, componentId, name),
    )
    .sort(
      (a, b) =>
        Math.abs(allPinNames.indexOf(a) - clickedIdx) -
        Math.abs(allPinNames.indexOf(b) - clickedIdx),
    );
  return candidates[0] ?? pinName;
}
