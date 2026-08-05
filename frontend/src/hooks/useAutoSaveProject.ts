/**
 * Auto-save hook — skeleton.
 *
 * The actual save logic (debouncing, dirty detection, owner eligibility,
 * PUT to /api/projects/{id}) is supplied by an installed implementation.
 * OSS without an overlay registers no implementation, and the hook stays
 * idle forever — exactly the behavior we want once project persistence
 * moves to the private overlay (Phase 3 of the OSS split).
 *
 * The skeleton always runs the same useState + useEffect, so registering
 * an implementation later cannot change the hook count and break React.
 * Implementations are expected to be installed once at module load via
 * installAutoSaveImpl() — see ./autoSaveImpl.ts for the default wiring.
 */

import { useEffect, useState } from 'react';

export type AutoSaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface AutoSaveState {
  status: AutoSaveStatus;
  lastSavedAt: number | null;
  errorMessage: string | null;
}

/** Implementation contract: receive a setter, return an unsubscribe. */
export type AutoSaveImpl = (emit: (state: AutoSaveState) => void) => () => void;

const IDLE: AutoSaveState = { status: 'idle', lastSavedAt: null, errorMessage: null };

let installedImpl: AutoSaveImpl | null = null;

/** Hooks that mounted before an impl was installed, waiting to start it. */
const installWaiters = new Set<() => void>();

export function installAutoSaveImpl(impl: AutoSaveImpl | null): void {
  installedImpl = impl;
  // Overlays load through a dynamic import that races the first React
  // commit: a hook whose mount effect ran before the overlay chunk
  // evaluated used to see `installedImpl === null` and stay idle for the
  // whole life of the tab — no auto-save, no unload flush. Start those
  // already-mounted hooks now that the impl exists.
  if (impl) installWaiters.forEach((start) => start());
}

export function useAutoSaveProject(): AutoSaveState {
  const [state, setState] = useState<AutoSaveState>(IDLE);

  useEffect(() => {
    let cleanup: (() => void) | null = null;
    const start = () => {
      if (installedImpl && !cleanup) cleanup = installedImpl(setState);
    };
    start();
    // Late-install support only — swapping a live impl at runtime is still
    // unsupported (the first installed impl keeps running until unmount).
    installWaiters.add(start);
    return () => {
      installWaiters.delete(start);
      cleanup?.();
      cleanup = null;
    };
  }, []);

  return state;
}
