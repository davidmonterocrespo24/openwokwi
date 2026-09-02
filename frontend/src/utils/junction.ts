/**
 * The wire-junction predicate, shared by every consumer that must recognize
 * the node part (canvas gestures, the digital gate engine's net classifier).
 *
 * Mirrors `isBreadboard` in breadboardNets.ts: one metadataId test in one
 * place, so the id never gets string-compared in five files. The junction is
 * a normal 1-pin component everywhere else — the SPICE-side net builders
 * union a shared pin transitively and need no knowledge of it at all (and it
 * deliberately has NO componentToSpice mapper: absence keeps its nets out of
 * `sourcedNets`, exactly like a bare wire).
 */

export const JUNCTION_METADATA_ID = 'junction';

/** The single pin every junction exposes (see velxio-elements/junction-element.ts).
 *  Deliberately clear of the GND/VCC power-pin regexes that four separate net
 *  builders match on. */
export const JUNCTION_PIN = 'J';

export function isJunction(metadataId: string): boolean {
  return metadataId === JUNCTION_METADATA_ID;
}
