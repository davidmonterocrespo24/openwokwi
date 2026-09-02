/**
 * Measurement probes (voltmeters, ammeters, scope probes).
 *
 * Probes are Velxio components with `metadataId` starting with `instr-`.
 * They do NOT contribute SPICE cards themselves (so `componentToSpice`
 * returns null for them). Instead, they read the already-solved result
 * via net names derived from the same Union-Find used in NetlistBuilder.
 *
 * The ammeter is special: it *does* inject a "V_name_sense 0" voltage
 * source (0 V) in series with one of its pins so ngspice reports a
 * branch current for it. Phase 8.5 MVP: emit the sense source by extending
 * componentToSpice with an ammeter mapper.
 */
import type { ComponentForSpice, ElectricalSolveResult, TimeWaveforms } from './types';
import type { Wire } from '../../types/wire';
import { UnionFind } from './unionFind';
import { auxRailNetName, isAuxRailNet } from './boardPinGroups';
import { GROUND_PIN_RE, VCC_PIN_RE } from './NetlistBuilder';
import { rms, mean, peak, subtract, isAC } from './waveformStats';

export type ProbeKind = 'voltmeter' | 'ammeter' | 'multimeter';

/**
 * Time-domain statistics computed from a `.tran` waveform.
 * Present only when the probed net has AC content.
 */
export interface ProbeAcStats {
  /** Root-mean-square (what a real RMS meter reads for AC). */
  rms: number;
  /** DC component (mean). */
  dc: number;
  /** Peak absolute value. */
  peak: number;
  /** Pre-formatted "RMS X.XX V" / "RMS X.XX mA" line. */
  rmsDisplay: string;
  /** Pre-formatted "pk X.XX V" line. */
  peakDisplay: string;
  /** Pre-formatted "DC X.XX V" line. */
  dcDisplay: string;
}

export interface ProbeReading {
  kind: ProbeKind;
  /** Primary numeric value (volts for voltmeter, amps for ammeter). */
  value: number;
  /** Pretty string for UI display (legacy single-line). */
  display: string;
  /** Unit label shown next to the value. */
  unit: 'V' | 'mV' | 'µV' | 'A' | 'mA' | 'µA' | 'nA' | 'Ω' | 'kΩ' | 'MΩ' | '—';
  /** Whether the reading is stale / invalid. */
  stale: boolean;
  /** Time-domain statistics when the probed net has AC content. */
  ac?: ProbeAcStats;
}

/** True if a component is an instrument (doesn't stamp SPICE cards itself). */
export function isInstrument(metadataId: string): boolean {
  return metadataId.startsWith('instr-');
}

function formatV(v: number): { value: number; unit: ProbeReading['unit']; display: string } {
  const abs = Math.abs(v);
  if (abs < 1e-6) return { value: v * 1e6, unit: 'µV', display: `${(v * 1e6).toFixed(2)} µV` };
  if (abs < 1) return { value: v * 1e3, unit: 'mV', display: `${(v * 1e3).toFixed(2)} mV` };
  return { value: v, unit: 'V', display: `${v.toFixed(3)} V` };
}

function formatI(i: number): { value: number; unit: ProbeReading['unit']; display: string } {
  const abs = Math.abs(i);
  if (abs < 1e-9) return { value: 0, unit: 'nA', display: `0 nA` };
  if (abs < 1e-6) return { value: i * 1e9, unit: 'nA', display: `${(i * 1e9).toFixed(1)} nA` };
  if (abs < 1e-3) return { value: i * 1e6, unit: 'µA', display: `${(i * 1e6).toFixed(2)} µA` };
  if (abs < 1) return { value: i * 1e3, unit: 'mA', display: `${(i * 1e3).toFixed(2)} mA` };
  return { value: i, unit: 'A', display: `${i.toFixed(3)} A` };
}

/**
 * Build a pin → net lookup identical to what NetlistBuilder uses. Used by
 * probe readings so we can map `voltmeter:Vin` / `voltmeter:Vout` etc. to
 * actual net names in the solve result.
 */
export function buildPinNetLookup(
  wires: Wire[],
  groundPins: Array<{ componentId: string; pinName: string }>,
  vccPins: Array<{ componentId: string; pinName: string }>,
  auxPins: Array<{ componentId: string; pinName: string; volts: number }> = [],
): (componentId: string, pinName: string) => string | null {
  const uf = new UnionFind();
  for (const w of wires) {
    const a = `${w.start.componentId}:${w.start.pinName}`;
    const b = `${w.end.componentId}:${w.end.pinName}`;
    uf.union(a, b);
  }
  // Mirror NetlistBuilder step 2: ANY pin named like a ground / supply pin
  // anchors its net, not just the board's. A board-less circuit (9 V cell ->
  // 7805 -> divider) has no entry in `groundPins` at all, and its return net
  // is pinned to "0" solely by the regulator's GND pin. Skipping that here
  // shifted every auto-generated name by one (n0/n1/n2 vs the solver's
  // 0/n0/n1) and the probe read two unrelated nodes.
  // Instrument terminals ("V+", "V-", "A+", "A-") are excluded by the regexes
  // themselves, matching NetlistBuilder's skipCanonicalization().
  for (const w of wires) {
    for (const endpoint of [w.start, w.end]) {
      const key = `${endpoint.componentId}:${endpoint.pinName}`;
      if (GROUND_PIN_RE.test(endpoint.pinName)) uf.setCanonical(key, '0');
      else if (VCC_PIN_RE.test(endpoint.pinName)) uf.setCanonical(key, 'vcc_rail');
    }
  }
  for (const g of groundPins) uf.setCanonical(`${g.componentId}:${g.pinName}`, '0');
  for (const v of vccPins) uf.setCanonical(`${v.componentId}:${v.pinName}`, 'vcc_rail');
  for (const a of auxPins) {
    uf.setCanonical(`${a.componentId}:${a.pinName}`, auxRailNetName(a.volts));
  }
  // Build deterministic net names matching NetlistBuilder's scheme (n0, n1, …)
  const reps = [...uf.nets()].sort();
  const netNames = new Map<string, string>();
  let counter = 0;
  for (const rep of reps) {
    if (rep === '0' || rep === 'vcc_rail' || isAuxRailNet(rep)) netNames.set(rep, rep);
    else netNames.set(rep, `n${counter++}`);
  }
  return (componentId, pinName) => {
    const key = `${componentId}:${pinName}`;
    if (!uf.has(key)) return null;
    return netNames.get(uf.find(key)) ?? null;
  };
}

