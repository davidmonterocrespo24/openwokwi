import { useSimulatorStore, getEsp32Bridge } from '../../store/useSimulatorStore';
import { useElectricalStore } from '../../store/useElectricalStore';
import { openDeviceGateway } from '../../lib/openDeviceGateway';
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Undo2, Redo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ESP32_ADC_PIN_MAP } from '../velxio-components/Esp32Element';
import { ComponentPickerModal } from '../ComponentPickerModal';
import { ComponentPropertyDialog } from './ComponentPropertyDialog';
import { CustomChipDialog } from '../customChips/CustomChipDialog';
import { SensorControlPanel } from './SensorControlPanel';
import { SENSOR_CONTROLS } from '../../simulation/sensorControlConfig';
import { DynamicComponent, createComponentFromMetadata } from '../DynamicComponent';
import { InstrumentComponent } from '../components-instruments/InstrumentComponent';
import { ComponentRegistry } from '../../services/ComponentRegistry';
import { getTabSessionId } from '../../simulation/Esp32Bridge';
import { CameraToggle } from './CameraToggle';
import { WireLayer } from './WireLayer';
import type { SegmentHandle, WaypointHandle, AlignmentGuide } from './WireLayer';
import { ElectricalOverlay } from '../analog-ui/ElectricalOverlay';
import { BoardOnCanvas } from './BoardOnCanvas';
import { CanvasMinimap } from './CanvasMinimap';
import { PartSimulationRegistry } from '../../simulation/parts';
import { PROPERTY_CHANGE_EVENT, type PropertyChangeDetail } from '../../simulation/parts/partUtils';
import { mountDigitalGateEngine } from '../../simulation/digital/digitalGateController';
import { isSpiceMapped } from '../../simulation/spice/componentToSpice';
import { PinOverlay } from './PinOverlay';
import { SeatedPinMarkers } from './SeatedPinMarkers';
import { calculatePinPosition } from '../../utils/pinPositionCalculator';
import { isBoardComponent, boardPinToNumber } from '../../utils/boardPinMapping';
import { isBreadboard } from '../../utils/breadboardNets';
import {
  autoWireColor,
  railWireColor,
  WIRE_JUMPER_PALETTE,
  WIRE_KEY_COLORS,
  expandOrthogonalPoints,
} from '../../utils/wireUtils';
import { findWireAtHole, resolveFreeHole } from '../../utils/breadboardOccupancy';
import {
  isAutoVerticalPart,
  isOverBreadboard,
  seatOnDrop,
  snapPositionToBreadboard,
} from '../../utils/breadboardSnap';
import {
  findWireNearPoint,
  findSegmentNearPoint,
  getRenderedPoints,
  getRenderedSegments,
  moveSegment,
  renderedToWaypoints,
  renderedPointsToPath,
  simplifyOrthogonalPath,
  insertWaypointAtSegment,
  collectAlignmentTargets,
  addOwnWireAlignmentTargets,
  snapToNearest,
} from '../../utils/wireHitDetection';
import { useIsCoarsePointer } from '../../utils/useTouchDevice';
import type { ComponentMetadata } from '../../types/component-metadata';
import type { BoardKind } from '../../types/board';
import { BOARD_KIND_FQBN, boardDisplayName } from '../../types/board';
import { boardGateDecision, proBoardFeatureName, triggerProUpgradePrompt } from '../../lib/proBoardGate';
import { FlashModal } from './FlashModal';
import { isTauri as isTauriRuntimeFn } from '../../desktop/tauriBridge';
import { isEsp32Family } from '../../types/boardOptions';
import { BoardOptionsModal } from './BoardOptionsModal';
import { useOscilloscopeStore } from '../../store/useOscilloscopeStore';
import {
  trackSelectBoard,
  trackAddComponent,
  trackCreateWire,
  trackToggleSerialMonitor,
} from '../../utils/analytics';
import { SelectionActionBar } from './SelectionActionBar';
import { WireModeBanner } from './WireModeBanner';
import { PinPickerDialog } from './PinPickerDialog';
import { useButtonKeyBindings } from '../../hooks/useButtonKeyBindings';
import './SimulatorCanvas.css';

/** World-units of tolerance for alignment snap (scales with zoom). */
const ALIGN_SNAP_PX = 6;

/**
 * Large-bodied display parts whose face should occlude wires when the part is
 * seated on a breadboard — the flat canvas has no depth, so bridge wires
 * routed to holes UNDER the body would otherwise paint over the readout.
 * Matches both the metadata ids (`7segment`, `ssd1306`, …) and the `wokwi-`/
 * `velxio-` element-name variants. Thin two-pin parts are deliberately absent.
 */
const DISPLAY_BODY_METADATA_RE =
  /(7segment|led-matrix|max7219|neopixel-matrix|ssd1306|oled|ili9341|lcd1602|lcd2004|led-ring)/i;

/** Long-press duration for touch context menu (ms). */
const LONG_PRESS_MS = 500;

/** Max movement during long-press before it cancels (px). */
const LONG_PRESS_MOVE_TOLERANCE = 8;

/**
 * Distance (px, screen) a touch must drift before a passthrough-to-
 * wokwi-element touch is promoted to a component drag. Set just above
 * normal tap jitter so accidental drags from a finger press are rare.
 */
const DRAG_PROMOTE_THRESHOLD_PX = 8;

/** Check if a board kind is an ESP32-family board. */
function isEsp32Kind(kind: BoardKind): boolean {
  return (
    kind.startsWith('esp32') ||
    kind === 'xiao-esp32-s3' ||
    kind === 'xiao-esp32-c3' ||
    kind === 'arduino-nano-esp32' ||
    kind === 'aitewinrobot-esp32c3-supermini' ||
    kind === 'esp32-cam' ||
    kind === 'wemos-lolin32-lite' ||
    kind === 'esp32-devkit-c-v4'
  );
}

interface SimulatorCanvasProps {
  /**
   * Optional DOM element to portal the canvas header (board selector,
   * Serial/Scope toggles, zoom controls, Add component button) into. When
   * provided, the header renders into the slot instead of in place — used by
   * EditorPage to merge it with the editor toolbar into a single full-width
   * top bar that doesn't reflow when the editor/canvas splitter moves.
   */
  headerSlot?: HTMLElement | null;
}

