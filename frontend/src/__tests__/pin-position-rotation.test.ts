// @vitest-environment jsdom
/**
 * Regression test for the rotation bug: when a component rotates, its
 * wire endpoints stayed at the unrotated pin positions and the part
 * visually disconnected from its cables.
 *
 * Root cause was twofold:
 *   1. `useSimulatorStore.updateComponent()` only triggered
 *      `updateWirePositions()` when x or y changed — never on rotation.
 *   2. `calculatePinPosition()` knew nothing about rotation; it returned
 *      the unrotated offset even when the wrapper had a CSS transform.
 *
 * Both paths are now exercised here:
 *   - calculatePinPosition with rotation arg returns the correct rotated
 *     coordinate for a known wrapper + pin layout.
 *   - rotating a component through the store re-stamps wire endpoints.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { calculatePinPosition, rotatePinLocal } from '../utils/pinPositionCalculator';
import { useSimulatorStore } from '../store/useSimulatorStore';

// Build a minimal DOM matching the runtime layout:
//   <div class="dynamic-component-wrapper">   ← what CSS rotates
//     <div class="web-component-container">
//       <fake-led id="comp1" />               ← .pinInfo carrier
//     </div>
//   </div>
function buildFakeComponent(opts: {
  id: string;
  wrapperW: number;
  wrapperH: number;
  pins: Array<{ name: string; x: number; y: number }>;
}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'dynamic-component-wrapper';
  // jsdom defaults offsetWidth / Height to 0; set them manually so the
  // rotation math sees a real layout box.
  Object.defineProperty(wrapper, 'offsetWidth', { value: opts.wrapperW, configurable: true });
  Object.defineProperty(wrapper, 'offsetHeight', { value: opts.wrapperH, configurable: true });

  const container = document.createElement('div');
  container.className = 'web-component-container';

  const inner = document.createElement('div');
  inner.id = opts.id;
  (inner as any).pinInfo = opts.pins;

  container.appendChild(inner);
  wrapper.appendChild(container);
  document.body.appendChild(wrapper);
  return { wrapper, inner };
}

describe('calculatePinPosition — rotation math', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns the unrotated offset when rotation is 0', () => {
    buildFakeComponent({
      id: 'comp0',
      wrapperW: 72,
      wrapperH: 48,
      pins: [{ name: 'A', x: 0, y: 14 }],
    });
    // componentX/Y are the inner-element top-left after the +6/+6
    // wrapper offset that updateWirePositions applies. With
    // component.x = 100 → componentX = 106.
    const pos = calculatePinPosition('comp0', 'A', 106, 106, 0);
    expect(pos).toEqual({ x: 106, y: 120 });
  });

  it('rotates a left-side pin to the bottom when rotation = 90°', () => {
    // Wrapper 72×48 (small 2-input gate). Pin A at (0, 14) on the LEFT
    // edge. After a 90° CW rotation around the wrapper centre, that pin
    // should land on the bottom of the wrapper.
    buildFakeComponent({
      id: 'comp90',
      wrapperW: 72,
      wrapperH: 48,
      pins: [{ name: 'A', x: 0, y: 14 }],
    });
    const pos = calculatePinPosition('comp90', 'A', 106, 106, 90);
    expect(pos).not.toBeNull();
    // Walk through the math to keep the assertion expressive:
    //   wrapperLeft = 106 - 6 = 100
    //   wrapperTop  = 106 - 6 = 100
    //   pivot       = (100 + 36, 100 + 24) = (136, 124)
    //   unrotated   = (106 + 0, 106 + 14) = (106, 120)
    //   dx, dy      = (-30, -4)
    //   90° → (dx*0 - dy*1, dx*1 + dy*0) = (4, -30)
    //   result      = (136 + 4, 124 - 30) = (140, 94)
    expect(pos!.x).toBeCloseTo(140, 5);
    expect(pos!.y).toBeCloseTo(94, 5);
  });

  it('rotates 180° flips both axes around the wrapper centre', () => {
    buildFakeComponent({
      id: 'comp180',
      wrapperW: 72,
      wrapperH: 48,
      pins: [{ name: 'Y', x: 72, y: 24 }],
    });
    // unrotated Y is on the right edge midpoint
    //   wrapperLeft = 100, wrapperTop = 100, pivot = (136, 124)
    //   unrotated = (106+72, 106+24) = (178, 130)
    //   dx, dy = (42, 6)
    //   180° → (-42, -6) → (94, 118)
    const pos = calculatePinPosition('comp180', 'Y', 106, 106, 180);
    expect(pos!.x).toBeCloseTo(94, 5);
    expect(pos!.y).toBeCloseTo(118, 5);
  });

  it('rotating four 90° steps lands back on the original coordinates', () => {
    buildFakeComponent({
      id: 'comp360',
      wrapperW: 72,
      wrapperH: 48,
      pins: [{ name: 'Y', x: 72, y: 24 }],
    });
    const base = calculatePinPosition('comp360', 'Y', 106, 106, 0);
    const full = calculatePinPosition('comp360', 'Y', 106, 106, 360);
    expect(full!.x).toBeCloseTo(base!.x, 5);
    expect(full!.y).toBeCloseTo(base!.y, 5);
  });

  it('accepts negative angles', () => {
    buildFakeComponent({
      id: 'compNeg',
      wrapperW: 72,
      wrapperH: 48,
      pins: [{ name: 'A', x: 0, y: 14 }],
    });
    // -90° (= 270°) sends a left-edge pin to the TOP of the wrapper.
    //   dx, dy = (-30, -4)
    //   Standard 2D rotation matrix [cos -sin; sin cos] with θ=-90°
    //     cos = 0, sin = -1
    //     (dx*0 - dy*(-1), dx*(-1) + dy*0) = (dy, -dx) = (-4, 30)
    //   result = (136 - 4, 124 + 30) = (132, 154)
    const pos = calculatePinPosition('compNeg', 'A', 106, 106, -90);
    expect(pos!.x).toBeCloseTo(132, 5);
    expect(pos!.y).toBeCloseTo(154, 5);
  });
});

describe('useSimulatorStore — rotating a component re-stamps wires', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    // Reset the store to a clean slate. Boards aren't needed for this test;
    // we add the component directly.
    useSimulatorStore.setState((s) => {
      const ids = s.boards.map((b) => b.id);
      ids.forEach((id) => s.removeBoard(id));
      return s;
    });
    useSimulatorStore.setState({
      components: [],
      wires: [],
    });
  });

  it('updateComponent({rotation}) recomputes wire endpoints', () => {
    // Set up a gate-shaped component plus a wire anchored to its A pin.
    buildFakeComponent({
      id: 'g1',
      wrapperW: 72,
      wrapperH: 48,
      pins: [
        { name: 'A', x: 0, y: 14 },
        { name: 'B', x: 0, y: 34 },
        { name: 'Y', x: 72, y: 24 },
      ],
    });

    useSimulatorStore.setState({
      components: [
        {
          id: 'g1',
          metadataId: 'logic-gate-and',
          x: 100,
          y: 100,
          properties: {},
        },
      ],
      wires: [
        {
          id: 'w1',
          start: { componentId: 'g1', pinName: 'A', x: 106, y: 120 },
          end: { componentId: 'g1', pinName: 'A', x: 106, y: 120 },
          color: '#000',
          waypoints: [],
        },
      ],
    });

    // Initial position should match the unrotated math (component.x=100
    // plus +6 wrapper offset, plus pin.x=0 → 106 for X; same on Y plus
    // pin.y=14 → 120).
    const before = useSimulatorStore.getState().wires[0];
    expect(before.start.x).toBe(106);
    expect(before.start.y).toBe(120);

    // Now rotate 90° via updateComponent — the wire should follow.
    useSimulatorStore.getState().updateComponent('g1', {
      properties: { rotation: 90 },
    } as any);
    const after = useSimulatorStore.getState().wires[0];
    expect(after.start.x).toBeCloseTo(140, 5);
    expect(after.start.y).toBeCloseTo(94, 5);
  });
});

describe('rotatePinLocal — shared by hit boxes and seated-pin markers', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns the input unchanged at rotation 0', () => {
    expect(rotatePinLocal(12, 34, 0, { w: 72, h: 48 }, 6, 6)).toEqual({ x: 12, y: 34 });
    // No wrapper box measured yet → also a no-op.
    expect(rotatePinLocal(12, 34, 90, null, 6, 6)).toEqual({ x: 12, y: 34 });
  });

  it('agrees with calculatePinPosition so green dots track wire endpoints', () => {
    // The two must never drift: the marker layer and the wire-endpoint math
    // are the same rotation about the same wrapper pivot, differing only by
    // the container origin (componentX/Y + wrapper offset).
    buildFakeComponent({
      id: 'compR',
      wrapperW: 72,
      wrapperH: 48,
      pins: [{ name: 'A', x: 0, y: 14 }],
    });
    const componentX = 106; // inner-element top-left (component.x 100 + 6)
    const componentY = 106;
    for (const rot of [0, 90, 180, 270]) {
      const abs = calculatePinPosition('compR', 'A', componentX, componentY, rot)!;
      // rotatePinLocal works in element space (pin.x/pin.y) and returns
      // coords local to the container at (component.x + 6, component.y + 6).
      const local = rotatePinLocal(0, 14, rot, { w: 72, h: 48 }, 6, 6);
      expect(local.x + componentX).toBeCloseTo(abs.x, 5);
      expect(local.y + componentY).toBeCloseTo(abs.y, 5);
    }
  });
})
