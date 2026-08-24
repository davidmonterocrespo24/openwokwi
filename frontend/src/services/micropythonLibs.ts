/**
 * micropythonLibs — the MicroPython side of the Library Manager (issue #214).
 *
 * There is no install step on the board: a MicroPython library IS a .py file
 * in the project, copied onto the board's filesystem before main.py runs. So
 * "installing" here means resolving a package from the official
 * micropython-lib index (via the backend proxy, which enforces source-only +
 * size caps) and WRITING its files into the active board's file group —
 * visible in the explorer, editable, and travelling with the project.
 */
import axios from 'axios';
import { getApiBase } from '../lib/apiBase';
import { useEditorStore } from '../store/useEditorStore';

export interface MpyPackage {
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
}

export interface MpyFile {
  path: string;
  content: string;
}

/**
 * Featured picks shown before the user types — the drivers Velxio actually
 * emulates as parts, so "add → wire → run" works end to end. All resolve
 * through the same index fetch; nothing here is a separate install path.
 */
export const FEATURED_MPY_PACKAGES: ReadonlyArray<{ name: string; blurb: string }> = [
  { name: 'ssd1306', blurb: 'SSD1306 OLED driver (I2C/SPI) — the 128x64 display part' },
  { name: 'umqtt.simple', blurb: 'Minimal MQTT client (WiFi boards)' },
  { name: 'umqtt.robust', blurb: 'MQTT client with auto-reconnect' },
  { name: 'urequests', blurb: 'HTTP requests (WiFi boards)' },
];

/**
 * Modules already frozen into the MicroPython firmware Velxio boots — no
 * install needed, `import` just works. Listed so a search for "dht" answers
 * "you already have it" instead of a confusing empty result.
 */
export const BUILTIN_MPY_MODULES: ReadonlyArray<{ name: string; blurb: string }> = [
  { name: 'machine', blurb: 'Pins, I2C, SPI, ADC, PWM, timers' },
  { name: 'network', blurb: 'WiFi (WLAN) on ESP32-family boards' },
  { name: 'neopixel', blurb: 'WS2812 RGB LED strips' },
  { name: 'dht', blurb: 'DHT11 / DHT22 temperature & humidity' },
  { name: 'onewire', blurb: '1-Wire bus' },
  { name: 'ds18x20', blurb: 'DS18B20 temperature sensor (over onewire)' },
  { name: 'framebuf', blurb: 'Frame buffer drawing (used by display drivers)' },
];

export async function searchMpyPackages(q: string): Promise<MpyPackage[]> {
  const { data } = await axios.get<{ success: boolean; packages: MpyPackage[]; error?: string }>(
    `${getApiBase()}/micropython-libs/search`,
    { params: { q } },
  );
  if (!data.success) throw new Error(data.error || 'search failed');
  return data.packages;
}

export async function fetchMpyPackage(name: string): Promise<MpyFile[]> {
  const { data } = await axios.post<{ success: boolean; files: MpyFile[]; error?: string }>(
    `${getApiBase()}/micropython-libs/fetch`,
    { name },
  );
  if (!data.success) throw new Error(data.error || 'fetch failed');
  return data.files;
}

/**
 * Upsert the package's files into a board's file group. Existing files with
 * the same path are overwritten (that IS the upgrade path); everything else
 * is untouched. The group must be the ACTIVE one — the modal operates on the
 * active board, whose group the editor is already pointed at.
 */
export function writeFilesIntoGroup(groupId: string, files: MpyFile[]): string[] {
  const ed = useEditorStore.getState();
  if (ed.activeGroupId !== groupId) ed.setActiveGroup(groupId);
  const written: string[] = [];
  for (const f of files) {
    const existing = useEditorStore
      .getState()
      .getGroupFiles(groupId)
      .find((x) => x.name === f.path);
    if (existing) {
      useEditorStore.getState().updateGroupFile(groupId, existing.id, f.content);
    } else {
      const id = useEditorStore.getState().createFile(f.path);
      useEditorStore.getState().setFileContent(id, f.content);
    }
    written.push(f.path);
  }
  return written;
}

/** Which of the package's files are already in the group (by exact path). */
export function packageFilesInGroup(groupId: string, name: string): boolean {
  // Cheap heuristic for list rendering: the package's canonical module file
  // ("ssd1306" -> ssd1306.py, "umqtt.simple" -> umqtt/simple.py) is present.
  const candidates = [`${name}.py`, `${name.replace(/\./g, '/')}.py`, `${name}/__init__.py`];
  const names = new Set(
    useEditorStore
      .getState()
      .getGroupFiles(groupId)
      .map((f) => f.name),
  );
  return candidates.some((c) => names.has(c));
}
