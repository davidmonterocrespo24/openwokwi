// @vitest-environment jsdom
/**
 * Regression tests for the two data-loss races the phase-2 adversarial
 * review confirmed in the chip file sync:
 *
 * 1. ensureChipWasm awaited a seconds-long compile and then wrote back a
 *    PRE-await properties snapshot — a chip.c edit synced during the await
 *    was reverted (and the old wasm stamped fresh), after which the sync
 *    pass overwrote the user's Monaco buffer with the old text.
 * 2. installChipFileSync's trailing-edge debounce was re-armed by EVERY
 *    store notification; a running sketch printing to serial flushes the
 *    simulator store every animation frame, so the sync never ran for the
 *    whole simulation (chips dropped mid-run never got their file group).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const compileChip = vi.fn();
vi.mock('../services/chipCompileService', () => ({
  compileChip: (...a: unknown[]) => compileChip(...a),
}));

import { useEditorStore, chipFileGroupId } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import {
  seedChipFileGroups,
  syncChipFilesOnce,
  ensureChipWasm,
  installChipFileSync,
  chipSourceHash,
  CHIP_SOURCE_FILE,
  __resetChipFileSyncForTests,
} from '../services/chipFiles';

const CHIP_ID = 'chip-race-1';
const S1 = '#include "velxio-chip.h"\nvoid chip_setup(void) {} /* v1 */\n';
const S2 = '#include "velxio-chip.h"\nvoid chip_setup(void) {} /* v2 */\n';

function seedStores() {
  useSimulatorStore.setState({
    components: [
      {
        id: CHIP_ID,
        metadataId: 'custom-chip',
        x: 0,
        y: 0,
        properties: {
          chipName: 'Race Chip',
          sourceC: S1,
          chipJson: '{"name":"Race Chip","pins":["IN","OUT"]}',
          wasmBase64: '',
        },
      } as never,
    ],
  } as never);
}

function chipProps() {
  return useSimulatorStore.getState().components[0].properties as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetChipFileSyncForTests();
  useEditorStore.getState().deleteFileGroup(chipFileGroupId(CHIP_ID));
  seedStores();
});

describe('ensureChipWasm vs concurrent edits', () => {
  it('an edit landing mid-compile survives and gets its own compile', async () => {
    seedChipFileGroups();

    // First compile call hangs until we let it finish; during that window
    // the user edit lands. Second call (the retry) resolves immediately.
    let releaseFirst!: (v: unknown) => void;
    compileChip
      .mockImplementationOnce(() => new Promise((res) => { releaseFirst = res; }))
      .mockResolvedValueOnce({ success: true, wasm_base64: 'V2WASM', byte_size: 2 });

    const done = ensureChipWasm(CHIP_ID);
    await Promise.resolve(); // let the first compile start

    // User types in chip.c; the (flushed) sync commits it to properties.
    const gid = chipFileGroupId(CHIP_ID);
    const src = useEditorStore.getState().fileGroups[gid].find((f) => f.name === CHIP_SOURCE_FILE)!;
    useEditorStore.getState().updateGroupFile(gid, src.id, S2);
    syncChipFilesOnce();
    expect(chipProps().sourceC).toBe(S2);

    releaseFirst({ success: true, wasm_base64: 'V1WASM', byte_size: 1 });
    const r = await done;

    expect(r.ok).toBe(true);
    // The edit was NOT reverted, the stale V1 wasm was NOT stamped, and the
    // retry compiled the new source.
    expect(chipProps().sourceC).toBe(S2);
    expect(chipProps().wasmBase64).toBe('V2WASM');
    expect(chipProps().sourceHash).toBe(chipSourceHash(S2));
    expect(compileChip).toHaveBeenCalledTimes(2);
    expect((compileChip.mock.calls[1] as unknown[])[0]).toBe(S2);
    // And the editor buffer still shows the user's text.
    const after = useEditorStore.getState().fileGroups[gid].find((f) => f.name === CHIP_SOURCE_FILE)!;
    expect(after.content).toBe(S2);
  });

  it('flushes a pending edit before compiling (no stale-source success)', async () => {
    seedChipFileGroups();
    syncChipFilesOnce();
    const gid = chipFileGroupId(CHIP_ID);
    const src = useEditorStore.getState().fileGroups[gid].find((f) => f.name === CHIP_SOURCE_FILE)!;
    useEditorStore.getState().updateGroupFile(gid, src.id, S2);
    // No manual sync — ensureChipWasm must flush the debounce itself.
    compileChip.mockResolvedValue({ success: true, wasm_base64: 'W', byte_size: 1 });
    const r = await ensureChipWasm(CHIP_ID);
    expect(r.ok).toBe(true);
    expect((compileChip.mock.calls[0] as unknown[])[0]).toBe(S2);
  });
});

describe('installChipFileSync under store-notification storms', () => {
  afterEach(() => vi.useRealTimers());

  it('the max-wait fires the sync even while notifications stream every frame', () => {
    vi.useFakeTimers();
    const uninstall = installChipFileSync();
    // The install pass seeded the existing chip; now a NEW chip lands while
    // a "running sketch" hammers the store every 16 ms.
    useSimulatorStore.setState({
      components: [
        ...useSimulatorStore.getState().components,
        {
          id: 'chip-race-2',
          metadataId: 'custom-chip',
          x: 0,
          y: 0,
          properties: { chipName: 'Mid-run', sourceC: S1, chipJson: '{"name":"M","pins":["A"]}', wasmBase64: '' },
        } as never,
      ],
    } as never);

    for (let t = 0; t < 3000; t += 16) {
      useSimulatorStore.setState({ serialNonce: t } as never); // any notification
      vi.advanceTimersByTime(16);
    }
    // A pure trailing debounce would never have fired; the max-wait must
    // have seeded the new chip's group within ~1s.
    const group = useEditorStore.getState().fileGroups[chipFileGroupId('chip-race-2')];
    expect(group?.some((f) => f.name === CHIP_SOURCE_FILE)).toBe(true);
    uninstall();
  });
});
