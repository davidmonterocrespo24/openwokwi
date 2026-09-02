/**
 * chipAttachExtensions — overlay seam on the custom-chip part lifecycle.
 *
 * CustomChipPart invokes every registered extension when a chip attaches
 * (once per instantiation, both the browser-runtime and the ESP32-worker
 * paths) and runs the returned cleanups on detach. Pure OSS registers
 * nothing; the velxio-prod overlay uses this to wire pro-only behaviour
 * (e.g. live sensor controls) without forking the part.
 */
import type { ChipInstance } from './ChipRuntime';

export interface ChipAttachContext {
  kind: 'browser' | 'esp32';
  componentId: string;
  /** The simulator handle the part attached with (bridge object on ESP32). */
  simulator: unknown;
  /** Browser path only: the live chip instance. */
  instance?: ChipInstance;
  /** Browser path only: chip pin name -> resolved pin number. */
  wires?: Map<string, number>;
  /** ESP32 path only: the worker's virtual sensor slot for this chip. */
  virtualPin?: number;
}

export type ChipAttachExtension = (ctx: ChipAttachContext) => (() => void) | void;

const extensions: ChipAttachExtension[] = [];

export function registerChipAttachExtension(ext: ChipAttachExtension): void {
  extensions.push(ext);
}

/** Run every extension; returns a combined cleanup. Extension errors are
 *  contained — a broken overlay extension must not kill the chip. */
export function runChipAttachExtensions(ctx: ChipAttachContext): () => void {
  const cleanups: Array<() => void> = [];
  for (const ext of extensions) {
    try {
      const c = ext(ctx);
      if (typeof c === 'function') cleanups.push(c);
    } catch (e) {
      console.warn('[custom-chip] attach extension failed:', e);
    }
  }
  return () => {
    for (const c of cleanups) {
      try { c(); } catch { /* ignore */ }
    }
  };
}
