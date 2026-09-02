/**
 * chipFiles — custom chip source as ordinary editor files.
 *
 * Every custom chip on the canvas owns an editor file group
 * (`group-chip-<id>`, the same group programmable chips already used for
 * their program file). This module seeds `chip.c` + `chip.json` into that
 * group and keeps them in two-way sync with the component's `properties`
 * (`sourceC` / `chipJson`), which remain the storage contract — projects,
 * `.vlx` files and the runtime keep reading properties and never change.
 *
 * Sync direction is decided per file against the last content both sides
 * agreed on (module-level, session-only):
 *   - file changed, properties didn't  -> user typed in Monaco -> properties
 *     follow (and a chip.c change invalidates the compiled wasm).
 *   - properties changed, file didn't  -> the AI agent / example gallery
 *     programmed the chip -> the file follows.
 *   - both changed -> properties win (the agent just compiled that source).
 */
import { useEditorStore, chipFileGroupId } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { compileChip } from './chipCompileService';
import {
  isProgrammableChip,
  targetForChip,
  DEFAULT_CHIP_PROGRAM_FILE,
  DEFAULT_CHIP_PROGRAM_C,
} from './romCompileService';
import { BLANK_CHIP } from '../components/customChips/chipExamples';

export const CHIP_SOURCE_FILE = 'chip.c';
export const CHIP_MANIFEST_FILE = 'chip.json';

export function isChipManifestFile(name: string): boolean {
  return name === CHIP_MANIFEST_FILE || name.endsWith('.chip.json');
}
export function isChipSourceFile(name: string): boolean {
  return name === CHIP_SOURCE_FILE || name.endsWith('.chip.c');
}

/** The optional face image: chip.png / chip.jpg / chip.jpeg / chip.svg. */
export function isChipImageFile(name: string): boolean {
  return /^chip\.(png|jpe?g|svg)$/i.test(name);
}

/** File name for a stored image data URL, by its mime. */
export function chipImageFileName(dataUrl: string): string {
  if (dataUrl.startsWith('data:image/svg')) return 'chip.svg';
  if (dataUrl.startsWith('data:image/jpeg') || dataUrl.startsWith('data:image/jpg')) return 'chip.jpg';
  return 'chip.png';
}

/** Normalise what a chip image FILE may hold into the properties contract
 *  (a data: URL). Raw SVG markup pasted into chip.svg is welcomed and
 *  wrapped; anything that is neither a data URL nor SVG text is refused so
 *  garbage never reaches the renderer. */
export function normalizeChipImage(content: string): string | null {
  const c = content.trim();
  if (!c) return '';
  if (/^data:image\/(png|jpe?g|svg\+xml)[;,]/i.test(c)) return c;
  if (c.startsWith('<svg') || c.startsWith('<?xml')) {
    try {
      const b64 = btoa(unescape(encodeURIComponent(c)));
      return `data:image/svg+xml;base64,${b64}`;
    } catch {
      return null;
    }
  }
  return null;
}

