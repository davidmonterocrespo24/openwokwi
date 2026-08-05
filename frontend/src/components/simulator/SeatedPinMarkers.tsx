/**
 * SeatedPinMarkers
 *
 * A small green dot on each component pin that is PLUGGED INTO a breadboard
 * hole (Wokwi-style). Seating is otherwise invisible — the pin↔hole link is a
 * zero-length `bb` wire that never renders — so without this a user can't tell
 * a part that merely sits ON the board from one whose pins are actually
 * connected. The dots make "seated & connected" legible at a glance.
 *
 * Unlike PinOverlay (hover/wiring-gated clickable hit boxes) this layer is
 * ALWAYS visible and never interactive. Both reuse `rotatePinLocal` so the
 * markers and the hit boxes can never drift apart under rotation.
 */

import React, { useEffect, useState } from 'react';
import { rotatePinLocal } from '../../utils/pinPositionCalculator';

interface PinInfo {
  name: string;
  x: number;
  y: number;
}

interface SeatedPinMarkersProps {
  componentId: string;
  componentX: number;
  componentY: number;
  /** Pin names currently plugged into a breadboard hole (from bb wires). */
  seatedPins: string[];
  rotation?: number;
  /** Wrapper padding+border inset, matching PinOverlay. */
  wrapperOffsetX?: number;
  wrapperOffsetY?: number;
}

/** Green dot diameter in world px (zoom-independent, like the pin hit boxes). */
const DOT_SIZE = 7;

export const SeatedPinMarkers: React.FC<SeatedPinMarkersProps> = ({
  componentId,
  componentX,
  componentY,
  seatedPins,
  rotation = 0,
  wrapperOffsetX = 6,
  wrapperOffsetY = 6,
}) => {
  const [pins, setPins] = useState<PinInfo[]>([]);
  const [wrapperBox, setWrapperBox] = useState<{ w: number; h: number } | null>(null);

  // Same DOM read as PinOverlay: pinInfo gives element-space pin coords, and
  // the wrapper's unrotated layout box gives the rotation pivot. Re-measure
  // after layout because a part imported already-rotated may not have its
  // final size on the mount tick (issues #230/#232). Re-run when the seating
  // changes so a freshly plugged pin appears without a hover.
  const seatedKey = seatedPins.join(',');
  useEffect(() => {
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryRead = (): boolean => {
      const element = document.getElementById(componentId);
      if (element && (element as unknown as { pinInfo?: PinInfo[] }).pinInfo) {
        setPins((element as unknown as { pinInfo: PinInfo[] }).pinInfo);
        const wrapper = element.closest('.dynamic-component-wrapper') as HTMLElement | null;
        if (wrapper) setWrapperBox({ w: wrapper.offsetWidth, h: wrapper.offsetHeight });
        return true;
      }
      return false;
    };
    tryRead();
    raf = requestAnimationFrame(() => {
      if (!tryRead()) timer = setTimeout(tryRead, 50);
    });
    return () => {
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  }, [componentId, rotation, seatedKey]);

  if (seatedPins.length === 0 || pins.length === 0) return null;
  const seated = new Set(seatedPins);

  return (
    <div
      style={{
        position: 'absolute',
        left: `${componentX + wrapperOffsetX}px`,
        top: `${componentY + wrapperOffsetY}px`,
        pointerEvents: 'none',
        // Just above the component body so the dots read as sitting on the
        // pins; below the z:30 wire-target overlay so hover boxes still win.
        zIndex: 29,
      }}
    >
      {pins.map((pin, index) => {
        if (!seated.has(pin.name)) return null;
        const { x, y } = rotatePinLocal(pin.x, pin.y, rotation, wrapperBox, wrapperOffsetX, wrapperOffsetY);
        return (
          <div
            key={`${pin.name}-${index}`}
            title={`${pin.name} → breadboard`}
            style={{
              position: 'absolute',
              left: `${x - DOT_SIZE / 2}px`,
              top: `${y - DOT_SIZE / 2}px`,
              width: `${DOT_SIZE}px`,
              height: `${DOT_SIZE}px`,
              borderRadius: '50%',
              backgroundColor: '#22e06a',
              border: '1px solid rgba(255,255,255,0.85)',
              boxShadow: '0 0 4px 1px rgba(34,224,106,0.85)',
              pointerEvents: 'none',
            }}
          />
        );
      })}
    </div>
  );
};
