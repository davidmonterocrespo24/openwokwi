/**
 * <velxio-junction> — a wire junction node: the solder dot that lets a wire
 * connect to another wire, so a shared rail (GND, VCC) can be ONE wire with
 * taps instead of a star of separate wires back to the board.
 *
 * Deliberately the smallest possible part: one pin, dead-center, and a filled
 * circle that takes the wire's color. It is a NORMAL component to every other
 * subsystem — that is the whole design. The five net builders treat a shared
 * pin transitively (union(A, J) + union(J, B) puts A, J, B in one net), the
 * verifier sees an ordinary wired pin, persistence serializes it verbatim,
 * and DynamicComponent drags it like anything else. It has NO SPICE mapper on
 * purpose: absence keeps its nets out of `sourcedNets`, exactly like a bare
 * wire.
 *
 * Not in the component picker (GESTURE_ONLY_COMPONENTS): junctions are
 * created by dropping a wire-end onto a wire or with the node tool, never
 * placed bare — a junction on empty canvas connects nothing.
 */

interface ElementPin {
  name: string;
  x: number;
  y: number;
  signals: unknown[];
}

export class JunctionElement extends HTMLElement {
  static observedAttributes = ['color'];

  /** Pin dead-center of the dot. The name must stay clear of the power-pin
   *  regexes (GND/VCC/...) that four separate net builders match on. */
  readonly pinInfo: ElementPin[] = [{ name: 'J', x: 5, y: 5, signals: [] }];

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML =
      `<style>:host{display:flex}</style>` +
      `<svg width="10" height="10" viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">` +
      `<circle class="dot" cx="5" cy="5" r="3.4" fill="#4caf50" ` +
      `stroke="rgba(0,0,0,0.35)" stroke-width="0.8" />` +
      `</svg>`;
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === 'color') this._paint(value);
  }

  /** Wire color of the run this junction sits on — set by the split gesture
   *  so the dot reads as part of the wire, not as a foreign component.
   *  DynamicComponent re-assigns properties on every sync; same-value sets
   *  are harmless (plain attribute write). */
  get color(): string {
    return this.getAttribute('color') ?? '#4caf50';
  }
  set color(v: string) {
    this.setAttribute('color', String(v));
  }

  private _paint(value: string | null): void {
    const dot = this.shadowRoot?.querySelector('.dot');
    if (dot) dot.setAttribute('fill', value || '#4caf50');
  }
}

if (!customElements.get('velxio-junction')) {
  customElements.define('velxio-junction', JunctionElement);
}
