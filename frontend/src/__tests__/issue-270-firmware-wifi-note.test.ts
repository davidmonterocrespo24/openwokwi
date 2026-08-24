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
    const note = await wifiSsidNoteFor(image(['WiFiGeneric', 'MyHomeNet']));
    expect(note).toBeTruthy();
    for (const ssid of EMULATED_WIFI_SSIDS) expect(note).toContain(ssid);
  });

  it('stays quiet when the image already names one', async () => {
    for (const ssid of EMULATED_WIFI_SSIDS) {
      expect(await wifiSsidNoteFor(image(['WiFiGeneric', ssid]))).toBeNull();
    }
  });

  it('stays quiet for firmware that does not use WiFi', async () => {
    // A note nobody needs is noise, and noise is how people learn to ignore
    // the console.
    expect(await wifiSsidNoteFor(image(['blink', 'digitalWrite']))).toBeNull();
  });

  it('recognises the WiFi stack by more than one marker', async () => {
    for (const marker of ['WiFiGeneric', 'STA.cpp', 'esp_wifi_connect', 'wifi_station']) {
      expect(await wifiSsidNoteFor(image([marker, 'SomeHomeNet']))).toBeTruthy();
    }
  });

  it('finds a marker that straddles the very end of the image', async () => {
    const bytes: number[] = [];
    for (let i = 0; i < 100; i++) bytes.push(0xff);
    for (const ch of 'WiFiGeneric') bytes.push(ch.charCodeAt(0));
    const note = await wifiSsidNoteFor(new File([new Uint8Array(bytes)], 'fw.bin'));
    expect(note).toBeTruthy();
  });
});
