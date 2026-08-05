/**
 * connectMcuEdgesToService — bridges MCU pin transitions to the
 * CircuitSimulationService, completing the mixed-mode loop.
 *
 * Without this wiring, the service only re-solves on canvas changes —
 * MCU edges propagate via PinManager → component handlers directly,
 * but SPICE never sees them.  This module:
 *
 *   1. Subscribes to each board's PinManager for every pin referenced
 *      by a wire (i.e., pins that appear in the SPICE netlist).
 *   2. Coalesces edges per pin (last-state-wins inside a 16 ms
 *      window) so kHz toggles don't drown the solver.
 *   3. Calls `service.handleMcuEdge(boardId, pinName, state, vcc)`
 *      which alters the corresponding V source + re-resolves +
 *      publishes the new electrical snapshot.
 *
 * Why batching here and not in the service:
 *   - The service is solver-rate (limited by ngspice solve time).
 *   - PinManager events fire at MCU clock rate (16 MHz simulated).
 *   - Throttling at the source matches event rates; throttling at the
 *     service would still queue O(N) edges per ms.
 *
 * Lifecycle: mount alongside the service in EditorPage.  Re-subscribes
 * when boards change (board lifecycle = new PinManager instance).
 */
import {
  useSimulatorStore,
  getBoardPinManager,
} from '../../store/useSimulatorStore';
import { stm32LinearToPinName, stm32PinNameToLinear } from '../Stm32Bridge';
import { isStm32BoardKind, isPiBoardKind } from '../../types/board';
import type { BoardKind } from '../../types/board';
import { useElectricalStore } from '../../store/useElectricalStore';
import { BOARD_PIN_GROUPS } from './boardPinGroups';
import { pinNameToArduinoPin } from './collectPinStates';
import type { CircuitSimulationService } from './CircuitSimulationService';

/** How long edges per pin coalesce.  16 ms ≈ 60 fps, well below any
 *  human-perceptible MCU update rate and above the solver's per-edge
 *  cost (~5-15 ms for typical netlists). */
const COALESCE_WINDOW_MS = 16;

/**
 * Wire MCU pin transitions to the service.  Returns an unsubscribe
 * handle.  Idempotent — calling twice double-subscribes; callers
 * should hold a single instance per editor mount.
 */
