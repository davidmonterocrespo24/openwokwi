/**
 * The "settled" signal for late-registered pro examples.
 *
 * A direct link to a pro example races the overlay's dynamic import; the
 * page must be able to tell "not in the gallery" from "not YET" or it
 * flashes a 404 before the editor loads (as reported on
 * /example/pi5-opencv-vision). main.tsx flips the flag once the overlay
 * import settles — or immediately when no overlay is configured.
 */
import { describe, it, expect } from 'vitest';
import {
  areProExamplesSettled,
  markProExamplesSettled,
  subscribeProExamples,
} from '../data/examples';

describe('pro examples settled flag', () => {
  it('starts unsettled, settles once, notifies subscribers exactly once', () => {
    expect(areProExamplesSettled()).toBe(false);
    let ticks = 0;
    const unsub = subscribeProExamples(() => ticks++);
    markProExamplesSettled();
    expect(areProExamplesSettled()).toBe(true);
    expect(ticks).toBe(1);
    // Idempotent: settling again must not re-notify (a re-render storm
    // on every overlay hot-reload would be the symptom).
    markProExamplesSettled();
    expect(ticks).toBe(1);
    unsub();
  });
});
