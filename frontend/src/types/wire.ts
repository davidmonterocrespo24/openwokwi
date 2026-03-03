/**
 * Wire system type definitions for visual wiring system
 */

export interface WireEndpoint {
  componentId: string;  // ID of the component (e.g., 'led-123', 'arduino-uno')
  pinName: string;      // Pin name from ElementPin (e.g., 'A', 'C', 'GND.1', '13')
  x: number;            // Absolute canvas position in pixels
  y: number;            // Absolute canvas position in pixels
}

export interface WireControlPoint {
  id: string;           // Unique ID for React keys
  x: number;            // Canvas pixel coordinates
  y: number;            // Canvas pixel coordinates
}

export interface Wire {
  id: string;

  // Endpoints
  start: WireEndpoint;
  end: WireEndpoint;

  // Path control points for multi-segment routing (Phase 2)
  controlPoints: WireControlPoint[];

  // Visual properties
  color: string;        // Computed from signal type

  // Metadata
  signalType: WireSignalType | null;  // For validation and coloring
  isValid: boolean;     // Connection validation result (Phase 3)
  validationError?: string;
}

export type WireSignalType =
  | 'power-vcc'
  | 'power-gnd'
  | 'analog'
  | 'digital'
  | 'pwm'
  | 'i2c'
  | 'spi'
  | 'usart';

export interface WireColorMap {
  'power-vcc': string;   // Red
  'power-gnd': string;   // Black
  'analog': string;      // Blue
  'digital': string;     // Green
  'pwm': string;         // Purple
  'i2c': string;         // Yellow
  'spi': string;         // Orange
  'usart': string;       // Cyan
}

// Temporary wire being created (Phase 2)
export interface WireInProgress {
  startEndpoint: WireEndpoint;
  currentX: number;
  currentY: number;
}
