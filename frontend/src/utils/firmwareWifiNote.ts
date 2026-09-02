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
 * Markers that the image links the WiFi stack.
 *
 * Chosen by measurement, against two real builds of the same board: a blink
 * sketch and a WiFi one. Every name here is absent from the blink image and
 * present in the WiFi one. `WIFI_INIT` looked obvious and is in BOTH, so it is
 * not here.
 *
 * They are IDF-level names on purpose. The first version of this list used the
 * Arduino log strings ('WiFiGeneric', 'STA.cpp'), which vanish when the build
 * lowers its debug level — the reporter's own second binary has neither, and
 * the note would have stayed silent on the exact firmware it was written for.
 * These survive, because they are the driver, not a message about it.
 */
const WIFI_MARKERS = ['net80211', 'phy_init', 'esp_wifi', 'wifi_init'];

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
  // A project with its own AP parts (overlay window seam) defines the
  // airspace; without them the classic four stand. Either way, firmware
  // that names one of the on-air networks needs no note.
  const custom =
    (window as { __velxio_custom_wifi_ssids__?: () => string[] | null })
      .__velxio_custom_wifi_ssids__?.() ?? null;
  const onAir: readonly string[] = custom ?? EMULATED_WIFI_SSIDS;
  if (onAir.some((s) => containsAscii(bytes, s))) return null;
  if (custom) {
    return (
      'This firmware uses WiFi but does not name any network in this project. ' +
      `The project's access points broadcast: ${custom.join(', ')}. ` +
      'Add a WiFi Access Point part with the SSID the firmware expects and it will connect.'
    );
  }
  return (
    'This firmware uses WiFi but does not name any network the emulator has. ' +
    `The emulated radio broadcasts only: ${EMULATED_WIFI_SSIDS.join(', ')} — all open, ` +
    'no password. Rebuild it with one of those as the SSID — or add a WiFi Access ' +
    'Point part with your SSID (paid feature) — and it will connect. ' +
    '(Sketches compiled here are rewritten automatically; an uploaded binary cannot be.)'
  );
}
