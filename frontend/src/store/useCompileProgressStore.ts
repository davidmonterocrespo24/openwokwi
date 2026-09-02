/**
 * Zustand store for the LIVE state of the compiles currently in flight.
 *
 * Separate from `useCompileLogsStore` (which accumulates the finished log) for
 * the same reason that one lives outside <EditorPage>: the compile is started
 * by EditorToolbar, and the panel that reports it renders over the simulator
 * canvas — two different subtrees, and on multi-board projects several builds
 * at once. A store is the only thing both ends can reach without prop-drilling
 * through the whole editor shell.
 *
 * One entry per board being built. The overlay aggregates them into a single
 * card; keeping them separate is what lets it say "2 of 3 boards" honestly
 * instead of showing whichever build reported last.
 *
 * Entries are removed shortly after they finish so the card can show the final
 * "Compiled in 8.1s" for a beat instead of vanishing mid-sentence.
 */

import { create } from 'zustand';

import type { CompileProgressInfo, CompileStage, CompileTier, ServerLoad } from '../services/compilation';

/** How long a finished build stays on screen before the card drops it. */
const LINGER_MS = 1600;

export type CompileOutcome = 'success' | 'error';

export interface CompileProgressEntry {
  boardId: string;
  /** Human label for the board being built ("ESP32 DevKit"). */
  label: string;
  /** Client clock at the moment Compile was pressed. Drives the on-screen
   *  timer, which must keep ticking between polls. */
  startedAt: number;
  stage: CompileStage;
  /** 0..1, or null while queued (nothing honest to draw yet). */
  progress: number | null;
  estimatedSeconds: number | null;
  buildSeconds: number;
  serverLoad: ServerLoad;
  tier: CompileTier;
  priority: boolean;
  /** Most recent meaningful line of build output, shown under the bar. */
  lastLine: string;
  outcome: CompileOutcome | null;
  finishedAt: number | null;
}

interface CompileProgressState {
  entries: Record<string, CompileProgressEntry>;
  /** Increments when a compile run starts (a `begin` with nothing in flight).
   *  The card keys its dismissal on this: deriving a run identity from
   *  min(startedAt) instead was unstable — it changed as entries settled and
   *  dropped, so a dismissed card could reappear and a new run's card could
   *  stay suppressed behind a lingering older entry. */
  runId: number;
  /** True from the click until the last build settles — the card's own
   *  visibility gate, independent of whether any poll has landed yet. */
  begin: (boardId: string, label: string) => void;
  update: (boardId: string, info: CompileProgressInfo, lastLine?: string) => void;
  /** Rename an in-flight entry without restarting its timer. Compile-All
   *  builds the boards one after another under a single card, and the header
   *  has to follow along ("ESP32 DevKit (2 of 3)") without the elapsed time
   *  resetting at every board. */
  relabel: (boardId: string, label: string) => void;
  finish: (boardId: string, outcome: CompileOutcome) => void;
  /** Drop everything immediately (project switch, unmount). */
  reset: () => void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function clearTimer(boardId: string): void {
  const timer = timers.get(boardId);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(boardId);
  }
}

export const useCompileProgressStore = create<CompileProgressState>((set, get) => ({
  entries: {},
  runId: 0,

  begin: (boardId, label) => {
    clearTimer(boardId);
    set((s) => ({
      // A new RUN starts only when nothing was in flight; the second board of
      // a Compile-All joins the run already under way.
      runId: Object.keys(s.entries).length === 0 ? s.runId + 1 : s.runId,
      entries: {
        ...s.entries,
        [boardId]: {
          boardId,
          label,
          startedAt: Date.now(),
          // Every compile starts queued as far as the client knows: the job is
          // posted and nothing has come back yet. Claiming 'preparing' here
          // would show a progress bar for a build that may not have started.
          stage: 'queued',
          progress: null,
          estimatedSeconds: null,
          buildSeconds: 0,
          serverLoad: 'low',
          tier: 'local',
          priority: false,
          lastLine: '',
          outcome: null,
          finishedAt: null,
        },
      },
    }));
  },

  update: (boardId, info, lastLine) => {
    const existing = get().entries[boardId];
    if (!existing || existing.outcome !== null) return;
    set((s) => ({
      entries: {
        ...s.entries,
        [boardId]: {
          ...existing,
          stage: info.stage,
          progress: info.progress,
          estimatedSeconds: info.estimatedSeconds,
          buildSeconds: info.buildSeconds,
          serverLoad: info.serverLoad,
          tier: info.tier,
          priority: info.priority,
          lastLine: lastLine ?? existing.lastLine,
        },
      },
    }));
  },

  relabel: (boardId, label) => {
    const existing = get().entries[boardId];
    if (!existing || existing.outcome !== null) return;
    set((s) => ({
      entries: {
        ...s.entries,
        // A new board's build starts with no fraction of its own; carrying the
        // previous board's percentage over would show the bar jumping
        // backwards on the next poll.
        [boardId]: { ...existing, label, progress: null, stage: 'queued', lastLine: '' },
      },
    }));
  },

  finish: (boardId, outcome) => {
    const existing = get().entries[boardId];
    if (!existing) return;
    set((s) => ({
      entries: {
        ...s.entries,
        [boardId]: {
          ...existing,
          stage: 'done',
          progress: 1,
          outcome,
          finishedAt: Date.now(),
        },
      },
    }));
    clearTimer(boardId);
    timers.set(
      boardId,
      setTimeout(() => {
        timers.delete(boardId);
        set((s) => {
          const next = { ...s.entries };
          delete next[boardId];
          return { entries: next };
        });
      }, LINGER_MS),
    );
  },

  reset: () => {
    timers.forEach((timer) => clearTimeout(timer));
    timers.clear();
    set({ entries: {} });
  },

}));

/**
 * The one entry a Compile-All uses. The boards are built sequentially, so
 * `begin`-ing each real board id would show two cards' worth of state during
 * the hand-over (the finished one lingers) and restart the timer every board.
 * One synthetic entry, relabelled as the loop advances, is what the user
 * actually wants to see: one build running, N of M.
 */
export const MULTI_BOARD_PROGRESS_ID = '__compile-all__';

/** Non-hook accessor for call sites outside React (the toolbar's async
 *  compile handler, the agent's compile tool). */
export const compileProgress = {
  begin: (boardId: string, label: string) =>
    useCompileProgressStore.getState().begin(boardId, label),
  update: (boardId: string, info: CompileProgressInfo, lastLine?: string) =>
    useCompileProgressStore.getState().update(boardId, info, lastLine),
  relabel: (boardId: string, label: string) =>
    useCompileProgressStore.getState().relabel(boardId, label),
  finish: (boardId: string, outcome: CompileOutcome) =>
    useCompileProgressStore.getState().finish(boardId, outcome),
};
