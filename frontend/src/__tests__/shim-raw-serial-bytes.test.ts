/**
 * The raw-byte UART seam on the board shims.
 *
 * `feedUart` and `serialWrite` take a string and encode it as UTF-8. That is
 * correct for the text protocols they were written for (NMEA, AT commands),
 * and silently destroys anything binary: every byte >= 0x80 becomes two.
 *
 * A part answering a framed protocol — sync words like 0xAA/0x55, a checksum,
 * a length field — has to reach the guest byte for byte, so the shims expose
 * `sendSerialBytes(bytes, uart)` alongside. This test pins that difference so
 * the two paths do not quietly converge again.
 */

import { describe, expect, it, vi } from 'vitest';

/** Minimal stand-in for the bridge: records what actually reaches the guest. */
class FakeBridge {
  sent: Array<{ bytes: number[]; uart: number | undefined }> = [];
  connected = true;
  sendSerialBytes(bytes: number[], uart?: number) {
    this.sent.push({ bytes, uart });
  }
  sendPinEvent() {}
}

/**
 * The shims are module-private, so exercise the two code paths directly
 * against the same fake bridge. This mirrors `Esp32BridgeShim.serialWrite` /
 * `.feedUart` (UTF-8) versus `.sendSerialBytes` (raw) exactly.
 */
const textPath = (bridge: FakeBridge, data: string, uart = 0) =>
  bridge.sendSerialBytes(Array.from(new TextEncoder().encode(data)), uart);
const rawPath = (bridge: FakeBridge, bytes: number[], uart = 0) => bridge.sendSerialBytes(bytes, uart);

/** A Chain-protocol heartbeat reply: two sync words and a checksum. */
const BINARY_FRAME = [0xaa, 0x55, 0x04, 0x00, 0xff, 0xfd, 0x01, 0xfd, 0x55, 0xaa];

describe('raw-byte UART seam', () => {
  it('the text path mangles every byte >= 0x80', () => {
    const b = new FakeBridge();
    textPath(b, String.fromCharCode(...BINARY_FRAME));
    const got = b.sent[0].bytes;
    expect(got).not.toEqual(BINARY_FRAME);
    expect(got.length).toBeGreaterThan(BINARY_FRAME.length);
    // 0xAA arrives as the two-byte UTF-8 sequence C2 AA.
    expect(got.slice(0, 2)).toEqual([0xc2, 0xaa]);
  });

  it('the raw path delivers the frame byte for byte', () => {
    const b = new FakeBridge();
    rawPath(b, BINARY_FRAME);
    expect(b.sent[0].bytes).toEqual(BINARY_FRAME);
    expect(b.sent[0].uart).toBe(0);
  });

  it('the two paths agree on pure ASCII, which is why this went unnoticed', () => {
    const ascii = 'HELLO';
    const a = new FakeBridge();
    const c = new FakeBridge();
    textPath(a, ascii);
    rawPath(c, Array.from(ascii, (ch) => ch.charCodeAt(0)));
    expect(a.sent[0].bytes).toEqual(c.sent[0].bytes);
  });

  it('routes to the requested UART', () => {
    const b = new FakeBridge();
    rawPath(b, [0x01], 2);
    expect(b.sent[0].uart).toBe(2);
  });

  it('every byte value survives a round trip through the raw path', () => {
    const b = new FakeBridge();
    const all = Array.from({ length: 256 }, (_, i) => i);
    rawPath(b, all);
    expect(b.sent[0].bytes).toEqual(all);
    // The text path would balloon past 256 for the same input.
    const t = new FakeBridge();
    textPath(t, String.fromCharCode(...all));
    expect(t.sent[0].bytes.length).toBeGreaterThan(256);
  });
});

describe('the shims expose the raw seam', () => {
  it('Esp32BridgeShim and the STM32 shim both declare sendSerialBytes', async () => {
    // Source-level assertion: the shims are not exported, and importing the
    // store pulls in the whole simulation tree. Reading the file keeps this
    // test honest about WHAT it checks — that both seams exist and forward
    // without encoding.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, '../store/useSimulatorStore.ts'), 'utf8');
    const raw = src.match(/sendSerialBytes\(bytes: number\[\], uart = 0\): void \{\s*this\.bridge\.sendSerialBytes\(bytes, uart\);/g);
    expect(raw, 'both shims must forward raw bytes unencoded').toHaveLength(2);
  });
});

// Guard against a stray global TextEncoder stub in the suite masking the above.
it('TextEncoder really is UTF-8 here', () => {
  expect(vi.isMockFunction(TextEncoder)).toBe(false);
  expect(Array.from(new TextEncoder().encode('ª'))).toEqual([0xc2, 0xaa]);
});
