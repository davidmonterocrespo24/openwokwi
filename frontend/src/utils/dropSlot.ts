/**
 * Where a newly added component lands on the canvas.
 *
 * Two things went wrong before this existed. New parts were placed at fixed
 * world coordinates, so once the canvas was panned they appeared outside the
 * viewport — added, invisible, apparently broken. And the cascade that kept
 * them from stacking was keyed on how many components the project had, so it
 * marched on forever: move a part away or delete it and the next drop still
 * landed further down-right, drifting away from where you were looking.
 *
 * The rule here is simpler and matches what people expect: start at the
 * top-left of the VISIBLE canvas and take the first free slot, stepping
 * down-right while something is still parked on one. Move the last part
 * aside and the next drop reclaims its place.
 */

export interface PlacedItem {
  x: number;
  y: number;
}

export interface DropSlotOptions {
  /** How far apart consecutive drops sit, in world units. */
  step: number;
  /** Give up cascading after this many occupied slots and stack at the last
   *  one — past a dozen untouched drops the cascade would leave the viewport
   *  anyway, which is the very problem this solves. */
  maxSlots?: number;
}

/**
 * First free slot at or after `origin`, cascading down-right.
 *
 * "Free" means no item is parked within half a step of it, so a component
 * the user nudged aside no longer counts as occupying its old slot.
 */
export function pickDropSlot(
  origin: PlacedItem,
  placed: readonly PlacedItem[],
  { step, maxSlots = 12 }: DropSlotOptions,
): PlacedItem {
  const tolerance = Math.abs(step) * 0.5;
  const occupied = (px: number, py: number): boolean =>
    placed.some(
      (item) => Math.abs(item.x - px) < tolerance && Math.abs(item.y - py) < tolerance,
    );

  let x = origin.x;
  let y = origin.y;
  for (let slot = 0; slot < maxSlots && occupied(x, y); slot++) {
    x = origin.x + (slot + 1) * step;
    y = origin.y + (slot + 1) * step;
  }
  return { x, y };
}
