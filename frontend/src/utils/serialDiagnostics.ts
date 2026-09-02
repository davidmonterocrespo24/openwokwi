/**
 * One-line explanations for serial errors that read as emulator bugs.
 *
 * The firmware's own message is written for someone holding real hardware.
 * `ESP_ERR_WIFI_SSID` cost the reporter of issue #270 days: his Visuino build
 * called WiFi.begin() with no credentials, which on a real DevKit quietly
 * reuses the network saved in the chip's flash (NVS) by some earlier firmware
 * — and the simulator's flash starts blank, so the same binary fails at boot
 * with a hex code. Nothing was wrong with the emulation; nothing in the output
 * said so.
 *
 * Each entry appends its note once per run: the note re-arms when the serial
 * log is cleared (every Run starts a fresh log), because the presence of the
 * note in the existing output is itself the marker.
 */
const NOTES: ReadonlyArray<{ marker: string; note: string }> = [
  {
    marker: '0x300a: ESP_ERR_WIFI_SSID',
    note:
      '[velxio] This firmware asked to connect with no SSID (or an invalid one). ' +
      'WiFi.begin() without arguments reuses credentials saved in the chip’s flash (NVS) ' +
      'by a previous firmware — the simulator’s flash starts blank, so there is nothing ' +
      'to reuse. Pass them explicitly: WiFi.begin("Velxio-GUEST", "").',
  },
];

/**
 * The chunk to actually append, with any due explanation attached. Pure so it
 * can be tested without the frame batcher around it.
 */
export function annotateSerialChunk(existingOutput: string, chunk: string): string {
  let out = chunk;
  for (const { marker, note } of NOTES) {
    if (out.includes(marker) && !existingOutput.includes(note) && !out.includes(note)) {
      out += `\r\n${note}\r\n`;
    }
  }
  return out;
}
