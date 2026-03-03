/**
 * WireLayer Component
 *
 * SVG layer that renders all wires below components.
 * Positioned absolutely with full canvas coverage.
 */

import React from 'react';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { WireRenderer } from './WireRenderer';
import { WireInProgressRenderer } from './WireInProgressRenderer';

export const WireLayer: React.FC = () => {
  const { wires, wireInProgress, selectedWireId } = useSimulatorStore();

  return (
    <svg
      className="wire-layer"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'auto',  // Enable pointer events for control points
        zIndex: 1,  // Below components (which have zIndex: 2)
      }}
    >
      {/* Transparent background - allows click-through when not clicking on wires */}
      <rect
        width="100%"
        height="100%"
        fill="transparent"
        style={{ pointerEvents: 'none' }}
      />

      {/* Render all wires */}
      {wires.map((wire) => (
        <WireRenderer
          key={wire.id}
          wire={wire}
          isSelected={wire.id === selectedWireId}
        />
      ))}

      {/* Render wire being created (Phase 2) */}
      {wireInProgress && (
        <WireInProgressRenderer wireInProgress={wireInProgress} />
      )}
    </svg>
  );
};
