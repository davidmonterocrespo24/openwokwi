/**
 * chipActions — overlay seam for extra per-chip actions in the file
 * explorer's custom-chip section header (next to Compile/Rename).
 *
 * Same contract as proRoutes/proSaveAction: OSS renders whatever is
 * registered (nothing, in a pure OSS build); the velxio-prod overlay
 * registers e.g. "Save to my chips". Version + subscribe let React pick
 * up registrations that land after mount (the overlay loads via a dynamic
 * import) — consume with useSyncExternalStore.
 */

export interface ChipAction {
  id: string;
  /** Tooltip/label. */
  title: string;
  /** Small glyph rendered inside the button (emoji or short text). */
  glyph: string;
  /** Invoked with the chip's component id. */
  run: (chipComponentId: string) => void;
}

const actions: ChipAction[] = [];
let version = 0;
const listeners = new Set<() => void>();

export function registerChipAction(action: ChipAction): void {
  const i = actions.findIndex((a) => a.id === action.id);
  if (i >= 0) actions[i] = action;
  else actions.push(action);
  version++;
  listeners.forEach((l) => l());
}

export function getChipActions(): readonly ChipAction[] {
  return actions;
}

export function getChipActionsVersion(): number {
  return version;
}

export function subscribeChipActions(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