export const SimulatorCanvas = ({ headerSlot }: SimulatorCanvasProps = {}) => {
  const { t } = useTranslation();
  const isTouchDevice = useIsCoarsePointer();
  // Mirror to a ref so the long-lived touch handler effect (deps deliberately
  // narrow to avoid rebinding listeners on every render) can read the latest
  // value without listing it as a dep.
  const isTouchDeviceRef = useRef(isTouchDevice);
  isTouchDeviceRef.current = isTouchDevice;
  const {
    boards,
    activeBoardId,
    setBoardPosition,
    addBoard,
    components,
    running,
    sensorResetNonce,
    pinManager,
    initSimulator,
    updateComponentState,
    removeBoard,
    updateBoard,
    updateComponent,
    serialMonitorOpen,
    toggleSerialMonitor,
  } = useSimulatorStore();
  // `addComponent` / `removeComponent` / `removeWire` are no longer used here —
  // every user-initiated mutation routes through the record* actions below
  // so it can be undone. Raw mutators are still available for transient
  // operations (e.g. drag preview frames) but those don't live in this file.

  // Active board (for WiFi/BLE status display)
  const activeBoard = boards.find((b) => b.id === activeBoardId) ?? null;

  // Keyboard → pushbutton bindings (component `key` property).
  useButtonKeyBindings(components);

  // Legacy derived values for components that still use them
  const boardType = useSimulatorStore((s) => s.boardType);
  const boardPosition = useSimulatorStore((s) => s.boardPosition);

  // Wire management from store
  const startWireCreation = useSimulatorStore((s) => s.startWireCreation);
  const updateWireInProgress = useSimulatorStore((s) => s.updateWireInProgress);
  const addWireWaypoint = useSimulatorStore((s) => s.addWireWaypoint);
  const setWireInProgressColor = useSimulatorStore((s) => s.setWireInProgressColor);
  const finishWireCreation = useSimulatorStore((s) => s.finishWireCreation);
  const cancelWireCreation = useSimulatorStore((s) => s.cancelWireCreation);
  const wireInProgress = useSimulatorStore((s) => s.wireInProgress);
  const recalculateAllWirePositions = useSimulatorStore((s) => s.recalculateAllWirePositions);
  const selectedWireId = useSimulatorStore((s) => s.selectedWireId);
  const setSelectedWire = useSimulatorStore((s) => s.setSelectedWire);
  const updateWire = useSimulatorStore((s) => s.updateWire);
  const wires = useSimulatorStore((s) => s.wires);

  // Recorded canvas actions — these wrap the raw mutators above with an
  // undoable CanvasCommand. Use these at the *commit* point of a user
  // interaction (drag-end, click finish, picker confirm); use the raw
  // mutators for transient state during the interaction (drag preview).
  const recordAddComponent = useSimulatorStore((s) => s.recordAddComponent);
  const recordRemoveComponent = useSimulatorStore((s) => s.recordRemoveComponent);
  const recordMove = useSimulatorStore((s) => s.recordMove);
  const recordRotate = useSimulatorStore((s) => s.recordRotate);
  const recordSetProperty = useSimulatorStore((s) => s.recordSetProperty);
  const recordRemoveWire = useSimulatorStore((s) => s.recordRemoveWire);
  const recordUpdateWire = useSimulatorStore((s) => s.recordUpdateWire);
  // Subscribe to history shape so the undo/redo buttons reactively
  // enable/disable and their tooltips reflect the next command.
  const history = useSimulatorStore((s) => s.history);
  const historyIndex = useSimulatorStore((s) => s.historyIndex);
  const undo = useSimulatorStore((s) => s.undo);
  const redo = useSimulatorStore((s) => s.redo);

  // Oscilloscope
  const oscilloscopeOpen = useOscilloscopeStore((s) => s.open);
  const toggleOscilloscope = useOscilloscopeStore((s) => s.toggleOscilloscope);

  // ESP32 crash notification
  const esp32CrashBoardId = useSimulatorStore((s) => s.esp32CrashBoardId);
  const dismissEsp32Crash = useSimulatorStore((s) => s.dismissEsp32Crash);

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

  // Hover tracking — drives the conditional pin overlay so the canvas isn't
  // permanently covered in pin chips. Pins show for the hovered/selected
  // component or board, plus all elements while a wire is in progress.
  const [hoveredComponentId, setHoveredComponentId] = useState<string | null>(null);
  const [hoveredBoardId, setHoveredBoardId] = useState<string | null>(null);

  // Touch-friendly pin picker — shown when the user taps a component or board
  // body (not a tiny pin overlay) and we want to let them pick a pin from a
  // list. `kind` distinguishes board vs component so we can pull the right
  // metadata for the dialog title.
  const [pinPicker, setPinPicker] = useState<
    { kind: 'component' | 'board'; targetId: string } | null
  >(null);

  // Component property dialog
  const [showPropertyDialog, setShowPropertyDialog] = useState(false);
  const [propertyDialogComponentId, setPropertyDialogComponentId] = useState<string | null>(null);
  /** When non-null, the Custom Chip designer dialog is open for this component. */
  const [customChipComponentId, setCustomChipComponentId] = useState<string | null>(null);
  const [propertyDialogPosition, setPropertyDialogPosition] = useState({ x: 0, y: 0 });

  // Sensor control panel (shown instead of property dialog for sensor components during simulation)
  const [sensorControlComponentId, setSensorControlComponentId] = useState<string | null>(null);
  const [sensorControlMetadataId, setSensorControlMetadataId] = useState<string | null>(null);

  // Board built-in LED states (pin 13 for AVR, GPIO25 for RP2040, etc.)
  // Tracks directly from pinManager — independent of any led-builtin component.
  const [boardLedStates, setBoardLedStates] = useState<Record<string, boolean>>({});

  // Board context menu (right-click)
  const [boardContextMenu, setBoardContextMenu] = useState<{
    boardId: string;
    x: number;
    y: number;
  } | null>(null);
  // Right-click context menu for a wire (color swatches + delete).
  const [wireContextMenu, setWireContextMenu] = useState<{
    wireId: string;
    x: number;
    y: number;
  } | null>(null);
  // Board removal confirmation dialog
  const [boardToRemove, setBoardToRemove] = useState<string | null>(null);
  // Board Options modal — id of the board whose options are being edited.
  const [boardOptionsModalFor, setBoardOptionsModalFor] = useState<string | null>(null);
  // Hardware-flash modal: set to a board id when the user picks
  // "Flash to real board" from the board context menu. The FlashModal
  // owns its own port-picker / progress UI; we just gate the mount.
  const [flashModalFor, setFlashModalFor] = useState<string | null>(null);
  // Cached Tauri-runtime probe — used to gate the "Flash to real
  // board" menu item in web builds. Hooks-stable across re-renders.
  const isTauriRuntime = useRef(isTauriRuntimeFn()).current;

  // Click vs drag detection
  const [clickStartTime, setClickStartTime] = useState<number>(0);
  const [clickStartPos, setClickStartPos] = useState({ x: 0, y: 0 });

  // Component dragging state
  const [draggedComponentId, setDraggedComponentId] = useState<string | null>(null);
  // Captures (x, y) of the dragged component at mousedown so a drag-end
  // can record the diff as a single undoable Move. Boards are intentionally
  // skipped — board moves don't go through component history.
  const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  // Canvas ref for coordinate calculations
  const canvasRef = useRef<HTMLDivElement>(null);

  // Pan & zoom state
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  // Use refs during active pan to avoid setState lag
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ mouseX: 0, mouseY: 0, panX: 0, panY: 0 });
  const panRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);

  // Board-less SPICE circuits (analog / digital examples with no MCU on
  // the canvas) have no concept of a board to "start", so `running` is
  // always false. But the simulation IS effectively live the moment the
  // engine has solved at least once — switches and buttons should toggle
  // their own state on click instead of opening the property dialog.
  // We treat board-less + un-paused as "interaction-running" so the same
  // gating logic that suppresses the dialog for MCU-running mode also
  // covers board-less circuits — BUT only when SPICE has actually
  // engaged (submittedNetlist != ''). Without that extra check, deleting
  // the only board on a normal Arduino+LED circuit dropped boards to 0
  // and silently flipped every remaining component to "running" mode,
  // which suppresses the property dialog and makes them appear
  // unresponsive to clicks (issue #211).
  const electricalPaused = useElectricalStore((s) => s.paused);
  const electricalEngaged = useElectricalStore((s) => s.submittedNetlist !== '');
  const interactionRunning =
    running || (boards.length === 0 && electricalEngaged && !electricalPaused);

  // Refs that mirror state/props for use inside touch event closures
  // (touch listeners are added imperatively and can't access current React state)
  const runningRef = useRef(running);
  runningRef.current = running;
  const interactionRunningRef = useRef(interactionRunning);
  interactionRunningRef.current = interactionRunning;

  // When a run starts the canvas becomes interact-only — drop any edit
  // selection so leftover wire/segment handles don't linger over the circuit.
  useEffect(() => {
    if (interactionRunning) {
      setSelectedWire(null);
      setSelectedComponentId(null);
    }
  }, [interactionRunning, setSelectedWire]);

  // Lets the touch handlers (defined in an earlier effect closure) reach the
  // drop-time breadboard seating declared further down.
  const seatDroppedComponentRef = useRef<(componentId: string) => void>(() => {});

  const componentsRef = useRef(components);
  componentsRef.current = components;
  const boardPositionRef = useRef(boardPosition);
  boardPositionRef.current = boardPosition;
  const boardsRef = useRef(boards);
  boardsRef.current = boards;

  // Wire interaction state (canvas-level hit detection — bypasses SVG pointer-events issues)
  const [hoveredWireId, setHoveredWireId] = useState<string | null>(null);
  const [segmentDragPreview, setSegmentDragPreview] = useState<{
    wireId: string;
    overridePath: string;
  } | null>(null);
  const segmentDragRef = useRef<{
    wireId: string;
    segIndex: number;
    axis: 'horizontal' | 'vertical';
    renderedPts: { x: number; y: number }[];
    isDragging: boolean;
  } | null>(null);
  /** Active waypoint drag (free 2D move of a single bend point). */
  const waypointDragRef = useRef<{
    wireId: string;
    waypointIndex: number;
    originalWaypoints: { x: number; y: number }[];
    isDragging: boolean;
  } | null>(null);
  const [waypointDragPreview, setWaypointDragPreview] = useState<{
    wireId: string;
    waypoints: { x: number; y: number }[];
  } | null>(null);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);
  /** Set to true during mouseup if a segment/waypoint drag committed, so onClick can skip selection. */
  const segmentDragJustCommittedRef = useRef(false);
  // Set when the mouse-up handler already resolved this click into a wire
  // selection (click on the breadboard body over a wire) — the bubbled
  // canvas onClick must not re-toggle that selection.
  const wireSelectJustHandledRef = useRef(false);
  const wiresRef = useRef(wires);
  wiresRef.current = wires;

  // Compute midpoint handles for the selected wire's segments
  const segmentHandles = React.useMemo<SegmentHandle[]>(() => {
    if (!selectedWireId) return [];
    const wire = wires.find((w) => w.id === selectedWireId);
    if (!wire) return [];
    return getRenderedSegments(wire).map((seg, i) => ({
      segIndex: i,
      axis: seg.axis,
      mx: (seg.x1 + seg.x2) / 2,
      my: (seg.y1 + seg.y2) / 2,
    }));
  }, [selectedWireId, wires]);

  // Compute bend-point handles (one per waypoint) for the selected wire
  const waypointHandles = React.useMemo<WaypointHandle[]>(() => {
    if (!selectedWireId) return [];
    const wire = wires.find((w) => w.id === selectedWireId);
    if (!wire) return [];
    // While the user is dragging a waypoint, render handles at the live preview
    // positions so the dot tracks the cursor instead of jumping at commit.
    const activeDrag = waypointDragPreview?.wireId === wire.id ? waypointDragPreview : null;
    const wps = activeDrag ? activeDrag.waypoints : (wire.waypoints ?? []);
    return wps.map((wp, i) => ({ index: i, x: wp.x, y: wp.y }));
  }, [selectedWireId, wires, waypointDragPreview]);

  // Touch-specific state refs (for single-finger drag and pinch-to-zoom)
  const touchDraggedComponentIdRef = useRef<string | null>(null);
  const touchDragOffsetRef = useRef({ x: 0, y: 0 });
  const touchClickStartTimeRef = useRef(0);
  const touchClickStartPosRef = useRef({ x: 0, y: 0 });
  const pinchStartDistRef = useRef(0);
  const pinchStartZoomRef = useRef(1);
  const pinchStartMidRef = useRef({ x: 0, y: 0 });
  const pinchStartPanRef = useRef({ x: 0, y: 0 });

  // Refs for touch-based wire creation, selection, and interactive passthrough
  const wireInProgressRef = useRef(wireInProgress);
  wireInProgressRef.current = wireInProgress;
  const selectedWireIdRef = useRef(selectedWireId);
  selectedWireIdRef.current = selectedWireId;
  const touchPassthroughRef = useRef(false);
  // While `touchPassthroughRef` is true (touch let through to an interactive
  // wokwi-element while the simulation runs), we still remember which
  // component the touch started on. If the finger drifts past
  // DRAG_PROMOTE_THRESHOLD_PX, we cancel the passthrough and start a real
  // drag — so the user can rearrange interactive parts live without first
  // pausing the simulation.
  const pendingTouchDragRef = useRef<
    { componentId: string; startX: number; startY: number } | null
  >(null);
  const touchOnPinRef = useRef(false);
  const lastTapTimeRef = useRef(0);

  // Long-press (touch-equivalent of right-click) — opens board context menu on
  // touch devices since right-click isn't available there.
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  // Convert viewport coords to world (canvas) coords
  const toWorld = useCallback((screenX: number, screenY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: screenX, y: screenY };
    return {
      x: (screenX - rect.left - panRef.current.x) / zoomRef.current,
      y: (screenY - rect.top - panRef.current.y) / zoomRef.current,
    };
  }, []);

  // Initialize simulator on mount
  useEffect(() => {
    initSimulator();
  }, [initSimulator]);

  // Runtime parts (pots, switches, sensor panels) emit
  // `velxio:property-change` instead of writing the store directly — one
  // listener here routes every mutation through `updateComponent()`, which
  // is the same path the Property Dialog uses. Keeps parts decoupled from
  // Zustand and guarantees the SPICE netlist memo invalidates on every
  // user-driven property change.
  useEffect(() => {
    const onPropertyChange = (evt: Event) => {
      const { componentId, propName, value } = (evt as CustomEvent<PropertyChangeDetail>).detail;
      const state = useSimulatorStore.getState();
      const comp = state.components.find((c) => c.id === componentId);
      if (!comp) return;
      if (String(comp.properties?.[propName]) === String(value)) return;
      state.updateComponent(componentId, {
        properties: { ...comp.properties, [propName]: value },
      });
    };
    window.addEventListener(PROPERTY_CHANGE_EVENT, onPropertyChange);
    return () => window.removeEventListener(PROPERTY_CHANGE_EVENT, onPropertyChange);
  }, []);

  // Digital-gate engine (project/digital-gate-engine): when ?digitalgates=on and
  // the board-less circuit is all-digital, evaluate the logic gates on the
  // event-driven settle kernel and paint the LEDs, instead of ngspice B-sources.
  // No-op when the flag is off (default).
  useEffect(() => mountDigitalGateEngine(), []);

  // Auto-start/stop Pi bridges when simulation state changes
  const startBoard = useSimulatorStore((s) => s.startBoard);
  const stopBoard = useSimulatorStore((s) => s.stopBoard);
  useEffect(() => {
    const remoteBoards = boards.filter(
      (b) =>
        b.boardKind === 'raspberry-pi-3' ||
        b.boardKind === 'raspberry-pi-4' ||
        b.boardKind === 'raspberry-pi-5' ||
        b.boardKind === 'esp32' ||
        b.boardKind === 'esp32-s3' ||
        b.boardKind === 'esp32-c3',
    );
    remoteBoards.forEach((b) => {
      if (running && !b.running) startBoard(b.id);
      else if (!running && b.running) stopBoard(b.id);
    });
  }, [running, boards, startBoard, stopBoard]);

  // Attach wheel listener as non-passive so preventDefault() works
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const newZoom = Math.min(5, Math.max(0.1, zoomRef.current * factor));
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const worldX = (mx - panRef.current.x) / zoomRef.current;
      const worldY = (my - panRef.current.y) / zoomRef.current;
      const newPan = { x: mx - worldX * newZoom, y: my - worldY * newZoom };
      zoomRef.current = newZoom;
      panRef.current = newPan;
      setZoom(newZoom);
      setPan(newPan);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Attach touch listeners as non-passive so preventDefault() works, enabling
  // single-finger pan, component drag, wire creation/selection, and two-finger pinch-to-zoom.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      // Reset per-gesture flags
      touchOnPinRef.current = false;
      touchPassthroughRef.current = false;
      pendingTouchDragRef.current = null;
      pinchStartDistRef.current = 0;

      if (e.touches.length === 2) {
        e.preventDefault();
        // Cancel wire in progress and any pending long-press on two-finger gesture
        cancelLongPress();
        if (wireInProgressRef.current) {
          useSimulatorStore.getState().cancelWireCreation();
        }
        // Cancel any active drag/pan and prepare zoom
        isPanningRef.current = false;
        touchDraggedComponentIdRef.current = null;

        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchStartDistRef.current = Math.sqrt(dx * dx + dy * dy);
        pinchStartZoomRef.current = zoomRef.current;
        pinchStartPanRef.current = { ...panRef.current };

        const rect = el.getBoundingClientRect();
        pinchStartMidRef.current = {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top,
        };
        return;
      }

      if (e.touches.length !== 1) return;
      const touch = e.touches[0];

      // Identify what element was touched
      const target = document.elementFromPoint(touch.clientX, touch.clientY);

      // ── 1. Pin overlay → let pin's onTouchEnd React handler call handlePinClick ──
      if (target?.closest('[data-pin-overlay]')) {
        e.preventDefault();
        touchOnPinRef.current = true;
        return;
      }

      // ── 1b. Wire segment/waypoint handle → let WireLayer's React handler claim the drag.
      // We must skip the canvas-level pan/drag setup so the handle drag works in isolation.
      if (target?.closest('[data-wire-handle]')) {
        e.preventDefault();
        touchPassthroughRef.current = true;
        return;
      }

      // ── 2. Interactive web component during simulation → let browser synthesize mouse events ──
      //    (potentiometer knobs, button presses, etc. need mousedown/mouseup synthesis)
      //    touch-action:none on .canvas-content already prevents browser scroll/zoom.
      // Board-less SPICE circuits piggy-back on the same path so a tap on
      // a slide-switch reaches the wokwi element and triggers its toggle.
      // We still remember the starting position + component id so that if
      // the finger drifts past DRAG_PROMOTE_THRESHOLD_PX onTouchMove can
      // cancel the passthrough and start a real drag, letting the user
      // rearrange interactive parts live without pausing the simulation.
      if (interactionRunningRef.current) {
        const webComp = target?.closest('.web-component-container');
        if (webComp) {
          touchPassthroughRef.current = true;
          const componentWrapper = target?.closest('[data-component-id]') as HTMLElement | null;
          const cid = componentWrapper?.getAttribute('data-component-id') || null;
          pendingTouchDragRef.current = cid
            ? { componentId: cid, startX: touch.clientX, startY: touch.clientY }
            : null;
          // Don't preventDefault → browser synthesizes mouse events for the component
          return;
        }
      }

      e.preventDefault();

      touchClickStartTimeRef.current = Date.now();
      touchClickStartPosRef.current = { x: touch.clientX, y: touch.clientY };

      // ── 3. Wire in progress → track for waypoint, update preview ──
      if (wireInProgressRef.current) {
        const world = toWorld(touch.clientX, touch.clientY);
        useSimulatorStore.getState().updateWireInProgress(world.x, world.y);
        // Don't start pan/drag — let touchmove update wire preview, touchend add waypoint
        return;
      }

      // ── 4. Component detection ──
      const componentWrapper = target?.closest('[data-component-id]') as HTMLElement | null;
      const boardOverlay = target?.closest('[data-board-overlay]') as HTMLElement | null;

      if (componentWrapper) {
        const componentId = componentWrapper.getAttribute('data-component-id');
        if (componentId) {
          const component = componentsRef.current.find((c) => c.id === componentId);
          if (component) {
            const world = toWorld(touch.clientX, touch.clientY);
            touchDraggedComponentIdRef.current = componentId;
            touchDragOffsetRef.current = {
              x: world.x - component.x,
              y: world.y - component.y,
            };
            setSelectedComponentId(componentId);
          }
        }
      } else if (boardOverlay && !runningRef.current) {
        // ── 5. Board overlay: use multi-board path ──
        const boardId = boardOverlay.getAttribute('data-board-id');
        const storeBoards = useSimulatorStore.getState().boards;
        const boardInstance = boardId ? storeBoards.find((b) => b.id === boardId) : null;
        if (boardInstance) {
          const world = toWorld(touch.clientX, touch.clientY);
          touchDraggedComponentIdRef.current = `__board__:${boardId}`;
          touchDragOffsetRef.current = {
            x: world.x - boardInstance.x,
            y: world.y - boardInstance.y,
          };

          // Schedule long-press to open the board context menu (touch
          // equivalent of right-click). Cancelled if the user moves enough
          // to start a drag, ends touch quickly, or starts a pinch.
          longPressFiredRef.current = false;
          cancelLongPress();
          const pressX = touch.clientX;
          const pressY = touch.clientY;
          const targetBoardId = boardInstance.id;
          longPressTimerRef.current = setTimeout(() => {
            longPressFiredRef.current = true;
            // Cancel the implicit drag so finger lifting after the menu opens
            // doesn't also fire the short-tap "set active board" branch.
            touchDraggedComponentIdRef.current = null;
            setBoardContextMenu({ boardId: targetBoardId, x: pressX, y: pressY });
          }, LONG_PRESS_MS);
        } else {
          // Fallback to legacy single board
          const board = boardPositionRef.current;
          const world = toWorld(touch.clientX, touch.clientY);
          touchDraggedComponentIdRef.current = '__board__';
          touchDragOffsetRef.current = {
            x: world.x - board.x,
            y: world.y - board.y,
          };
        }
      } else {
        // ── 6. Empty canvas → start pan ──
        isPanningRef.current = true;
        panStartRef.current = {
          mouseX: touch.clientX,
          mouseY: touch.clientY,
          panX: panRef.current.x,
          panY: panRef.current.y,
        };
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      // Let interactive components handle their own touch (potentiometer drag, etc.)
      // — UNLESS the finger has drifted past DRAG_PROMOTE_THRESHOLD_PX,
      // in which case we cancel the passthrough and start a real component
      // drag. Lets users rearrange parts during simulation without pausing.
      if (touchPassthroughRef.current) {
        const pending = pendingTouchDragRef.current;
        if (pending && e.touches.length === 1) {
          const t = e.touches[0];
          const dx = t.clientX - pending.startX;
          const dy = t.clientY - pending.startY;
          if (dx * dx + dy * dy > DRAG_PROMOTE_THRESHOLD_PX * DRAG_PROMOTE_THRESHOLD_PX) {
            const component = componentsRef.current.find((c) => c.id === pending.componentId);
            if (component) {
              const world = toWorld(t.clientX, t.clientY);
              touchDraggedComponentIdRef.current = pending.componentId;
              touchDragOffsetRef.current = {
                x: world.x - component.x,
                y: world.y - component.y,
              };
              // Snapshot the drag start position so touchend can fold the
              // move into a single undoable Move command, mirroring the
              // mouse-drag path.
              dragStartPosRef.current = { x: component.x, y: component.y };
              touchClickStartTimeRef.current = Date.now();
              touchClickStartPosRef.current = { x: t.clientX, y: t.clientY };
              // Release any pending press the wokwi-element registered when
              // the browser synthesized the initial mousedown at touchstart.
              // Without this the interactive part (button, switch knob) stays
              // visually held until the user taps it again.
              const target = document.elementFromPoint(pending.startX, pending.startY);
              if (target) {
                target.dispatchEvent(
                  new MouseEvent('mouseup', {
                    bubbles: true,
                    cancelable: true,
                    clientX: pending.startX,
                    clientY: pending.startY,
                  }),
                );
                target.dispatchEvent(
                  new MouseEvent('mouseleave', { bubbles: false }),
                );
              }
            }
            touchPassthroughRef.current = false;
            pendingTouchDragRef.current = null;
            e.preventDefault();
            // Fall through to normal touch-drag handling below.
          } else {
            return;
          }
        } else {
          return;
        }
      }
      // Pin touch: no move processing needed
      if (touchOnPinRef.current) {
        e.preventDefault();
        return;
      }

      // Cancel pending long-press if the finger drifts beyond tolerance.
      if (longPressTimerRef.current && e.touches.length === 1) {
        const t = e.touches[0];
        const dx = t.clientX - touchClickStartPosRef.current.x;
        const dy = t.clientY - touchClickStartPosRef.current.y;
        if (dx * dx + dy * dy > LONG_PRESS_MOVE_TOLERANCE * LONG_PRESS_MOVE_TOLERANCE) {
          cancelLongPress();
        }
      }

      e.preventDefault();

      if (e.touches.length === 2 && pinchStartDistRef.current > 0) {
        // ── Two-finger pinch: update zoom ──
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const scale = dist / pinchStartDistRef.current;
        const newZoom = Math.min(5, Math.max(0.1, pinchStartZoomRef.current * scale));

        const mid = pinchStartMidRef.current;
        const startPan = pinchStartPanRef.current;
        const startZoom = pinchStartZoomRef.current;
        const worldX = (mid.x - startPan.x) / startZoom;
        const worldY = (mid.y - startPan.y) / startZoom;
        const newPan = {
          x: mid.x - worldX * newZoom,
          y: mid.y - worldY * newZoom,
        };

        zoomRef.current = newZoom;
        panRef.current = newPan;
        const worldEl = el.querySelector('.canvas-world') as HTMLElement | null;
        if (worldEl) {
          worldEl.style.transform = `translate(${newPan.x}px, ${newPan.y}px) scale(${newZoom})`;
        }
        return;
      }

      if (e.touches.length !== 1) return;
      const touch = e.touches[0];

      // ── Segment drag (wire editing) via touch ──
      if (segmentDragRef.current) {
        const world = toWorld(touch.clientX, touch.clientY);
        const sd = segmentDragRef.current;
        sd.isDragging = true;
        const newValue = sd.axis === 'horizontal' ? world.y : world.x;
        const newPts = moveSegment(sd.renderedPts, sd.segIndex, sd.axis, newValue);
        const overridePath = renderedPointsToPath(newPts);
        setSegmentDragPreview({ wireId: sd.wireId, overridePath });
        return;
      }

      // ── Wire preview: update position as finger moves ──
      if (
        wireInProgressRef.current &&
        !isPanningRef.current &&
        !touchDraggedComponentIdRef.current
      ) {
        const world = toWorld(touch.clientX, touch.clientY);
        useSimulatorStore.getState().updateWireInProgress(world.x, world.y);
        return;
      }

      if (isPanningRef.current) {
        // ── Single finger pan ──
        const dx = touch.clientX - panStartRef.current.mouseX;
        const dy = touch.clientY - panStartRef.current.mouseY;
        const newPan = {
          x: panStartRef.current.panX + dx,
          y: panStartRef.current.panY + dy,
        };
        panRef.current = newPan;
        const worldEl = el.querySelector('.canvas-world') as HTMLElement | null;
        if (worldEl) {
          worldEl.style.transform = `translate(${newPan.x}px, ${newPan.y}px) scale(${zoomRef.current})`;
        }
      } else if (touchDraggedComponentIdRef.current) {
        // ── Single finger component/board drag ──
        const world = toWorld(touch.clientX, touch.clientY);
        const touchId = touchDraggedComponentIdRef.current;
        if (touchId && touchId.startsWith('__board__:')) {
          const boardId = touchId.slice('__board__:'.length);
          setBoardPosition(
            {
              x: world.x - touchDragOffsetRef.current.x,
              y: world.y - touchDragOffsetRef.current.y,
            },
            boardId,
          );
        } else if (touchId === '__board__') {
          setBoardPosition({
            x: world.x - touchDragOffsetRef.current.x,
            y: world.y - touchDragOffsetRef.current.y,
          });
        } else {
          let nx = world.x - touchDragOffsetRef.current.x;
          let ny = world.y - touchDragOffsetRef.current.y;
          const simState = useSimulatorStore.getState();
          const dragged = simState.components.find(
            (c) => c.id === touchDraggedComponentIdRef.current,
          );
          if (dragged) {
            if (
              isAutoVerticalPart(dragged.metadataId) &&
              (Number(dragged.properties?.rotation) || 0) === 0 &&
              isOverBreadboard(dragged, nx, ny, simState.components)
            ) {
              updateComponent(touchDraggedComponentIdRef.current!, {
                properties: { ...dragged.properties, rotation: 90 },
              } as any);
            }
            const cur = useSimulatorStore
              .getState()
              .components.find((c) => c.id === touchDraggedComponentIdRef.current);
            const snapped =
              cur && snapPositionToBreadboard(cur, nx, ny, simState.components);
            if (snapped) {
              nx = snapped.x;
              ny = snapped.y;
            }
          }
          updateComponent(touchDraggedComponentIdRef.current!, {
            x: nx,
            y: ny,
          } as any);
        }
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      // Always clear any pending long-press timer on touch release.
      cancelLongPress();
      // If the long-press fired and opened a context menu, swallow this
      // touchend so we don't also fire the short-tap action below.
      if (longPressFiredRef.current) {
        longPressFiredRef.current = false;
        touchDraggedComponentIdRef.current = null;
        e.preventDefault();
        return;
      }
      // Let interactive components handle their own touch
      if (touchPassthroughRef.current) {
        touchPassthroughRef.current = false;
        pendingTouchDragRef.current = null;
        return;
      }
      // Pin touch: let pin's onTouchEnd React handler deal with it
      if (touchOnPinRef.current) {
        touchOnPinRef.current = false;
        e.preventDefault();
        return;
      }

      e.preventDefault();

      // ── Finish pinch zoom: commit values to React state ──
      if (pinchStartDistRef.current > 0 && e.touches.length < 2) {
        setZoom(zoomRef.current);
        setPan({ ...panRef.current });
        pinchStartDistRef.current = 0;
      }

      if (e.touches.length > 0) return; // Still fingers on screen

      // ── Finish segment drag (wire editing) via touch ──
      if (segmentDragRef.current) {
        const sd = segmentDragRef.current;
        if (sd.isDragging) {
          segmentDragJustCommittedRef.current = true;
          const changed = e.changedTouches[0];
          if (changed) {
            const world = toWorld(changed.clientX, changed.clientY);
            const newValue = sd.axis === 'horizontal' ? world.y : world.x;
            const newPts = moveSegment(sd.renderedPts, sd.segIndex, sd.axis, newValue);
            updateWire(sd.wireId, { waypoints: renderedToWaypoints(newPts), autoRouted: false });
          }
        }
        segmentDragRef.current = null;
        setSegmentDragPreview(null);
        return;
      }

      // ── Finish panning ──
      let wasPanning = false;
      if (isPanningRef.current) {
        isPanningRef.current = false;
        setPan({ ...panRef.current });
        wasPanning = true;
        // Don't return — fall through so short taps can select wires
      }

      const changed = e.changedTouches[0];
      if (!changed) return;

      const elapsed = Date.now() - touchClickStartTimeRef.current;
      const dx = changed.clientX - touchClickStartPosRef.current.x;
      const dy = changed.clientY - touchClickStartPosRef.current.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const isShortTap = dist < 20 && elapsed < 400;

      // If we actually panned (moved significantly), don't process as tap
      if (wasPanning && !isShortTap) return;

      // ── Finish component/board drag ──
      if (touchDraggedComponentIdRef.current) {
        const touchId = touchDraggedComponentIdRef.current;

        if (isShortTap) {
          if (touchId.startsWith('__board__:')) {
            // Short tap on board: first tap → make it active (so pins show);
            // tap again on the same board → open the touch-friendly pin
            // picker so the user can start a wire by name without poking at
            // a tiny pin overlay with a finger.
            const boardId = touchId.slice('__board__:'.length);
            const state = useSimulatorStore.getState();
            if (state.activeBoardId === boardId) {
              setPinPicker({ kind: 'board', targetId: boardId });
            } else {
              state.setActiveBoardId(boardId);
            }
          } else if (touchId !== '__board__') {
            // Short tap on component → open property dialog or sensor panel.
            // While the simulator is running (MCU or board-less SPICE),
            // components stay interactive — only sensor panels may open;
            // property editing is disabled so the tap reaches the
            // wokwi-element underneath and toggles it.
            const component = componentsRef.current.find((c) => c.id === touchId);
            if (component) {
              if (interactionRunningRef.current) {
                if (SENSOR_CONTROLS[component.metadataId] !== undefined) {
                  setSensorControlComponentId(touchId);
                  setSensorControlMetadataId(component.metadataId);
                }
              } else {
                setPropertyDialogComponentId(touchId);
                setPropertyDialogPosition({
                  x: component.x * zoomRef.current + panRef.current.x,
                  y: component.y * zoomRef.current + panRef.current.y,
                });
                setShowPropertyDialog(true);
              }
            }
          }
        } else if (touchId !== '__board__' && !touchId.startsWith('__board__:')) {
          // Real touch drag (not a tap) — seat it properly on release,
          // same as the mouse path.
          seatDroppedComponentRef.current(touchId);
        }

        recalculateAllWirePositions();
        touchDraggedComponentIdRef.current = null;
        return;
      }

      // ── Wire in progress: short tap adds waypoint OR opens pin picker ──
      // If the user tapped on a component / board body (not a pin overlay),
      // open the touch-friendly pin picker so they can finish the wire by
      // tapping a pin name from a list — far more reliable than poking at a
      // 12px overlay with a fingertip. Empty-canvas taps still drop waypoints.
      if (wireInProgressRef.current) {
        if (isShortTap) {
          const tapTarget = document.elementFromPoint(changed.clientX, changed.clientY);
          const componentWrapper = tapTarget?.closest('[data-component-id]');
          const boardOverlay = tapTarget?.closest('[data-board-overlay]');
          if (componentWrapper) {
            const id = componentWrapper.getAttribute('data-component-id');
            if (id) setPinPicker({ kind: 'component', targetId: id });
          } else if (boardOverlay) {
            const id = boardOverlay.getAttribute('data-board-id');
            if (id) setPinPicker({ kind: 'board', targetId: id });
          } else {
            const world = toWorld(changed.clientX, changed.clientY);
            useSimulatorStore.getState().addWireWaypoint(world.x, world.y);
          }
        }
        return;
      }

      // ── Short tap on empty canvas: wire selection + double-tap inserts waypoint ──
      // Disabled while running — the canvas is interact-only then.
      if (isShortTap && !interactionRunningRef.current) {
        const now = Date.now();
        const world = toWorld(changed.clientX, changed.clientY);
        const baseThreshold = isTouchDeviceRef.current ? 20 : 8;
        const threshold = baseThreshold / zoomRef.current;
        const wire = findWireNearPoint(wiresRef.current, world.x, world.y, threshold);

        // Double-tap on a wire → insert draggable waypoint at the tap location
        const timeSinceLastTap = now - lastTapTimeRef.current;
        if (timeSinceLastTap < 350 && wire) {
          const seg = findSegmentNearPoint(wire, world.x, world.y, threshold);
          if (seg) {
            const newWaypoints = insertWaypointAtSegment(
              wire.waypoints ?? [],
              seg,
              world.x,
              world.y,
            );
            useSimulatorStore.getState().updateWire(wire.id, { waypoints: newWaypoints, autoRouted: false });
            useSimulatorStore.getState().setSelectedWire(wire.id);
          }
          lastTapTimeRef.current = 0;
          return;
        }
        lastTapTimeRef.current = now;

        if (wire) {
          const curr = selectedWireIdRef.current;
          useSimulatorStore.getState().setSelectedWire(curr === wire.id ? null : wire.id);
        } else {
          useSimulatorStore.getState().setSelectedWire(null);
          setSelectedComponentId(null);
        }
      }
    };

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: false });

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      cancelLongPress();
    };
  }, [toWorld, setBoardPosition, updateComponent, recalculateAllWirePositions, cancelLongPress]);

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

    // Returns true if the component has at least one wire connected to a board
    // GND or power-rail pin (boardPinToNumber returns -1 for these).
    // Used to block output components from activating without a ground connection.
    const componentHasGndWire = (component: any): boolean =>
      wires.some((w) => {
        const isSelfStart = w.start.componentId === component.id;
        const isSelfEnd = w.end.componentId === component.id;
        if (!isSelfStart && !isSelfEnd) return false;
        const otherEndpoint = isSelfStart ? w.end : w.start;
        if (!isBoardComponent(otherEndpoint.componentId)) return false;
        const boardInstance = boards.find((b) => b.id === otherEndpoint.componentId);
        const lookupKey = boardInstance ? boardInstance.boardKind : otherEndpoint.componentId;
        return boardPinToNumber(lookupKey, otherEndpoint.pinName) === -1;
      });

    // Helper to add subscription
    // wireConnected: true when this call came from the wire-scanning path (not properties.pin).
    const subscribeComponentToPin = (
      component: any,
      pin: number,
      componentPinName?: string,
      wireConnected = false,
    ) => {
      // Components with attachEvents in PartSimulationRegistry manage their own
      // visual state (e.g. LED, servo, buzzer). Skip generic digital/PWM updates for
      // them — they already handle GND logic internally via getArduinoPinHelper.
      //
      // SPICE-mapped components (every analog/mixed part — resistors, capacitors,
      // diodes, MOSFETs, op-amps, regulators, …) are ALSO treated as self-managed:
      // SPICE is the authoritative source for their electrical state. If we echoed
      // the raw digital pin value back into `components[i].properties.state` on
      // every toggle, the store update would invalidate the solver debounce every
      // ~2 ms under PWM (490 Hz) and the solver would effectively never run — the
      // root cause of the MOSFET-PWM-LED regression. This single rule makes every
      // current and future SPICE mapper immune to that feedback loop.
      const logic = PartSimulationRegistry.get(component.metadataId);
      const spiceOwned = isSpiceMapped(component.metadataId);
      // Breadboards have no visual on/off state, but they ARE direct-wired to
      // many board pins (one wire per strip → GPIO). Writing properties.state
      // per edge minted a new components array thousands of times per second
      // on multiplexed sketches — pure churn that re-rendered the whole
      // editor. Treat them as self-managed: skip the generic state echo.
      const hasSelfManagedVisuals =
        !!(logic && logic.attachEvents) || spiceOwned || isBreadboard(component.metadataId);

      // Generic GND check: for wire-connected output components that don't manage
      // their own state, require at least one GND wire before activating.
      // Skip the check for pin-property components (no GND wire to detect) and for
      // self-managed components (they handle GND themselves via attachEvents).
      const hasGnd =
        !wireConnected || hasSelfManagedVisuals ? true : componentHasGndWire(component);

      const unsubscribe = pinManager.onPinChange(pin, (_pin, state) => {
        if (!hasSelfManagedVisuals) {
          // Update React state — gate on GND for wire-connected components.
          updateComponentState(component.id, hasGnd && state);
        }

        // Delegate to PartSimulationRegistry for custom visual updates
        if (logic && logic.onPinStateChange) {
          const el = document.getElementById(component.id);
          if (el) {
            logic.onPinStateChange(componentPinName || 'A', hasGnd && state, el);
          }
        }
      });
      unsubscribers.push(unsubscribe);
    };

    components.forEach((component) => {
      // 1. Subscribe by explicit pin property (old-style, no wire needed)
      if (component.properties.pin !== undefined) {
        subscribeComponentToPin(component, component.properties.pin as number, 'A', false);
      } else {
        // 2. Subscribe by finding wires connected to arduino
        const connectedWires = wires.filter(
          (w) => w.start.componentId === component.id || w.end.componentId === component.id,
        );

        connectedWires.forEach((wire) => {
          const isStartSelf = wire.start.componentId === component.id;
          const selfEndpoint = isStartSelf ? wire.start : wire.end;
          const otherEndpoint = isStartSelf ? wire.end : wire.start;

          // Recognise board endpoints from the LIVE boards list first —
          // isBoardComponent only matches static id prefixes, so every
          // runtime-added board (agent-minted UUID ids) failed it and its
          // directly-wired components were never subscribed.
          const boardInstance = boards.find((b) => b.id === otherEndpoint.componentId);
          if (boardInstance || isBoardComponent(otherEndpoint.componentId)) {
            // Use the board's actual boardKind (not just its instance ID) so that
            // a board whose ID is 'arduino-uno' but whose kind is 'esp32' gets the
            // correct GPIO mapping ('GPIO4' → 4, not null).
            const lookupKey = boardInstance ? boardInstance.boardKind : otherEndpoint.componentId;
            const pin = boardPinToNumber(lookupKey, otherEndpoint.pinName);
            if (pin !== null && pin >= 0) {
              subscribeComponentToPin(component, pin, selfEndpoint.pinName, true);
            } else if (pin === null) {
              console.warn(
                `[WirePin] Could not resolve pin "${otherEndpoint.pinName}" on ${lookupKey}`,
              );
            }
            // pin === -1 → power/GND pin, skip silently
          }
        });
      }
    });

    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
  }, [components, wires, boards, pinManager, updateComponentState]);

  // Board built-in LED: subscribe directly to pinManager for the LED pin of each board.
  // This works even when no external led-builtin component exists (e.g. basic Blink example).
  useEffect(() => {
    if (!pinManager) return;
    const unsubs: (() => void)[] = [];

    boards.forEach((board) => {
      // Determine which GPIO pin drives the board's built-in LED
      let ledPin: number;
      switch (board.boardKind) {
        case 'raspberry-pi-pico':
        case 'pi-pico-w':
        case 'nano-rp2040':
          ledPin = 25; // GPIO25
          break;
        case 'attiny85':
          ledPin = 1; // PB1 (Digispark convention)
          break;
        default:
          ledPin = 13; // Pin 13 for Arduino Uno/Nano/Mega
      }

      unsubs.push(
        pinManager.onPinChange(ledPin, (_pin, state) => {
          setBoardLedStates((prev) => {
            if (prev[board.id] === state) return prev;
            return { ...prev, [board.id]: state };
          });
        }),
      );
    });

    return () => unsubs.forEach((u) => u());
  }, [boards, pinManager]);

  // ESP32 input components: forward button presses and potentiometer values to QEMU
  useEffect(() => {
    const cleanups: (() => void)[] = [];

    components.forEach((component) => {
      const connectedWires = wires.filter(
        (w) => w.start.componentId === component.id || w.end.componentId === component.id,
      );

      connectedWires.forEach((wire) => {
        const isStartSelf = wire.start.componentId === component.id;
        const selfEndpoint = isStartSelf ? wire.start : wire.end;
        const otherEndpoint = isStartSelf ? wire.end : wire.start;

        if (!isBoardComponent(otherEndpoint.componentId)) return;

        const boardId = otherEndpoint.componentId;
        const bridge = getEsp32Bridge(boardId);
        if (!bridge) return; // not an ESP32 board

        const boardInstance = boards.find((b) => b.id === boardId);
        const lookupKey = boardInstance ? boardInstance.boardKind : boardId;
        const gpioPin = boardPinToNumber(lookupKey, otherEndpoint.pinName);
        if (gpioPin === null) return;

        // Delay lookup so the web component has time to render
        const timeout = setTimeout(() => {
          const el = document.getElementById(component.id);
          if (!el) return;
          const tag = el.tagName.toLowerCase();

          // Push-button: forward press/release as GPIO level changes
          if (tag === 'wokwi-pushbutton') {
            const onPress = () => bridge.sendPinEvent(gpioPin, true);
            const onRelease = () => bridge.sendPinEvent(gpioPin, false);
            el.addEventListener('button-press', onPress);
            el.addEventListener('button-release', onRelease);
            cleanups.push(() => {
              el.removeEventListener('button-press', onPress);
              el.removeEventListener('button-release', onRelease);
            });
          }

          // Potentiometer: forward analog value as ADC millivolts
          if (tag === 'wokwi-potentiometer' && selfEndpoint.pinName === 'SIG') {
            const adcInfo = ESP32_ADC_PIN_MAP[gpioPin];
            if (adcInfo) {
              const onInput = (e: Event) => {
                const pct = parseFloat((e.target as any).value ?? '0'); // 0–100
                bridge.setAdc(adcInfo.chn, Math.round((pct / 100) * 3300));
              };
              el.addEventListener('input', onInput);
              cleanups.push(() => el.removeEventListener('input', onInput));
            }
          }
        }, 300);

        cleanups.push(() => clearTimeout(timeout));
      });
    });

    return () => cleanups.forEach((fn) => fn());
  }, [components, wires, boards]);

  // Handle keyboard delete for the selected component
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip when the user is typing in an input/textarea/contenteditable —
      // otherwise Backspace inside the AI chat (or any future text field)
      // would also delete the selected component.
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) {
          return;
        }
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedComponentId) {
          // Recorded so the user can Ctrl+Z this back. Cascades wire removal too.
          recordRemoveComponent(selectedComponentId);
          setSelectedComponentId(null);
        }
        // The board is intentionally NOT deletable via Delete/Backspace. It is
        // always the "active" board (its code is shown in the editor), so keying
        // off activeBoardId here popped the board-removal confirmation whenever
        // the user pressed Delete to remove a wire, or after they had just
        // deleted a component. Board removal stays on the explicit, deliberate
        // paths: the right-click "Remove board" context menu and the touch
        // pin-picker delete action.
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedComponentId, recordRemoveComponent]);

  // Handle component selection from modal
  const handleSelectComponent = (metadata: ComponentMetadata) => {
    // Anchor new components to the visible top-left of the canvas, so they
    // appear in the user's current viewport regardless of pan/zoom (instead
    // of growing off-screen at fixed world coords like (400, 100 + row*250)).
    const rect = canvasRef.current?.getBoundingClientRect();
    const z = zoomRef.current || 1;
    const screenMargin = 60; // px on screen — keeps the part off the toolbar/edge
    const worldOrigin = rect
      ? toWorld(rect.left + screenMargin, rect.top + screenMargin)
      : { x: 100, y: 100 };

    // Tile additional drops so they don't stack exactly on top of each other,
    // while still landing inside the viewport.
    const tileStep = 40 / z; // 40 screen-px between successive drops
    const cols = 4;
    const idx = components.length;
    const x = worldOrigin.x + (idx % cols) * tileStep;
    const y = worldOrigin.y + Math.floor(idx / cols) * tileStep;

    const component = createComponentFromMetadata(metadata, x, y);
    trackAddComponent(metadata.id);
    // Recorded — user can Ctrl+Z to remove the just-added component.
    recordAddComponent(component as Parameters<typeof recordAddComponent>[0]);
    setShowComponentPicker(false);

    // Custom Chips need a compile step before they can do anything — open the
    // designer dialog immediately so the user lands in the editor.
    if (metadata.id === 'custom-chip') {
      setCustomChipComponentId(component.id);
    }
  };

  // Component rotation — applies the new angle and records it as a single
  // undoable command (round-trip flips the rotation property both ways).
  const handleRotateComponent = (componentId: string) => {
    const component = components.find((c) => c.id === componentId);
    if (!component) return;

    const currentRotation = (component.properties.rotation as number) || 0;
    const nextRotation = (currentRotation + 90) % 360;
    updateComponent(componentId, {
      properties: {
        ...component.properties,
        rotation: nextRotation,
      },
    } as any);
    recordRotate(componentId, currentRotation, nextRotation);
  };

  // Component dragging handlers
  const handleComponentMouseDown = (componentId: string, e: React.MouseEvent) => {
    if (showPropertyDialog) return;

    // While running, the canvas is read-only and most components
    // (pushbutton, switch, pot, …) need the raw event so their
    // wokwi-element shadow DOM can fire button-press / change events —
    // we let the mousedown propagate. Sensors are the exception: their
    // only interaction is the SensorControlPanel we open ourselves, so
    // we still claim the click for them (mouseUp opens the panel via
    // the SENSOR_CONTROLS branch). Without this, sensor clicks during a
    // run bubble to the canvas pan handler instead (grab cursor, no
    // panel). Mirrors the touch tap flow above.
    if (interactionRunning) {
      const component = components.find((c) => c.id === componentId);
      const isSensor = !!component && SENSOR_CONTROLS[component.metadataId] !== undefined;
      if (!isSensor) return;
    }

    e.stopPropagation();
    const component = components.find((c) => c.id === componentId);
    if (!component) return;

    setClickStartTime(Date.now());
    setClickStartPos({ x: e.clientX, y: e.clientY });

    const world = toWorld(e.clientX, e.clientY);
    setDraggedComponentId(componentId);
    setDragOffset({
      x: world.x - component.x,
      y: world.y - component.y,
    });
    // Snapshot the starting position. mouseup uses this to push a single
    // Move command if the component actually moved (vs being a click).
    dragStartPosRef.current = { x: component.x, y: component.y };
    setSelectedComponentId(componentId);
  };

  const handleCanvasMouseMove = (e: React.MouseEvent) => {
    // Handle active panning (ref-based, no setState lag)
    if (isPanningRef.current) {
      const dx = e.clientX - panStartRef.current.mouseX;
      const dy = e.clientY - panStartRef.current.mouseY;
      const newPan = {
        x: panStartRef.current.panX + dx,
        y: panStartRef.current.panY + dy,
      };
      panRef.current = newPan;
      // Update the transform directly for zero-lag panning
      const world = canvasRef.current?.querySelector('.canvas-world') as HTMLElement | null;
      if (world) {
        world.style.transform = `translate(${newPan.x}px, ${newPan.y}px) scale(${zoomRef.current})`;
      }
      return;
    }

    // Handle component/board dragging
    if (draggedComponentId) {
      const world = toWorld(e.clientX, e.clientY);
      if (draggedComponentId.startsWith('__board__:')) {
        const boardId = draggedComponentId.slice('__board__:'.length);
        setBoardPosition({ x: world.x - dragOffset.x, y: world.y - dragOffset.y }, boardId);
      } else if (draggedComponentId === '__board__') {
        // legacy fallback
        setBoardPosition({ x: world.x - dragOffset.x, y: world.y - dragOffset.y });
      } else {
        let nx = world.x - dragOffset.x;
        let ny = world.y - dragOffset.y;
        const simState = useSimulatorStore.getState();
        const dragged = simState.components.find((c) => c.id === draggedComponentId);
        if (dragged) {
          // Axial parts entering a breadboard flip to vertical so they
          // bridge the trench columns like on a real board.
          if (
            isAutoVerticalPart(dragged.metadataId) &&
            (Number(dragged.properties?.rotation) || 0) === 0 &&
            isOverBreadboard(dragged, nx, ny, simState.components)
          ) {
            updateComponent(draggedComponentId, {
              properties: { ...dragged.properties, rotation: 90 },
            } as any);
          }
          const cur = useSimulatorStore
            .getState()
            .components.find((c) => c.id === draggedComponentId);
          const snapped =
            cur && snapPositionToBreadboard(cur, nx, ny, simState.components);
          if (snapped) {
            nx = snapped.x;
            ny = snapped.y;
          }
        }
        updateComponent(draggedComponentId, { x: nx, y: ny } as any);
      }
    }

    // Handle wire creation preview
    if (wireInProgress) {
      const world = toWorld(e.clientX, e.clientY);
      updateWireInProgress(world.x, world.y);
      return;
    }

    // Handle segment handle dragging
    if (segmentDragRef.current) {
      const world = toWorld(e.clientX, e.clientY);
      const sd = segmentDragRef.current;
      sd.isDragging = true;
      const threshold = ALIGN_SNAP_PX / zoomRef.current;
      const targets = collectAlignmentTargets(wiresRef.current, sd.wireId);
      // Snap against the wire's own runs too, so a dragged segment can
      // line up with (and fuse into) its neighbours instead of ending
      // up millimetres off.
      addOwnWireAlignmentTargets(targets, sd.renderedPts, [sd.segIndex, sd.segIndex + 1]);
      const guides: AlignmentGuide[] = [];
      let newValue = sd.axis === 'horizontal' ? world.y : world.x;
      const snap = snapToNearest(
        newValue,
        sd.axis === 'horizontal' ? targets.ys : targets.xs,
        threshold,
      );
      if (snap) {
        newValue = snap.snapped;
        guides.push({ axis: sd.axis === 'horizontal' ? 'y' : 'x', value: snap.target });
      }
      setAlignmentGuides(guides);
      const newPts = moveSegment(sd.renderedPts, sd.segIndex, sd.axis, newValue);
      const overridePath = renderedPointsToPath(simplifyOrthogonalPath(newPts));
      setSegmentDragPreview({ wireId: sd.wireId, overridePath });
      return;
    }

    // Handle waypoint handle dragging (free 2D move)
    if (waypointDragRef.current) {
      const world = toWorld(e.clientX, e.clientY);
      const wd = waypointDragRef.current;
      wd.isDragging = true;
      const wire = wiresRef.current.find((w) => w.id === wd.wireId);
      if (wire) {
        const threshold = ALIGN_SNAP_PX / zoomRef.current;
        const targets = collectAlignmentTargets(wiresRef.current, wd.wireId);
        // Own-wire targets (start, end, other bends) minus the dragged
        // bend itself, so it can fuse back onto its own wire's lines.
        addOwnWireAlignmentTargets(
          targets,
          [
            { x: wire.start.x, y: wire.start.y },
            ...wd.originalWaypoints,
            { x: wire.end.x, y: wire.end.y },
          ],
          [wd.waypointIndex + 1],
        );
        const guides: AlignmentGuide[] = [];
        let snappedX = world.x;
        let snappedY = world.y;
        const snapX = snapToNearest(world.x, targets.xs, threshold);
        if (snapX) {
          snappedX = snapX.snapped;
          guides.push({ axis: 'x', value: snapX.target });
        }
        const snapY = snapToNearest(world.y, targets.ys, threshold);
        if (snapY) {
          snappedY = snapY.snapped;
          guides.push({ axis: 'y', value: snapY.target });
        }
        setAlignmentGuides(guides);
        const newWaypoints = wd.originalWaypoints.map((wp, i) =>
          i === wd.waypointIndex ? { x: snappedX, y: snappedY } : { ...wp },
        );
        setWaypointDragPreview({ wireId: wd.wireId, waypoints: newWaypoints });
        // Reflect the moved bend point in the rendered path live
        const expanded = expandOrthogonalPoints([
          { x: wire.start.x, y: wire.start.y },
          ...newWaypoints,
          { x: wire.end.x, y: wire.end.y },
        ]);
        const overridePath = renderedPointsToPath(simplifyOrthogonalPath(expanded));
        setSegmentDragPreview({ wireId: wd.wireId, overridePath });
      }
      return;
    }

    // Wire hover detection (when not dragging anything). Skipped while running —
    // wires aren't selectable then, so they shouldn't highlight as hoverable.
    if (!draggedComponentId && !interactionRunningRef.current) {
      const world = toWorld(e.clientX, e.clientY);
      const threshold = 8 / zoomRef.current;
      const wire = findWireNearPoint(wiresRef.current, world.x, world.y, threshold);
      setHoveredWireId(wire ? wire.id : null);
    }
  };

  /**
   * Drop-time breadboard seating. The drag-time magnet only aligns the
   * anchor pin, which is how parts ended up HALF-seated (some pins in
   * holes, the rest dead in the air). On release we re-solve properly:
   * nearest position where every pin is in a free hole, sliding past
   * occupied columns if needed. Leaves the part untouched when it is not
   * over a board or genuinely does not fit.
   */
  const seatDroppedComponent = (componentId: string) => {
    const state = useSimulatorStore.getState();
    const comp = state.components.find((c) => c.id === componentId);
    if (!comp) return;
    const placement = seatOnDrop(comp, comp.x, comp.y, state.components);
    if (!placement || placement.moved < 0.01) return;
    updateComponent(componentId, { x: placement.x, y: placement.y } as any);
  };
  seatDroppedComponentRef.current = seatDroppedComponent;

  const handleCanvasMouseUp = (e: React.MouseEvent) => {
    // Finish panning — commit ref value to state so React knows the final pan
    if (isPanningRef.current) {
      isPanningRef.current = false;
      setPan({ ...panRef.current });
      return;
    }

    // Commit segment handle drag
    if (segmentDragRef.current) {
      const sd = segmentDragRef.current;
      if (sd.isDragging) {
        segmentDragJustCommittedRef.current = true;
        const world = toWorld(e.clientX, e.clientY);
        const threshold = ALIGN_SNAP_PX / zoomRef.current;
        const targets = collectAlignmentTargets(wiresRef.current, sd.wireId);
        addOwnWireAlignmentTargets(targets, sd.renderedPts, [sd.segIndex, sd.segIndex + 1]);
        let newValue = sd.axis === 'horizontal' ? world.y : world.x;
        const snap = snapToNearest(
          newValue,
          sd.axis === 'horizontal' ? targets.ys : targets.xs,
          threshold,
        );
        if (snap) newValue = snap.snapped;
        const newPts = moveSegment(sd.renderedPts, sd.segIndex, sd.axis, newValue);
        updateWire(sd.wireId, { waypoints: renderedToWaypoints(newPts), autoRouted: false });
      }
      segmentDragRef.current = null;
      setSegmentDragPreview(null);
      setAlignmentGuides([]);
      return;
    }

    // Commit waypoint handle drag
    if (waypointDragRef.current) {
      const wd = waypointDragRef.current;
      if (wd.isDragging) {
        segmentDragJustCommittedRef.current = true;
        const world = toWorld(e.clientX, e.clientY);
        const wire = wiresRef.current.find((w) => w.id === wd.wireId);
        if (wire) {
          const threshold = ALIGN_SNAP_PX / zoomRef.current;
          const targets = collectAlignmentTargets(wiresRef.current, wd.wireId);
          addOwnWireAlignmentTargets(
            targets,
            [
              { x: wire.start.x, y: wire.start.y },
              ...wd.originalWaypoints,
              { x: wire.end.x, y: wire.end.y },
            ],
            [wd.waypointIndex + 1],
          );
          let snappedX = world.x;
          let snappedY = world.y;
          const snapX = snapToNearest(world.x, targets.xs, threshold);
          if (snapX) snappedX = snapX.snapped;
          const snapY = snapToNearest(world.y, targets.ys, threshold);
          if (snapY) snappedY = snapY.snapped;
          const newWaypoints = wd.originalWaypoints.map((wp, i) =>
            i === wd.waypointIndex ? { x: snappedX, y: snappedY } : { ...wp },
          );
          // Run through expand → simplify so collinear waypoints get cleaned up
          const expanded = expandOrthogonalPoints([
            { x: wire.start.x, y: wire.start.y },
            ...newWaypoints,
            { x: wire.end.x, y: wire.end.y },
          ]);
          updateWire(wd.wireId, { waypoints: renderedToWaypoints(expanded), autoRouted: false });
        }
      }
      waypointDragRef.current = null;
      setWaypointDragPreview(null);
      setSegmentDragPreview(null);
      setAlignmentGuides([]);
      return;
    }

    if (draggedComponentId) {
      const timeDiff = Date.now() - clickStartTime;
      const posDiff = Math.sqrt(
        Math.pow(e.clientX - clickStartPos.x, 2) + Math.pow(e.clientY - clickStartPos.y, 2),
      );

      if (posDiff < 5 && timeDiff < 300) {
        if (draggedComponentId.startsWith('__board__:')) {
          // Click on a board — make it the active board (editor switches to its code)
          const boardId = draggedComponentId.slice('__board__:'.length);
          useSimulatorStore.getState().setActiveBoardId(boardId);
        } else if (draggedComponentId !== '__board__') {
          const component = components.find((c) => c.id === draggedComponentId);
          if (component) {
            if (interactionRunning) {
              // During simulation (MCU running OR board-less SPICE active)
              // only sensor panels open on click — every other component
              // is interactive (pushbutton, switch, pot, …) and must
              // handle its own clicks, so we suppress the property
              // dialog entirely. This is the path that also unblocks
              // wokwi-slide-switch toggling in the digital examples.
              if (SENSOR_CONTROLS[component.metadataId] !== undefined) {
                setSensorControlComponentId(draggedComponentId);
                setSensorControlMetadataId(component.metadataId);
              }
            } else if (component.metadataId === 'custom-chip') {
              // Custom Chips have their own designer (C editor + chip.json + Compile).
              setCustomChipComponentId(draggedComponentId);
            } else if (
              isBreadboard(component.metadataId) &&
              (() => {
                // A wire crossing the breadboard body sits visually ON TOP of
                // it — clicking the wire must select the wire, not bury it
                // under the breadboard's full-pin-list property dialog
                // (reported: bb→bb wires were unselectable, the hole list
                // popped over everything instead).
                const world = toWorld(e.clientX, e.clientY);
                const nearWire = findWireNearPoint(
                  wiresRef.current,
                  world.x,
                  world.y,
                  8 / zoomRef.current,
                );
                if (nearWire) {
                  setSelectedWire(nearWire.id);
                  // The subsequent canvas onClick would re-hit the same wire
                  // and toggle it back OFF — suppress that one click.
                  wireSelectJustHandledRef.current = true;
                  return true;
                }
                return false;
              })()
            ) {
              // handled — wire selected instead of opening the dialog
            } else {
              setPropertyDialogComponentId(draggedComponentId);
              setPropertyDialogPosition({
                x: component.x * zoomRef.current + panRef.current.x,
                y: component.y * zoomRef.current + panRef.current.y,
              });
              setShowPropertyDialog(true);
            }
          }
        }
      }

      // If this was a real drag (not a click), commit one Move command
      // so undo can roll the position back. Click-without-drag short-
      // circuits via the (posDiff < 5 && timeDiff < 300) branch above
      // and just opens the property dialog — no history entry needed.
      const start = dragStartPosRef.current;
      const isClick = posDiff < 5 && timeDiff < 300;
      if (
        !isClick &&
        start &&
        draggedComponentId &&
        !draggedComponentId.startsWith('__board__')
      ) {
        // Seat BEFORE recording the move, so undo restores the pre-drag
        // position in one step instead of leaving the part mid-seat.
        seatDroppedComponent(draggedComponentId);
        // Re-read from the store: `components` is the render-time closure
        // and does not include the seating correction just applied.
        const moved = useSimulatorStore
          .getState()
          .components.find((c) => c.id === draggedComponentId);
        if (moved && (moved.x !== start.x || moved.y !== start.y)) {
          recordMove(draggedComponentId, start, { x: moved.x, y: moved.y });
        }
      }
      dragStartPosRef.current = null;

      recalculateAllWirePositions();
      setDraggedComponentId(null);
    }
  };

  // Start panning on middle-click or right-click
  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    // Middle / right click — always pan, regardless of context.
    // Left click — pan only when clicking ON THE BACKGROUND (the event
    // reaches the canvas because component mousedowns stopPropagation),
    // and only when not wiring (wire mode uses left click to drop
    // waypoints) or running a property dialog. Matches the diagram-editor
    // convention used in Figma / Miro / draw.io.
    const leftButton = e.button === 0;
    const middleOrRight = e.button === 1 || e.button === 2;
    const isPanGesture =
      middleOrRight ||
      (leftButton && !wireInProgress && !showPropertyDialog);

    if (isPanGesture) {
      e.preventDefault();
      isPanningRef.current = true;
      panStartRef.current = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        panX: panRef.current.x,
        panY: panRef.current.y,
      };
    }
  };

  // Handle mousedown on a segment handle circle (called from WireLayer)
  const handleHandleMouseDown = useCallback(
    (e: React.MouseEvent, segIndex: number) => {
      e.stopPropagation();
      e.preventDefault();
      if (interactionRunningRef.current) return; // interact-only while running
      if (!selectedWireId) return;
      const wire = wiresRef.current.find((w) => w.id === selectedWireId);
      if (!wire) return;
      const segments = getRenderedSegments(wire);
      const seg = segments[segIndex];
      if (!seg) return;
      const expandedPts = getRenderedPoints(wire);
      segmentDragRef.current = {
        wireId: wire.id,
        segIndex,
        axis: seg.axis,
        renderedPts: expandedPts,
        isDragging: false,
      };
    },
    [selectedWireId],
  );

  // Handle touchstart on a segment handle circle (mobile wire editing)
  const handleHandleTouchStart = useCallback(
    (e: React.TouchEvent, segIndex: number) => {
      e.stopPropagation();
      if (interactionRunningRef.current) return;
      if (!selectedWireId) return;
      const wire = wiresRef.current.find((w) => w.id === selectedWireId);
      if (!wire) return;
      const segments = getRenderedSegments(wire);
      const seg = segments[segIndex];
      if (!seg) return;
      const expandedPts = getRenderedPoints(wire);
      segmentDragRef.current = {
        wireId: wire.id,
        segIndex,
        axis: seg.axis,
        renderedPts: expandedPts,
        isDragging: false,
      };
    },
    [selectedWireId],
  );

  // Handle mousedown on a waypoint (bend-point) handle: free 2D drag
  const handleWaypointMouseDown = useCallback(
    (e: React.MouseEvent, waypointIndex: number) => {
      e.stopPropagation();
      e.preventDefault();
      if (interactionRunningRef.current) return; // interact-only while running
      if (!selectedWireId) return;
      const wire = wiresRef.current.find((w) => w.id === selectedWireId);
      if (!wire) return;
      waypointDragRef.current = {
        wireId: wire.id,
        waypointIndex,
        originalWaypoints: (wire.waypoints ?? []).map((wp) => ({ ...wp })),
        isDragging: false,
      };
    },
    [selectedWireId],
  );

  // Handle touchstart on a waypoint handle (mobile)
  const handleWaypointTouchStart = useCallback(
    (e: React.TouchEvent, waypointIndex: number) => {
      e.stopPropagation();
      if (interactionRunningRef.current) return;
      if (!selectedWireId) return;
      const wire = wiresRef.current.find((w) => w.id === selectedWireId);
      if (!wire) return;
      waypointDragRef.current = {
        wireId: wire.id,
        waypointIndex,
        originalWaypoints: (wire.waypoints ?? []).map((wp) => ({ ...wp })),
        isDragging: false,
      };
    },
    [selectedWireId],
  );

  // Zoom centered on cursor
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.min(5, Math.max(0.1, zoomRef.current * factor));

    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // Keep the world point under the cursor fixed
    const worldX = (mx - panRef.current.x) / zoomRef.current;
    const worldY = (my - panRef.current.y) / zoomRef.current;
    const newPan = {
      x: mx - worldX * newZoom,
      y: my - worldY * newZoom,
    };

    zoomRef.current = newZoom;
    panRef.current = newPan;
    setZoom(newZoom);
    setPan(newPan);
  };

  const handleResetView = () => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // Wire creation via pin clicks
  const handlePinClick = (componentId: string, pinName: string, x: number, y: number) => {
    // No making connections while the simulation runs — interact-only.
    if (interactionRunningRef.current) return;
    // Close property dialog when starting wire creation
    if (showPropertyDialog) {
      setShowPropertyDialog(false);
    }

    // ── Breadboard hole rules: one hole, one wire ──────────────────────
    // A hole already holding a visible wire end can't start another wire —
    // clicking it SELECTS that wire instead. (Without this, a wire whose
    // endpoints sit in holes is impossible to select: the hole overlays
    // swallow every click and silently start a new wire.) When a new end
    // does land in an occupied hole (seated leg or another wire), it
    // shifts to the nearest free hole of the same 5-hole strip / rail —
    // electrically identical, visually untangled.
    const bbComp = componentsRef.current.find((c) => c.id === componentId);
    const isBBHole = !!bbComp && isBreadboard(bbComp.metadataId);
    if (isBBHole) {
      if (!wireInProgress) {
        const occupying = findWireAtHole(wiresRef.current, componentId, pinName);
        if (occupying) {
          setSelectedWire(occupying.id);
          return;
        }
      }
      const el = document.getElementById(componentId) as
        | (HTMLElement & { pinInfo?: Array<{ name: string }> })
        | null;
      const allNames = (el?.pinInfo ?? []).map((p) => p.name);
      const free = resolveFreeHole(
        bbComp.metadataId,
        componentId,
        pinName,
        wiresRef.current,
        allNames,
      );
      if (free !== pinName) {
        const rot = Number(bbComp.properties?.rotation) || 0;
        const pos = calculatePinPosition(componentId, free, bbComp.x + 6, bbComp.y + 6, rot);
        if (pos) {
          pinName = free;
          x = pos.x;
          y = pos.y;
        }
      }
    }

    if (wireInProgress) {
      // Finish wire: the store atomically appends the new wire and clears
      // `wireInProgress`. Once that's done, we look up the wire it just
      // created and push a CanvasCommand with applyNow:false (state is
      // already at the post-add state). Undo removes the wire; redo re-adds.
      finishWireCreation({ componentId, pinName, x, y });
      trackCreateWire();
      const wires = useSimulatorStore.getState().wires;
      const created = wires[wires.length - 1];
      if (created) {
        useSimulatorStore.getState().pushCommand(
          {
            description: 'Add wire',
            execute: () => useSimulatorStore.getState().addWire(created),
            undo: () => useSimulatorStore.getState().removeWire(created.id),
          },
          { applyNow: false },
        );
      }
    } else {
      // Start wire: rails mandate red (+) / black (−); other breadboard
      // holes pick a random jumper color (like a real jumper kit — a board
      // full of identical green wires is unreadable); component pins keep
      // the name-based auto color (GND → black, VCC → red, else green).
      const color = isBBHole
        ? (railWireColor(pinName) ??
          WIRE_JUMPER_PALETTE[Math.floor(Math.random() * WIRE_JUMPER_PALETTE.length)])
        : autoWireColor(pinName);
      startWireCreation({ componentId, pinName, x, y }, color);
    }
  };

  // Keyboard handlers for wires
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape → cancel in-progress wire (works even while a field is focused).
      if (e.key === 'Escape' && wireInProgress) {
        cancelWireCreation();
        return;
      }
      // Skip the rest when the user is typing in an input/textarea/select/
      // contenteditable — otherwise Backspace in a text field (e.g. the AI chat)
      // would delete the selected wire, and the color-shortcut keys below would
      // hijack normal typing.
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) {
          return;
        }
      }
      // Delete / Backspace → remove selected wire (recorded for undo).
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedWireId) {
        recordRemoveWire(selectedWireId);
        return;
      }
      // Color shortcuts (0-9, c, l, m, p, y) — Wokwi style
      const key = e.key.toLowerCase();
      if (key in WIRE_KEY_COLORS) {
        if (wireInProgress) {
          setWireInProgressColor(WIRE_KEY_COLORS[key]);
        } else if (selectedWireId) {
          updateWire(selectedWireId, { color: WIRE_KEY_COLORS[key] });
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    wireInProgress,
    cancelWireCreation,
    selectedWireId,
    recordRemoveWire,
    setWireInProgressColor,
    updateWire,
  ]);

  // Recalculate wire positions when components change (e.g., when loading an example)
  useEffect(() => {
    // Wait for components to render and pinInfo to be available
    // Use multiple retries to ensure pinInfo is ready
    const timers: ReturnType<typeof setTimeout>[] = [];

    // Try at 100ms, 300ms, and 500ms to ensure all components have rendered
    timers.push(setTimeout(() => recalculateAllWirePositions(), 100));
    timers.push(setTimeout(() => recalculateAllWirePositions(), 300));
    timers.push(setTimeout(() => recalculateAllWirePositions(), 500));

    return () => timers.forEach((t) => clearTimeout(t));
  }, [components, recalculateAllWirePositions]);

  // Auto-pan/zoom to keep the board and all components visible after a project
  // import/load. We track the previous component count and only re-center when
  // the count jumps (indicating the user loaded a new circuit, not just added
  // one part).
  //
  // On touch-primary devices we also auto-fit the zoom — projects authored on
  // a desktop with a wide canvas otherwise show up cramped at zoom 1 on a
  // ~400px-wide phone, with everything piled into the top-left corner.
  const prevComponentCountRef = useRef(-1);
  useEffect(() => {
    const prev = prevComponentCountRef.current;
    const curr = components.length;
    prevComponentCountRef.current = curr;

    // Only re-fit when the component list transitions from empty/different
    // project to a populated one (i.e., a load/import event).
    const isLoad = curr > 0 && (prev <= 0 || Math.abs(curr - prev) > 2);
    if (!isLoad) return;

    const timer = setTimeout(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();

      // Read actual rendered sizes from the DOM so the fit accounts for each
      // board/component's true footprint, not a guessed bounding box.
      const z = zoomRef.current;
      const p = panRef.current;
      const toWorldRect = (r: DOMRect) => ({
        x1: (r.left - rect.left - p.x) / z,
        y1: (r.top - rect.top - p.y) / z,
        x2: (r.right - rect.left - p.x) / z,
        y2: (r.bottom - rect.top - p.y) / z,
      });

      const targets: HTMLElement[] = [];
      boardsRef.current.forEach((b) => {
        const el = canvas.querySelector<HTMLElement>(`[data-board-id="${b.id}"]`);
        if (el) targets.push(el);
      });
      componentsRef.current.forEach((c) => {
        const el = canvas.querySelector<HTMLElement>(`[data-component-id="${c.id}"]`);
        if (el) targets.push(el);
      });

      if (targets.length === 0) return;

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      targets.forEach((el) => {
        const wr = toWorldRect(el.getBoundingClientRect());
        if (wr.x1 < minX) minX = wr.x1;
        if (wr.y1 < minY) minY = wr.y1;
        if (wr.x2 > maxX) maxX = wr.x2;
        if (wr.y2 > maxY) maxY = wr.y2;
      });
      if (!isFinite(minX)) return;

      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const worldW = Math.max(1, maxX - minX);
      const worldH = Math.max(1, maxY - minY);

      // On touch-primary viewports, also adjust zoom so everything fits with
      // padding. On desktop, keep the existing behavior (pan only) so users
      // who set a custom zoom don't lose it on every load.
      let nextZoom = z;
      if (isTouchDeviceRef.current) {
        const PADDING = 32;
        const availW = Math.max(50, rect.width - PADDING * 2);
        const availH = Math.max(50, rect.height - PADDING * 2);
        // Never zoom *in* past 1× — small projects shouldn't get magnified.
        const fit = Math.min(availW / worldW, availH / worldH, 1);
        nextZoom = Math.max(0.2, fit);
      }

      const newPan = {
        x: rect.width / 2 - centerX * nextZoom,
        y: rect.height / 2 - centerY * nextZoom,
      };
      zoomRef.current = nextZoom;
      panRef.current = newPan;
      setZoom(nextZoom);
      setPan(newPan);
    }, 200);

    return () => clearTimeout(timer);
  }, [components.length]);

  // Which pins of each component are plugged into a breadboard hole. Seating
  // is an invisible `bb` wire (component pin = start, hole = end), so one pass
  // over the wires gives every part its seated-pin names for the green markers.
  const seatedPinsByComponent = React.useMemo(() => {
    const map = new Map<string, string[]>();
    for (const w of wires) {
      if (!w.bb) continue;
      const arr = map.get(w.start.componentId);
      if (arr) arr.push(w.start.pinName);
      else map.set(w.start.componentId, [w.start.pinName]);
    }
    return map;
  }, [wires]);

  // Render component using dynamic renderer
  const renderComponent = (component: any) => {
    // SPICE probes are React components, not web components — render them
    // directly and let PinOverlay read the pinInfo we attach in the wrapper.
    if (component.metadataId === 'instr-voltmeter' || component.metadataId === 'instr-ammeter') {
      const isSelected = selectedComponentId === component.id;
      const isHovered = hoveredComponentId === component.id;
      // Suppress pin overlays whenever a modal-style UI is open over the
      // canvas — they'd just visually conflict with the dialog's controls.
      const dialogOpen =
        showPropertyDialog || customChipComponentId !== null || sensorControlComponentId !== null;
      // On touch devices the pin picker dialog (PinPickerDialog) is the
      // primary way to pick pins, so the tiny overlay squares are hidden —
      // they're hard to hit with a finger anyway. Desktop shows overlays on
      // hover / while wiring only — selection alone doesn't light them up.
      const showPinsForComponent =
        !dialogOpen && !isTouchDevice && (wireInProgress || isHovered);
      return (
        <React.Fragment key={component.id}>
          <div
            className="component-interactive-group"
            onMouseEnter={() => setHoveredComponentId(component.id)}
            onMouseLeave={() =>
              setHoveredComponentId((curr) => (curr === component.id ? null : curr))
            }
            // Zero-size positioned wrapper: children keep their absolute canvas
            // coords, but body + pins now share ONE stacking context, so this
            // component's pins can never paint above a component covering it.
            // pointerEvents re-enables hit-testing under .components-area's
            // pointer-events: none.
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              zIndex: isSelected ? 2 : 1,
              pointerEvents: 'auto',
            }}
          >
            <InstrumentComponent
              id={component.id}
              metadataId={component.metadataId}
              x={component.x}
              y={component.y}
              isSelected={isSelected}
              onMouseDown={(e) => handleComponentMouseDown(component.id, e)}
            />
            {!interactionRunning && (
              <PinOverlay
                componentId={component.id}
                componentX={component.x}
                componentY={component.y}
                onPinClick={handlePinClick}
                showPins={showPinsForComponent}
                zoom={zoom}
                wrapperOffsetX={0}
                wrapperOffsetY={0}
                wiring={wireInProgress}
              />
            )}
          </div>
        </React.Fragment>
      );
    }

    const metadata = registry.getById(component.metadataId);
    if (!metadata) {
      console.warn(`Metadata not found for component: ${component.metadataId}`);
      return null;
    }

    const isSelected = selectedComponentId === component.id;
    const isHovered = hoveredComponentId === component.id;
    const dialogOpen =
      showPropertyDialog || customChipComponentId !== null || sensorControlComponentId !== null;
    // Show pins only when relevant: while a wire is in progress (any pin is a
    // valid target) or while hovering the component — selection alone doesn't
    // light them up (a selected breadboard lit 170 squares permanently).
    // Hidden when a dialog is open. Hidden entirely on touch — there the
    // PinPickerDialog (tap component → list of pins) replaces the overlays.
    const showPinsForComponent =
      !dialogOpen && !isTouchDevice && (wireInProgress || isHovered);

    // Breadboards are the physical base of a circuit — everything plugs into
    // them — so they always sit at the very back: below boards (z 0), other
    // components (z 1/2) and wires (z 35). Selection doesn't raise them.
    const isBreadboard = String(component.metadataId).startsWith('breadboard');
    // A large-bodied display seated on a breadboard physically sits ON the
    // board, so wires routed to holes UNDERNEATH it pass behind its body in
    // real life. On the flat canvas those bridge wires (segment strips whose
    // holes are literally under the display) otherwise paint OVER the digits
    // — the reported "los cables se ven superpuestos y casi ni se ven los
    // dígitos". Raise a seated display above the wire layer (z 35) so its
    // face occludes the wires crossing it, exactly as the real part would.
    // Scoped to occluding display bodies + only when actually seated, so
    // thin parts (resistors, LEDs) and free-floating displays are untouched.
    const isSeated = (seatedPinsByComponent.get(component.id)?.length ?? 0) > 0;
    const occludesWhenSeated = DISPLAY_BODY_METADATA_RE.test(String(component.metadataId));
    const groupZIndex = isBreadboard
      ? -1
      : isSeated && occludesWhenSeated
        ? isSelected
          ? 37
          : 36
        : isSelected
          ? 2
          : 1;

    return (
      <React.Fragment key={component.id}>
        <div
          className="component-interactive-group"
          onMouseEnter={() => setHoveredComponentId(component.id)}
          onMouseLeave={() =>
            setHoveredComponentId((curr) => (curr === component.id ? null : curr))
          }
          // Zero-size positioned wrapper: children keep their absolute canvas
          // coords, but body + pins now share ONE stacking context, so this
          // component's pins can never paint above a component covering it.
          // Selected components (z 2) still raise above unselected ones (z 1);
          // breadboards are pinned behind everything (z -1).
          // pointerEvents re-enables hit-testing under .components-area's
          // pointer-events: none.
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            zIndex: groupZIndex,
            pointerEvents: 'auto',
          }}
        >
          <DynamicComponent
            id={component.id}
            metadata={metadata}
            properties={component.properties}
            x={component.x}
            y={component.y}
            isSelected={isSelected}
            isHovered={isHovered}
            onMouseDown={(e) => {
              handleComponentMouseDown(component.id, e);
            }}
          />

          {/* Green dots on pins plugged into a breadboard — always visible so
              "seated & connected" is legible without hovering. */}
          <SeatedPinMarkers
            componentId={component.id}
            componentX={component.x}
            componentY={component.y}
            seatedPins={seatedPinsByComponent.get(component.id) ?? []}
            rotation={Number(component.properties?.rotation) || 0}
          />

          {/* Pin overlay for wire creation - hide while interacting/running */}
          {!interactionRunning && (
            <PinOverlay
              componentId={component.id}
              componentX={component.x}
              componentY={component.y}
              onPinClick={handlePinClick}
              showPins={showPinsForComponent}
              zoom={zoom}
              rotation={Number(component.properties?.rotation) || 0}
              wiring={wireInProgress}
            />
          )}
        </div>
      </React.Fragment>
    );
  };

  return (
    <div className="simulator-canvas-container">
      {/* ESP32 crash notification */}
      {esp32CrashBoardId && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1000,
            background: '#c0392b',
            color: '#fff',
            padding: '8px 16px',
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontSize: 13,
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          }}
        >
          <span>
            ESP32 crash detected on board <strong>{esp32CrashBoardId}</strong> — cache error (IDF
            incompatibility)
          </span>
          <button
            onClick={dismissEsp32Crash}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.6)',
              color: '#fff',
              borderRadius: 4,
              padding: '2px 8px',
              cursor: 'pointer',
            }}
          >
            {t('editor.canvas.dismiss')}
          </button>
        </div>
      )}

      {/* Main Canvas */}
      <div className="simulator-canvas">
        {(() => {
          const headerJsx = (
        <div className={`canvas-header${headerSlot ? ' canvas-header--portaled' : ''}`}>
          <div className="canvas-header-left">
            {/* Status LED */}
            <span
              className={`status-dot ${running ? 'running' : 'stopped'}`}
              title={running ? t('editor.canvas.status.running') : t('editor.canvas.status.stopped')}
            />

            {/* Active board selector (multi-board) — hidden when no boards */}
            {boards.length > 0 ? (
              <select
                className="board-selector"
                value={activeBoardId ?? ''}
                onChange={(e) => useSimulatorStore.getState().setActiveBoardId(e.target.value)}
                disabled={running}
                title={t('editor.canvas.activeBoard')}
              >
                {boards.map((b) => (
                  <option key={b.id} value={b.id}>
                    {boardDisplayName(b)}
                  </option>
                ))}
              </select>
            ) : (
              <span
                className="board-selector"
                style={{ opacity: 0.55, fontStyle: 'italic', cursor: 'default' }}
                title={t('editor.canvas.noBoardHint')}
              >
                {t('editor.canvas.noBoard')}
              </span>
            )}

            {/* Undo / Redo — canvas-scoped, mirrors the Ctrl+Z / Ctrl+Y
                handler in EditorPage. Tooltip surfaces the description of
                the command that would be applied. Disabled when the stack
                is exhausted in that direction. */}
            <button
              onClick={() => undo()}
              disabled={historyIndex < 0}
              className="canvas-icon-btn"
              title={
                historyIndex >= 0
                  ? t('editor.canvas.undo.title', { description: history[historyIndex].description })
                  : t('editor.canvas.undo.empty')
              }
              aria-label={t('editor.canvas.undo.label')}
            >
              <Undo2 size={16} strokeWidth={2} aria-hidden="true" />
            </button>
            <button
              onClick={() => redo()}
              disabled={historyIndex >= history.length - 1}
              className="canvas-icon-btn"
              title={
                historyIndex < history.length - 1
                  ? t('editor.canvas.redo.title', { description: history[historyIndex + 1].description })
                  : t('editor.canvas.redo.empty')
              }
              aria-label={t('editor.canvas.redo.label')}
            >
              <Redo2 size={16} strokeWidth={2} aria-hidden="true" />
            </button>

            {/* Serial Monitor toggle */}
            <button
              onClick={() => {
                toggleSerialMonitor();
                trackToggleSerialMonitor(!serialMonitorOpen);
              }}
              className={`canvas-serial-btn${serialMonitorOpen ? ' canvas-serial-btn-active' : ''}`}
              title={t('editor.canvas.toggleSerialMonitor')}
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <path d="M8 21h8M12 17v4" />
              </svg>
              {t('editor.canvas.serial')}
            </button>

            {/* ESP32-CAM webcam stream toggle */}
            {activeBoard?.boardKind === 'esp32-cam' && (
              <CameraToggle boardId={activeBoard.id} />
            )}

            {/* WiFi status indicator + IoT-gateway launcher (ESP32 + Pico W) */}
            {activeBoard &&
              (isEsp32Kind(activeBoard.boardKind) ||
                activeBoard.boardKind === 'pi-pico-w') &&
              activeBoard.wifiStatus &&
              (() => {
                // The Pico W virtual net assigns its IP deterministically when
                // the sketch connects; the bridge reports 'started' carrying the
                // IP. Treat that as got_ip so the badge matches the ESP32 (green,
                // clickable → the same /api/gateway proxy).
                const rawStatus = activeBoard.wifiStatus.status;
                const status =
                  activeBoard.boardKind === 'pi-pico-w' &&
                  rawStatus === 'started' &&
                  activeBoard.wifiStatus.ip
                    ? 'got_ip'
                    : rawStatus;
                const hasIp = status === 'got_ip';
                const sessionId = getTabSessionId();
                const clientId = `${sessionId}::${activeBoard.id}`;
                const backendBase =
                  (import.meta.env.VITE_API_BASE as string | undefined) ??
                  'http://localhost:8001/api';
                const gatewayUrl = `${backendBase}/gateway/${clientId}/`;

                const openGateway = () => {
                  if (!hasIp) return;
                  // A private overlay (velxio.dev) can install a synchronous
                  // gate to keep the IoT gateway behind a paid plan. When it
                  // returns true it has already handled the click (e.g. shown
                  // an in-place upgrade modal), so we don't open the tab.
                  // OSS builds have no hook → always open.
                  const gate = (window as unknown as {
                    __velxio_iot_gateway_open_gate__?: () => boolean;
                  }).__velxio_iot_gateway_open_gate__;
                  if (gate && gate()) return;
                  // Pico W runs in THIS tab — a new tab would background and
                  // freeze the emulation. Show the page in an in-app iframe.
                  if (activeBoard.boardKind === 'pi-pico-w') {
                    openDeviceGateway(gatewayUrl);
                  } else {
                    window.open(gatewayUrl, '_blank');
                  }
                };
                return (
                  <span
                    className={`canvas-wifi-badge canvas-wifi-${status}${hasIp ? ' canvas-wifi-clickable' : ''}`}
                    onClick={openGateway}
                    title={
                      hasIp
                        ? `WiFi: ${activeBoard.wifiStatus.ssid ?? 'Velxio-GUEST'} — IP: ${activeBoard.wifiStatus.ip}\nClick to open IoT Gateway ↗`
                        : status === 'connected'
                          ? `WiFi: ${activeBoard.wifiStatus.ssid ?? 'Velxio-GUEST'} — Connecting...`
                          : status === 'initializing'
                            ? 'WiFi: Initializing...'
                            : 'WiFi: Disconnected'
                    }
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 12.55a11 11 0 0 1 14.08 0" />
                      <path d="M1.42 9a16 16 0 0 1 21.16 0" />
                      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                      <circle cx="12" cy="20" r="1" />
                    </svg>
                  </span>
                );
              })()}

            {/* BLE status indicator (ESP32 boards only) */}
            {activeBoard && isEsp32Kind(activeBoard.boardKind) && activeBoard.bleStatus && (
              <span
                className={`canvas-ble-badge canvas-ble-${activeBoard.bleStatus.status}`}
                title={
                  activeBoard.bleStatus.status === 'advertising'
                    ? 'BLE: Advertising'
                    : 'BLE: Initialized'
                }
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5" />
                </svg>
              </span>
            )}

            {/* Oscilloscope toggle */}
            <button
              onClick={toggleOscilloscope}
              className={`canvas-serial-btn${oscilloscopeOpen ? ' canvas-serial-btn-active' : ''}`}
              title={t('editor.canvas.toggleScope')}
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="2 14 6 8 10 14 14 6 18 14 22 10" />
              </svg>
              {t('editor.canvas.scope')}
            </button>
          </div>

          <div className="canvas-header-right">
            {/* Zoom controls */}
            <div className="zoom-controls">
              <button
                className="zoom-btn"
                onClick={() =>
                  handleWheel({
                    deltaY: 100,
                    clientX: 0,
                    clientY: 0,
                    preventDefault: () => {},
                  } as any)
                }
                title={t('editor.canvas.zoomOut')}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
              <button
                className="zoom-level"
                onClick={handleResetView}
                title={t('editor.canvas.resetView')}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                className="zoom-btn"
                onClick={() =>
                  handleWheel({
                    deltaY: -100,
                    clientX: 0,
                    clientY: 0,
                    preventDefault: () => {},
                  } as any)
                }
                title={t('editor.canvas.zoomIn')}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            </div>

            {/* Component count */}
            <span
              className="component-count"
              title={t('editor.canvas.componentCount', { count: components.length })}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="2" y="7" width="20" height="14" rx="2" />
                <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
              </svg>
              {components.length}
            </span>

            {/* Add Component */}
            <button
              className="add-component-btn"
              onClick={() => setShowComponentPicker(true)}
              title={t('editor.canvas.addComponentTitle')}
              disabled={running}
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              {t('editor.canvas.add')}
            </button>
          </div>
        </div>
          );
          return headerSlot ? createPortal(headerJsx, headerSlot) : headerJsx;
        })()}
        <div
          ref={canvasRef}
          className="canvas-content"
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
          onMouseLeave={() => {
            isPanningRef.current = false;
            setPan({ ...panRef.current });
            setDraggedComponentId(null);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            if (wireInProgress) {
              cancelWireCreation();
              return;
            }
            // Right-click on a wire → open its color / delete context menu.
            // Right-clicks on a board are handled by the board element's own
            // onContextMenu (which stops propagation), so this only fires over
            // empty canvas or a wire. Disabled while the simulation runs
            // (canvas is interact-only then).
            if (interactionRunning) return;
            const world = toWorld(e.clientX, e.clientY);
            const threshold = 8 / zoomRef.current;
            const wire = findWireNearPoint(wiresRef.current, world.x, world.y, threshold);
            if (wire) {
              setSelectedWire(wire.id);
              setWireContextMenu({ wireId: wire.id, x: e.clientX, y: e.clientY });
            }
          }}
          onClick={(e) => {
            if (wireInProgress) {
              const world = toWorld(e.clientX, e.clientY);
              addWireWaypoint(world.x, world.y);
              return;
            }
            // If a segment handle drag just finished, don't also select
            if (segmentDragJustCommittedRef.current) {
              segmentDragJustCommittedRef.current = false;
              return;
            }
            // Mouse-up already selected a wire under this click (breadboard
            // body case) — don't let this bubbled click toggle it back off.
            if (wireSelectJustHandledRef.current) {
              wireSelectJustHandledRef.current = false;
              return;
            }
            // While the simulation runs the canvas is interact-only: a click on
            // a button must press it (its own handler), not select the wire
            // underneath it for editing.
            if (interactionRunning) return;
            // Wire selection via canvas-level hit detection
            const world = toWorld(e.clientX, e.clientY);
            const threshold = 8 / zoomRef.current;
            const wire = findWireNearPoint(wiresRef.current, world.x, world.y, threshold);
            if (wire) {
              setSelectedWire(selectedWireId === wire.id ? null : wire.id);
            } else {
              setSelectedWire(null);
              setSelectedComponentId(null);
            }
          }}
          onDoubleClick={(e) => {
            if (wireInProgress || interactionRunning) return;
            const world = toWorld(e.clientX, e.clientY);
            const threshold = 8 / zoomRef.current;
            const wire = findWireNearPoint(wiresRef.current, world.x, world.y, threshold);
            if (!wire) return;
            const seg = findSegmentNearPoint(wire, world.x, world.y, threshold);
            if (!seg) return;
            // Insert a draggable waypoint where the user double-clicked,
            // projected onto the segment so the wire stays orthogonal.
            const newWaypoints = insertWaypointAtSegment(
              wire.waypoints ?? [],
              seg,
              world.x,
              world.y,
            );
            updateWire(wire.id, { waypoints: newWaypoints, autoRouted: false });
            setSelectedWire(wire.id);
          }}
          style={{
            cursor: isPanningRef.current
              ? 'grabbing'
              : wireInProgress
                ? 'crosshair'
                : hoveredWireId
                  ? 'pointer'
                  : 'default',
          }}
        >
          {/* Sensor Control Panel — shown when a sensor component is clicked during simulation.
              key={sensorControlComponentId} forces a fresh mount when the user clicks a
              different instance of the same sensor type (e.g. a second photoresistor); the
              slider state is local and would otherwise show the previously-clicked sensor's
              value until the user manually moved it. The sensorResetNonce suffix also remounts
              it on Reset, so the slider snaps back to the sensor's default value. */}
          {sensorControlComponentId &&
            sensorControlMetadataId &&
            (() => {
              const meta = registry.getById(sensorControlMetadataId);
              return (
                <SensorControlPanel
                  key={`${sensorControlComponentId}:${sensorResetNonce}`}
                  componentId={sensorControlComponentId}
                  metadataId={sensorControlMetadataId}
                  sensorName={meta?.name ?? sensorControlMetadataId}
                  onClose={() => {
                    setSensorControlComponentId(null);
                    setSensorControlMetadataId(null);
                  }}
                />
              );
            })()}

          {/* Infinite world — pan+zoom applied here */}
          <div
            className="canvas-world"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
          >
            {/* Wire Layer - Renders below all components */}
            <WireLayer
              hoveredWireId={hoveredWireId}
              segmentDragPreview={segmentDragPreview}
              segmentHandles={segmentHandles}
              waypointHandles={waypointHandles}
              alignmentGuides={alignmentGuides}
              onHandleMouseDown={handleHandleMouseDown}
              onHandleTouchStart={handleHandleTouchStart}
              onWaypointMouseDown={handleWaypointMouseDown}
              onWaypointTouchStart={handleWaypointTouchStart}
            />

            {/* All boards on canvas */}
            {boards.map((board) => {
              const isHovered = hoveredBoardId === board.id;
              const isActive = board.id === activeBoardId;
              const dialogOpen =
                showPropertyDialog ||
                customChipComponentId !== null ||
                sensorControlComponentId !== null;
              // Pins show during wiring (every endpoint is a valid target) or
              // when hovering the board — NOT just for being the active board,
              // which lit up every pin permanently and cluttered the canvas.
              // Suppressed while a dialog is open. Hidden entirely on touch
              // since the PinPickerDialog (tap board to open list) replaces
              // the overlays — fingers can't reliably hit a 12px pin anyway.
              const showPins =
                !dialogOpen && !isTouchDevice && (wireInProgress || isHovered);
              return (
                <BoardOnCanvas
                  key={board.id}
                  board={board}
                  running={running}
                  isActive={isActive}
                  showPins={showPins}
                  wiring={wireInProgress}
                  led13={Boolean(boardLedStates[board.id])}
                  onMouseEnter={() => setHoveredBoardId(board.id)}
                  onMouseLeave={() =>
                    setHoveredBoardId((curr) => (curr === board.id ? null : curr))
                  }
                  onMouseDown={(e) => {
                    setClickStartTime(Date.now());
                    setClickStartPos({ x: e.clientX, y: e.clientY });
                    const world = toWorld(e.clientX, e.clientY);
                    setDraggedComponentId(`__board__:${board.id}`);
                    setDragOffset({ x: world.x - board.x, y: world.y - board.y });
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setBoardContextMenu({ boardId: board.id, x: e.clientX, y: e.clientY });
                  }}
                  onPinClick={handlePinClick}
                  zoom={zoom}
                />
              );
            })}

            {/* Components using wokwi-elements */}
            <div className="components-area">
              {registryLoaded && components.map(renderComponent)}
            </div>

            {/* Electrical simulation overlay (voltages / warnings).
                Voltage pills are hover-gated — see ElectricalOverlay. */}
            <ElectricalOverlay
              hoveredWireId={hoveredWireId}
              hoveredComponentId={hoveredComponentId}
              hoveredBoardId={hoveredBoardId}
            />
          </div>

          {/* Wire creation mode banner — visible on both desktop and mobile */}
          {wireInProgress && (
            <WireModeBanner
              message="Tap a pin to connect — tap canvas for waypoints"
              onCancel={() => cancelWireCreation()}
            />
          )}

          {/* Floating action bar (top-center) for the current selection. Hidden
              while creating a wire (fights the wire-mode banner) and while the
              simulator is running (canvas is read-only).
              - WIRE selection shows on BOTH desktop and touch: it carries the
                color palette, which is otherwise only reachable on desktop via
                the 0-9 / c,l,m,p,y keyboard shortcuts (not discoverable). The
                bar is pinned top-center so it never covers pins near the wire.
              - COMPONENT selection stays touch-only — desktop already has the
                Delete key + the right-click rotate menu. */}
          {!wireInProgress && !interactionRunning &&
            (() => {
              if (selectedWireId) {
                const wire = wires.find((w) => w.id === selectedWireId);
                return (
                  <SelectionActionBar
                    kind="wire"
                    label="Wire"
                    currentColor={wire?.color}
                    onColorChange={(color) => {
                      if (!wire) return;
                      recordUpdateWire(selectedWireId, { color: wire.color }, { color });
                    }}
                    onDelete={() => {
                      // Recorded so the delete is also undoable.
                      recordRemoveWire(selectedWireId);
                      setSelectedWire(null);
                    }}
                    onDeselect={() => setSelectedWire(null)}
                  />
                );
              }
              if (isTouchDevice && selectedComponentId) {
                const c = components.find((x) => x.id === selectedComponentId);
                if (!c) return null;
                const meta = registry.getById(c.metadataId);
                return (
                  <SelectionActionBar
                    kind="component"
                    label={meta?.name ?? 'Component'}
                    canRotate
                    onRotate={() => handleRotateComponent(selectedComponentId)}
                    onDelete={() => {
                      recordRemoveComponent(selectedComponentId);
                      setSelectedComponentId(null);
                    }}
                    onDeselect={() => setSelectedComponentId(null)}
                  />
                );
              }
              return null;
            })()}

          {/* Minimap — small overview of the world with a draggable viewport
              rectangle, anchored to the canvas-content bottom-right corner.
              Sits inside .canvas-content (not .canvas-world) so it stays
              fixed while the world pans / zooms. */}
          <CanvasMinimap
            pan={pan}
            zoom={zoom}
            setPan={(p) => {
              panRef.current = p;
              setPan(p);
            }}
            panRef={panRef}
            zoomRef={zoomRef}
            components={components}
            boards={boards}
            viewportRef={canvasRef}
          />
        </div>
      </div>

      {/* Touch-friendly pin picker — used to pick a pin from a list when the
          user taps a component or board body (rather than poking a 12px
          overlay). Closes on backdrop tap or after a pin is chosen. */}
      {pinPicker &&
        (() => {
          const id = pinPicker.targetId;
          const el = document.getElementById(id);
          const pins: Array<{ name: string; x: number; y: number; description?: string }> = el
            ? ((el as any).pinInfo ?? [])
            : [];
          let title = pinPicker.kind === 'board' ? 'Board' : 'Component';
          if (pinPicker.kind === 'board') {
            const b = boards.find((x) => x.id === id);
            if (b) title = boardDisplayName(b);
          } else {
            const c = components.find((x) => x.id === id);
            const meta = c ? registry.getById(c.metadataId) : null;
            if (meta) title = meta.name;
          }
          const subtitle = wireInProgress ? 'Tap a pin to connect' : 'Tap a pin to start a wire';
          // Rotate is only meaningful for components (boards have no rotation).
          const handlePickerRotate =
            pinPicker.kind === 'component'
              ? () => {
                  handleRotateComponent(id);
                }
              : undefined;
          // Delete handlers route through the existing flows: components use
          // removeComponent() directly; boards use the confirmation dialog
          // that's already wired for the right-click "Remove board" item.
          const handlePickerDelete = () => {
            if (pinPicker.kind === 'board') {
              setPinPicker(null);
              setBoardToRemove(id);
            } else {
              setPinPicker(null);
              recordRemoveComponent(id);
              setSelectedComponentId(null);
            }
          };
          return (
            <PinPickerDialog
              targetId={id}
              title={title}
              subtitle={subtitle}
              pins={pins}
              onRotate={handlePickerRotate}
              onDelete={handlePickerDelete}
              onClose={() => setPinPicker(null)}
              onPinSelect={(targetId, pinName) => {
                const pin = pins.find((p) => p.name === pinName);
                if (!pin) {
                  setPinPicker(null);
                  return;
                }
                // Resolve world coords the SAME way wires + the pin overlay do:
                // calculatePinPosition rotates the pin around the wrapper centre
                // for the component's rotation. The old getBoundingClientRect path
                // added the unrotated pin offset to the ROTATED bounding-box corner,
                // landing the wire start ~70-100px off on a rotated part (issue #231).
                let worldX: number;
                let worldY: number;
                if (pinPicker.kind === 'board') {
                  const b = boards.find((x) => x.id === targetId);
                  const pos = calculatePinPosition(targetId, pinName, b?.x ?? 0, b?.y ?? 0, 0);
                  worldX = pos?.x ?? (b?.x ?? 0) + pin.x;
                  worldY = pos?.y ?? (b?.y ?? 0) + pin.y;
                } else {
                  const c = components.find((x) => x.id === targetId);
                  const rot = c ? Number(c.properties?.rotation) || 0 : 0;
                  const pos = calculatePinPosition(targetId, pinName, (c?.x ?? 0) + 6, (c?.y ?? 0) + 6, rot);
                  worldX = pos?.x ?? (c?.x ?? 0) + pin.x;
                  worldY = pos?.y ?? (c?.y ?? 0) + pin.y;
                }
                setPinPicker(null);
                handlePinClick(targetId, pinName, worldX, worldY);
              }}
            />
          );
        })()}

      {/* Component Property Dialog */}
      {showPropertyDialog &&
        propertyDialogComponentId &&
        (() => {
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
              wireInProgress={Boolean(wireInProgress)}
              onClose={() => setShowPropertyDialog(false)}
              onRotate={handleRotateComponent}
              onDelete={(id) => {
                recordRemoveComponent(id);
                setShowPropertyDialog(false);
              }}
              onPropertyChange={(id, propName, value) => {
                const comp = components.find((c) => c.id === id);
                if (comp) {
                  const prevValue = comp.properties[propName];
                  updateComponent(id, {
                    properties: { ...comp.properties, [propName]: value },
                  });
                  // Property panel is the canonical UI for property edits — record
                  // each change so Ctrl+Z reverts the value (without re-running the
                  // raw mutation, which already happened).
                  if (prevValue !== value) {
                    recordSetProperty(id, propName, prevValue, value);
                  }
                }
              }}
              onPinSelect={(id, pinName) => {
                // Resolve world coords the SAME way wires + the pin overlay do,
                // via calculatePinPosition, which rotates the pin around the
                // wrapper centre for the component's rotation. The old
                // getBoundingClientRect path added the unrotated pin offset to the
                // ROTATED bounding-box corner, so on a rotated part the wire start
                // landed ~70-100px away from the pin (issue #231).
                const pin = (pinInfo || []).find((p: { name: string }) => p.name === pinName);
                const c = components.find((x) => x.id === id);
                if (!c || !pin) return;
                const rot = Number(c.properties?.rotation) || 0;
                const pos = calculatePinPosition(id, pinName, c.x + 6, c.y + 6, rot);
                const worldX = pos?.x ?? c.x + pin.x;
                const worldY = pos?.y ?? c.y + pin.y;
                setShowPropertyDialog(false);
                handlePinClick(id, pinName, worldX, worldY);
              }}
            />
          );
        })()}

      {/* Custom Chip Designer Dialog */}
      {customChipComponentId &&
        (() => {
          const comp = components.find((c) => c.id === customChipComponentId);
          if (!comp) return null;
          const props = comp.properties as Record<string, unknown>;
          return (
            <CustomChipDialog
              initial={{
                chipName:   String(props.chipName   ?? 'My Chip'),
                sourceC:    String(props.sourceC    ?? ''),
                chipJson:   String(props.chipJson   ?? ''),
                wasmBase64: String(props.wasmBase64 ?? ''),
                attrs:      (props.attrs as Record<string, number>) ?? {},
              }}
              onClose={() => setCustomChipComponentId(null)}
              onSave={(data) => {
                updateComponent(customChipComponentId, {
                  properties: { ...comp.properties, ...data },
                } as any);
                setCustomChipComponentId(null);
                // Force the chip's pin layout to re-render after the save.
                recalculateAllWirePositions();
              }}
            />
          );
        })()}

      {/* Component Picker Modal */}
      <ComponentPickerModal
        isOpen={showComponentPicker}
        onClose={() => setShowComponentPicker(false)}
        onSelectComponent={handleSelectComponent}
        onSelectBoard={(kind: BoardKind) => {
          // Pro gate: STM32 + Raspberry Pi emulation is paid-only on the web.
          // The overlay's gate returns 'block' for non-paid web users; show the
          // upgrade prompt and skip the add. OSS / desktop / paid -> 'allow'.
          if (boardGateDecision(kind) === 'block') {
            triggerProUpgradePrompt(proBoardFeatureName(kind));
            return;
          }
          trackSelectBoard(kind);
          const sameKind = boards.filter((b) => b.boardKind === kind);
          const newBoardId = sameKind.length === 0 ? kind : `${kind}-${sameKind.length + 1}`;
          const x = boardPosition.x + boards.length * 60 + 420;
          const y = boardPosition.y + boards.length * 30;
          addBoard(kind, x, y);
          // file group is created inside addBoard
          void newBoardId;
        }}
      />

      {/* Board right-click context menu */}
      {wireContextMenu &&
        (() => {
          const wire = wires.find((w) => w.id === wireContextMenu.wireId);
          if (!wire) return null;
          return (
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
                onClick={() => setWireContextMenu(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setWireContextMenu(null);
                }}
              />
              <div
                style={{
                  position: 'fixed',
                  left: wireContextMenu.x,
                  top: wireContextMenu.y,
                  background: '#252526',
                  border: '1px solid #3c3c3c',
                  borderRadius: 6,
                  padding: 8,
                  zIndex: 9999,
                  width: 188,
                  boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
                  fontSize: 13,
                }}
              >
                <div style={{ padding: '2px 4px 8px', color: '#888', fontSize: 11 }}>
                  {t('editor.selectionBar.changeColor')}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {Object.values(WIRE_KEY_COLORS).map((color) => (
                    <button
                      key={color}
                      type="button"
                      title={color}
                      onClick={() => {
                        recordUpdateWire(
                          wireContextMenu.wireId,
                          { color: wire.color },
                          { color },
                        );
                        setWireContextMenu(null);
                      }}
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: '50%',
                        backgroundColor: color,
                        border:
                          color.toLowerCase() === wire.color?.toLowerCase()
                            ? '2px solid #fff'
                            : '1px solid rgba(255,255,255,0.2)',
                        cursor: 'pointer',
                        padding: 0,
                        flexShrink: 0,
                      }}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    recordRemoveWire(wireContextMenu.wireId);
                    setSelectedWire(null);
                    setWireContextMenu(null);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    marginTop: 8,
                    padding: '7px 6px',
                    background: 'none',
                    border: 'none',
                    borderTop: '1px solid #3c3c3c',
                    color: '#e06c75',
                    cursor: 'pointer',
                    fontSize: 13,
                    textAlign: 'left',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = '#2a2d2e';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'none';
                  }}
                >
                  {t('editor.selectionBar.deleteKind.wire')}
                </button>
              </div>
            </>
          );
        })()}

      {boardContextMenu &&
        (() => {
          const board = boards.find((b) => b.id === boardContextMenu.boardId);
          const label = board ? boardDisplayName(board) : 'Board';
          const connectedWires = wires.filter(
            (w) =>
              w.start.componentId === boardContextMenu.boardId ||
              w.end.componentId === boardContextMenu.boardId,
          ).length;
          const supportsOptions = board ? isEsp32Family(board.boardKind) : false;
          return (
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
                onClick={() => setBoardContextMenu(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setBoardContextMenu(null);
                }}
              />
              <div
                style={{
                  position: 'fixed',
                  left: boardContextMenu.x,
                  top: boardContextMenu.y,
                  background: '#252526',
                  border: '1px solid #3c3c3c',
                  borderRadius: 6,
                  padding: '4px 0',
                  zIndex: 9999,
                  minWidth: 200,
                  boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
                  fontSize: 13,
                }}
              >
                <div
                  style={{
                    padding: '6px 14px',
                    color: '#888',
                    fontSize: 11,
                    borderBottom: '1px solid #3c3c3c',
                    marginBottom: 2,
                  }}
                >
                  {label}
                </div>
                <button
                  disabled={!supportsOptions}
                  title={supportsOptions ? undefined : 'ESP32 only'}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '7px 14px',
                    background: 'none',
                    border: 'none',
                    color: supportsOptions ? '#ddd' : '#555',
                    cursor: supportsOptions ? 'pointer' : 'not-allowed',
                    fontSize: 13,
                    textAlign: 'left',
                  }}
                  onMouseEnter={(e) => {
                    if (supportsOptions) e.currentTarget.style.background = '#2a2d2e';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'none';
                  }}
                  onClick={() => {
                    if (!supportsOptions) return;
                    setBoardOptionsModalFor(boardContextMenu.boardId);
                    setBoardContextMenu(null);
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  Board Options...
                </button>
                <div
                  style={{
                    height: 1,
                    background: '#3c3c3c',
                    margin: '4px 0',
                  }}
                />
                {/* Hardware flash — only useful inside Tauri (web can't
                    talk to USB serial without WebSerial). Hidden in web
                    so the item doesn't tease a feature that won't work
                    until the WebSerial track lands. */}
                {isTauriRuntime && (
                  <button
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '7px 14px',
                      background: 'none',
                      border: 'none',
                      color: !!board?.compiledProgram ? '#e6e6e9' : '#666',
                      cursor: !!board?.compiledProgram ? 'pointer' : 'not-allowed',
                      fontSize: 13,
                      textAlign: 'left',
                    }}
                    onMouseEnter={(e) => {
                      if (board?.compiledProgram) e.currentTarget.style.background = '#2a2d2e';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'none';
                    }}
                    disabled={!board?.compiledProgram}
                    title={
                      board?.compiledProgram
                        ? 'Flash the compiled sketch to a real USB-attached board'
                        : 'Compile the sketch first'
                    }
                    onClick={() => {
                      if (!board?.compiledProgram) return;
                      setFlashModalFor(boardContextMenu.boardId);
                      setBoardContextMenu(null);
                    }}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                    </svg>
                    Flash to real board
                  </button>
                )}
                <div
                  style={{
                    height: 1,
                    background: '#3c3c3c',
                    margin: '4px 0',
                  }}
                />
                <button
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '7px 14px',
                    background: 'none',
                    border: 'none',
                    color: '#e06c75',
                    cursor: 'pointer',
                    fontSize: 13,
                    textAlign: 'left',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = '#2a2d2e';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'none';
                  }}
                  onClick={() => {
                    setBoardContextMenu(null);
                    setBoardToRemove(boardContextMenu.boardId);
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                  {t('editor.canvas.removeBoard')}
                  {connectedWires > 0 && (
                    <span style={{ color: '#888', fontSize: 11 }}>
                      ({t('editor.canvas.wireCount', { count: connectedWires })})
                    </span>
                  )}
                </button>
              </div>
            </>
          );
        })()}

      {/* Hardware flash modal — opens from board context menu when
          the user has compiled the sketch + clicks "Flash to real
          board". Only present in Tauri (web hides the menu item). */}
      {flashModalFor &&
        (() => {
          const b = boards.find((x) => x.id === flashModalFor);
          if (!b) return null;
          const fqbn = BOARD_KIND_FQBN[b.boardKind];
          if (!fqbn) {
            // The board kind has no arduino-cli FQBN (e.g. some
            // virtual boards or chips). Auto-close — surface a toast
            // via the existing menu-event system if/when that exists.
            console.warn('[flash] no FQBN for board kind', b.boardKind);
            setFlashModalFor(null);
            return null;
          }
          return (
            <FlashModal
              board={b}
              fqbn={fqbn}
              onClose={() => setFlashModalFor(null)}
            />
          );
        })()}

      {/* Board Options modal (ESP32 only) */}
      {boardOptionsModalFor &&
        (() => {
          const b = boards.find((x) => x.id === boardOptionsModalFor);
          if (!b) return null;
          return (
            <BoardOptionsModal
              isOpen={true}
              boardId={b.id}
              boardName={b.name}
              boardKind={b.boardKind}
              currentOptions={b.boardOptions}
              spiffsFiles={b.spiffsFiles ?? []}
              onClose={() => setBoardOptionsModalFor(null)}
              onApply={(opts) => updateBoard(b.id, { boardOptions: opts })}
              onSpiffsChange={(files) => updateBoard(b.id, { spiffsFiles: files })}
            />
          );
        })()}

      {/* Board removal confirmation dialog */}
      {boardToRemove &&
        (() => {
          const board = boards.find((b) => b.id === boardToRemove);
          const label = board ? boardDisplayName(board) : t('editor.canvas.removeConfirm.boardFallback');
          const connectedWires = wires.filter(
            (w) => w.start.componentId === boardToRemove || w.end.componentId === boardToRemove,
          ).length;
          return (
            <div
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.5)',
                zIndex: 10000,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <div
                style={{
                  background: '#1e1e1e',
                  border: '1px solid #3c3c3c',
                  borderRadius: 8,
                  padding: '20px 24px',
                  maxWidth: 380,
                  boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
                }}
              >
                <h3 style={{ margin: '0 0 10px', color: '#e0e0e0', fontSize: 15 }}>
                  {t('editor.canvas.removeConfirm.title', { label })}
                </h3>
                <p style={{ margin: '0 0 16px', color: '#999', fontSize: 13, lineHeight: 1.5 }}>
                  {connectedWires > 0
                    ? t('editor.canvas.removeConfirm.bodyWithWires', { count: connectedWires })
                    : t('editor.canvas.removeConfirm.body')}
                </p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => setBoardToRemove(null)}
                    style={{
                      padding: '6px 16px',
                      background: '#333',
                      border: '1px solid #555',
                      borderRadius: 4,
                      color: '#ccc',
                      cursor: 'pointer',
                      fontSize: 13,
                    }}
                  >
                    {t('editor.canvas.removeConfirm.cancel')}
                  </button>
                  <button
                    onClick={() => {
                      removeBoard(boardToRemove);
                      setBoardToRemove(null);
                    }}
                    style={{
                      padding: '6px 16px',
                      background: '#e06c75',
                      border: 'none',
                      borderRadius: 4,
                      color: '#fff',
                      cursor: 'pointer',
                      fontSize: 13,
                    }}
                  >
                    {t('editor.canvas.removeConfirm.remove')}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
};
