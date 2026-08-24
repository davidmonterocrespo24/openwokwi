/**
 * collectPinStates — read MCU output pin states from each board's
 * PinManager for pins that are referenced by a wire.
 *
 * Domain helper used by `CircuitSimulationService` to populate
 * `BoardForSpice.pins` at solve time.  Lives in its own module so
 * the service doesn't depend on (and the legacy `subscribeToStore`
 * doesn't own) the per-board pin-number mapping.
 */
import { getBoardPinManager } from '../../store/useSimulatorStore';
import type { PinSourceState } from './types';
import type { BoardKind } from '../../types/board';
import { isStm32BoardKind } from '../../types/board';
import { stm32PinNameToLinear } from '../Stm32Bridge';
import { BOARD_PIN_GROUPS } from './boardPinGroups';
import { boardPinToNumber } from '../../utils/boardPinMapping';

/**
 * Convert a board pin name (e.g. "9", "A0", "GP26", "GPIO32") to the
 * Arduino-style pin number that PinManager uses internally.
 * Returns -1 if the name doesn't map to a GPIO pin.
 *
 * Exported so connectMcuEdgesToService can subscribe its MCU-edge
 * listeners under the SAME name→pin mapping the netlist collector uses —
 * a reverse mapping that disagrees (e.g. "GPIO2" vs the wire's "2")
 * detaches every listener on resubscription and freezes LEDs mid-run.
 */
export function pinNameToArduinoPin(pinName: string, boardKind: BoardKind): number {
  const group = BOARD_PIN_GROUPS[boardKind] ?? BOARD_PIN_GROUPS.default;
  if (group.gnd.includes(pinName) || group.vcc_pins.includes(pinName)) return -1;
  // Aux-rail supply pins (VIN / 5V / off-voltage 3V3) are not GPIOs either.
  if (group.aux?.pins.includes(pinName)) return -1;
  // Single source of truth: utils/boardPinMapping knows every family's
  // silkscreen->GPIO map (nano-esp32 D2->GPIO5, xiao D-pins, STM32
  // PC13->linear 45, Pico GP*, ...). This function used to be a parallel
  // half-implementation: 'PC13'/'D2' fell through to -1, so STM32 outputs
  // never got a V source stamped (LED dark with correct firmware, lianqi
  // 07-23) and nano-esp32 INPUT_PULLUP pins never got their pull resistor
  // (dead START button, prabkagi 07-21 — 2026-07 emulation-gaps audit).
  const n = boardPinToNumber(boardKind, pinName);
  if (n != null) return n;
  // Fallbacks for names boardPinToNumber doesn't know (older saved
  // projects / generic boards): GPIO before GP so 'GPIO32' never parses
  // as 'IO32'; A<n> uses the AVR convention; ATtiny85 PB<n> is identity.
  if (pinName.startsWith('GPIO')) {
    const g = parseInt(pinName.slice(4), 10);
    return Number.isFinite(g) ? g : -1;
  }
  if (pinName.startsWith('GP')) {
    const g = parseInt(pinName.slice(2), 10);
    return Number.isFinite(g) ? g : -1;
  }
  if (/^A\d+$/.test(pinName)) {
    return 14 + parseInt(pinName.slice(1), 10);
  }
  if (/^PB\d+$/.test(pinName)) {
    return parseInt(pinName.slice(2), 10);
  }
  // micro:bit-style pad names (P0..P25) used by QEMU-Linux SBC edges and
  // Gravity ports (e.g. the UNIHIKER's P24). Must come after the PB test.
  if (/^P\d+$/.test(pinName)) {
    return parseInt(pinName.slice(1), 10);
  }
  if (/^\d+$/.test(pinName)) {
    return parseInt(pinName, 10);
  }
  return -1;
}

/**
 * Build the `pinStates` field for a board going into the
 * NetlistBuilder.  Iterates pins that any wire references for this
 * board, asks PinManager for the current digital / PWM value, and
 * shapes it into the SPICE-side PinSourceState union.
 *
 * MCU output pins not in any wire are skipped — the netlist doesn't
 * need a V source for an unconnected pin.
 */
export function collectPinStates(
  boardId: string,
  boardKind: BoardKind,
  wires: Array<{
    start: { componentId: string; pinName: string };
    end: { componentId: string; pinName: string };
  }>,
): Record<string, PinSourceState> {
  const pm = getBoardPinManager(boardId);
  if (!pm) return {};
  const group = BOARD_PIN_GROUPS[boardKind] ?? BOARD_PIN_GROUPS.default;
  const vcc = group.vcc;

  const result: Record<string, PinSourceState> = {};
  const pinNames = new Set<string>();
  for (const w of wires) {
    if (w.start.componentId === boardId) pinNames.add(w.start.pinName);
    if (w.end.componentId === boardId) pinNames.add(w.end.pinName);
  }

  const outputPins = pm.getOutputPins();

  // STM32 names pins PA0/PC13 and keys its PinManager on the linear pin
  // (port*16+pin). It runs in backend QEMU; the worker streams gpio_change
  // for outputs and gpio_pull for inputs. Outputs were historically LEFT OUT
  // of the netlist ("the part layer will render them") — but the part layer
  // never drove wired parts, so a correctly-wired LED sat at ~0 A forever
  // (lianqi 07-23, emulation-gaps F3). Now that the name mapping is right,
  // stamp outputs as V sources exactly like every other board; inputs still
  // contribute only their internal pull.
  const isStm32 = isStm32BoardKind(boardKind);
  if (isStm32) {
    for (const pinName of pinNames) {
      const linear = stm32PinNameToLinear(pinName);
      if (linear < 0) continue;
      if (outputPins.has(linear)) {
        result[pinName] = {
          type: 'digital',
          v: pm.getPinState(linear) ? vcc : 0,
        };
      } else {
        const pull = pm.getPinPull(linear);
        if (pull !== 0) result[pinName] = { type: 'input', pull };
      }
    }
    return result;
  }

  for (const pinName of pinNames) {
    const arduinoPin = pinNameToArduinoPin(pinName, boardKind);
    if (arduinoPin < 0) continue;
    const pwmDuty = pm.getPwmValue(arduinoPin);
    if (pwmDuty > 0) {
      result[pinName] = { type: 'pwm', duty: pwmDuty };
      continue;
    }
    if (outputPins.has(arduinoPin)) {
      // The MCU has actually driven this pin at least once
      // (digitalWrite / PWM / port-listener fire), so emit a V-source
      // for NetlistBuilder.  MixedModeScheduler.onMcuPinChange will
      // alterSource() on each subsequent edge; the V-source needs to
      // exist in the netlist for the alter to bind (otherwise it's a
      // silent no-op and the LED never updates).
      result[pinName] = {
        type: 'digital',
        v: pm.getPinState(arduinoPin) ? vcc : 0,
      };
    } else {
      // Not driven by the MCU. If the firmware enabled an internal pull
      // (INPUT_PULLUP / INPUT_PULLDOWN), surface it so NetlistBuilder can
      // stamp the weak resistor — without it a button-to-GND input floats
      // to 0 V and reads LOW even at idle, so active-low buttons never work.
      // For pull-less inputs leave the net free: external components (sensor
      // divider, pull-up, button, etc.) drive the SPICE node, and an
      // unconditional 0 V source would short out any analog sensor on the pin.
      const pull = pm.getPinPull(arduinoPin);
      if (pull !== 0) result[pinName] = { type: 'input', pull };
    }
  }
  return result;
}
