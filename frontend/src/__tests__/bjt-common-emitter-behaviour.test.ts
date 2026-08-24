/**
 * The common-emitter example must actually AMPLIFY.
 *
 * The netlist snapshot froze this circuit's text for a long time while the
 * circuit did nothing: `analogRead(A0)` printed a flat 1021-1023 on every loop,
 * which is the collector pinned at Vcc. Measured in the running app, the bias
 * point was base 0.481 V, emitter 0.001 V, collector 4.994 V — the transistor
 * sat in cutoff, because the 10k "coupling resistor" from the signal generator
 * is in parallel with Rb2 at DC (a generator with 0 V offset is ground for DC):
 *
 *     10k || 10k = 5k  ->  Vb = 5 * 5/(47+5) = 0.481 V   (needs ~0.65 V)
 *
 * A snapshot cannot catch that: the text was exactly what the author intended.
 * So assert the physics instead — bias in the active region, and an output that
 * swings with gain.
 */
import { describe, expect, it } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { exampleToBuildNetlistInput } from '../utils/exampleToBuildNetlistInput';
import { exampleProjects } from '../data/examples';
import { runNetlist } from './helpers/testSolver';

const EXAMPLE_ID = 'bjt-common-emitter';

/** The example's real netlist plus the pin->net map, board and all — the same
 *  path the app takes. Dropping the board would drop the 5 V rail with it and
 *  every node would read 0 V: a dead amplifier, but really a dead test.
 *
 *  Node NAMES are resolved through the map rather than hardcoded: the builder
 *  numbers nets in traversal order, so `n2` is not stably "the base" and a
 *  hardcoded guess silently measures the wrong wire. */
function rigFor(id: string) {
  const ex = exampleProjects.find((e) => e.id === id);
  if (!ex) throw new Error(`example ${id} not found`);
  const built = buildNetlist(exampleToBuildNetlistInput(ex));
  const netOf = (pin: string): string => {
    const n = built.pinNetMap.get(pin);
    if (!n) throw new Error(`no net for ${pin} — wiring changed?`);
    return n;
  };
  // In the app the board supplies its own rails (collectBoardPinStates marks 5V
  // as an output, so the builder emits a source for it). Building from the
  // example alone leaves that node unpowered, and an unpowered amplifier reads
  // 0 V everywhere — which would make this test pass or fail for the wrong
  // reason. Add the rail the board would provide.
  const vccNet = netOf('arduino-uno:5V');
  const netlist = built.netlist.replace(
    /^\.tran/m,
    `V_testrail ${vccNet} 0 DC 5\n.tran`,
  );
  return {
    netlist,
    base: `v(${netOf('q1:B')})`,
    emitter: `v(${netOf('q1:E')})`,
    collector: `v(${netOf('q1:C')})`,
  };
}

/** Numeric magnitude of a possibly-complex vector sample. */
const mag = (v: number | { real: number; imag: number }): number =>
  typeof v === 'number' ? v : Math.hypot(v.real, v.imag);

describe('bjt-common-emitter behaviour', () => {
  it('biases the transistor into the active region', async () => {
    const rig = rigFor(EXAMPLE_ID);
    const result = await runNetlist(rig.netlist);
    const base = mag(result.vAtLast(rig.base));
    const emitter = mag(result.vAtLast(rig.emitter));

    expect(base).toBeGreaterThan(0.65); // above Vbe(on) — otherwise: cutoff
    expect(emitter).toBeGreaterThan(0.1); // current is actually flowing
  });

  it('does not pin the collector to either rail', async () => {
    const rig = rigFor(EXAMPLE_ID);
    const result = await runNetlist(rig.netlist);
    const collector = mag(result.vAtLast(rig.collector));
    // The sketch's own comment promises a mid-rail bias. Anything within a few
    // hundred mV of a rail has no room to swing and reads as a flat ADC line.
    expect(collector).toBeGreaterThan(1.0);
    expect(collector).toBeLessThan(4.5);
  });

  it('swings the collector — the output is an amplified signal, not a flat line', async () => {
    const rig = rigFor(EXAMPLE_ID);
    const result = await runNetlist(rig.netlist);
    const samples = result.vec(rig.collector).map(mag).filter(Number.isFinite);
    expect(samples.length).toBeGreaterThan(10);
    const swing = Math.max(...samples) - Math.min(...samples);
    // Input is 0.05 V peak (0.1 Vpp) and the stage's gain is -Rc/Re = -4.7, so
    // a working amplifier moves the collector by a good fraction of a volt.
    // A flat line — the bug — measures ~0.
    expect(swing).toBeGreaterThan(0.1);
  });
});
