/**
 * Tell someone their uploaded firmware will never find a network (issue #270).
 *
 * A sketch compiled inside Velxio has its WiFi SSID rewritten on the way to
 * the emulator, because the emulated radio broadcasts a fixed set of networks
 * and nothing else. Firmware that arrives already built — from the Arduino
 * IDE, from Visuino, from anywhere — skips that step by construction: there is
 * no compile to rewrite anything. So it boots, runs, and hunts for a network
 * that does not exist here, which looks like the emulator failing rather than
 * a configuration mismatch. The reporter of #270 lost an afternoon to exactly
 * that with a binary that was, in every other respect, working.
 */
import { EMULATED_WIFI_SSIDS } from '../types/board';

/**
 * Markers that the image contains the Arduino WiFi stack. Kept narrow on
 * purpose: `esp_wifi` alone appears in images that never touch the radio, and
 * a note shown to someone who does not need it is noise that teaches people to
 * ignore the console.
 */
const WIFI_MARKERS = ['WiFiGeneric', 'STA.cpp', 'esp_wifi_connect', 'wifi_station'];

/** Search a binary for an ASCII string, without decoding the whole image. */
function containsAscii(bytes: Uint8Array, needle: string): boolean {
  const pat = new Uint8Array(needle.length);
  for (let i = 0; i < needle.length; i++) pat[i] = needle.charCodeAt(i);
  outer: for (let i = 0; i + pat.length <= bytes.length; i++) {
    for (let j = 0; j < pat.length; j++) if (bytes[i + j] !== pat[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * The line to print for this firmware, or null when there is nothing to say —
 * either it does not use WiFi, or it already names a network the emulator
 * broadcasts and will connect on its own.
 */
export async function wifiSsidNoteFor(file: File): Promise<string | null> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return null; // unreadable is the caller's problem, not ours to report twice
  }
  if (!WIFI_MARKERS.some((m) => containsAscii(bytes, m))) return null;
  if (EMULATED_WIFI_SSIDS.some((s) => containsAscii(bytes, s))) return null;
  return (
    'This firmware uses WiFi but does not name any network the emulator has. ' +
    `The emulated radio broadcasts only: ${EMULATED_WIFI_SSIDS.join(', ')} — all open, ` +
    'no password. Rebuild it with one of those as the SSID and it will connect. ' +
    '(Sketches compiled here are rewritten automatically; an uploaded binary cannot be.)'
  );
}
