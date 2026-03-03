import { create } from 'zustand';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import type { Wire, WireInProgress, WireEndpoint } from '../types/wire';
import { calculatePinPosition } from '../utils/pinPositionCalculator';

// Fixed position for the Arduino board (not in components array)
export const ARDUINO_POSITION = { x: 50, y: 50 };

interface Component {
  id: string;
  type: 'led' | 'resistor' | 'pushbutton' | 'potentiometer';
  x: number;
  y: number;
  properties: {
    color?: string;
    value?: number;
    pin?: number;
    state?: boolean;
  };
}

interface SimulatorState {
  // Simulation state
  simulator: AVRSimulator | null;
  pinManager: PinManager;
  running: boolean;
  compiledHex: string | null;

  // Components
  components: Component[];

  // Wire state (Phase 1)
  wires: Wire[];
  selectedWireId: string | null;
  wireInProgress: WireInProgress | null;

  // Actions
  initSimulator: () => void;
  loadHex: (hex: string) => void;
  startSimulation: () => void;
  stopSimulation: () => void;
  resetSimulation: () => void;
  setCompiledHex: (hex: string) => void;
  setRunning: (running: boolean) => void;

  // Component management
  addComponent: (component: Component) => void;
  removeComponent: (id: string) => void;
  updateComponent: (id: string, updates: Partial<Component>) => void;
  updateComponentState: (id: string, state: boolean) => void;

  // Wire management (Phase 1)
  addWire: (wire: Wire) => void;
  removeWire: (wireId: string) => void;
  updateWire: (wireId: string, updates: Partial<Wire>) => void;
  setSelectedWire: (wireId: string | null) => void;

  // Wire creation (Phase 2)
  startWireCreation: (endpoint: WireEndpoint) => void;
  updateWireInProgress: (x: number, y: number) => void;
  finishWireCreation: (endpoint: WireEndpoint) => void;
  cancelWireCreation: () => void;

  // Wire position updates (auto-update when components move)
  updateWirePositions: (componentId: string) => void;
  recalculateAllWirePositions: () => void;
}