export function connectMcuEdgesToService(service: CircuitSimulationService): () => void {
  // Per-board, per-pin subscriptions (Arduino pin number → unsubscribe).
  const boardSubs = new Map<string, Map<number, () => void>>();
  // Pending coalesced state per pin.
  const pending = new Map<string, { state: boolean; vcc: number; pinName: string; timer: ReturnType<typeof setTimeout> | null }>();

  function pinKey(boardId: string, pinName: string): string {
    return `${boardId}|${pinName}`;
  }

  function flushPin(boardId: string, pinName: string): void {
    const key = pinKey(boardId, pinName);
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    void service.handleMcuEdge(boardId, pinName, entry.state, entry.vcc);
  }

  function schedulePin(boardId: string, pinName: string, state: boolean, vcc: number): void {
    const key = pinKey(boardId, pinName);
    const existing = pending.get(key);
    if (existing) {
      existing.state = state; // last-state-wins
      return;
    }
    const timer = setTimeout(() => flushPin(boardId, pinName), COALESCE_WINDOW_MS);
    pending.set(key, { state, vcc, pinName, timer });
  }

  function arduinoPinToName(arduinoPin: number, boardKind: string): string | null {
    // Reverse of pinNameToArduinoPin in subscribeToStore.ts.  Both
    // need to live until subscribeToStore is deleted; trade-off
    // accepted for now since the mapping is per-board-family.
    if (boardKind === 'arduino-uno' || boardKind === 'arduino-nano' || boardKind === 'arduino-mega') {
      if (arduinoPin >= 14 && arduinoPin <= 21) return `A${arduinoPin - 14}`;
      return String(arduinoPin);
    }
    if (boardKind === 'raspberry-pi-pico' || boardKind === 'pi-pico-w') {
      return `GP${arduinoPin}`;
    }
    if (boardKind.startsWith('esp32')) {
      return `GPIO${arduinoPin}`;
    }
    // STM32 wires reference port-style names (PA0 / PC13); its PinManager is
    // keyed on the linear pin index. Without this reverse mapping the MCU-edge
    // listener never attaches ("13" ≠ "PC13") — previously masked because
    // PinManager requested a full re-solve on EVERY mcu edge; now that the
    // full tick only fires on first classification, this fine-grained path
    // must actually cover STM32.
    if (isStm32BoardKind(boardKind)) {
      return stm32LinearToPinName(arduinoPin);
    }
    // Raspberry Pi (Linux boards) wires use GPIO-style names like ESP32.
    if (isPiBoardKind(boardKind)) {
      return `GPIO${arduinoPin}`;
    }
    // ATtiny85 wires reference port-style names (PB0..PB5), matching the
    // netlist pin names from collectPinStates. Without this, the reverse
    // mapping returns "1" instead of "PB1", so the MCU-edge listener is
    // never attached (pin name not in `pinsInCircuit`) and the SPICE
    // V-source is never altered on digitalWrite LOW — the LED latches ON
    // (and analogWrite duty changes never re-solve). See pinNameToArduinoPin.
    if (boardKind === 'attiny85') {
      return `PB${arduinoPin}`;
    }
    return String(arduinoPin);
  }

  /**
   * Look up which pin names this board actually wires into the SPICE
   * netlist.  Reads from `pinNetMap` (populated after each solve) so
   * we subscribe to ~3-8 pins per board instead of all 64.
   *
   * Phase 1d #11: previously we subscribed to every Arduino pin 0..63
   * "since unused listeners are free" — true for AVR (8 pins) but
   * spammy for ESP32 (40+ GPIOs × multiple boards = thousands of
   * dead listeners).  Now scoped to pins the circuit references.
   */
  function pinsInCircuit(boardId: string): Set<string> {
    const { pinNetMap } = useElectricalStore.getState();
    const pins = new Set<string>();
    for (const key of pinNetMap.keys()) {
      const idx = key.indexOf(':');
      if (idx < 0) continue;
      if (key.slice(0, idx) === boardId) pins.add(key.slice(idx + 1));
    }
    return pins;
  }

  function subscribeBoard(boardId: string, boardKind: string): void {
    const pm = getBoardPinManager(boardId);
    if (!pm) return;
    const group = BOARD_PIN_GROUPS[boardKind as keyof typeof BOARD_PIN_GROUPS] ?? BOARD_PIN_GROUPS.default;
    const vcc = group.vcc;

    const pinSubs = new Map<number, () => void>();
    boardSubs.set(boardId, pinSubs);

    const wanted = pinsInCircuit(boardId);

    // Resolve which (pin number, pin name) pairs to listen on.
    //
    // When the netlist has been solved at least once, `wanted` holds the
    // EXACT pin names the wires reference ('2', 'A0', 'GP4', 'PC13', …) —
    // the same names collectPinStates keyed the V-sources on. Map each of
    // those through the SAME name→number function so the listener fires
    // on the right PinManager pin AND `handleMcuEdge` receives the name
    // whose `v_<board>_<name>` source actually exists (fast alterSource
    // path, no per-edge rebuild). The previous approach reversed pin
    // NUMBERS to names instead ('GPIO2' on ESP32) which never matched the
    // wire names, so every resubscription after a mid-run pinNetMap
    // change (e.g. a gpio_pull reported by pure ESP-IDF's gpio_reset_pin)
    // silently detached all MCU-edge listeners and froze LEDs.
    //
    // Before the first solve (`wanted` empty) fall back to the historical
    // 0..63 sweep with the reverse-mapped names.
    const listenPins: Array<{ pin: number; pinName: string }> = [];
    if (wanted.size > 0) {
      const isStm32 = isStm32BoardKind(boardKind);
      for (const pinName of wanted) {
        const pin = isStm32
          ? stm32PinNameToLinear(pinName)
          : pinNameToArduinoPin(pinName, boardKind as BoardKind);
        if (pin < 0) continue;
        listenPins.push({ pin, pinName });
      }
    } else {
      for (let pin = 0; pin < 64; pin++) {
        const pinName = arduinoPinToName(pin, boardKind);
        if (!pinName) continue;
        listenPins.push({ pin, pinName });
      }
    }

    for (const { pin, pinName } of listenPins) {
      const unsub = pm.onPinChange(pin, (_p, state) => {
        // Suppress digital edges when the pin has active PWM. The OCR-based
        // PWM duty is converted to a DC-averaged voltage in NetlistBuilder
        // (`state.duty * board.vcc`), giving smooth analog dimming. If we
        // also let the Timer1/Timer2-driven port toggles fire alterSource,
        // each PWM cycle's HIGH/LOW transition would race with the duty
        // average and force the V-source to bounce between 0 and vcc —
        // making `analogWrite(pin, 128)` look like a binary blink instead
        // of a steady 2.5 V (Fade-LED example regression).
        if (pm.getPwmValue(pin) > 0) return;
        schedulePin(boardId, pinName, state, vcc);
      });
      pinSubs.set(pin, unsub);

      // Re-tick when PWM duty changes so the duty-averaged V-source picks
      // up new analogWrite values. Without this, duty stays whatever it was
      // at first solve and `analogWrite()` in a loop never updates the
      // visible LED. Throttled to ~60 Hz to amortise the netlist-rebuild
      // cost (the firmware ramps brightness every 30 ms in the canonical
      // Fade-LED example, well within this budget).
      let pwmTickPending = false;
      const unsubPwm = pm.onPwmChange(pin, () => {
        if (pwmTickPending) return;
        pwmTickPending = true;
        setTimeout(() => {
          pwmTickPending = false;
          void service.tick();
        }, 16);
      });
      pinSubs.set(pin + 1000, unsubPwm); // key offset to avoid collision
    }
  }

  function unsubscribeBoard(boardId: string): void {
    const pinSubs = boardSubs.get(boardId);
    if (!pinSubs) return;
    for (const unsub of pinSubs.values()) unsub();
    boardSubs.delete(boardId);
  }

  function syncBoardSubscriptions(): void {
    const boards = useSimulatorStore.getState().boards;
    const wanted = new Set(boards.map((b) => b.id));
    for (const id of Array.from(boardSubs.keys())) {
      if (!wanted.has(id)) unsubscribeBoard(id);
    }
    for (const b of boards) {
      if (!boardSubs.has(b.id)) subscribeBoard(b.id, b.boardKind);
    }
  }

  syncBoardSubscriptions();

  const unsubBoards = useSimulatorStore.subscribe((state, prev) => {
    if (state.boards !== prev.boards) syncBoardSubscriptions();
  });

  // Re-subscribe when the pinNetMap changes — a new wire / removed
  // wire might add or drop pins that need listeners.  Drop ALL subs
  // and re-create from the new pinNetMap (cheap: a Map clear and
  // ~10 pm.onPinChange calls).
  const unsubElectrical = useElectricalStore.subscribe((state, prev) => {
    if (state.pinNetMap === prev.pinNetMap) return;
    const boards = useSimulatorStore.getState().boards;
    for (const id of Array.from(boardSubs.keys())) unsubscribeBoard(id);
    for (const b of boards) subscribeBoard(b.id, b.boardKind);
  });

  return () => {
    unsubBoards();
    unsubElectrical();
    for (const pinSubs of boardSubs.values()) {
      for (const unsub of pinSubs.values()) unsub();
    }
    boardSubs.clear();
    for (const entry of pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    pending.clear();
  };
}
