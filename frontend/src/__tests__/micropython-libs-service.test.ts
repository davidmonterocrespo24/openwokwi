/**
 * micropythonLibs service (issue #214) — the workspace-write half.
 *
 * The backend resolves a micropython-lib package into .py files; this side
 * upserts them into the board's file group. Pinned here: upsert semantics
 * (re-adding = upgrade, not duplicate), package-dir paths, and the
 * in-project detection the modal's pills rely on.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '../store/useEditorStore';
import {
  packageFilesInGroup,
  writeFilesIntoGroup,
  BUILTIN_MPY_MODULES,
  FEATURED_MPY_PACKAGES,
} from '../services/micropythonLibs';

const GROUP = 'group-mpy-test';

describe('writeFilesIntoGroup', () => {
  beforeEach(() => {
    const ed = useEditorStore.getState();
    ed.deleteFileGroup(GROUP);
    ed.createFileGroup(GROUP, [{ name: 'main.py', content: 'print(1)\n' }]);
    ed.setActiveGroup(GROUP);
  });

  it('adds the package files next to main.py', () => {
    const written = writeFilesIntoGroup(GROUP, [
      { path: 'ssd1306.py', content: '# driver\n' },
    ]);
    expect(written).toEqual(['ssd1306.py']);
    const names = useEditorStore.getState().getGroupFiles(GROUP).map((f) => f.name);
    expect(names).toContain('main.py');
    expect(names).toContain('ssd1306.py');
  });

  it('re-adding overwrites instead of duplicating (that is the upgrade path)', () => {
    writeFilesIntoGroup(GROUP, [{ path: 'ssd1306.py', content: 'v1\n' }]);
    writeFilesIntoGroup(GROUP, [{ path: 'ssd1306.py', content: 'v2\n' }]);
    const files = useEditorStore.getState().getGroupFiles(GROUP);
    const matches = files.filter((f) => f.name === 'ssd1306.py');
    expect(matches).toHaveLength(1);
    expect(matches[0].content).toBe('v2\n');
  });

  it('handles package-dir paths the way micropython-lib ships them', () => {
    writeFilesIntoGroup(GROUP, [{ path: 'umqtt/simple.py', content: '# mqtt\n' }]);
    const names = useEditorStore.getState().getGroupFiles(GROUP).map((f) => f.name);
    expect(names).toContain('umqtt/simple.py');
  });
});

describe('packageFilesInGroup', () => {
  beforeEach(() => {
    const ed = useEditorStore.getState();
    ed.deleteFileGroup(GROUP);
    ed.createFileGroup(GROUP, [{ name: 'main.py', content: '' }]);
    ed.setActiveGroup(GROUP);
  });

  it('detects a plain module and a dotted package', () => {
    expect(packageFilesInGroup(GROUP, 'ssd1306')).toBe(false);
    writeFilesIntoGroup(GROUP, [{ path: 'ssd1306.py', content: 'x' }]);
    expect(packageFilesInGroup(GROUP, 'ssd1306')).toBe(true);

    expect(packageFilesInGroup(GROUP, 'umqtt.simple')).toBe(false);
    writeFilesIntoGroup(GROUP, [{ path: 'umqtt/simple.py', content: 'x' }]);
    expect(packageFilesInGroup(GROUP, 'umqtt.simple')).toBe(true);
  });
});

describe('curated lists', () => {
  it('featured picks never claim firmware builtins (one truth per module)', () => {
    const builtins = new Set(BUILTIN_MPY_MODULES.map((b) => b.name));
    for (const f of FEATURED_MPY_PACKAGES) {
      expect(builtins.has(f.name)).toBe(false);
    }
  });
});
