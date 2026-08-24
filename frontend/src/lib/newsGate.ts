/**
 * Startup-overlay gate between the news announcement and the starter
 * dialog ("Start a new project").
 *
 * Product rule: on editor entry the announcement modal shows FIRST, and
 * the pristine-visit starter dialog appears only after news is out of
 * the way. This tiny state machine is what enforces "only one startup
 * overlay on screen":
 *
 *   pending  — NewsAnnouncer hasn't decided yet (fetch in flight)
 *   showing  — an announcement modal is on screen
 *   clear    — nothing to show, or the modal was closed
 *
 * Consumers call whenNewsClear(maxPendingWaitMs): it resolves once the
 * state reaches 'clear'. The timeout applies ONLY while 'pending' — a
 * dead feed must not hold the starter dialog hostage, but a user
 * actually reading an announcement can take as long as they like.
 *
 * Module-level state, one announcement flow per page load — the same
 * lifetime as EditorPage's starterDialogShownThisLoad guard.
 */

type NewsGateState = 'pending' | 'showing' | 'clear';

let state: NewsGateState = 'pending';
const listeners = new Set<() => void>();

function setState(next: NewsGateState): void {
  if (state === next) return;
  state = next;
  for (const fn of [...listeners]) fn();
}

/** An announcement was delivered and its modal is now on screen. */
export function markNewsShowing(): void {
  if (state === 'pending') setState('showing');
}

/** Nothing to announce (empty queue, fetch failed, feature off). */
export function markNewsNone(): void {
  if (state === 'pending') setState('clear');
}

/** The announcement modal was closed. */
export function markNewsClosed(): void {
  setState('clear');
}

/**
 * Resolves when the announcement flow is out of the way. While still
 * 'pending', gives up after maxPendingWaitMs; once 'showing', waits
 * indefinitely for the close.
 */
export function whenNewsClear(maxPendingWaitMs: number): Promise<void> {
  if (state === 'clear') return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = () => {
      listeners.delete(onChange);
      if (timer != null) clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (state === 'clear') {
        done();
      } else if (state === 'showing' && timer != null) {
        // Decision arrived: a modal is up. Stop the pending timeout and
        // wait for the actual close.
        clearTimeout(timer);
        timer = null;
      }
    };
    listeners.add(onChange);
    if (state === 'pending') {
      timer = setTimeout(() => {
        if (state === 'pending') done();
      }, maxPendingWaitMs);
    }
  });
}
