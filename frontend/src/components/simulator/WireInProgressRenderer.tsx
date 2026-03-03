/**
 * WireInProgressRenderer Component
 *
 * Renders a temporary wire preview while the user is creating a wire.
 * Shows a live path from the start endpoint to the current mouse position.
 * (Phase 2 - will be fully implemented when wire creation is added)
 */

import React, { useMemo } from 'react';
import type { WireInProgress } from '../../types/wire';

interface WireInProgressRendererProps {
  wireInProgress: WireInProgress;
}

export const WireInProgressRenderer: React.FC<WireInProgressRendererProps> = ({
  wireInProgress,
}) => {
  // Generate simple path from start to current mouse position
  const path = useMemo(() => {
    const { startEndpoint, currentX, currentY } = wireInProgress;

    // Simple L-shape preview
    const midX = startEndpoint.x + (currentX - startEndpoint.x) / 2;

    return `M ${startEndpoint.x} ${startEndpoint.y} L ${midX} ${startEndpoint.y} L ${midX} ${currentY} L ${currentX} ${currentY}`;
  }, [wireInProgress]);

  return (
    <g className="wire-in-progress">
      {/* Preview path (dashed green) */}
      <path
        d={path}
        stroke="#00ff00"
        strokeWidth="2"
        fill="none"
        strokeDasharray="5,5"
        opacity="0.7"
        style={{ pointerEvents: 'none' }}
      />

      {/* Start point marker */}
      <circle
        cx={wireInProgress.startEndpoint.x}
        cy={wireInProgress.startEndpoint.y}
        r="4"
        fill="#00ff00"
        stroke="white"
        strokeWidth="2"
        style={{ pointerEvents: 'none' }}
      />

      {/* Current mouse position marker */}
      <circle
        cx={wireInProgress.currentX}
        cy={wireInProgress.currentY}
        r="4"
        fill="#00ff00"
        stroke="white"
        strokeWidth="2"
        opacity="0.6"
        style={{ pointerEvents: 'none' }}
      />
    </g>
  );
};