export const useSimulatorStore = create<SimulatorState>((set, get) => {
  // Create PinManager instance
  const pinManager = new PinManager();

  return {
    simulator: null,
    pinManager,
    running: false,
    compiledHex: null,
    components: [
      {
        id: 'led-builtin',
        type: 'led',
        x: 350,
        y: 100,
        properties: {
          color: 'red',
          pin: 13,
          state: false,
        },
      },
    ],

    // Wire state with test wires (Phase 1 - Testing)
    // Positions will be recalculated dynamically after DOM mount
    wires: [
      {
        id: 'wire-test-1',
        start: {
          componentId: 'arduino-uno',
          pinName: 'GND.1',
          x: 0,
          y: 0,
        },
        end: {
          componentId: 'led-builtin',
          pinName: 'A',
          x: 0,
          y: 0,
        },
        controlPoints: [],
        color: '#000000', // Black for GND
        signalType: 'power-gnd',
        isValid: true,
      },
      {
        id: 'wire-test-2',
        start: {
          componentId: 'arduino-uno',
          pinName: '13',
          x: 0,
          y: 0,
        },
        end: {
          componentId: 'led-builtin',
          pinName: 'C',
          x: 0,
          y: 0,
        },
        controlPoints: [],
        color: '#00ff00', // Green for digital
        signalType: 'digital',
        isValid: true,
      },
    ],
    selectedWireId: null,
    wireInProgress: null,

    initSimulator: () => {
      const simulator = new AVRSimulator(pinManager);
      set({ simulator });
      console.log('Simulator initialized');
    },

    loadHex: (hex: string) => {
      const { simulator } = get();
      if (simulator) {
        try {
          simulator.loadHex(hex);
          set({ compiledHex: hex });
          console.log('HEX file loaded successfully');
        } catch (error) {
          console.error('Failed to load HEX:', error);
        }
      } else {
        console.warn('Simulator not initialized');
      }
    },

    startSimulation: () => {
      const { simulator } = get();
      if (simulator) {
        simulator.start();
        set({ running: true });
      }
    },

    stopSimulation: () => {
      const { simulator } = get();
      if (simulator) {
        simulator.stop();
        set({ running: false });
      }
    },

    resetSimulation: () => {
      const { simulator } = get();
      if (simulator) {
        simulator.reset();
        set({ running: false });
      }
    },

    setCompiledHex: (hex: string) => {
      set({ compiledHex: hex });
      // Auto-load hex when set
      get().loadHex(hex);
    },

    setRunning: (running: boolean) => set({ running }),

    addComponent: (component) => {
      set((state) => ({
        components: [...state.components, component],
      }));
    },

    removeComponent: (id) => {
      set((state) => ({
        components: state.components.filter((c) => c.id !== id),
        // Also remove wires connected to this component
        wires: state.wires.filter((w) =>
          w.start.componentId !== id && w.end.componentId !== id
        ),
      }));
    },

    updateComponent: (id, updates) => {
      set((state) => ({
        components: state.components.map((c) =>
          c.id === id ? { ...c, ...updates } : c
        ),
      }));

      // Update wire positions if component moved
      if (updates.x !== undefined || updates.y !== undefined) {
        get().updateWirePositions(id);
      }
    },

    updateComponentState: (id, state) => {
      set((prevState) => ({
        components: prevState.components.map((c) =>
          c.id === id ? { ...c, properties: { ...c.properties, state } } : c
        ),
      }));
    },

    // Wire management actions
    addWire: (wire) => {
      set((state) => ({
        wires: [...state.wires, wire],
      }));
    },

    removeWire: (wireId) => {
      set((state) => ({
        wires: state.wires.filter((w) => w.id !== wireId),
        selectedWireId: state.selectedWireId === wireId ? null : state.selectedWireId,
      }));
    },

    updateWire: (wireId, updates) => {
      set((state) => ({
        wires: state.wires.map((w) =>
          w.id === wireId ? { ...w, ...updates } : w
        ),
      }));
    },

    setSelectedWire: (wireId) => {
      set({ selectedWireId: wireId });
    },

    // Wire creation actions (Phase 2)
    startWireCreation: (endpoint) => {
      set({
        wireInProgress: {
          startEndpoint: endpoint,
          currentX: endpoint.x,
          currentY: endpoint.y,
        },
      });
    },

    updateWireInProgress: (x, y) => {
      set((state) => {
        if (!state.wireInProgress) return state;
        return {
          wireInProgress: {
            ...state.wireInProgress,
            currentX: x,
            currentY: y,
          },
        };
      });
    },

    finishWireCreation: (endpoint) => {
      const state = get();
      if (!state.wireInProgress) return;

      const { startEndpoint } = state.wireInProgress;

      // Calculate midpoint for control point
      const midX = (startEndpoint.x + endpoint.x) / 2;
      const midY = (startEndpoint.y + endpoint.y) / 2;

      const newWire: Wire = {
        id: `wire-${Date.now()}`,
        start: startEndpoint,
        end: endpoint,
        controlPoints: [
          {
            id: `cp-${Date.now()}`,
            x: midX,
            y: midY,
          },
        ],
        color: '#00ff00', // Default green, will be calculated based on signal type
        signalType: 'digital',
        isValid: true,
      };

      set((state) => ({
        wires: [...state.wires, newWire],
        wireInProgress: null,
      }));
    },

    cancelWireCreation: () => {
      set({ wireInProgress: null });
    },

    // Update wire positions when component moves
    updateWirePositions: (componentId) => {
      set((state) => {
        const component = state.components.find((c) => c.id === componentId);
        // For fixed components like Arduino, use ARDUINO_POSITION
        const compX = component ? component.x : ARDUINO_POSITION.x;
        const compY = component ? component.y : ARDUINO_POSITION.y;

        const updatedWires = state.wires.map((wire) => {
          const updated = { ...wire };
          if (wire.start.componentId === componentId) {
            const pos = calculatePinPosition(
              componentId,
              wire.start.pinName,
              compX,
              compY
            );
            if (pos) {
              updated.start = { ...wire.start, x: pos.x, y: pos.y };
            }
          }

          // Update end endpoint if it belongs to this component
          if (wire.end.componentId === componentId) {
            const pos = calculatePinPosition(
              componentId,
              wire.end.pinName,
              compX,
              compY
            );
            if (pos) {
              updated.end = { ...wire.end, x: pos.x, y: pos.y };
            }
          }

          return updated;
        });

        return { wires: updatedWires };
      });
    },

    // Recalculate all wire positions from actual DOM pinInfo
    recalculateAllWirePositions: () => {
      const state = get();
      const updatedWires = state.wires.map((wire) => {
        const updated = { ...wire };
        const startComp = state.components.find((c) => c.id === wire.start.componentId);
        const startX = startComp ? startComp.x : ARDUINO_POSITION.x;
        const startY = startComp ? startComp.y : ARDUINO_POSITION.y;

        const startPos = calculatePinPosition(
          wire.start.componentId,
          wire.start.pinName,
          startX,
          startY
        );
        if (startPos) {
          updated.start = { ...wire.start, x: startPos.x, y: startPos.y };
        }

        // Resolve end component position
        const endComp = state.components.find((c) => c.id === wire.end.componentId);
        const endX = endComp ? endComp.x : ARDUINO_POSITION.x;
        const endY = endComp ? endComp.y : ARDUINO_POSITION.y;

        const endPos = calculatePinPosition(
          wire.end.componentId,
          wire.end.pinName,
          endX,
          endY
        );
        if (endPos) {
          updated.end = { ...wire.end, x: endPos.x, y: endPos.y };
        }

        return updated;
      });

      set({ wires: updatedWires });
    },
  };
});
