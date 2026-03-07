/**
 * Wokwi zip import/export
 *
 * Converts between Wokwi's diagram.json format and Velxio's internal
 * component/wire format, bundling everything into a .zip file.
 *
 * Wokwi zip structure:
 *   diagram.json     — parts + connections
 *   sketch.ino       — main sketch (or projectname.ino)
 *   *.h / *.cpp      — additional files
 *   libraries.txt    — optional library list
 *   wokwi-project.txt — optional metadata
 */

import JSZip from 'jszip';
import type { Wire } from '../types/wire';

// ── Type definitions ──────────────────────────────────────────────────────────

interface WokwiPart {
  type: string;
  id: string;
  top: number;
  left: number;
  rotate?: number;
  attrs: Record<string, unknown>;
}

interface WokwiDiagram {
  version: number;
  author: string;
  editor: string;
  parts: WokwiPart[];
  connections: [string, string, string, string[]][];
}

export interface VelxioComponent {
  id: string;
  metadataId: string;
  x: number;
  y: number;
  properties: Record<string, unknown>;
}

export interface ImportResult {
  boardType: 'arduino-uno' | 'raspberry-pi-pico';
  components: VelxioComponent[];
  wires: Wire[];
  files: Array<{ name: string; content: string }>;
}

// ── Board mappings ────────────────────────────────────────────────────────────

// Wokwi board type → Velxio boardType
const WOKWI_TYPE_TO_BOARD: Record<string, 'arduino-uno' | 'raspberry-pi-pico'> = {
  'wokwi-arduino-uno': 'arduino-uno',
  'wokwi-arduino-nano': 'arduino-uno',
  'wokwi-arduino-mega': 'arduino-uno',
  'wokwi-raspberry-pi-pico': 'raspberry-pi-pico',
};

// Velxio boardType → Wokwi type
const BOARD_TO_WOKWI_TYPE: Record<string, string> = {
  'arduino-uno': 'wokwi-arduino-uno',
  'raspberry-pi-pico': 'wokwi-raspberry-pi-pico',
};

// Velxio boardType → default Wokwi part id
const BOARD_TO_WOKWI_ID: Record<string, string> = {
  'arduino-uno': 'uno',
  'raspberry-pi-pico': 'pico',
};

// ── Color helpers ─────────────────────────────────────────────────────────────

const COLOR_NAME_TO_HEX: Record<string, string> = {
  red: '#ff0000', black: '#000000', green: '#00c800', blue: '#0000ff',
  yellow: '#ffff00', orange: '#ff8800', white: '#ffffff', gray: '#808080',
  grey: '#808080', purple: '#800080', pink: '#ff69b4', cyan: '#00ffff',
  gold: '#ffd700', brown: '#8b4513', magenta: '#ff00ff', lime: '#00ff00',
  violet: '#ee82ee', maroon: '#800000', navy: '#000080', teal: '#008080',
};

const HEX_TO_COLOR_NAME: Record<string, string> = {
  '#ff0000': 'red', '#000000': 'black', '#00ff00': 'green', '#00c800': 'green',
  '#0000ff': 'blue', '#ffff00': 'yellow', '#ff8800': 'orange', '#ffffff': 'white',
  '#808080': 'gray', '#800080': 'purple', '#00ffff': 'cyan', '#ffd700': 'gold',
};

function colorToHex(color: string): string {
  if (!color) return '#888888';
  if (color.startsWith('#')) return color.toLowerCase();
  return COLOR_NAME_TO_HEX[color.toLowerCase()] ?? '#888888';
}

function hexToColorName(hex: string): string {
  return HEX_TO_COLOR_NAME[hex.toLowerCase()] ?? hex;
}

// ── Type conversion ───────────────────────────────────────────────────────────

function wokwiTypeToMetadataId(type: string): string {
  if (type.startsWith('wokwi-')) return type.slice(6);
  if (type.startsWith('board-')) return type.slice(6);
  return type;
}

function metadataIdToWokwiType(metadataId: string): string {
  return `wokwi-${metadataId}`;
}

// ── Export ────────────────────────────────────────────────────────────────────

