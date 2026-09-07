/**
 * Workspace draft — keep an anonymous user's in-progress circuit + code across
 * a full-page navigation to /login and back.
 *
 * The Sign-in links mount in a separate React root without Router context, so
 * they navigate with `window.location.assign` (full page load), which wipes
 * the in-memory Zustand stores. Before that navigation we stash the whole
 * workspace (reusing the lossless `.vlx` serialisation) into sessionStorage;
 * when the editor remounts after login it restores the stash. sessionStorage
 * is same-tab and survives the reload, and is discarded when the tab closes.
 *
 * Scoped strictly to the login round-trip via a one-shot restore flag — it is
 * NOT a general autosave, so a normal reload never resurrects an old draft.
 */

import type { BoardInstance } from '../types/board';
import { useProjectStore } from '../store/useProjectStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useEditorStore } from '../store/useEditorStore';
import { isProBoardKind } from '../lib/proBoardGate';
import { buildVlxPayload } from './vlxFile';

const DRAFT_KEY = 'velxio_ws_draft';
const RESTORE_FLAG = 'velxio_ws_restore';

/** True when the workspace holds something worth preserving (a real build,
 *  not just the empty starter board).
 *
 *  Parts and wires were the only signals, and the most common reason to
 *  sign in mid-build has neither: a Pro board placed alone with its code
 *  written (the sign-in prompt on Run), or a second board on the canvas.
 *  So a board beyond the starter, a Pro board, or an edited file all count. */
export function workspaceHasWork(): boolean {
  const sim = useSimulatorStore.getState();
  if (sim.components.length > 0 || sim.wires.length > 0) return true;
  if (sim.boards.length > 1) return true;
  if (sim.boards.some((b) => isProBoardKind(b.boardKind))) return true;
  return useEditorStore.getState().files.some((f) => f.modified);
}

/**
 * Snapshot the current workspace and mark it for restore on the next editor
 * mount. Call right before a full-page navigation to /login. No-op when there
 * is nothing worth keeping or storage is unavailable.
 */
export function stashWorkspaceForAuth(): void {
  try {
    if (!workspaceHasWork()) return;
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(buildVlxPayload()));
    sessionStorage.setItem(RESTORE_FLAG, '1');
  } catch {
    // storage full / disabled — degrade to losing the draft, never throw.
  }
}

/**
 * If a stash is pending (set before the login redirect), load it into the
 * stores and clear it. Runs once on editor mount. Skips when a named project
 * is already loaded so it never clobbers one. Returns whether it restored.
 */
export function restoreStashedWorkspace(): boolean {
  let raw: string | null = null;
  try {
    if (sessionStorage.getItem(RESTORE_FLAG) !== '1') return false;
    sessionStorage.removeItem(RESTORE_FLAG);
    raw = sessionStorage.getItem(DRAFT_KEY);
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;
  if (useProjectStore.getState().currentProject) return false;
  try {
    const payload = JSON.parse(raw);
    useSimulatorStore.getState().loadProjectState({
      boards: payload.boards as unknown as BoardInstance[],
      fileGroups: payload.fileGroups,
      folderGroups: payload.folderGroups,
      components: payload.components,
      wires: payload.wires,
      activeBoardId: payload.activeBoardId,
    });
    return true;
  } catch {
    return false;
  }
}
