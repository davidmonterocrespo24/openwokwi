// @vitest-environment jsdom
/**
 * Issue #270 — a Visuino-built .bin boots and runs in Velxio and then reports
 * `STA connect failed! 0x300a: ESP_ERR_WIFI_SSID`, which reads as the emulator
 * being broken. It is not: the emulated radio broadcasts four networks and
 * nothing else, and a binary built outside Velxio keeps whatever SSID it was
 * built with, because the rewrite that saves compiled sketches happens in the
 * compiler this file never went through.
 *
 * Verified against the real emulator while writing this: the same sketch built
 * with SSID "MyHomeNet" fails to associate, and with "Velxio-GUEST" connects
 * on 192.168.4.x.
 */
import { describe, it, expect } from 'vitest';
import { wifiSsidNoteFor } from '../utils/firmwareWifiNote';
import { EMULATED_WIFI_SSIDS } from '../types/board';

/** A fake image: some binary noise with the given ASCII strings buried in it. */
function image(strings: string[]): File {
  const parts: number[] = [];
  for (let i = 0; i < 512; i++) parts.push(i & 0xff);
  for (const s of strings) {
    for (let i = 0; i < s.length; i++) parts.push(s.charCodeAt(i));
    parts.push(0);
    for (let i = 0; i < 64; i++) parts.push(0xa5);
  }
  return new File([new Uint8Array(parts)], 'Generated.ino.merged.bin');
}

describe('issue #270 — uploaded firmware that cannot reach any network', () => {
  it('warns when the image uses WiFi and names no reachable network', async () => {
    const note = await wifiSsidNoteFor(image(['net80211', 'esp_wifi', 'MyHomeNet']));
    expect(note).toBeTruthy();
    for (const ssid of EMULATED_WIFI_SSIDS) expect(note).toContain(ssid);
  });

  it('stays quiet when the image already names one', async () => {
    for (const ssid of EMULATED_WIFI_SSIDS) {
      expect(await wifiSsidNoteFor(image(['net80211', 'esp_wifi', ssid]))).toBeNull();
    }
  });

  it('stays quiet for firmware that does not use WiFi', async () => {
    // A note nobody needs is noise, and noise is how people learn to ignore
    // the console.
    expect(await wifiSsidNoteFor(image(['blink', 'digitalWrite']))).toBeNull();
  });

  it('stays quiet for the reporter\'s own binary, which names the right network', async () => {
    // His SSID was correct all along — the note must not accuse him of a
    // problem he does not have.
    expect(await wifiSsidNoteFor(image(['net80211', 'esp_wifi', 'Velxio-GUEST']))).toBeNull();
  });

  it('recognises the WiFi stack by more than one marker', async () => {
    for (const marker of ['net80211', 'phy_init', 'esp_wifi', 'wifi_init']) {
      expect(await wifiSsidNoteFor(image([marker, 'SomeHomeNet']))).toBeTruthy();
    }
  });

  it('still recognises it when the build stripped its log strings', async () => {
    // The reporter's second binary has no 'STA.cpp' and no 'WiFiGeneric' at
    // all — a lower debug level drops them — while the driver names remain.
    // Keying on the log strings meant the note stayed silent on exactly the
    // firmware it exists for.
    const stripped = image(['net80211', 'phy_init', 'esp_wifi', 'MyHomeNet']);
    expect(await wifiSsidNoteFor(stripped)).toBeTruthy();
  });

  it('does not fire on a name that a blink image also carries', async () => {
    // WIFI_INIT is in both a blink build and a WiFi build, measured.
    expect(await wifiSsidNoteFor(image(['WIFI_INIT_CONFIG_DEFAULT', 'blink']))).toBeNull();
  });

  it('finds a marker that straddles the very end of the image', async () => {
    const bytes: number[] = [];
    for (let i = 0; i < 100; i++) bytes.push(0xff);
    for (const ch of 'net80211') bytes.push(ch.charCodeAt(0));
    const note = await wifiSsidNoteFor(new File([new Uint8Array(bytes)], 'fw.bin'));
    expect(note).toBeTruthy();
  });
});

describe('issue #270 — the serial note for a blank-NVS connect', () => {
  // Verified against the emulator: WiFi.begin() with no arguments on the
  // simulator's blank flash produces exactly `STA.cpp:357 ... 0x300a:
  // ESP_ERR_WIFI_SSID` — the reporter's error, timestamps and all. On his
  // real DevKit the same binary worked because NVS still held credentials
  // some earlier firmware had saved.
  const MARKER = '0x300a: ESP_ERR_WIFI_SSID';

  it('explains the error once', async () => {
    const { annotateSerialChunk } = await import('../utils/serialDiagnostics');
    const chunk = `[  40][E][STA.cpp:357] connect(): STA connect failed! ${MARKER}\r\n`;
    const out = annotateSerialChunk('', chunk);
    expect(out).toContain('NVS');
    expect(out).toContain('Velxio-GUEST');
  });

  it('does not repeat itself while the same run keeps failing', async () => {
    const { annotateSerialChunk } = await import('../utils/serialDiagnostics');
    const chunk = `STA connect failed! ${MARKER}\r\n`;
    const first = annotateSerialChunk('', chunk);
    const second = annotateSerialChunk(first, chunk);
    expect(second).not.toContain('NVS');
  });

  it('re-arms on a fresh run, whose log starts empty', async () => {
    const { annotateSerialChunk } = await import('../utils/serialDiagnostics');
    const chunk = `STA connect failed! ${MARKER}\r\n`;
    annotateSerialChunk('', chunk);
    expect(annotateSerialChunk('', chunk)).toContain('NVS');
  });

  it('leaves ordinary output alone', async () => {
    const { annotateSerialChunk } = await import('../utils/serialDiagnostics');
    expect(annotateSerialChunk('', 'TICK 1\r\n')).toBe('TICK 1\r\n');
  });
});
