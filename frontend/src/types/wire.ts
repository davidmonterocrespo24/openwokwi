export interface WireEndpoint {
  componentId: string;
  pinName: string;
  x: number;
  y: number;
}

/**
 * Logical signal type carried by a wire. Used by `wireColors` for
 * visual coding and by `Interconnect` as a hint for cross-process
 * UART byte-level shortcuts.
 */
export type WireSignalType =
  | 'power-vcc'
  | 'power-gnd'
  | 'analog'
  | 'digital'
  | 'pwm'
  | 'i2c'
  | 'spi'
  | 'usart';

/** Map of every signal type to its display color. */
export type WireColorMap = Record<WireSignalType, string>;

export interface Wire {
  id: string;
  start: WireEndpoint;
  end: WireEndpoint;
  /** Intermediate waypoints clicked by the user during wire creation */
  waypoints: { x: number; y: number }[];
  color: string;
  /**
   * Optional logical signal classification (digital, i2c, usart, …).
   * Set by classifiers; absent on freshly-drawn wires until they are
   * resolved against board pin metadata.
   */
  signalType?: WireSignalType;
  /**
   * Breadboard seating wire: auto-created zero-length connection from a
   * part pin to the hole it is plugged into (Wokwi's `["$bb"]` entries).
   * Electrically a normal wire; never rendered, never hit-testable, and
   * re-generated whenever the part moves.
   */
  bb?: boolean;
  /**
   * The SYSTEM owns this wire's shape: its waypoints came from the
   * auto-router (pin-to-pin creation or an agent add_wire), and the
   * post-move pass may re-route it to keep it clear of components and
   * other wires. Cleared the moment the user drags a segment — from then
   * on the wire is hand-authored and is never re-shaped. Absent on wires
   * from older projects, which are treated as hand-authored.
   */
  autoRouted?: boolean;
}

export interface WireInProgress {
  startEndpoint: WireEndpoint;
  waypoints: { x: number; y: number }[];
  color: string;
  currentX: number;
  currentY: number;
  /**
   * Live obstacle-avoiding route to the cursor (interior corners), shown
   * by the preview so the committed wire matches what the user saw while
   * dragging. Only computed while there are no user-placed waypoints;
   * null when the direct elbow is already clean.
   */
  routedPreview?: { x: number; y: number }[] | null;
  /** Throttle stamp for preview routing (ms epoch). */
  lastRouteAt?: number;
}
