/**
 * NetlistBuilder — turn a Velxio circuit (components + wires + board pin
 * state) into a complete ngspice netlist string.
 *
 * Algorithm (see plan phase_8_velxio_implementation §5):
 *   1. Union-Find on wires to identify nets.
 *   2. Canonicalize known-special nets: GND → "0", VCC/VDD/5V/3V3 → "vcc_rail".
 *   3. Auto-name remaining nets "n0", "n1", ... deterministically.
 *   4. Detect floating nodes (no DC path to 0) → add auto pull-down 100 MΩ.
 *   5. Emit component cards via `componentToSpice`.
 *   6. Emit board GPIO source cards (digital or PWM quasi-static).
 *   7. Emit the Vcc rail source.
 *   8. Append `.model` / `.subckt` cards for every used device.
 *   9. Append analysis card (`.op` / `.tran` / `.ac`).
 *  10. `.end`.
 */
import { UnionFind } from './unionFind';
import { componentToSpice } from './componentToSpice';
import type { BuildNetlistInput, ComponentForSpice, BoardForSpice, WireForSpice } from './types';

const GROUND_PIN_RE = /^(gnd|vss|vee|ground|gnd\.\d+)$/i;
// Deliberately excludes "V+" / "V-" (which are probe terminals) and
// "VBB" (non-standard). VCC-like pins on boards are handled via the
// board.vccPinNames list, not this regex.
const VCC_PIN_RE = /^(vcc|vdd|vcc_rail|5v|3v3|3\.3v)$/i;

/** metadataId prefixes of components that must NOT be auto-canonicalized
 *  by the pin-name regex (their pins are just probe labels). */
function skipCanonicalization(metadataId: string): boolean {
  return metadataId.startsWith('instr-');
}

/**
 * Sanitize a component / board / pin id for use inside a SPICE identifier
 * (V-source name, etc.). ngspice's interactive `alter` command treats `-`
 * as an arithmetic / range operator and silently no-ops on hyphenated
 * source names — so even though the netlist *parser* tolerates hyphens
 * via the regex on line 206, mid-simulation MCU pin transitions stop
 * propagating after the first solve. Substituting `-` → `_` here keeps
 * the identifier ngspice-safe AND consistent with whatever the scheduler
 * passes to `alter`. Must be reused by MixedModeScheduler when building
 * the alter target name.
 */
export function sanitizeSpiceId(id: string): string {
  return id.replace(/-/g, '_');
}

export interface BuildNetlistResult {
  netlist: string;
  /** "boardId:pinName" → SPICE net name, from the same UF used to build the netlist. */
  pinNetMap: Map<string, string>;
  /**
   * Every SPICE net name in the circuit except canonical "0" (ground).
   * Includes `vcc_rail` plus all auto-named nets (n0, n1, ...).  Used
   * by CircuitSimulationService to ask the solver for every node
   * voltage in one shot (vectorsOfInterest).
   */
  nets: string[];
  /**
   * Every voltage source name in the circuit (without the leading
   * `V` prefix is NOT how ngspice names them — they include the V).
   * Examples: `V_VCC_RAIL`, `V_uno_9`, `V_led1_sense`. Used to
   * request branch currents (`i(v_<name>)`).
   */
  voltageSources: string[];
}

