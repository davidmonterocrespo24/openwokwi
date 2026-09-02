// @vitest-environment jsdom
/**
 * Overlay QEMU-Linux boards (ProBoardDef.piFamily) in the example loader and
 * in the Pro upgrade prompt.
 *
 * Both used to answer as if the board were a Raspberry Pi, because both read
 * a registry the overlay only fills at mount:
 *
 *   - `loadExample` gated the guest-script branch on `isPiBoardKind()`. A
 *     direct /example/<id> link can load before the overlay registers its
 *     kinds (the pro overlay registered the partner examples first), so the
 *     branch was skipped and the editor opened on the board group's Arduino
 *     blink default instead of the example's script.py.
 *   - `proBoardFeatureName` named the FAMILY, so a free user clicking Run on
 *     a UNIHIKER M10 was told "Raspberry Pi emulation is a Pro feature" about
 *     a board that is not a Raspberry Pi.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useEditorStore } from '../store/useEditorStore';
import { useElectricalStore } from '../store/useElectricalStore';
import { registerProBoards } from '../lib/proBoardRegistry';
import { proBoardFeatureName } from '../lib/proBoardGate';
import { loadExample } from '../utils/loadExample';
import type { ExampleProject } from '../data/examples';
import type { BoardKind } from '../types/board';

// Never registered — stands in for a board whose overlay import has not
// landed yet at load time.
const UNREGISTERED = 'linux-test-unregistered';
// Registered below, as the overlay does at mount.
const REGISTERED = 'linux-test-registered';

const SCRIPT = '# guest script\nprint("hello from the guest")\n';

const exampleFor = (kind: string): ExampleProject =>
  ({
    id: `example-${kind}`,
    title: `${kind} example`,
    description: 'guest script uploaded to the QEMU-Linux board',
    category: 'basics',
    difficulty: 'beginner',
    boardType: kind,
    code: '',
    boards: [{ boardKind: kind, x: 40, y: 40, vfsFiles: { 'script.py': SCRIPT } }],
    components: [],
    wires: [],
  }) as unknown as ExampleProject;

function resetStores() {
  const sim = useSimulatorStore.getState();
  for (const id of sim.boards.map((b) => b.id)) sim.removeBoard(id);
  useElectricalStore.getState().setPaused(false);
}

describe('overlay QEMU-Linux boards', () => {
  beforeEach(resetStores);

  it('loads the example guest script even before the kind is registered', async () => {
    await loadExample(exampleFor(UNREGISTERED));

    const sim = useSimulatorStore.getState();
    expect(sim.boards).toHaveLength(1);
    const files = useEditorStore.getState().fileGroups[sim.boards[0].activeFileGroupId] ?? [];
    expect(files.map((f) => f.name)).toContain('script.py');
    expect(files.find((f) => f.name === 'script.py')?.content).toBe(SCRIPT);
    // The board group's Arduino default must be gone, not sitting next to it.
    expect(files.some((f) => (f.content ?? '').includes('Arduino Blink Example'))).toBe(false);
  });

  it('names the board itself in the upgrade prompt, not the family it rides', () => {
    registerProBoards([
      {
        kind: REGISTERED,
        label: 'Test Linux SBC',
        fqbn: null,
        description: 'overlay QEMU-Linux board',
        tag: 'velxio-linux-test',
        size: { w: 100, h: 100 },
        piFamily: true,
      },
    ]);

    expect(proBoardFeatureName(REGISTERED)).toBe('Test Linux SBC emulation');
    // The OSS families keep their family names — every kind in them is one.
    expect(proBoardFeatureName('raspberry-pi-4' as BoardKind)).toBe('Raspberry Pi emulation');
    expect(proBoardFeatureName('stm32-bluepill' as BoardKind)).toBe('STM32 emulation');
    expect(proBoardFeatureName('arduino-uno' as BoardKind)).toBe('this board');
  });
});
