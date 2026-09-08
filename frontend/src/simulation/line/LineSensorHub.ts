/**
 * LineSensorHub — hosts line-owning sensor models on one board.
 *
 * One instance per simulator that declares `mode: 'local'`. It is the whole of
 * the generic half: it turns a sensor record into a model, listens to the pad
 * events the model asked for, hands the frames the model returns to the
 * board's timeline, keeps the model's pins at rest between exchanges, and
 * answers the two questions the rest of the board asks — does anything own
 * this pad, and may the clock skip right now. It never dispatches on a
 * sensor's name.
 *
 * Usage from a simulator:
 *   const hub = new LineSensorHub(port);           // port: LineHostPort
 *   hub.attach({ sensor_type: 'dht22', pin: 4, temperature: 21 });
 *   // in the time-skipping path, while the guest is executing:
 *   const allowed = hub.skipBudget(want, port.now());
 *   // on reboot:
 *   hub.reset();
 */

import { LineTimeline } from './LineTimeline';
import type { LineHostPort } from './LineHost';
import './models';
import {
  createLineModel,
  type LineClock,
  type LineModel,
  type LineSensorRecord,
} from './lineModels';

interface Attached {
  rec: LineSensorRecord;
  model: LineModel;
  unsubscribe: Array<() => void>;
}

export class LineSensorHub {
  readonly timeline: LineTimeline;
  private readonly port: LineHostPort;
  private readonly clock: LineClock;
  /** Keyed by the record's `pin` (the data or trigger pin), like the wire protocol. */
  private readonly attached = new Map<number, Attached>();

  constructor(port: LineHostPort) {
    this.port = port;
    this.timeline = new LineTimeline(port);
    this.clock = {
      now: () => port.now(),
      us: (n) => Math.round((n * port.clockHz()) / 1_000_000),
    };
  }

  /** Number of attached sensors. */
  get size(): number {
    return this.attached.size;
  }

  /**
   * Attach a sensor. Returns false when no model is registered for its
   * `sensor_type` — the caller reports that; nothing is attached silently. A
   * record on a pin that already has a sensor replaces it.
   */
  attach(rec: LineSensorRecord): boolean {
    const model = createLineModel(rec);
    if (!model) return false;
    this.detach(rec.pin);
    const unsubscribe = model.listens.map((pin) =>
      this.port.onPad(pin, (e) => {
        const frame = model.onPad(e, this.clock);
        if (frame) this.timeline.emit(frame, this.clock.now());
      }),
    );
    this.attached.set(rec.pin, { rec, model, unsubscribe });
    this.restPins(model);
    return true;
  }

  /**
   * New property values for the sensor keyed on `pin`. A model that speaks
   * unprompted may answer the change with a frame — see `LineModel.update`.
   */
  update(pin: number, props: Record<string, unknown>): void {
    const frame = this.attached.get(pin)?.model.update(props, this.clock);
    if (frame) this.timeline.emit(frame, this.clock.now());
  }

  detach(pin: number): void {
    const a = this.attached.get(pin);
    if (!a) return;
    for (const u of a.unsubscribe) u();
    this.attached.delete(pin);
  }

  detachAll(): void {
    for (const pin of [...this.attached.keys()]) this.detach(pin);
  }

  /** The board rebooted: forget protocol state, forget frames, re-rest pads. */
  reset(): void {
    this.timeline.reset();
    for (const a of this.attached.values()) {
      a.model.reset();
      this.restPins(a.model);
    }
  }

  /** Pins any attached model drives — off limits to every other layer. */
  ownsPin(pin: number): boolean {
    for (const a of this.attached.values()) {
      if (a.model.drives.includes(pin)) return true;
    }
    return false;
  }

  /** The skip allowed to a mechanism that advances time while the guest executes. */
  skipBudget(want: number, nowCycle: number): number {
    return this.timeline.skipBudget(want, nowCycle);
  }

  /** The floor alone: false while a self-timed frame is on the wire. */
  maySkip(nowCycle: number): boolean {
    return this.timeline.maySkip(nowCycle);
  }

  /** The fence alone: cycles to the nearest pending edge, Infinity if none. */
  cyclesUntilNextEdge(nowCycle: number): number {
    return this.timeline.cyclesUntilNextEdge(nowCycle);
  }

  /** The attached records, for a host that mirrors them somewhere (a worker). */
  records(): LineSensorRecord[] {
    return [...this.attached.values()].map((a) => a.rec);
  }

  private restPins(model: LineModel): void {
    for (const r of model.rest()) this.port.restPad(r.pin, r.level, r.driven);
  }
}