export async function exportToWokwiZip(
  files: Array<{ name: string; content: string }>,
  components: VelxioComponent[],
  wires: Wire[],
  boardType: string,
  projectName: string,
): Promise<void> {
  const zip = new JSZip();

  const boardWokwiType = BOARD_TO_WOKWI_TYPE[boardType] ?? 'wokwi-arduino-uno';
  const boardId = BOARD_TO_WOKWI_ID[boardType] ?? 'uno';

  // Build parts — board first, then user components
  const parts: WokwiPart[] = [
    { type: boardWokwiType, id: boardId, top: 0, left: 0, attrs: {} },
    ...components.map((c) => ({
      type: metadataIdToWokwiType(c.metadataId),
      id: c.id,
      top: Math.round(c.y),
      left: Math.round(c.x),
      attrs: c.properties as Record<string, unknown>,
    })),
  ];

  // Build connections
  const connections: [string, string, string, string[]][] = wires.map((w) => {
    const startId = w.start.componentId === 'arduino-uno' ? boardId : w.start.componentId;
    const endId = w.end.componentId === 'arduino-uno' ? boardId : w.end.componentId;
    return [
      `${startId}:${w.start.pinName}`,
      `${endId}:${w.end.pinName}`,
      hexToColorName(w.color ?? '#888888'),
      [],
    ];
  });

  const diagram: WokwiDiagram = {
    version: 1,
    author: 'Velxio',
    editor: 'wokwi',
    parts,
    connections,
  };

  zip.file('diagram.json', JSON.stringify(diagram, null, 2));
  zip.file('wokwi-project.txt', `Exported from Velxio\n\nSimulate this project on https://velxio.dev\n`);

  for (const f of files) {
    zip.file(f.name, f.content);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(projectName || 'velxio-project').replace(/[^a-z0-9_-]/gi, '-')}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Import ────────────────────────────────────────────────────────────────────

export async function importFromWokwiZip(file: File): Promise<ImportResult> {
  const zip = await JSZip.loadAsync(file);

  // diagram.json is required
  const diagramEntry = zip.file('diagram.json');
  if (!diagramEntry) throw new Error('No diagram.json found in the zip file.');

  const diagramText = await diagramEntry.async('string');
  const diagram: WokwiDiagram = JSON.parse(diagramText);

  // Detect board
  const boardPart = diagram.parts.find((p) => WOKWI_TYPE_TO_BOARD[p.type]);
  const boardType = boardPart ? WOKWI_TYPE_TO_BOARD[boardPart.type] : 'arduino-uno';
  const boardId = boardPart?.id ?? 'uno';

  // Convert non-board parts to Velxio components
  const components: VelxioComponent[] = diagram.parts
    .filter((p) => !WOKWI_TYPE_TO_BOARD[p.type])
    .map((p) => ({
      id: p.id,
      metadataId: wokwiTypeToMetadataId(p.type),
      x: p.left,
      y: p.top,
      properties: { ...p.attrs },
    }));

  // Convert connections to Velxio wires
  const wires: Wire[] = diagram.connections.map((conn, i) => {
    const [startStr, endStr, color] = conn;
    const colonA = startStr.indexOf(':');
    const colonB = endStr.indexOf(':');
    const startCompRaw = colonA >= 0 ? startStr.slice(0, colonA) : startStr;
    const startPin = colonA >= 0 ? startStr.slice(colonA + 1) : '';
    const endCompRaw = colonB >= 0 ? endStr.slice(0, colonB) : endStr;
    const endPin = colonB >= 0 ? endStr.slice(colonB + 1) : '';

    // Remap board part id → Velxio internal board id
    const startId = startCompRaw === boardId ? 'arduino-uno' : startCompRaw;
    const endId = endCompRaw === boardId ? 'arduino-uno' : endCompRaw;

    return {
      id: `wire-${i}-${Date.now()}`,
      start: { componentId: startId, pinName: startPin, x: 0, y: 0 },
      end: { componentId: endId, pinName: endPin, x: 0, y: 0 },
      controlPoints: [],
      color: colorToHex(color),
      signalType: 'digital' as const,
      isValid: true,
    };
  });

  // Read code files (.ino, .h, .cpp, .c)
  const CODE_EXTS = new Set(['.ino', '.h', '.cpp', '.c']);
  const files: Array<{ name: string; content: string }> = [];

  for (const [filename, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const basename = filename.split('/').pop() ?? filename;
    const ext = '.' + basename.split('.').pop()!.toLowerCase();
    if (CODE_EXTS.has(ext)) {
      const content = await entry.async('string');
      files.push({ name: basename, content });
    }
  }

  // Sort: .ino first, then alphabetically
  files.sort((a, b) => {
    const aIno = a.name.endsWith('.ino');
    const bIno = b.name.endsWith('.ino');
    if (aIno && !bIno) return -1;
    if (!aIno && bIno) return 1;
    return a.name.localeCompare(b.name);
  });

  return { boardType, components, wires, files };
}