export function buildNetlist(input: BuildNetlistInput): BuildNetlistResult {
  const { components, wires, boards, analysis, extraCards = [] } = input;

  // ── 1. Union-Find over wires ─────────────────────────────────────────────
  const uf = new UnionFind();
  const pinKey = (componentId: string, pinName: string) => `${componentId}:${pinName}`;

  // Seed every pin referenced by a wire (components pins are added on demand).
  // Phase 4: when a wire has `length_cm` set, its endpoints stay in separate
  // nets and a R_wire_<id> card is emitted later (step 7).
  const resistiveWires: typeof wires = [];
  for (const w of wires) {
    const a = pinKey(w.start.componentId, w.start.pinName);
    const b = pinKey(w.end.componentId, w.end.pinName);
    uf.add(a);
    uf.add(b);
    if (w.length_cm !== undefined && w.length_cm > 0) {
      resistiveWires.push(w);
    } else {
      uf.union(a, b);
    }
  }

  // ── 2. Canonicalize ground / VCC pins ────────────────────────────────────
  for (const board of boards) {
    for (const [pinName, target] of Object.entries(board.pinTargets)) {
      const key = pinKey(board.id, pinName);
      if (target.toUpperCase() === 'GND') {
        uf.setCanonical(key, '0');
      } else if (target.toLowerCase().startsWith('power')) {
        uf.setCanonical(key, 'vcc_rail');
      }
    }
    // Fallback: any board pin a wire references whose name looks like a
    // ground pin (GND, GND.1, GND.9, etc.) is canonicalized to "0" even if
    // it's not in `groundPinNames`. Boards with many GND pins (ESP32-C3
    // dev kits ship up to 10) often miss some in the per-board list, which
    // would leave wires connected to those pins floating instead of grounded.
    for (const pinName of pinsReferencedByWires(board.id, wires)) {
      if (GROUND_PIN_RE.test(pinName)) {
        uf.setCanonical(pinKey(board.id, pinName), '0');
      } else if (VCC_PIN_RE.test(pinName)) {
        uf.setCanonical(pinKey(board.id, pinName), 'vcc_rail');
      }
    }
  }
  for (const comp of components) {
    if (skipCanonicalization(comp.metadataId)) continue;
    for (const pinName of pinsReferencedByWires(comp.id, wires)) {
      if (GROUND_PIN_RE.test(pinName)) {
        uf.setCanonical(pinKey(comp.id, pinName), '0');
      } else if (VCC_PIN_RE.test(pinName)) {
        uf.setCanonical(pinKey(comp.id, pinName), 'vcc_rail');
      }
    }
  }

  // ── 3. Auto-name remaining nets deterministically ────────────────────────
  const netNames = assignDeterministicNetNames(uf);

  // Helper: pin → net name (null if pin isn't in any net)
  function netLookup(componentId: string, pinName: string): string | null {
    const key = pinKey(componentId, pinName);
    if (!uf.has(key)) return null;
    return netNames.get(uf.find(key)) ?? null;
  }

  // ── 4. Emit component cards ───────────────────────────────────────────────
  const cards: string[] = [];
  const modelLines = new Set<string>();
  const dominantVcc = boards[0]?.vcc ?? 5;

  for (const comp of components) {
    const localLookup = (pinName: string) => netLookup(comp.id, pinName);
    const emission = componentToSpice(comp, localLookup, { vcc: dominantVcc });
    if (!emission) continue;
    cards.push(...emission.cards);
    for (const m of emission.modelsUsed) modelLines.add(m);
  }

  // ── 5. Board GPIO sources ─────────────────────────────────────────────────
  // Hyphens are kept in the V-source name (NetlistBuilder regex on line 206
  // captures `[_\w-]*`), so ngspice itself can parse + load the source and
  // expose the branch current as `v_<board>-<pin>#branch` — visible in the
  // canvas voltmeters / branch-current map. BUT ngspice's *interactive*
  // `alter` command treats `-` as an operator and silently no-ops on
  // hyphenated source names — making MCU pin transitions stop propagating
  // after the very first solve. So MixedModeScheduler.onMcuPinChange must
  // build the same sanitized name we emit here. See sanitizeSpiceId().
  for (const board of boards) {
    for (const [pinName, state] of Object.entries(board.pins)) {
      if (state.type === 'input') continue; // don't drive the pin
      const net = netLookup(board.id, pinName);
      if (!net) continue;
      if (net === '0' || net === 'vcc_rail') continue; // already served
      const v = state.type === 'digital' ? state.v : state.duty * board.vcc;
      cards.push(`V_${sanitizeSpiceId(board.id)}_${sanitizeSpiceId(pinName)} ${net} 0 DC ${v}`);
    }
  }

  // ── 6. Vcc rail source (if any pin referenced it) ─────────────────────────
  if (hasNet(netNames, 'vcc_rail')) {
    cards.unshift(`V_VCC_RAIL vcc_rail 0 DC ${dominantVcc}`);
  }

  // ── 6.5. Wire resistance (Phase 4) ───────────────────────────────────────
  // Wires marked with length_cm get a resistor between their endpoint nets.
  // R = 0.01 ohm/cm — order-of-magnitude correct for AWG 22 copper hookup
  // wire — enough to show voltage drop on long buses without dominating
  // ordinary circuit behaviour.  Emitted before pull-down detection so the
  // resistors count as DC paths between their endpoints.
  for (const w of resistiveWires) {
    const cm = w.length_cm ?? 0;
    if (cm <= 0) continue;
    const ohms = Math.max(0.01, 0.01 * cm);
    const a = netLookup(w.start.componentId, w.start.pinName);
    const b = netLookup(w.end.componentId, w.end.pinName);
    if (!a || !b) continue;
    cards.push(`R_wire_${w.id} ${a} ${b} ${ohms}`);
  }

  // ── 7. Auto pull-downs for floating nets ─────────────────────────────────
  const floating = detectFloatingNets(netNames, cards);
  for (const net of floating) {
    cards.push(`R_autopull_${net} ${net} 0 100Meg`);
  }

  // ── 8. Compose netlist ────────────────────────────────────────────────────
  const lines: string[] = [`* Velxio circuit @ ${new Date().toISOString()}`];
  lines.push(...cards);
  lines.push(...modelLines);
  lines.push(...extraCards);

  switch (analysis.kind) {
    case 'op':
      lines.push('.op');
      break;
    case 'tran':
      lines.push(`.tran ${analysis.step} ${analysis.stop}`);
      break;
    case 'ac': {
      const kind = analysis.type ?? 'dec';
      const points = analysis.points ?? 20;
      const fstart = analysis.fstart ?? 1;
      const fstop = analysis.fstop ?? 1e6;
      lines.push(`.ac ${kind} ${points} ${fstart} ${fstop}`);
      break;
    }
  }
  lines.push('.end');

  // ── 9. Build (component|board) pin → net map from the same UF ────────────
  // Every wire endpoint is in the UF. Including component-pin entries (not
  // just board pins) lets the MixedModeScheduler bridge route SPICE voltages
  // to component subscribers downstream of active devices. Legacy ADC
  // injection still works — it only looks up board-prefixed keys.
  const pinNetMap = new Map<string, string>();
  for (const w of wires) {
    for (const endpoint of [w.start, w.end]) {
      const key = pinKey(endpoint.componentId, endpoint.pinName);
      if (!uf.has(key)) continue;
      const netName = netNames.get(uf.find(key));
      if (netName) pinNetMap.set(key, netName);
    }
  }

  // ── 10. Enumerate every net + voltage source for the solve options ───────
  // Distinct, non-ground nets — every node the solver should report.
  const nets = Array.from(new Set(netNames.values())).filter((n) => n !== '0');
  // Voltage sources are any card starting with `V` (uppercase) followed
  // by an underscore or digit.  ngspice's case-insensitive match means
  // both `Vname` and `vname` count.  We emit only uppercase prefixes
  // from componentToSpice + NetlistBuilder, so this regex is safe.
  //
  // The character class MUST include `-` (hyphen). Component ids in
  // examples and user-drawn circuits commonly contain hyphens
  // (`led-builtin`, `led-red`, auto-generated `led-1717…-abc`), and
  // SPICE itself happily parses identifiers with hyphens. If the regex
  // doesn't accept them it truncates the captured name at the first
  // hyphen ⇒ wrong voltageSources entry ⇒ CircuitSimulationService
  // asks ngspice for the WRONG branch-current vector ⇒ branchCurrents
  // lookup returns undefined ⇒ LED brightness stays at zero even though
  // the circuit conducts correctly. Single-character fix, but it
  // unblocks every hyphenated id across every existing project.
  const voltageSources: string[] = [];
  for (const card of cards) {
    const m = card.match(/^([Vv][_\w-]*)\s/);
    if (m) voltageSources.push(m[1]);
  }

  return {
    netlist: lines.join('\n'),
    pinNetMap,
    nets,
    voltageSources,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function pinsReferencedByWires(componentId: string, wires: WireForSpice[]): string[] {
  const pins = new Set<string>();
  for (const w of wires) {
    if (w.start.componentId === componentId) pins.add(w.start.pinName);
    if (w.end.componentId === componentId) pins.add(w.end.pinName);
  }
  return [...pins];
}

function assignDeterministicNetNames(uf: UnionFind): Map<string, string> {
  const reps = [...uf.nets()].sort();
  const out = new Map<string, string>();
  let counter = 0;
  for (const rep of reps) {
    if (rep === '0' || rep === 'vcc_rail') {
      out.set(rep, rep);
    } else {
      // Strip characters ngspice doesn't like from auto-names
      out.set(rep, `n${counter++}`);
    }
  }
  return out;
}

function hasNet(netNames: Map<string, string>, name: string): boolean {
  for (const v of netNames.values()) if (v === name) return true;
  return false;
}

/**
 * Detect nets that lack a DC path to ground.
 *
 * Does a graph walk starting from node "0" and "vcc_rail" (both have a
 * hard-wired source in every circuit that references them), traversing only
 * DC-conducting cards:
 *   - resistor (R...)
 *   - voltage source (V...)           — V-source is a DC short for connectivity
 *   - current source (I...)
 *   - inductor (L... — treated as DC short)
 *   - switch (S...)
 *   - behavioral source (B...)         — also connects output to ground via its KCL stamp
 *   - MNA-controlled source (E..., G..., F..., H...)
 *   - subckt instance (X...)           — optimistic: assume any X instance exposes DC paths
 *
 * Capacitors (C...) are intentionally NOT conductive in this walk — they are
 * OPEN at DC, so a net connected only via a C to another node is still floating.
 *
 * An older version of this function used a "touched-by-R" heuristic: a net
 * was marked safe if ANY resistor terminal referenced it. That was wrong for
 * topologies like `V0-R1-n0-R2-n1-C-0` where n0 and n1 are chained through
 * R's but neither has a DC path to ground (shipping RC-low-pass example).
 * The graph walk fixes that — it only considers a net safe when a DC path
 * actually traces back to node "0".
 *
 * Returns the set of nets that should receive an auto 100 MΩ pull-down.
 */
function detectFloatingNets(netNames: Map<string, string>, cards: string[]): Set<string> {
  const nets = new Set(netNames.values());

  // Build an undirected adjacency list over DC-conducting elements.
  // For a 2-terminal element the two nets on it become connected.
  // For 3+ terminal (E/G/F/H, S, X) we connect every pair of listed nets —
  // this is conservative (over-connects), which is the safe side for a
  // "does this net have SOME DC path to ground" question.
  const adj = new Map<string, Set<string>>();
  function ensure(n: string) {
    if (!adj.has(n)) adj.set(n, new Set());
    return adj.get(n)!;
  }
  function link(a: string, b: string) {
    if (a === b) return;
    ensure(a).add(b);
    ensure(b).add(a);
  }

  // Cards that define a DC path between their listed nets. Capacitor ('C')
  // is deliberately excluded.
  const DC_PREFIXES = 'RLVISBEGFHX';

  for (const line of cards) {
    const prefix = line[0];
    if (DC_PREFIXES.indexOf(prefix) < 0) continue;
    const tokens = line.split(/\s+/);
    // tokens[0] is the element name (e.g. "R_r1", "V_VCC_RAIL"). The nets
    // appear next; stop at the first token that isn't a valid net name.
    const pinNets: string[] = [];
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (!nets.has(t) && t !== '0' && t !== 'vcc_rail') break;
      pinNets.push(t);
    }
    // Connect every pair of pins — handles both 2-terminal and N-terminal.
    for (let i = 0; i < pinNets.length; i++) {
      for (let j = i + 1; j < pinNets.length; j++) {
        link(pinNets[i], pinNets[j]);
      }
    }
  }

  // BFS from node "0" (and "vcc_rail", which always has V_VCC_RAIL → 0 edge).
  const reachable = new Set<string>();
  const queue: string[] = ['0'];
  if (adj.has('vcc_rail')) queue.push('vcc_rail');
  while (queue.length) {
    const n = queue.shift()!;
    if (reachable.has(n)) continue;
    reachable.add(n);
    const neigh = adj.get(n);
    if (!neigh) continue;
    for (const m of neigh) if (!reachable.has(m)) queue.push(m);
  }

  const floating = new Set<string>();
  for (const net of nets) {
    if (net === '0' || net === 'vcc_rail') continue;
    if (!reachable.has(net)) floating.add(net);
  }
  return floating;
}

/**
 * Build a wireId → netName map using the same Union-Find logic as buildNetlist.
 * Lightweight (no SPICE call) — suitable for the overlay to look up voltages.
 */
export function buildWireNetMap(
  input: Pick<BuildNetlistInput, 'components' | 'wires' | 'boards'>,
): Map<string, string> {
  const { wires, boards, components } = input;
  const uf = new UnionFind();
  const pin = (cId: string, pName: string) => `${cId}:${pName}`;

  for (const w of wires) {
    const a = pin(w.start.componentId, w.start.pinName);
    const b = pin(w.end.componentId, w.end.pinName);
    uf.add(a);
    uf.add(b);
    uf.union(a, b);
  }

  for (const board of boards) {
    for (const [pName, target] of Object.entries(board.pinTargets)) {
      const k = pin(board.id, pName);
      if (target.toUpperCase() === 'GND') uf.setCanonical(k, '0');
      else if (target.toLowerCase().startsWith('power')) uf.setCanonical(k, 'vcc_rail');
    }
  }
  for (const comp of components) {
    if (comp.metadataId.startsWith('instr-')) continue;
    for (const pName of pinsReferencedByWires(comp.id, wires)) {
      if (GROUND_PIN_RE.test(pName)) uf.setCanonical(pin(comp.id, pName), '0');
      else if (VCC_PIN_RE.test(pName)) uf.setCanonical(pin(comp.id, pName), 'vcc_rail');
    }
  }

  const netNames = assignDeterministicNetNames(uf);
  const result = new Map<string, string>();
  for (const w of wires) {
    const key = pin(w.start.componentId, w.start.pinName);
    if (uf.has(key)) {
      const netName = netNames.get(uf.find(key));
      if (netName) result.set(w.id, netName);
    }
  }
  return result;
}

/**
 * Build a map from `"${boardId}:${pinName}"` → SPICE net name for every
 * board pin that participates in the circuit. Used by the ADC injection
 * step in subscribeToStore so it can look up voltages by pin name.
 */
export function buildBoardPinNetMap(
  input: Pick<BuildNetlistInput, 'components' | 'wires' | 'boards'>,
): Map<string, string> {
  const { wires, boards, components } = input;
  const uf = new UnionFind();
  const pin = (cId: string, pName: string) => `${cId}:${pName}`;

  // Collect board IDs for fast lookup
  const boardIds = new Set(boards.map((b) => b.id));

  for (const w of wires) {
    const a = pin(w.start.componentId, w.start.pinName);
    const b = pin(w.end.componentId, w.end.pinName);
    uf.add(a);
    uf.add(b);
    uf.union(a, b);
  }

  // Canonicalize board ground/vcc pins (from boardPinGroups metadata)
  for (const board of boards) {
    for (const [pName, target] of Object.entries(board.pinTargets)) {
      const isGnd = target.toUpperCase() === 'GND';
      const isVcc = target.toLowerCase().startsWith('power');
      if (isGnd || isVcc) {
        const k = pin(board.id, pName);
        uf.add(k);
        uf.setCanonical(k, isGnd ? '0' : 'vcc_rail');
      }
    }
  }
  // Canonicalize non-board component GND/VCC pins referenced by wires
  for (const comp of components) {
    if (comp.metadataId.startsWith('instr-')) continue;
    if (boardIds.has(comp.id)) continue; // board handled above
    for (const pName of pinsReferencedByWires(comp.id, wires)) {
      if (GROUND_PIN_RE.test(pName)) uf.setCanonical(pin(comp.id, pName), '0');
      else if (VCC_PIN_RE.test(pName)) uf.setCanonical(pin(comp.id, pName), 'vcc_rail');
    }
  }

  const netNames = assignDeterministicNetNames(uf);
  const result = new Map<string, string>();

  // For each board, collect ALL pins that appear in wires (via wire endpoints)
  // plus the explicit pinTargets/pins lists.
  for (const board of boards) {
    const wireReferencedPins = pinsReferencedByWires(board.id, wires);
    const allPins = new Set([
      ...Object.keys(board.pinTargets ?? {}),
      ...Object.keys(board.pins ?? {}),
      ...wireReferencedPins, // ← the pins that actually exist in the UF
    ]);
    for (const pName of allPins) {
      const k = pin(board.id, pName);
      if (uf.has(k)) {
        const netName = netNames.get(uf.find(k));
        if (netName) result.set(k, netName);
      }
    }
  }
  return result;
}

/** Re-export types for callers. */
export type { BuildNetlistInput, ComponentForSpice, BoardForSpice, WireForSpice } from './types';
