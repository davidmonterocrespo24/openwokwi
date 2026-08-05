/**
 * WireRenderer — purely visual renderer for a single wire.
 * All interaction (click/hover/drag) is handled by SimulatorCanvas.
 */

import React from 'react';
import type { Wire } from '../../types/wire';
import { generateOrthogonalPath } from '../../utils/wireUtils';

interface WireRendererProps {
  wire: Wire;
  isSelected: boolean;
  isHovered: boolean;
  /** Temporary waypoints used during drag preview */
  previewWaypoints?: { x: number; y: number }[];
  /** Override the full SVG path string (used during segment drag preview) */
  overridePath?: string;
}

export const WireRenderer: React.FC<WireRendererProps> = ({
  wire,
  isSelected,
  isHovered,
  previewWaypoints,
  overridePath,
}) => {
  // Breadboard seating wires are pure connectivity — the part visually
  // sits in the holes, so there is nothing to draw.
  if (wire.bb) return null;

  const waypoints = previewWaypoints ?? wire.waypoints;
  const path = overridePath ?? generateOrthogonalPath(wire.start, waypoints, wire.end);

  if (!path) return null;

  const color = wire.color;
  const strokeW = isSelected ? 3 : 2;
  const outlineW = isSelected ? 6 : 5;
  const opacity = isSelected || isHovered ? 1 : 0.85;

  return (
    <g style={{ pointerEvents: 'none' }} strokeLinecap="round" strokeLinejoin="round">
      {/* Dark outline for wire crossing effect */}
      <path d={path} stroke="#1a1a1a" strokeWidth={outlineW} fill="none" />

      {/* Hover highlight (below wire) */}
      {isHovered && !isSelected && (
        <path d={path} stroke="#ffffff" strokeWidth="6" fill="none" opacity="0.2" />
      )}

      {/* Visible wire */}
      <path d={path} stroke={color} strokeWidth={strokeW} fill="none" opacity={opacity} />

      {/* Selection dashed highlight */}
      {isSelected && (
        <path
          d={path}
          stroke="#ffffff"
          strokeWidth="1.5"
          fill="none"
          strokeDasharray="6,4"
          opacity="0.6"
        />
      )}

      {/* Endpoint dots */}
      <circle
        cx={wire.start.x}
        cy={wire.start.y}
        r="3"
        fill={color}
        stroke="#1a1a1a"
        strokeWidth="1"
      />
      <circle cx={wire.end.x} cy={wire.end.y} r="3" fill={color} stroke="#1a1a1a" strokeWidth="1" />
    </g>
  );
};
