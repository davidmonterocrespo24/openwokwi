import { useSimulatorStore, ARDUINO_POSITION, BOARD_LABELS } from '../../store/useSimulatorStore';
import type { BoardType } from '../../store/useSimulatorStore';
import React, { useEffect, useState, useRef } from 'react';
import { ArduinoUno } from '../components-wokwi/ArduinoUno';
import { NanoRP2040 } from '../components-wokwi/NanoRP2040';
import { ComponentPickerModal } from '../ComponentPickerModal';
import { ComponentPropertyDialog } from './ComponentPropertyDialog';
import { DynamicComponent, createComponentFromMetadata } from '../DynamicComponent';
import { ComponentRegistry } from '../../services/ComponentRegistry';
import { PinSelector } from './PinSelector';
import { WireLayer } from './WireLayer';
import { PinOverlay } from './PinOverlay';
import { PartSimulationRegistry } from '../../simulation/parts';
import { isBoardComponent, boardPinToNumber } from '../../utils/boardPinMapping';
import type { ComponentMetadata } from '../../types/component-metadata';
import './SimulatorCanvas.css';

export const SimulatorCanvas = () => {
  const {
    boardType,
    setBoardType,
    components,
    running,
    pinManager,
    initSimulator,
    updateComponentState,
    addComponent,
    removeComponent,
    updateComponent,
  } = useSimulatorStore();

  // Wire management from store
  const startWireCreation = useSimulatorStore((s) => s.startWireCreation);
  const updateWireInProgress = useSimulatorStore((s) => s.updateWireInProgress);
  const finishWireCreation = useSimulatorStore((s) => s.finishWireCreation);
  const cancelWireCreation = useSimulatorStore((s) => s.cancelWireCreation);
  const wireInProgress = useSimulatorStore((s) => s.wireInProgress);
  const recalculateAllWirePositions = useSimulatorStore((s) => s.recalculateAllWirePositions);

  // Component picker modal
  const [showComponentPicker, setShowComponentPicker] = useState(false);
  const [registry] = useState(() => ComponentRegistry.getInstance());
  const [registryLoaded, setRegistryLoaded] = useState(registry.isLoaded);

  // Wait for registry to finish loading before rendering components
  useEffect(() => {
    if (!registryLoaded) {
      registry.loadPromise.then(() => setRegistryLoaded(true));
    }
  }, [registry, registryLoaded]);

  // Component selection
  const [selectedComponentId, setSelectedComponentId] = useState<string | null>(null);
  const [showPinSelector, setShowPinSelector] = useState(false);
  const [pinSelectorPos, setPinSelectorPos] = useState({ x: 0, y: 0 });

  // Component property dialog
  const [showPropertyDialog, setShowPropertyDialog] = useState(false);
  const [propertyDialogComponentId, setPropertyDialogComponentId] = useState<string | null>(null);
  const [propertyDialogPosition, setPropertyDialogPosition] = useState({ x: 0, y: 0 });

  // Click vs drag detection
  const [clickStartTime, setClickStartTime] = useState<number>(0);
  const [clickStartPos, setClickStartPos] = useState({ x: 0, y: 0 });

  // Component dragging state
  const [draggedComponentId, setDraggedComponentId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  // Canvas ref for coordinate calculations
  const canvasRef = useRef<HTMLDivElement>(null);

  // Initialize simulator on mount
  useEffect(() => {
    initSimulator();
  }, [initSimulator]);

  // Recalculate wire positions after web components initialize their pinInfo
  useEffect(() => {
    const timer = setTimeout(() => {
      recalculateAllWirePositions();
    }, 500);
    return () => clearTimeout(timer);
  }, [recalculateAllWirePositions]);

  // Connect components to pin manager
  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    // Helper to add subscription
    const subscribeComponentToPin = (component: any, pin: number, componentPinName?: string) => {
      const unsubscribe = pinManager.onPinChange(
        pin,
        (_pin, state) => {
          // 1. Update React state for standard properties
          updateComponentState(component.id, state);

          // 2. Delegate to PartSimulationRegistry for custom visual updates
          const logic = PartSimulationRegistry.get(component.metadataId);
          if (logic && logic.onPinStateChange) {
            const el = document.getElementById(component.id);
            if (el) {
              logic.onPinStateChange(componentPinName || 'A', state, el);
            }
          }

          console.log(`Component ${component.id} on pin ${pin}: ${state ? 'HIGH' : 'LOW'}`);
        }
      );
      unsubscribers.push(unsubscribe);
    };

    components.forEach((component) => {
      // 1. Subscribe by explicit pin property
      if (component.properties.pin !== undefined) {
        subscribeComponentToPin(component, component.properties.pin as number, 'A');
      } else {
        // 2. Subscribe by finding wires connected to arduino
        const connectedWires = useSimulatorStore.getState().wires.filter(
          w => w.start.componentId === component.id || w.end.componentId === component.id
        );

        connectedWires.forEach(wire => {
          const isStartSelf = wire.start.componentId === component.id;
          const selfEndpoint = isStartSelf ? wire.start : wire.end;
          const otherEndpoint = isStartSelf ? wire.end : wire.start;

          if (isBoardComponent(otherEndpoint.componentId)) {
            const pin = boardPinToNumber(otherEndpoint.componentId, otherEndpoint.pinName);
            if (pin !== null) {
              subscribeComponentToPin(component, pin, selfEndpoint.pinName);
            }
          }
        });
      }
    });

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, [components, pinManager, updateComponentState]);

  // Handle keyboard delete
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedComponentId) {
        removeComponent(selectedComponentId);
        setSelectedComponentId(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedComponentId, removeComponent]);

  // Handle component selection from modal
  const handleSelectComponent = (metadata: ComponentMetadata) => {
    // Calculate grid position to avoid overlapping
    // Use existing components count to determine position
    const componentsCount = components.length;
    const gridSize = 250; // Space between components
    const cols = 3; // Components per row

    const col = componentsCount % cols;
    const row = Math.floor(componentsCount / cols);

    const x = 400 + (col * gridSize);
    const y = 100 + (row * gridSize);

    const component = createComponentFromMetadata(metadata, x, y);
    addComponent(component as any);
    setShowComponentPicker(false);
  };

  // Component selection (double click to open pin selector)
  const handleComponentDoubleClick = (componentId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    setSelectedComponentId(componentId);
    setPinSelectorPos({ x: event.clientX, y: event.clientY });
    setShowPinSelector(true);
  };

  // Pin assignment
  const handlePinSelect = (componentId: string, pin: number) => {
    updateComponent(componentId, {
      properties: {
        ...components.find((c) => c.id === componentId)?.properties,
        pin,
      },
    } as any);
  };

  // Component rotation
  const handleRotateComponent = (componentId: string) => {
    const component = components.find((c) => c.id === componentId);
    if (!component) return;

    const currentRotation = (component.properties.rotation as number) || 0;
    updateComponent(componentId, {
      properties: {
        ...component.properties,
        rotation: (currentRotation + 90) % 360,
      },
    } as any);
  };

  // Component dragging handlers
  const handleComponentMouseDown = (componentId: string, e: React.MouseEvent) => {
    // Don't start dragging if we're clicking on the pin selector or property dialog
    if (showPinSelector || showPropertyDialog) return;

    e.stopPropagation();
    const component = components.find((c) => c.id === componentId);
    if (!component || !canvasRef.current) return;

    // Record click start for click vs drag detection
    setClickStartTime(Date.now());
    setClickStartPos({ x: e.clientX, y: e.clientY });

    // Get canvas position to convert viewport coords to canvas coords
    const canvasRect = canvasRef.current.getBoundingClientRect();

    // Calculate offset in canvas coordinate system
    setDraggedComponentId(componentId);
    setDragOffset({
      x: (e.clientX - canvasRect.left) - component.x,
      y: (e.clientY - canvasRect.top) - component.y,
    });
    setSelectedComponentId(componentId);
  };

  const handleCanvasMouseMove = (e: React.MouseEvent) => {
    if (!canvasRef.current) return;

    // Handle component dragging
    if (draggedComponentId) {
      const canvasRect = canvasRef.current.getBoundingClientRect();
      const newX = e.clientX - canvasRect.left - dragOffset.x;
      const newY = e.clientY - canvasRect.top - dragOffset.y;

      updateComponent(draggedComponentId, {
        x: Math.max(0, newX),
        y: Math.max(0, newY),
      } as any);
    }

    // Handle wire creation preview
    if (wireInProgress && canvasRef.current) {
      const canvasRect = canvasRef.current.getBoundingClientRect();
      const currentX = e.clientX - canvasRect.left;
      const currentY = e.clientY - canvasRect.top;
      updateWireInProgress(currentX, currentY);
    }
  };

  const handleCanvasMouseUp = (e: React.MouseEvent) => {
    if (draggedComponentId) {
      // Check if this was a click or a drag
      const timeDiff = Date.now() - clickStartTime;
      const posDiff = Math.sqrt(
        Math.pow(e.clientX - clickStartPos.x, 2) +
        Math.pow(e.clientY - clickStartPos.y, 2)
      );

      // If moved < 5px and time < 300ms, treat as click
      if (posDiff < 5 && timeDiff < 300) {
        const component = components.find((c) => c.id === draggedComponentId);
        if (component) {
          setPropertyDialogComponentId(draggedComponentId);
          setPropertyDialogPosition({ x: component.x, y: component.y });
          setShowPropertyDialog(true);
        }
      }

      // Recalculate wire positions after moving component
      recalculateAllWirePositions();
      setDraggedComponentId(null);
    }
  };

  // Wire creation via pin clicks
  const handlePinClick = (componentId: string, pinName: string, x: number, y: number) => {
    // Close property dialog when starting wire creation
    if (showPropertyDialog) {
      setShowPropertyDialog(false);
    }

    if (wireInProgress) {
      // Finish wire creation
      finishWireCreation({
        componentId,
        pinName,
        x,
        y,
      });
    } else {
      // Start wire creation
      startWireCreation({
        componentId,
        pinName,
        x,
        y,
      });
    }
  };

  // Keyboard handlers for wires
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && wireInProgress) {
        cancelWireCreation();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [wireInProgress, cancelWireCreation]);

  // Recalculate wire positions when components change (e.g., when loading an example)
  useEffect(() => {
    // Wait for components to render and pinInfo to be available
    // Use multiple retries to ensure pinInfo is ready
    const timers: ReturnType<typeof setTimeout>[] = [];

    // Try at 100ms, 300ms, and 500ms to ensure all components have rendered
    timers.push(setTimeout(() => recalculateAllWirePositions(), 100));
    timers.push(setTimeout(() => recalculateAllWirePositions(), 300));
    timers.push(setTimeout(() => recalculateAllWirePositions(), 500));

    return () => timers.forEach(t => clearTimeout(t));
  }, [components, recalculateAllWirePositions]);

  // Render component using dynamic renderer
  const renderComponent = (component: any) => {
    const metadata = registry.getById(component.metadataId);
    if (!metadata) {
      console.warn(`Metadata not found for component: ${component.metadataId}`);
      return null;
    }

    const isSelected = selectedComponentId === component.id;
    // Always show pins for better UX when creating wires
    const showPinsForComponent = true;

    return (
      <React.Fragment key={component.id}>
        <DynamicComponent
          id={component.id}
          metadata={metadata}
          properties={component.properties}
          x={component.x}
          y={component.y}
          isSelected={isSelected}
          onMouseDown={(e) => {
            // Only handle UI events when simulation is NOT running
            if (!running) {
              handleComponentMouseDown(component.id, e);
            }
          }}
          onDoubleClick={(e) => {
            // Only handle UI events when simulation is NOT running
            if (!running) {
              handleComponentDoubleClick(component.id, e);
            }
          }}
        />

        {/* Pin overlay for wire creation - hide when running */}
        {!running && (
          <PinOverlay
            componentId={component.id}
            componentX={component.x}
            componentY={component.y}
            onPinClick={handlePinClick}
            showPins={showPinsForComponent}
          />
        )}
      </React.Fragment>
    );
  };

  return (
    <div className="simulator-canvas-container">
      {/* Main Canvas */}
      <div className="simulator-canvas">
        <div className="canvas-header">
          <div className="canvas-header-left">
            {/* Status LED */}
            <span className={`status-dot ${running ? 'running' : 'stopped'}`} title={running ? 'Running' : 'Stopped'} />

            {/* Board selector */}
            <select
              className="board-selector"
              value={boardType}
              onChange={(e) => setBoardType(e.target.value as BoardType)}
              disabled={running}
              title="Select board"
            >
              {(Object.entries(BOARD_LABELS) as [BoardType, string][]).map(([type, label]) => (
                <option key={type} value={type}>{label}</option>
              ))}
            </select>
          </div>

          <div className="canvas-header-right">
            {/* Component count */}
            <span className="component-count" title={`${components.length} component${components.length !== 1 ? 's' : ''}`}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="7" width="20" height="14" rx="2" />
                <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
              </svg>
              {components.length}
            </span>

            {/* Add Component */}
            <button
              className="add-component-btn"
              onClick={() => setShowComponentPicker(true)}
              title="Add Component"
              disabled={running}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add
            </button>
          </div>
        </div>
        <div
          ref={canvasRef}
          className="canvas-content"
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
          onClick={() => setSelectedComponentId(null)}
          style={{ cursor: wireInProgress ? 'crosshair' : 'default' }}
        >
          {/* Wire Layer - Renders below all components */}
          <WireLayer />

          {/* Board visual — switches based on selected board type */}
          {boardType === 'arduino-uno' ? (
            <ArduinoUno
              x={ARDUINO_POSITION.x}
              y={ARDUINO_POSITION.y}
              led13={Boolean(components.find((c) => c.id === 'led-builtin')?.properties.state)}
            />
          ) : (
            <NanoRP2040
              x={ARDUINO_POSITION.x}
              y={ARDUINO_POSITION.y}
              ledBuiltIn={Boolean(components.find((c) => c.id === 'led-builtin')?.properties.state)}
            />
          )}

          {/* Board pin overlay */}
          <PinOverlay
            componentId={boardType === 'arduino-uno' ? 'arduino-uno' : 'nano-rp2040'}
            componentX={ARDUINO_POSITION.x}
            componentY={ARDUINO_POSITION.y}
            onPinClick={handlePinClick}
            showPins={true}
            wrapperOffsetX={0}
            wrapperOffsetY={0}
          />

          {/* Components using wokwi-elements */}
          <div className="components-area">{registryLoaded && components.map(renderComponent)}</div>
        </div>
      </div>

      {/* Pin Selector Modal */}
      {showPinSelector && selectedComponentId && (
        <PinSelector
          componentId={selectedComponentId}
          componentType={
            components.find((c) => c.id === selectedComponentId)?.metadataId || 'unknown'
          }
          currentPin={
            components.find((c) => c.id === selectedComponentId)?.properties.pin as number | undefined
          }
          onPinSelect={handlePinSelect}
          onClose={() => setShowPinSelector(false)}
          position={pinSelectorPos}
        />
      )}

      {/* Component Property Dialog */}
      {showPropertyDialog && propertyDialogComponentId && (() => {
        const component = components.find((c) => c.id === propertyDialogComponentId);
        const metadata = component ? registry.getById(component.metadataId) : null;
        if (!component || !metadata) return null;

        const element = document.getElementById(propertyDialogComponentId);
        const pinInfo = element ? (element as any).pinInfo : [];

        return (
          <ComponentPropertyDialog
            componentId={propertyDialogComponentId}
            componentMetadata={metadata}
            componentProperties={component.properties}
            position={propertyDialogPosition}
            pinInfo={pinInfo || []}
            onClose={() => setShowPropertyDialog(false)}
            onRotate={handleRotateComponent}
            onDelete={(id) => {
              removeComponent(id);
              setShowPropertyDialog(false);
            }}
          />
        );
      })()}

      {/* Component Picker Modal */}
      <ComponentPickerModal
        isOpen={showComponentPicker}
        onClose={() => setShowComponentPicker(false)}
        onSelectComponent={handleSelectComponent}
      />
    </div>
  );
};
