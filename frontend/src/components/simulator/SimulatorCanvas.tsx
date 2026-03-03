import { useSimulatorStore, ARDUINO_POSITION } from '../../store/useSimulatorStore';
import React, { useEffect, useState, useRef } from 'react';
import { ArduinoUno } from '../components-wokwi/ArduinoUno';
import { LED } from '../components-wokwi/LED';
import { Resistor } from '../components-wokwi/Resistor';
import { Pushbutton } from '../components-wokwi/Pushbutton';
import { Potentiometer } from '../components-wokwi/Potentiometer';
import { ComponentPalette } from './ComponentPalette';
import { PinSelector } from './PinSelector';
import { WireLayer } from './WireLayer';
import { PinOverlay } from './PinOverlay';
import type { ComponentTemplate } from '../../types/components';
import './SimulatorCanvas.css';

export const SimulatorCanvas = () => {
  const {
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

  // Component palette drag
  const [draggedTemplate, setDraggedTemplate] = useState<ComponentTemplate | null>(null);

  // Component selection
  const [selectedComponentId, setSelectedComponentId] = useState<string | null>(null);
  const [showPinSelector, setShowPinSelector] = useState(false);
  const [pinSelectorPos, setPinSelectorPos] = useState({ x: 0, y: 0 });

  // Component dragging state
  const [draggedComponentId, setDraggedComponentId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  // Pin visualization
  const [hoveredComponentId, setHoveredComponentId] = useState<string | null>(null);

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

    components.forEach((component) => {
      if (component.properties.pin !== undefined) {
        const unsubscribe = pinManager.onPinChange(
          component.properties.pin,
          (pin, state) => {
            // Update component state when pin changes
            updateComponentState(component.id, state);
            console.log(`Component ${component.id} on pin ${pin}: ${state ? 'HIGH' : 'LOW'}`);
          }
        );
        unsubscribers.push(unsubscribe);
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

  // Drag & drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (!draggedTemplate) return;

    const canvasRect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - canvasRect.left;
    const y = e.clientY - canvasRect.top;

    const newComponent = {
      id: `${draggedTemplate.type}-${Date.now()}`,
      type: draggedTemplate.type,
      x,
      y,
      properties: {
        ...draggedTemplate.defaultProperties,
        state: false,
      },
    };

    addComponent(newComponent as any);
    setDraggedTemplate(null);
  };

  // Component selection
  const handleComponentClick = (componentId: string, event: React.MouseEvent) => {
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

  // Component dragging handlers
  const handleComponentMouseDown = (componentId: string, e: React.MouseEvent) => {
    // Don't start dragging if we're clicking on the pin selector
    if (showPinSelector) return;

    e.stopPropagation();
    const component = components.find((c) => c.id === componentId);
    if (!component || !canvasRef.current) return;

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

  const handleCanvasMouseUp = () => {
    if (draggedComponentId) {
      // Recalculate wire positions after moving component
      recalculateAllWirePositions();
      setDraggedComponentId(null);
    }
  };

  // Wire creation via pin clicks
  const handlePinClick = (componentId: string, pinName: string, x: number, y: number) => {
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

  // Render component
  const renderComponent = (component: any) => {
    const isSelected = selectedComponentId === component.id;
    const isHovered = hoveredComponentId === component.id;
    const showPinsForComponent = isHovered || wireInProgress !== null;

    const commonProps = {
      id: component.id,
      x: 0,  // Position handled by wrapper div - don't double-position
      y: 0,
    };

    const wrapperStyle = {
      position: 'absolute' as const,
      left: `${component.x}px`,
      top: `${component.y}px`,
      cursor: draggedComponentId === component.id ? 'grabbing' : 'grab',
      border: isSelected ? '2px dashed #007acc' : '2px solid transparent',
      borderRadius: '4px',
      padding: '4px',
      userSelect: 'none' as const,
    };

    return (
      <React.Fragment key={component.id}>
        <div
          style={wrapperStyle}
          onClick={(e) => handleComponentClick(component.id, e)}
          onMouseDown={(e) => handleComponentMouseDown(component.id, e)}
          onMouseEnter={() => setHoveredComponentId(component.id)}
          onMouseLeave={() => setHoveredComponentId(null)}
        >
        {component.type === 'led' && (
          <>
            <LED
              {...commonProps}
              color={component.properties.color as any}
              value={component.properties.state || false}
            />
            <div className="component-label">
              {component.properties.pin !== undefined
                ? `Pin ${component.properties.pin}`
                : 'No pin'}
            </div>
          </>
        )}
        {component.type === 'resistor' && (
          <>
            <Resistor {...commonProps} value={component.properties.value || 220} />
            <div className="component-label">
              {component.properties.value || 220}Ω
            </div>
          </>
        )}
        {component.type === 'pushbutton' && (
          <>
            <Pushbutton
              {...commonProps}
              color={component.properties.color as any}
              pressed={component.properties.state || false}
            />
            <div className="component-label">
              {component.properties.pin !== undefined
                ? `Pin ${component.properties.pin}`
                : 'No pin'}
            </div>
          </>
        )}
        {component.type === 'potentiometer' && (
          <>
            <Potentiometer {...commonProps} value={component.properties.value || 50} />
            <div className="component-label">
              {component.properties.pin !== undefined
                ? `Pin A${component.properties.pin - 14}`
                : 'No pin'}
            </div>
          </>
        )}
        </div>

        {/* Pin overlay for wire creation */}
        <PinOverlay
          componentId={component.id}
          componentX={component.x}
          componentY={component.y}
          onPinClick={handlePinClick}
          showPins={showPinsForComponent}
        />
      </React.Fragment>
    );
  };

  return (
    <div className="simulator-canvas-container">
      {/* Component Palette */}
      <ComponentPalette onDragStart={setDraggedTemplate} />

      {/* Main Canvas */}
      <div className="simulator-canvas">
        <div className="canvas-header">
          <h3>Arduino Simulator</h3>
          <div className="canvas-header-info">
            <span className={`status-indicator ${running ? 'running' : 'stopped'}`}>
              {running ? 'Running' : 'Stopped'}
            </span>
            <span className="component-count">{components.length} components</span>
          </div>
        </div>
        <div
          ref={canvasRef}
          className="canvas-content"
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
          onClick={() => setSelectedComponentId(null)}
          style={{ cursor: wireInProgress ? 'crosshair' : 'default' }}
        >
          {/* Wire Layer - Renders below all components */}
          <WireLayer />

          {/* Arduino Uno Board using wokwi-elements */}
          <ArduinoUno
            x={ARDUINO_POSITION.x}
            y={ARDUINO_POSITION.y}
            led13={components.find((c) => c.id === 'led-builtin')?.properties.state || false}
          />

          {/* Arduino pin overlay */}
          <PinOverlay
            componentId="arduino-uno"
            componentX={ARDUINO_POSITION.x}
            componentY={ARDUINO_POSITION.y}
            onPinClick={handlePinClick}
            showPins={wireInProgress !== null}
          />

          {/* Components using wokwi-elements */}
          <div className="components-area">{components.map(renderComponent)}</div>
        </div>
      </div>

      {/* Pin Selector Modal */}
      {showPinSelector && selectedComponentId && (
        <PinSelector
          componentId={selectedComponentId}
          componentType={
            components.find((c) => c.id === selectedComponentId)?.type || 'unknown'
          }
          currentPin={
            components.find((c) => c.id === selectedComponentId)?.properties.pin
          }
          onPinSelect={handlePinSelect}
          onClose={() => setShowPinSelector(false)}
          position={pinSelectorPos}
        />
      )}
    </div>
  );
};
