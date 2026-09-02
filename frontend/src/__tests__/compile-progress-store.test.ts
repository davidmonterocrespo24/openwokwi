/**
 * The live state behind the compile progress card.
 *
 * Two rules the card depends on and that are easy to break by "simplifying"
 * the store:
 *
 *   1. A queued build has NO progress fraction. The card draws a travelling
 *      sliver for null and a filling bar for a number, so leaking a 0 here
 *      turns "waiting for a slot" into "0% compiled" — a bar that says the
 *      build started when it has not.
 *   2. Compile-All relabels ONE entry as it walks the boards. The elapsed
 *      timer is the run's, so relabel must not reset startedAt; the fraction
 *      is the current board's, so relabel MUST reset progress or the bar
 *      jumps backwards on the next poll.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import {
  useCompileProgressStore,
  compileProgress,
} from '../store/useCompileProgressStore';
import type { CompileProgressInfo } from '../services/compilation';

const info = (over: Partial<CompileProgressInfo> = {}): CompileProgressInfo => ({
  state: 'running',
  stdout: '',
  elapsedSeconds: 1,
  stage: 'compiling',
  progress: 0.5,
  estimatedSeconds: 120,
  buildSeconds: 4,
  serverLoad: 'moderate',
  tier: 'free',
  priority: false,
  ...over,
});

const entry = (id: string) => useCompileProgressStore.getState().entries[id];

describe('useCompileProgressStore', () => {
  beforeEach(() => {
    useCompileProgressStore.getState().reset();
  });

  it('starts a build queued, with no fraction to draw', () => {
    compileProgress.begin('b1', 'ESP32 DevKit');
    expect(entry('b1').stage).toBe('queued');
    expect(entry('b1').progress).toBeNull();
  });

  it('carries the queue fields through from a poll', () => {
    compileProgress.begin('b1', 'ESP32 DevKit');
    compileProgress.update('b1', info({ serverLoad: 'peak', tier: 'pro', priority: true }), '[3/9] cc');
    expect(entry('b1').progress).toBe(0.5);
    expect(entry('b1').serverLoad).toBe('peak');
    expect(entry('b1').tier).toBe('pro');
    expect(entry('b1').priority).toBe(true);
    expect(entry('b1').lastLine).toBe('[3/9] cc');
  });

  it('a queued poll keeps the fraction null', () => {
    compileProgress.begin('b1', 'ESP32 DevKit');
    compileProgress.update('b1', info({ stage: 'queued', progress: null }));
    expect(entry('b1').progress).toBeNull();
  });

  it('relabel keeps the timer but drops the previous board progress', () => {
    compileProgress.begin('all', 'Uno (1/2)');
    compileProgress.update('all', info({ progress: 0.9 }), 'linking');
    const startedAt = entry('all').startedAt;

    compileProgress.relabel('all', 'ESP32 (2/2)');
    expect(entry('all').startedAt).toBe(startedAt);
    expect(entry('all').label).toBe('ESP32 (2/2)');
    expect(entry('all').progress).toBeNull();
    expect(entry('all').lastLine).toBe('');
  });

  it('ignores updates for an unknown or already-finished build', () => {
    compileProgress.update('ghost', info());
    expect(entry('ghost')).toBeUndefined();

    compileProgress.begin('b1', 'Uno');
    compileProgress.finish('b1', 'success');
    compileProgress.update('b1', info({ progress: 0.2 }));
    // The settled entry keeps its finished state until it is dropped.
    expect(entry('b1').progress).toBe(1);
    expect(entry('b1').outcome).toBe('success');
  });
});

describe('useCompileProgressStore lingering', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useCompileProgressStore.getState().reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a finished build on screen for a beat, then drops it', () => {
    compileProgress.begin('b1', 'Uno');
    compileProgress.finish('b1', 'success');
    // Still there right after finishing — the card shows "Compiled in 8.1s"
    // rather than vanishing mid-sentence.
    expect(entry('b1')).toBeDefined();
    vi.advanceTimersByTime(2000);
    expect(entry('b1')).toBeUndefined();
  });

  it('a new build on the same board cancels the pending removal', () => {
    compileProgress.begin('b1', 'Uno');
    compileProgress.finish('b1', 'success');
    vi.advanceTimersByTime(1000);
    compileProgress.begin('b1', 'Uno');
    // The first build's linger timer must not delete the second build.
    vi.advanceTimersByTime(2000);
    expect(entry('b1')).toBeDefined();
    expect(entry('b1').outcome).toBeNull();
  });
});
