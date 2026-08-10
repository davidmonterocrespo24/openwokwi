/**
 * instantEngine — runtime seam for an in-browser engine that can replace a
 * QEMU-Linux boot for the boards that don't need a real OS.
 *
 * QEMU-Linux boards (Raspberry Pi family + overlay piFamily kinds) cost a
 * backend process and ~90 s of boot per run. Most projects are just a
 * Python script driving GPIO and a screen — those can run in the browser
 * in a couple of seconds. An overlay registers an engine here; the store
 * asks it, per board, whether it can take this run:
 *
 *     Run pressed
 *       -> engine.decide(boardId)  ->  'instant'  : engine.run(boardId)
 *                                      'linux'    : boot the QEMU guest
 *
 * The decision is data (`EngineDecision`), not a boolean, so the UI can
 * explain WHY a board needs Linux ("script.py:12 uses subprocess") instead
 * of silently taking 90 s. Nothing is registered in the OSS build, so the
 * QEMU path stays exactly as it was.
 */

export interface EngineDecision {
  /** Which engine should take this run. */
  engine: 'instant' | 'linux';
  /** Short, user-facing reason. Empty when 'instant' with nothing to say. */
  reason: string;
  /** Optional `file:line` the reason refers to, for the tooltip. */
  where?: string;
}

export interface InstantEngine {
  /** Decide which engine runs this board's current files. */
  decide(boardId: string): EngineDecision;
  /** Run the board's files in the browser. Resolves when the script ends. */
  run(boardId: string): Promise<void>;
  /** Cancel a running script (the runtime may stay warm). */
  stop(boardId: string): void;
}

let engine: InstantEngine | null = null;
const listeners = new Set<() => void>();

export function registerInstantEngine(e: InstantEngine | null): void {
  engine = e;
  for (const l of listeners) l();
}

export function getInstantEngine(): InstantEngine | null {
  return engine;
}

/** Subscribe to registration (the overlay loads asynchronously). */
export function subscribeInstantEngine(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Which engine should run this board, honouring a user override.
 *
 * `pinned` comes from the board instance (the user clicked the mode chip
 * or turned on the Linux terminal); when set it wins over the detector,
 * because predictability beats cleverness for a project you already know.
 */
export function decideEngine(
  boardId: string,
  pinned?: 'instant' | 'linux',
): EngineDecision {
  if (pinned === 'linux') {
    return { engine: 'linux', reason: 'Linux mode is on for this project' };
  }
  if (!engine) {
    return { engine: 'linux', reason: 'the instant engine is not available' };
  }
  if (pinned === 'instant') {
    return { engine: 'instant', reason: 'instant mode is pinned for this project' };
  }
  try {
    return engine.decide(boardId);
  } catch {
    // A detector bug must never block a run: fall back to the real machine.
    return { engine: 'linux', reason: 'could not analyse the project' };
  }
}
