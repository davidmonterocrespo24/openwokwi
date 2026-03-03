/**
 * WireRenderer Component
 *
 * Renders an individual wire with the following features:
 * - Invisible thick path for easy clicking
 * - Visible colored path based on signal type
 * - Endpoint markers (circles)
 * - Control points when selected (Phase 2)
 * - Dashed line for invalid connections (Phase 3)
 */

import React, { useMemo, useCallback, useState, useRef } from 'react';
import type { Wire } from '../../types/wire';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { generateWirePath } from '../../utils/wirePathGenerator';

interface WireRendererProps {
  wire: Wire;
  isSelected: boolean;
}

export const WireRenderer: React.FC<WireRendererProps> = ({ wire, isSelected }) => {
  const { setSelectedWire, updateWire } = useSimulatorStore();
  const [draggedCPId, setDraggedCPId] = useState<string | null>(null);
  const svgRef = useRef<SVGGElement>(null);

  // Generate SVG path (memoized for performance)
  const path = useMemo(() => {
    return generateWirePath(wire);
  }, [wire.start.x, wire.start.y, wire.end.x, wire.end.y, wire.controlPoints]);

  const handleWireClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setSelectedWire(wire.id);
    },
    [wire.id, setSelectedWire]
  );

  const handleControlPointMouseDown = useCallback(
    (cpId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      setDraggedCPId(cpId);
    },
    []
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!draggedCPId || !svgRef.current) return;

      const svg = svgRef.current.ownerSVGElement;
      if (!svg) return;

      // Get SVG bounding rect and convert mouse position to SVG coordinates
      const svgRect = svg.getBoundingClientRect();
      const x = e.clientX - svgRect.left;
      const y = e.clientY - svgRect.top;

      const updatedControlPoints = wire.controlPoints.map((cp) =>
        cp.id === draggedCPId ? { ...cp, x, y } : cp
      );

      updateWire(wire.id, { controlPoints: updatedControlPoints });
    },
    [draggedCPId, wire.id, wire.controlPoints, updateWire]
  );

  const handleMouseUp = useCallback(() => {
    setDraggedCPId(null);
  }, []);

  return (
    <g
      ref={svgRef}
      className="wire-group"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Invisible thick path for easier clicking */}
      <path
        d={path}
        stroke="transparent"
        strokeWidth="10"
        fill="none"
        style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
        onClick={handleWireClick}
      />

      {/* Visible wire path */}
      <path
        d={path}
        stroke={wire.isValid ? wire.color : '#ff4444'}  // Red for invalid (Phase 3)
        strokeWidth="2"
        fill="none"
        strokeDasharray={wire.isValid ? undefined : '5,5'}  // Dashed for invalid
        style={{ pointerEvents: 'none' }}
      />

      {/* Endpoint markers */}
      <circle
        cx={wire.start.x}
        cy={wire.start.y}
        r="3"
        fill={wire.color}
        style={{ pointerEvents: 'none' }}
      />
      <circle
        cx={wire.end.x}
        cy={wire.end.y}
        r="3"
        fill={wire.color}
        style={{ pointerEvents: 'none' }}
      />

      {/* Selection indicator */}
      {isSelected && (
        <path
          d={path}
          stroke="#00ffff"  // Cyan highlight for selected wire
          strokeWidth="3"
          fill="none"
          strokeDasharray="10,5"
          opacity="0.6"
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* Control points - draggable when wire is selected */}
      {isSelected && wire.controlPoints.length > 0 && (
        <>
          {wire.controlPoints.map((cp) => (
            <circle
              key={cp.id}
              cx={cp.x}
              cy={cp.y}
              r="6"
              fill={draggedCPId === cp.id ? '#a78bfa' : '#8b5cf6'}  // Lighter purple when dragging
              stroke="white"
              strokeWidth="2"
              style={{ cursor: 'move', pointerEvents: 'all' }}
              onMouseDown={(e) => handleControlPointMouseDown(cp.id, e)}
            />
          ))}
        </>
      )}
    </g>
  );
};
