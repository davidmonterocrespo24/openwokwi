/**
 * The command registry behind the File/Edit menu bar.
 *
 * The registry is the contract between the menus (in the header) and the
 * four components that own the actual handlers. The subtle case it must
 * get right is React StrictMode-style remounting: the NEW closure
 * registers before the OLD effect's cleanup runs, and a naive cleanup
 * would then delete the fresh handler — a menu full of dead items.
 */
import { describe, it, expect } from 'vitest';
import {
  registerEditorCommand,
  hasEditorCommand,
  runEditorCommand,
  subscribeEditorCommands,
} from '../lib/editorCommands';

describe('editorCommands registry', () => {
  it('registers, runs and unregisters', () => {
    let ran = 0;
    const off = registerEditorCommand('project.save', () => ran++);
    expect(hasEditorCommand('project.save')).toBe(true);
    runEditorCommand('project.save');
    expect(ran).toBe(1);
    off();
    expect(hasEditorCommand('project.save')).toBe(false);
  });

  it('running an unregistered command is a no-op, not a crash', () => {
    expect(() => runEditorCommand('view.reset')).not.toThrow();
  });

  it('a stale cleanup does not delete the successor handler', () => {
    // Remount order: new register happens BEFORE old cleanup runs.
    let who = '';
    const offOld = registerEditorCommand('project.open', () => {
      who = 'old';
    });
    const offNew = registerEditorCommand('project.open', () => {
      who = 'new';
    });
    offOld(); // stale cleanup — must NOT remove the new handler
    expect(hasEditorCommand('project.open')).toBe(true);
    runEditorCommand('project.open');
    expect(who).toBe('new');
    offNew();
    expect(hasEditorCommand('project.open')).toBe(false);
  });

  it('notifies subscribers on register and unregister', () => {
    let ticks = 0;
    const unsub = subscribeEditorCommands(() => ticks++);
    const off = registerEditorCommand('view.zoomIn', () => {});
    off();
    unsub();
    expect(ticks).toBe(2);
    // After unsubscribe, silence.
    const off2 = registerEditorCommand('view.zoomOut', () => {});
    off2();
    expect(ticks).toBe(2);
  });
});