function buildAcStatsV(samples: readonly number[]): ProbeAcStats {
  const r = rms(samples);
  const dc = mean(samples);
  const pk = peak(samples);
  const rmsFmt = formatV(r);
  const dcFmt = formatV(dc);
  const pkFmt = formatV(pk);
  return {
    rms: r,
    dc,
    peak: pk,
    rmsDisplay: `RMS ${rmsFmt.display}`,
    peakDisplay: `pk ${pkFmt.display}`,
    dcDisplay: `DC ${dcFmt.display}`,
  };
}

function buildAcStatsI(samples: readonly number[]): ProbeAcStats {
  const r = rms(samples);
  const dc = mean(samples);
  const pk = peak(samples);
  const rmsFmt = formatI(r);
  const dcFmt = formatI(dc);
  const pkFmt = formatI(pk);
  return {
    rms: r,
    dc,
    peak: pk,
    rmsDisplay: `RMS ${rmsFmt.display}`,
    peakDisplay: `pk ${pkFmt.display}`,
    dcDisplay: `DC ${dcFmt.display}`,
  };
}

export function readVoltmeter(
  comp: ComponentForSpice,
  netLookup: (componentId: string, pinName: string) => string | null,
  solve: ElectricalSolveResult,
  timeWaveforms?: TimeWaveforms,
): ProbeReading {
  const plusNet = netLookup(comp.id, 'V+');
  const minusNet = netLookup(comp.id, 'V-');
  if (!plusNet || !minusNet) {
    return {
      kind: 'voltmeter',
      value: 0,
      unit: '—',
      display: '— probe not connected',
      stale: true,
    };
  }
  const vp = solve.nodeVoltages[plusNet] ?? 0;
  const vm = solve.nodeVoltages[minusNet] ?? 0;
  const diff = vp - vm;
  const fmt = formatV(diff);

  let ac: ProbeAcStats | undefined;
  if (timeWaveforms) {
    const plusSamples = timeWaveforms.nodes.get(plusNet);
    const minusSamples = plusNet === '0' ? undefined : timeWaveforms.nodes.get(minusNet);
    const plusArr = plusSamples ?? (plusNet === '0' ? [] : undefined);
    const minusArr = minusSamples ?? (minusNet === '0' ? [] : undefined);
    if (plusArr !== undefined && minusArr !== undefined) {
      // subtract() tolerates a zero-length array and returns []; guard with a length check.
      const diffSamples =
        plusArr.length === 0
          ? minusArr.map((v) => -v)
          : minusArr.length === 0
            ? [...plusArr]
            : subtract(plusArr, minusArr);
      if (diffSamples.length > 0 && isAC(diffSamples)) {
        ac = buildAcStatsV(diffSamples);
      }
    }
  }

  return {
    kind: 'voltmeter',
    value: fmt.value,
    unit: fmt.unit,
    display: ac ? ac.rmsDisplay : fmt.display,
    stale: !solve.converged,
    ac,
  };
}

export function readAmmeter(
  comp: ComponentForSpice,
  solve: ElectricalSolveResult,
  timeWaveforms?: TimeWaveforms,
): ProbeReading {
  const key = `v_${comp.id}_sense`;
  const i = solve.branchCurrents[key];
  if (i == null) {
    return { kind: 'ammeter', value: 0, unit: '—', display: '— no sense reading', stale: true };
  }
  // Sign convention: like a bench DMM with the red lead on A+, a positive
  // reading means current ENTERS the A+ terminal. That is already ngspice's
  // sign for `V_<id>_sense A+ mid` (current flowing in at the source's +
  // node and out at its − node is positive), so the raw value passes
  // through. Negating it here made the ordinary series wiring
  // (source -> A+ -> load -> A-) display a negative current.
  const signed = i;
  const fmt = formatI(signed);

  let ac: ProbeAcStats | undefined;
  if (timeWaveforms) {
    const raw = timeWaveforms.branches.get(key);
    if (raw && raw.length > 0 && isAC(raw)) {
      ac = buildAcStatsI(raw);
    }
  }

  return {
    kind: 'ammeter',
    value: fmt.value,
    unit: fmt.unit,
    display: ac ? ac.rmsDisplay : fmt.display,
    stale: !solve.converged,
    ac,
  };
}
