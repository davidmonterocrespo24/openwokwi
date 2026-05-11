/**
 * Board Definition Generator
 * 
 * Synchronizes Velxio board pin positions and SPICE metadata with the 
 * official board.json files from the wokwi-boards repository.
 */

import * as fs from 'fs';
import * as path from 'path';

// Mapping of Velxio BoardKind to wokwi-boards folder names
const BOARD_MAPPING: Record<string, string> = {
  'raspberry-pi-pico': 'pi-pico',
  'pi-pico-w': 'pi-pico-w',
  'esp32': 'esp32-devkit-v1',
  'esp32-devkit-c-v4': 'esp32-devkit-c-v4',
  'esp32-cam': 'esp32-cam',
  'wemos-lolin32-lite': 'wemos-lolin32-lite',
  'esp32-s3': 'esp32-s3-devkitc-1',
  'xiao-esp32-s3': 'xiao-esp32-s3',
  'arduino-nano-esp32': 'arduino-nano-esp32',
  'esp32-c3': 'esp32-c3-devkitm-1',
  'xiao-esp32-c3': 'xiao-esp32-c3',
  'aitewinrobot-esp32c3-supermini': 'aitewinrobot-esp32c3-supermini',
};

const BASE_DIR = path.join(__dirname, '..');
const WOKWI_BOARDS_DIR = path.join(BASE_DIR, 'third-party/wokwi-boards/boards');
const UI_OUTPUT_FILE = path.join(BASE_DIR, 'frontend/src/components/velxio-components/boardPins.generated.ts');
const SPICE_OUTPUT_FILE = path.join(BASE_DIR, 'frontend/src/simulation/spice/boardPinGroups.ts');
const PUBLIC_BOARDS_DIR = path.join(BASE_DIR, 'frontend/public/boards');

if (!fs.existsSync(PUBLIC_BOARDS_DIR)) {
  fs.mkdirSync(PUBLIC_BOARDS_DIR, { recursive: true });
}

interface PinDef {
  name: string;
  x: number;
  y: number;
  target?: string;
}

interface BoardData {
  kind: string;
  width: number;
  height: number;
  pins: PinDef[];
  vcc: number;
  svgUrl: string;
}