/** djb2 — cheap change detector for "did chip.c change since the last wasm". */
export function chipSourceHash(source: string): string {
  let h = 5381;
  for (let i = 0; i < source.length; i++) {
    h = ((h << 5) + h + source.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

interface ChipComponent {
  id: string;
  metadataId?: string;
  properties?: Record<string, unknown>;
}

function customChips(): ChipComponent[] {
  return useSimulatorStore
    .getState()
    .components.filter((c: ChipComponent) => c.metadataId === 'custom-chip');
}

/** Content both sides last agreed on, keyed by chip id. Session-only. */
const lastSynced = new Map<string, { source: string; manifest: string; image: string }>();

/** Forget sync state for chips that no longer exist (deleted / new project). */
function pruneSyncState(liveIds: Set<string>): void {
  for (const id of lastSynced.keys()) {
    if (!liveIds.has(id)) lastSynced.delete(id);
  }
}

/**
 * Ensure every custom chip's file group exists and contains chip.c and
 * chip.json (plus the program file for programmable chips — preserving the
 * behaviour the old FileExplorer effect implemented for those). Groups
 * seeded by loadExample (program file only) gain the two chip files here.
 */
export function seedChipFileGroups(): void {
  const ed = useEditorStore.getState();
  const sim = useSimulatorStore.getState();

  for (const chip of customChips()) {
    const gid = chipFileGroupId(chip.id);
    const props = (chip.properties ?? {}) as Record<string, unknown>;
    // The BLANK starter is only for a genuinely fresh chip. A chip that has
    // a compiled wasm but no stored source (edge case) must seed an EMPTY
    // chip.c — seeding the template there made the first sync pass treat it
    // as a user edit, push the template into properties and wipe the wasm.
    const hasWasm = String(props.wasmBase64 ?? '').length > 0;
    const sourceC = String(props.sourceC ?? '') || (hasWasm ? '' : BLANK_CHIP.sourceC);
    const chipJson = String(props.chipJson ?? '') || BLANK_CHIP.chipJson;

    const group = ed.fileGroups[gid];
    if (!group) {
      const files: { name: string; content: string }[] = [
        { name: CHIP_SOURCE_FILE, content: sourceC },
        { name: CHIP_MANIFEST_FILE, content: chipJson },
      ];
      if (String(props.image ?? '')) {
        files.push({ name: chipImageFileName(String(props.image)), content: String(props.image) });
      }
      if (isProgrammableChip(props)) {
        const existing = String(props.programFile ?? '').trim();
        if (existing) {
          files.push({ name: existing, content: String(props.programSource ?? '') });
        } else {
          const target = targetForChip(chipJson);
          sim.updateComponent(chip.id, {
            properties: { ...props, programFile: DEFAULT_CHIP_PROGRAM_FILE, programTarget: target },
          } as never);
          files.push({ name: DEFAULT_CHIP_PROGRAM_FILE, content: DEFAULT_CHIP_PROGRAM_C });
        }
      }
      ed.createFileGroup(gid, files);
    } else {
      // Existing group (older project / loadExample) — add what's missing.
      if (!group.some((f) => isChipSourceFile(f.name))) {
        ed.addFileToGroup(gid, { name: CHIP_SOURCE_FILE, content: sourceC });
      }
      if (!group.some((f) => isChipManifestFile(f.name))) {
        ed.addFileToGroup(gid, { name: CHIP_MANIFEST_FILE, content: chipJson });
      }
      const seedImage = String(props.image ?? '');
      if (seedImage && !group.some((f) => isChipImageFile(f.name))) {
        ed.addFileToGroup(gid, { name: chipImageFileName(seedImage), content: seedImage });
      }
      if (isProgrammableChip(props)) {
        const pf = String(props.programFile ?? '').trim();
        if (pf && !group.some((f) => f.name === pf)) {
          ed.addFileToGroup(gid, { name: pf, content: String(props.programSource ?? '') });
        } else if (!pf) {
          const target = targetForChip(chipJson);
          sim.updateComponent(chip.id, {
            properties: { ...props, programFile: DEFAULT_CHIP_PROGRAM_FILE, programTarget: target },
          } as never);
          if (!group.some((f) => f.name === DEFAULT_CHIP_PROGRAM_FILE)) {
            ed.addFileToGroup(gid, { name: DEFAULT_CHIP_PROGRAM_FILE, content: DEFAULT_CHIP_PROGRAM_C });
          }
        }
      }
    }

    if (!lastSynced.has(chip.id)) {
      // Baseline = the properties (files were just seeded from them, or the
      // group predates this session and the file may already differ — in that
      // case the first sync pass treats the file as the user's edit).
      lastSynced.set(chip.id, {
        source: String(props.sourceC ?? ''),
        manifest: String(props.chipJson ?? ''),
        image: String(props.image ?? ''),
      });
    }
  }

  pruneSyncState(new Set(customChips().map((c) => c.id)));
}

/** One reconciliation pass over every chip. Exposed for tests. */
export function syncChipFilesOnce(): void {
  const ed = useEditorStore.getState();
  const sim = useSimulatorStore.getState();

  for (const chip of customChips()) {
    const gid = chipFileGroupId(chip.id);
    const group = ed.fileGroups[gid];
    if (!group) continue;
    const props = (chip.properties ?? {}) as Record<string, unknown>;
    const last = lastSynced.get(chip.id) ?? {
      source: String(props.sourceC ?? ''),
      manifest: String(props.chipJson ?? ''),
      image: String(props.image ?? ''),
    };
    if (last.image === undefined) last.image = String(props.image ?? '');

    const srcFile = group.find((f) => isChipSourceFile(f.name));
    const jsonFile = group.find((f) => isChipManifestFile(f.name));
    const propsSource = String(props.sourceC ?? '');
    const propsManifest = String(props.chipJson ?? '');
    let nextProps: Record<string, unknown> | null = null;

    if (srcFile) {
      if (propsSource !== last.source) {
        // Properties changed externally (agent / gallery) — file follows.
        if (srcFile.content !== propsSource) {
          ed.setGroupFileContent(gid, srcFile.id, propsSource);
        }
        last.source = propsSource;
      } else if (srcFile.content !== last.source) {
        // User edited chip.c — properties follow, compiled wasm is stale.
        nextProps = { ...(nextProps ?? props), sourceC: srcFile.content, wasmBase64: '', sourceHash: '' };
        last.source = srcFile.content;
      }
    }

    if (jsonFile) {
      if (propsManifest !== last.manifest) {
        if (jsonFile.content !== propsManifest) {
          ed.setGroupFileContent(gid, jsonFile.id, propsManifest);
        }
        last.manifest = propsManifest;
        try { sim.recalculateAllWirePositions(); } catch { /* headless */ }
      } else if (jsonFile.content !== last.manifest) {
        // Only propagate a manifest the user finished typing — mid-edit
        // invalid JSON stays file-only until it parses.
        try {
          JSON.parse(jsonFile.content);
          nextProps = { ...(nextProps ?? props), chipJson: jsonFile.content };
          last.manifest = jsonFile.content;
        } catch { /* mid-edit */ }
      }
    }

    const imgFile = group.find((f) => isChipImageFile(f.name));
    const propsImage = String(props.image ?? '');
    if (propsImage !== last.image) {
      // Properties changed (upload button, agent, gallery) — file follows.
      if (propsImage) {
        if (imgFile) {
          if (imgFile.content !== propsImage) ed.setGroupFileContent(gid, imgFile.id, propsImage);
        } else {
          ed.addFileToGroup(gid, { name: chipImageFileName(propsImage), content: propsImage });
        }
      } else if (imgFile) {
        ed.removeFileFromGroup(gid, imgFile.id);
      }
      last.image = propsImage;
    } else if (imgFile && imgFile.content !== last.image) {
      // User edited/pasted into the image file — properties follow, but only
      // content the renderer can actually draw (data URL or raw SVG text).
      const normalized = normalizeChipImage(imgFile.content);
      if (normalized !== null) {
        nextProps = { ...(nextProps ?? props), image: normalized };
        last.image = imgFile.content;
      }
    } else if (!imgFile && last.image) {
      // The file was removed — the property goes with it.
      nextProps = { ...(nextProps ?? props), image: '' };
      last.image = '';
    }

    if (nextProps) {
      sim.updateComponent(chip.id, { properties: nextProps } as never);
      if ('chipJson' in nextProps) {
        try { sim.recalculateAllWirePositions(); } catch { /* headless */ }
      }
    }
    lastSynced.set(chip.id, last);
  }
}

let installed = 0;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSince = 0;

/**
 * Run the seed + sync pass NOW, cancelling any pending debounce. Call before
 * reading `properties.sourceC/chipJson` for a compile/export so an edit made
 * moments ago (or held back by the debounce) is never missed.
 */
export function flushChipFileSync(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  pendingSince = 0;
  seedChipFileGroups();
  syncChipFilesOnce();
}

/**
 * Install the seed + sync watchers. Returns an uninstall function. Reference
 * counted so a second mount (StrictMode double-effect) is harmless.
 *
 * The debounce is trailing-edge WITH a max-wait: both stores notify on every
 * setState, and a running sketch that prints flushes the simulator store
 * every animation frame — a pure trailing debounce would never fire for the
 * whole run (review finding: chips dropped mid-run got no file group, edits
 * never reached properties). The max-wait guarantees a pass at least every
 * MAX_WAIT_MS while notifications keep streaming.
 */
export function installChipFileSync(): () => void {
  installed++;
  if (installed > 1) return () => { installed--; };

  const DEBOUNCE_MS = 300;
  const MAX_WAIT_MS = 1000;
  const run = () => {
    pendingTimer = null;
    pendingSince = 0;
    seedChipFileGroups();
    syncChipFilesOnce();
  };
  const schedule = () => {
    const now = Date.now();
    if (!pendingSince) pendingSince = now;
    if (pendingTimer) {
      if (now - pendingSince >= MAX_WAIT_MS) return; // let the armed timer fire
      clearTimeout(pendingTimer);
    }
    const delay = Math.min(DEBOUNCE_MS, Math.max(0, pendingSince + MAX_WAIT_MS - now));
    pendingTimer = setTimeout(run, delay);
  };

  seedChipFileGroups();
  syncChipFilesOnce();
  const unsubEditor = useEditorStore.subscribe(schedule);
  const unsubSim = useSimulatorStore.subscribe(schedule);

  return () => {
    installed--;
    if (installed > 0) return;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
    pendingSince = 0;
    unsubEditor();
    unsubSim();
  };
}

/** Reset module sync state (tests). */
export function __resetChipFileSyncForTests(): void {
  lastSynced.clear();
}

/**
 * Compile a chip's current C source to WASM and store it (with the source
 * hash) on the component. Shared by the toolbar's prepare step and the file
 * explorer's per-chip Compile button.
 */
export async function ensureChipWasm(
  chipId: string,
  log?: (type: 'info' | 'success' | 'error', message: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  // Commit any edit still sitting in the debounce — otherwise a chip.c change
  // typed moments ago compiles the previous source and reports success.
  flushChipFileSync();

  // The compile is a seconds-long await; re-read and retry when the source
  // moved underneath it. The write-back merges onto the LIVE properties and
  // only lands when the compiled source is still current — a stale spread
  // here reverted concurrent edits and re-stamped the old wasm as fresh
  // (review finding, data loss).
  for (let attempt = 0; attempt < 2; attempt++) {
    const sim = useSimulatorStore.getState();
    const chip = sim.components.find((c: ChipComponent) => c.id === chipId);
    if (!chip) return { ok: false, error: 'chip not found' };
    const props = (chip.properties ?? {}) as Record<string, unknown>;
    const label = String(props.chipName ?? 'custom chip');
    const sourceC = String(props.sourceC ?? '');
    if (!sourceC.trim()) return { ok: false, error: 'chip has no C source' };

    const hash = chipSourceHash(sourceC);
    if (String(props.wasmBase64 ?? '') && String(props.sourceHash ?? '') === hash) {
      return { ok: true };
    }

    log?.('info', `Compiling chip "${label}" to WASM...`);
    try {
      const r = await compileChip(sourceC, String(props.chipJson ?? '') || undefined);
      if (!r.success || !r.wasm_base64) {
        const err = r.error || r.stderr || 'unknown error';
        log?.('error', `Chip "${label}" WASM compile failed: ${err}`);
        return { ok: false, error: err };
      }
      flushChipFileSync();
      const fresh = useSimulatorStore.getState().components.find((c: ChipComponent) => c.id === chipId);
      if (!fresh) return { ok: false, error: 'chip removed during compile' };
      const freshProps = (fresh.properties ?? {}) as Record<string, unknown>;
      if (String(freshProps.sourceC ?? '') !== sourceC) {
        log?.('info', `Chip "${label}" source changed during compile — recompiling.`);
        continue;
      }
      useSimulatorStore.getState().updateComponent(chipId, {
        properties: { ...freshProps, wasmBase64: r.wasm_base64, sourceHash: hash },
      } as never);
      log?.('success', `Chip "${label}" compiled (${r.byte_size} B WASM).`);
      return { ok: true };
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      log?.('error', `Chip "${label}" WASM compile error: ${err}`);
      return { ok: false, error: err };
    }
  }
  return { ok: false, error: 'source kept changing during compile — try again' };
}
