/**
 * partPinOwnership — which board pins a PART drives itself.
 *
 * Some parts are not in the SPICE netlist at all: an HC-SR04 answers a trigger
 * with a timed ECHO pulse, a DHT22 bit-bangs a frame on its DATA line, a rotary
 * encoder and a keypad emit edges from their own event model. They drive those
 * pins by calling the simulator directly, and nothing electrical describes them.
 *
 * connectDigitalInputsToMcu thresholds the SOLVED node voltage into every input
 * pin, and its `sourcedNets` gate was the only thing keeping it off those pins:
 * a net with no real component on it is "unsourced", so a part-managed line was
 * left alone. That gate is wrong as soon as the user wires the part the way real
 * hardware needs it — a pull-up on a DHT22, or the 1k/2k2 divider a 5 V HC-SR04
 * needs to talk to a 3.3 V board. Then the net IS backed by components, solves
 * at whatever the passive network says (~0 V, since nothing models the sensor's
 * output), and the connector pins the line the part is trying to pulse. The
 * sensor answers and the MCU never sees it.
 *
 * So ownership is explicit and board-agnostic: while a part is attached and has
 * driven a pin, that pin is ITS pin, and the SPICE-threshold path leaves it
 * alone — on AVR, RP2040, STM32, ESP32 and every overlay board alike. The
 * in-browser ESP32 engines already had a private version of this rule
 * (SingleWireSensorHub.ownsPin); this is the same rule where every board can
 * reach it.
 *
 * Claims are made implicitly: DynamicComponent hands each part a simulator
 * whose setPinState / schedulePinChange / registerSensor claim the pin they
 * touch, keyed by the component id so a re-attach or an unmount releases
 * exactly what that component took. A part that never drives a pin (a button,
 * an LED — things SPICE models properly) never claims anything and keeps
 * reading the real circuit.
 */

import { isSpiceMapped } from './spice/componentToSpice';

/** boardId -> pin -> set of component ids currently claiming it. */
const claims = new Map<string, Map<number, Set<string>>>();

/** Reverse index so releasing a component is exact and cheap. */
const byOwner = new Map<string, Array<{ boardId: string; pin: number }>>();

/** Record that `ownerId` (a component) drives `pin` on `boardId`. */
export function claimPartPin(boardId: string, pin: number, ownerId: string): void {
  if (!boardId || !Number.isFinite(pin) || pin < 0) return;
  let board = claims.get(boardId);
  if (!board) claims.set(boardId, (board = new Map()));
  let owners = board.get(pin);
  if (!owners) board.set(pin, (owners = new Set()));
  if (owners.has(ownerId)) return;
  owners.add(ownerId);
  const list = byOwner.get(ownerId);
  if (list) list.push({ boardId, pin });
  else byOwner.set(ownerId, [{ boardId, pin }]);
}

/** Drop every claim made by one component (unmount, re-attach, rewire). */
export function releasePartPins(ownerId: string): void {
  const list = byOwner.get(ownerId);
  if (!list) return;
  byOwner.delete(ownerId);
  for (const { boardId, pin } of list) {
    const board = claims.get(boardId);
    const owners = board?.get(pin);
    if (!owners) continue;
    owners.delete(ownerId);
    if (owners.size === 0) board!.delete(pin);
    if (board!.size === 0) claims.delete(boardId);
  }
}

/** True when a part drives this pin itself, so no other layer should. */
export function isPartOwnedPin(boardId: string, pin: number): boolean {
  return !!claims.get(boardId)?.has(pin);
}

/** Test/reset seam — also used when the whole workspace is replaced. */
export function clearPartPinOwnership(): void {
  claims.clear();
  byOwner.clear();
}

/**
 * Wrap the simulator handed to a part so every pin it drives is claimed for
 * `ownerId`. Kept as a Proxy rather than a copy because parts reach deep into
 * the object (`pinManager`, the lazy `spi` getter, `registerSensor`, board
 * specific extras) and those must keep their own `this`.
 *
 * `registerSensor(type, pin, props)` counts as driving: the sensor protocol
 * then runs in the backend QEMU worker (or an in-browser engine's sensor hub)
 * and owns both its data pin and any extra pin the props name — `echo_pin` for
 * an HC-SR04, which is exactly the line the divider report was about.
 */
export function withPartPinOwnership<T extends object | null>(
  sim: T,
  boardId: string | null,
  ownerId: string,
  metadataId: string,
): T {
  // The rule lives HERE so no caller can forget half of it: a component the
  // netlist can describe does NOT get to own its pins. A button, a slide
  // switch, a pot are all in SPICE — the solved circuit is the truth for them,
  // which is the whole point of spiceDrivenInputs (a mis-wired button must
  // read stuck, not "work anyway"). Ownership is for the parts SPICE says
  // nothing about: the sensors, the encoders, the keypads, whose only model is
  // their own event code. The day one of them gets a mapper, it stops claiming
  // and the circuit takes over, with nothing to update here.
  if (!sim || !boardId || isSpiceMapped(metadataId)) return sim;
  const claim = (pin: unknown) => {
    if (typeof pin === 'number') claimPartPin(boardId, pin, ownerId);
  };
  return new Proxy(sim as object, {
    get(target, prop, _recv) {
      // The receiver is the TARGET on purpose: lazy getters (`spi`) memoise on
      // the real object, and methods must not see the proxy as `this`.
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop === 'setPinState' || prop === 'schedulePinChange') {
        return (pin: number, ...rest: unknown[]) => {
          claim(pin);
          return (value as (...a: unknown[]) => unknown).call(target, pin, ...rest);
        };
      }
      if (prop === 'registerSensor') {
        return (type: string, pin: number, props?: Record<string, unknown>) => {
          claim(pin);
          for (const [k, v] of Object.entries(props ?? {})) {
            if (k.endsWith('_pin') || k.endsWith('Pin')) claim(v);
          }
          return (value as (...a: unknown[]) => unknown).call(target, type, pin, props);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  }) as T;
}