async function main() {
  console.log('🏗️  Generating board definitions...');
  
  const boards: BoardData[] = [];

  for (let [kind, folder] of Object.entries(BOARD_MAPPING)) {
    const boardDir = path.join(WOKWI_BOARDS_DIR, folder);
    const jsonPath = path.join(boardDir, 'board.json');
    const svgPath = path.join(boardDir, 'board.svg');
    
    if (!fs.existsSync(jsonPath)) {
      console.warn(`⚠️  Missing board.json for ${kind} at ${jsonPath}`);
      continue;
    }

    // Copy SVG to public folder
    const targetSvgName = `${folder}.svg`;
    const publicSvgPath = path.join(PUBLIC_BOARDS_DIR, targetSvgName);
    if (fs.existsSync(svgPath)) {
      fs.copyFileSync(svgPath, publicSvgPath);
    } else {
      console.warn(`⚠️  Missing board.svg for ${kind} at ${svgPath}`);
    }

    const rawJson = fs.readFileSync(jsonPath, 'utf-8');
    // Strip comments while ignoring those inside strings (e.g. https://)
    const cleanJson = rawJson.replace(/\\"|"(?:\\"|[^"])*"|(\/\*[\s\S]*?\*\/|\/\/.*$)/gm, (match, group) =>
      group ? "" : match
    );
    
    const json = JSON.parse(cleanJson);
    const pins: PinDef[] = [];
    let dominantVcc = 3.3; 

    for (const [name, info] of Object.entries<any>(json.pins)) {
      if (name.startsWith('$')) continue; // Skip internal pins

      // mm to px (5px/mm)
      const x = Math.round(info.x * 5);
      const y = Math.round(info.y * 5);
      const target = info.target;

      pins.push({ name, x, y, target });

      // Determine logical VCC for SPICE sources
      if (kind.includes('esp32') || kind.includes('pico')) {
        dominantVcc = 3.3;
      } else if (target?.startsWith('power(')) {
        const v = parseFloat(target.match(/power\(([\d\.]+)\)/)?.[1] || '3.3');
        if (v > dominantVcc) dominantVcc = v;
      }
    }

    boards.push({
      kind,
      width: json.width,
      height: json.height,
      pins,
      vcc: dominantVcc,
      svgUrl: `/boards/${targetSvgName}`
    });
    
    console.log(`  ✓ ${kind} (${pins.length} pins)`);
  }

  // 1. Generate UI Definitions
  const uiContent = `// AUTO-GENERATED BOARD CONFIGURATIONS
// Generated from third-party/wokwi-boards/boards/*/board.json
// Do not edit manually.

export const GENERATED_BOARD_CONFIGS: Record<string, any> = {
${boards.map(b => {
  const pinsJson = JSON.stringify(b.pins, null, 6)
    .replace(/"/g, "'"); // Convert to single quotes
  return `  '${b.kind}': {
    svgUrl: '${b.svgUrl}',
    w: ${Math.round(b.width * 5)},
    h: ${Math.round(b.height * 5)},
    pins: ${pinsJson},
  },`;
}).join('\n')}
};
`;
  fs.writeFileSync(UI_OUTPUT_FILE, uiContent);

  // 2. Generate SPICE Pin Groups
  const spiceContent = `// AUTO-GENERATED SPICE PIN GROUPS
// Generated from third-party/wokwi-boards/boards/*/board.json

import type { BoardKind } from '../../types/board';

export interface BoardPinGroup {
  /** Supply voltage (V). */
  vcc: number;
  /** Pin names mapped to their semantic targets (e.g. 'GND', 'power(3.3)'). */
  pinTargets: Record<string, string>;
}

const LEGACY_GROUPS: Record<string, BoardPinGroup> = {
  'arduino-uno': {
    vcc: 5,
    pinTargets: {
      'GND.1': 'GND', 'GND.2': 'GND', 'GND.3': 'GND', 'GND': 'GND',
      '5V': 'power(5)', 'VCC': 'power(5)', '3.3V': 'power(3.3)', 'AREF': 'AREF'
    },
  },
  'arduino-nano': {
    vcc: 5,
    pinTargets: {
      'GND.1': 'GND', 'GND.2': 'GND', 'GND': 'GND',
      '5V': 'power(5)', 'VCC': 'power(5)', '3V3': 'power(3.3)', 'AREF': 'AREF'
    },
  },
  'arduino-mega': {
    vcc: 5,
    pinTargets: {
      'GND.1': 'GND', 'GND.2': 'GND', 'GND.3': 'GND', 'GND.4': 'GND', 'GND': 'GND',
      '5V': 'power(5)', 'VCC': 'power(5)', '3.3V': 'power(3.3)', 'AREF': 'AREF'
    },
  },
  'attiny85': { vcc: 5, pinTargets: { 'GND': 'GND', 'VCC': 'power(5)' } },
  'raspberry-pi-3': { vcc: 5, pinTargets: { 'GND': 'GND', '5V': 'power(5)', '3.3V': 'power(3.3)' } },
  'raspberry-pi-4': { vcc: 5, pinTargets: { 'GND': 'GND', '5V': 'power(5)', '3.3V': 'power(3.3)' } },
  'raspberry-pi-5': { vcc: 5, pinTargets: { 'GND': 'GND', '5V': 'power(5)', '3.3V': 'power(3.3)' } },
};

export const BOARD_PIN_GROUPS: Record<BoardKind | 'default', BoardPinGroup> = {
  default: {
    vcc: 5,
    pinTargets: { 'GND': 'GND', 'GND.1': 'GND', 'GND.2': 'GND', '5V': 'power(5)', 'VCC': 'power(5)' }
  },
  ...LEGACY_GROUPS,
${boards.map(b => {
  const targets: Record<string, string> = {};
  b.pins.forEach(p => { if (p.target) targets[p.name] = p.target; });
  const targetEntries = Object.entries(targets).map(([k, v]) => `      '${k}': '${v}'`);
  const targetsStr = `{\n${targetEntries.join(',\n')}\n    }`;
  return `  '${b.kind}': {
    vcc: ${b.vcc},
    pinTargets: ${targetsStr},
  },`;
}).join('\n')}
};
`;
  fs.writeFileSync(SPICE_OUTPUT_FILE, spiceContent);

  console.log('\n✅ Board definitions and SVGs synchronized successfully.');
}

main().catch(err => {
  console.error('❌ Failed to generate board definitions:', err);
  process.exit(1);
});
