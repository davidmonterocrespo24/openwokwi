/**
 * Turning on Linux mode must actually boot the guest.
 *
 * The button pins the mode and restarts the board: stopBoard, then
 * startBoard a moment later. That second call has to reach the board's
 * bridge and open its WebSocket — when it silently did not, the user got
 * no guest, no error, and a toolbar still showing Stop.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The bridge opens a real WebSocket; capture the instances instead.
const opened: string[] = [];
class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    opened.push(url);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = FakeSocket.CLOSING;
  }
}

beforeEach(() => {
  opened.length = 0;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
});

describe('Linux mode restart', () => {
  it('opens the guest WebSocket when the board is pinned to linux', async () => {
    const { useSimulatorStore, getBoardBridge } = await import(
      '../store/useSimulatorStore'
    );

    const id = useSimulatorStore.getState().addBoard('raspberry-pi-3', 10, 10);
    expect(getBoardBridge(id), 'the board must get a bridge on add').toBeTruthy();

    // What the Linux-mode button does: pin, stop, start.
    useSimulatorStore.getState().updateBoard(id, { enginePinned: 'linux' });
    useSimulatorStore.getState().stopBoard(id);
    useSimulatorStore.getState().startBoard(id);

    expect(opened.filter((u) => u.includes('/simulation/ws/')).length).toBe(1);
    const board = useSimulatorStore.getState().boards.find((b) => b.id === id);
    expect(board?.engineMode).toBe('linux');
    expect(board?.running, 'the toolbar must show a running board').toBe(true);
  });

  it('reconnects even when the previous socket is still closing', async () => {
    const { useSimulatorStore, getBoardBridge } = await import(
      '../store/useSimulatorStore'
    );
    const id = useSimulatorStore.getState().addBoard('raspberry-pi-4', 10, 10);
    const bridge = getBoardBridge(id)!;

    useSimulatorStore.getState().updateBoard(id, { enginePinned: 'linux' });
    useSimulatorStore.getState().startBoard(id);
    expect(opened.length).toBe(1);

    // Stop closes the socket; a CLOSING socket used to look "alive" and
    // the next start became a no-op.
    useSimulatorStore.getState().stopBoard(id);
    bridge.connect();
    expect(opened.length).toBe(2);
  });
});
