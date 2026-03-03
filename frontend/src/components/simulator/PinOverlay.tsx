/**
 * PinOverlay Component
 *
 * Renders clickable pin indicators over components to enable wire creation.
 * Shows when hovering over a component or when creating a wire.
 */

import React, { useEffect, useState } from 'react';

interface PinInfo {
  name: string;
  x: number;  // mm
  y: number;  // mm
  signals?: Array<{ type: string; signal?: string }>;
}

interface PinOverlayProps {
  componentId: string;
  componentX: number;
  componentY: number;
  onPinClick: (componentId: string, pinName: string, x: number, y: number) => void;
  showPins: boolean;
}

const MM_TO_PX = 3.7795275591;

export const PinOverlay: React.FC<PinOverlayProps> = ({
  componentId,
  componentX,
  componentY,
  onPinClick,
  showPins,
}) => {
  const [pins, setPins] = useState<PinInfo[]>([]);

  useEffect(() => {
    // Get pin info from wokwi-element
    const element = document.getElementById(componentId);
    if (element && (element as any).pinInfo) {
      setPins((element as any).pinInfo);
    }
  }, [componentId]);

  if (!showPins || pins.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        position: 'absolute',
        left: `${componentX}px`,
        top: `${componentY}px`,
        pointerEvents: 'none',
        zIndex: 10,
      }}
    >
      {pins.map((pin) => {
        const pinX = pin.x * MM_TO_PX;
        const pinY = pin.y * MM_TO_PX;

        return (
          <div
            key={pin.name}
            onClick={(e) => {
              e.stopPropagation();
              onPinClick(componentId, pin.name, componentX + pinX, componentY + pinY);
            }}
            style={{
              position: 'absolute',
              left: `${pinX - 6}px`,
              top: `${pinY - 6}px`,
              width: '12px',
              height: '12px',
              borderRadius: '50%',
              backgroundColor: 'rgba(0, 200, 255, 0.7)',
              border: '2px solid white',
              cursor: 'crosshair',
              pointerEvents: 'all',
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(0, 255, 100, 1)';
              e.currentTarget.style.transform = 'scale(1.3)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(0, 200, 255, 0.7)';
              e.currentTarget.style.transform = 'scale(1)';
            }}
            title={pin.name}
          />
        );
      })}
    </div>
  );
};
