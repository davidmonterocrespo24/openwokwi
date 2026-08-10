/**
 * editorCommands — a tiny id → handler registry for the editor menu bar.
 *
 * The actions the File/Edit menus expose (save, open, export, reset the
 * canvas view…) already exist, but they live inside the closures of four
 * different components: EditorPage owns save/new, FileExplorer owns open,
 * EditorToolbar owns import/export, SimulatorCanvas owns the view. A menu
 * mounted in the app header can reach none of them by props without
 * threading callbacks through the whole page tree.
 *
 * So the owners register their handler under a stable id on mount (and
 * unregister on unmount), and the menu invokes by id — the same
 * registration-seam pattern the codebase already uses for pro examples,
 * guest setups and board builtins. A menu item whose command is not
 * currently registered renders disabled, which is also the truth: with no
 * canvas mounted there is nothing to reset.
 */

export type EditorCommandId =
  | 'project.new'
  | 'project.save'
  | 'project.open'
  | 'project.import'
  | 'project.export'
  | 'project.exportBom'
  | 'project.exportScreenshot'
  | 'file.new'
  | 'project.share'
  | 'project.githubSync'
  | 'firmware.upload'
  | 'sim.record'
  | 'sim.compile'
  | 'sim.run'
  | 'sim.stop'
  | 'sim.resetBoard'
  | 'view.toggleExplorer'
  | 'view.toggleConsole'
  | 'view.reset'
  | 'view.zoomIn'
  | 'view.zoomOut';

const handlers = new Map<EditorCommandId, () => void>();

// Menus re-render on registration changes so items enable/disable live.
let version = 0;
const listeners = new Set<() => void>();

export function registerEditorCommand(id: EditorCommandId, run: () => void): () => void {
  handlers.set(id, run);
  version++;
  for (const l of listeners) l();
  return () => {
    // Only clear if we are still the registered handler — a remount
    // registers the new closure BEFORE the old effect's cleanup runs.
    if (handlers.get(id) === run) {
      handlers.delete(id);
      version++;
      for (const l of listeners) l();
    }
  };
}

export function hasEditorCommand(id: EditorCommandId): boolean {
  return handlers.has(id);
}

export function runEditorCommand(id: EditorCommandId): void {
  handlers.get(id)?.();
}

export function subscribeEditorCommands(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getEditorCommandsVersion(): number {
  return version;
}
