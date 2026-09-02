// @vitest-environment jsdom
/**
 * .vlx round-trip for the editor-files chip model (phase 2 gate): a chip's
 * group now holds chip.c + chip.json + (for CPU chips) the program file —
 * export must carry all of them and import must restore them, with the
 * properties/file sync settling without clobbering either side.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore, chipFileGroupId } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { buildVlxPayload } from '../utils/vlxFile';
import {
  seedChipFileGroups,
  syncChipFilesOnce,
  __resetChipFileSyncForTests,
} from '../services/chipFiles';

const CHIP_ID = 'chip-vlx-1';
const SRC = '#include "velxio-chip.h"\nvoid chip_setup(void) {} /* vlx */\n';
const MANIFEST = '{"name":"Z80 CPU","pins":["CLK","D0"],"programTargets":["z80"]}';

beforeEach(() => {
  __resetChipFileSyncForTests();
  useEditorStore.getState().deleteFileGroup(chipFileGroupId(CHIP_ID));
  useSimulatorStore.setState({
    components: [
      {
        id: CHIP_ID,
        metadataId: 'custom-chip',
        x: 10,
        y: 10,
        properties: {
          chipName: 'Z80 CPU',
          sourceC: SRC,
          chipJson: MANIFEST,
          wasmBase64: 'QQ==',
          programFile: 'scanner.s',
        },
      } as never,
    ],
    wires: [],
    boards: [],
  } as never);
  const gid = chipFileGroupId(CHIP_ID);
  useEditorStore.getState().createFileGroup(gid, [{ name: 'scanner.s', content: 'org 0\n' }]);
  seedChipFileGroups();
  syncChipFilesOnce();
});

describe('vlx round-trip with chip files', () => {
  it('exports chip.c + chip.json + program file and restores them on import', () => {
    const gid = chipFileGroupId(CHIP_ID);
    const payload = buildVlxPayload({ name: 'test' });
    expect(Object.keys(payload.fileGroups)).toContain(gid);
    const names = payload.fileGroups[gid].map((f: { name: string }) => f.name).sort();
    expect(names).toEqual(['chip.c', 'chip.json', 'scanner.s']);

    // Wipe and re-import (the loadProjectState path importVlxFile uses).
    useEditorStore.getState().deleteFileGroup(gid);
    useSimulatorStore.setState({ components: [], wires: [], boards: [] } as never);
    __resetChipFileSyncForTests();
    useSimulatorStore.getState().loadProjectState({
      boards: payload.boards as never,
      fileGroups: payload.fileGroups,
      folderGroups: payload.folderGroups,
      components: payload.components as never,
      wires: payload.wires as never,
      activeBoardId: payload.activeBoardId,
    } as never);
    seedChipFileGroups();
    syncChipFilesOnce();

    const comp = useSimulatorStore.getState().components.find((c) => c.id === CHIP_ID)!;
    expect(comp).toBeDefined();
    expect(comp.properties.sourceC).toBe(SRC);
    expect(comp.properties.chipJson).toBe(MANIFEST);
    expect(comp.properties.wasmBase64).toBe('QQ==');
    const files = useEditorStore.getState().fileGroups[gid].map((f) => f.name).sort();
    expect(files).toEqual(['chip.c', 'chip.json', 'scanner.s']);
    // The sync settled without clobbering: the file mirrors properties.
    const src = useEditorStore.getState().fileGroups[gid].find((f) => f.name === 'chip.c')!;
    expect(src.content).toBe(SRC);
  });
});
