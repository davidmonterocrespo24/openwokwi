# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a local Arduino emulator (Wokwi clone) that provides a full development environment for Arduino projects:
- Frontend: React + Vite + TypeScript with Monaco Editor and visual simulation canvas
- Backend: FastAPI + Python for Arduino code compilation via arduino-cli
- Simulation: Real AVR8 emulation using avr8js with full GPIO/timer/USART support
- Components: Visual electronic components from wokwi-elements (LEDs, resistors, buttons, etc.)

The project uses **local clones of official Wokwi repositories** instead of npm packages for maximum compatibility and ease of updates.

## Development Commands

### Backend (FastAPI + Python)

**Setup:**
```bash
cd backend
python -m venv venv
venv\Scripts\activate  # Windows
pip install -r requirements.txt
```

**Run development server:**
```bash
cd backend
venv\Scripts\activate
uvicorn app.main:app --reload --port 8001
```

**Access:**
- API: http://localhost:8001
- Docs: http://localhost:8001/docs

### Frontend (React + Vite)

**Setup:**
```bash
cd frontend
npm install
```

**Run development server:**
```bash
cd frontend
npm run dev
```

**Build for production:**
```bash
cd frontend
npm run build
```

**Lint:**
```bash
cd frontend
npm run lint
```

**Access:**
- App: http://localhost:5173

### Wokwi Libraries (Local Repositories)

The project uses local clones of Wokwi repositories in `wokwi-libs/`:
- `wokwi-elements/` - Web Components for electronic parts
- `avr8js/` - AVR8 CPU emulator
- `rp2040js/` - RP2040 emulator (future use)

**Update libraries:**
```bash
update-wokwi-libs.bat
```

Or manually:
```bash
cd wokwi-libs/wokwi-elements
git pull origin main
npm install
npm run build
```

### External Dependencies

**arduino-cli** must be installed on your system:
```bash
# Verify installation
arduino-cli version

# Initialize (first time)
arduino-cli core update-index
arduino-cli core install arduino:avr
```

## Architecture

### High-Level Data Flow

1. **Code Editing**: User writes Arduino code → Monaco Editor → Zustand store (`useEditorStore`)
2. **Compilation**: Code → Frontend API call → Backend FastAPI → arduino-cli subprocess → Returns .hex file
3. **Simulation**: .hex file → AVRSimulator.loadHex() → Parsed into Uint16Array → CPU execution loop
4. **Pin Updates**: CPU writes to PORTB/C/D → Port listeners → PinManager → Component state updates
5. **Visual Updates**: Component state changes → React re-renders → wokwi-elements update visually

### Critical Architecture Patterns

**1. Vite Aliases for Local Wokwi Libs**

The `frontend/vite.config.ts` uses path aliases to import from local repositories:
```typescript
resolve: {
  alias: {
    'avr8js': path.resolve(__dirname, '../wokwi-libs/avr8js/dist/esm'),
    '@wokwi/elements': path.resolve(__dirname, '../wokwi-libs/wokwi-elements/dist/esm'),
  },
}
```

This allows importing as if they were npm packages while using local clones.

**2. AVR Simulation Loop**

The simulation runs at ~60 FPS using `requestAnimationFrame`:
- Each frame executes ~267,000 CPU cycles (16MHz / 60fps)
- Port listeners fire when PORTB/C/D registers change
- PinManager maps Arduino pins to components (e.g., pin 13 → LED_BUILTIN)

**3. State Management with Zustand**

Two main stores:
- `useEditorStore`: Code content, theme
- `useSimulatorStore`: Simulation state, components, wires, compiled hex

**4. Component-Pin Mapping**

Components are connected to Arduino pins via the PinManager:
- PORTB maps to digital pins 8-13 (pin 13 = built-in LED)
- PORTC maps to analog pins A0-A5
- PORTD maps to digital pins 0-7

When a port value changes, PinManager calls registered callbacks for affected components.

**5. Wire System (Phase 1 - Visual Only)**

Wires are stored as objects with start/end endpoints:
```typescript
{
  id: string
  start: { componentId, pinName, x, y }
  end: { componentId, pinName, x, y }
  color: string
  signalType: 'digital' | 'analog' | 'power-vcc' | 'power-gnd'
}
```

Wire positions auto-update when components move via `updateWirePositions()`.

## Key File Locations

### Backend
- [backend/app/main.py](backend/app/main.py) - FastAPI app entry point, CORS config
- [backend/app/api/routes/compile.py](backend/app/api/routes/compile.py) - Compilation endpoints
- [backend/app/services/arduino_cli.py](backend/app/services/arduino_cli.py) - arduino-cli wrapper, handles compilation subprocess

### Frontend - Core
- [frontend/src/App.tsx](frontend/src/App.tsx) - Main app component
- [frontend/src/store/useEditorStore.ts](frontend/src/store/useEditorStore.ts) - Code editor state
- [frontend/src/store/useSimulatorStore.ts](frontend/src/store/useSimulatorStore.ts) - Simulation state, components, wires

### Frontend - Simulation
- [frontend/src/simulation/AVRSimulator.ts](frontend/src/simulation/AVRSimulator.ts) - AVR8 CPU emulator wrapper, execution loop
- [frontend/src/simulation/PinManager.ts](frontend/src/simulation/PinManager.ts) - Maps Arduino pins to components
- [frontend/src/utils/hexParser.ts](frontend/src/utils/hexParser.ts) - Intel HEX format parser

### Frontend - UI Components
- [frontend/src/components/editor/CodeEditor.tsx](frontend/src/components/editor/CodeEditor.tsx) - Monaco editor wrapper
- [frontend/src/components/editor/EditorToolbar.tsx](frontend/src/components/editor/EditorToolbar.tsx) - Compile/Run/Stop buttons
- [frontend/src/components/simulator/SimulatorCanvas.tsx](frontend/src/components/simulator/SimulatorCanvas.tsx) - Main simulation canvas
- [frontend/src/components/simulator/WireLayer.tsx](frontend/src/components/simulator/WireLayer.tsx) - Wire rendering layer
- [frontend/src/components/components-wokwi/](frontend/src/components/components-wokwi/) - React wrappers for wokwi-elements

## Important Implementation Notes

### 1. AVR Instruction Execution

The simulation **must call both** `avrInstruction()` and `cpu.tick()` in the execution loop:
```typescript
avrInstruction(this.cpu);  // Execute the AVR instruction
this.cpu.tick();           // Update peripheral timers and cycles
```

Missing `avrInstruction()` will cause the CPU to appear "stuck" even though cycles increment.

### 2. Port Listeners

Port listeners in AVRSimulator.ts are attached to AVRIOPort instances, NOT directly to CPU registers:
```typescript
this.portB!.addListener((value, oldValue) => {
  // value is the PORTB register value (0-255)
  // Check individual pins: this.portB!.pinState(5) for pin 13
});
```

### 3. HEX File Format

Arduino compilation produces Intel HEX format. The parser in `hexParser.ts`:
- Parses lines starting with `:`
- Extracts address, record type, and data bytes
- Returns a `Uint8Array` of program bytes
- AVRSimulator converts this to `Uint16Array` (16-bit words, little-endian)

### 4. Component Registration

To add a component to the simulation:
1. Add it to the canvas in SimulatorCanvas.tsx
2. Register a pin change callback in PinManager
3. Update component state when pin changes

Example:
```typescript
pinManager.registerCallback(13, (state) => {
  // Update LED when pin 13 changes
  useSimulatorStore.getState().updateComponentState('led-builtin', state);
});
```

### 5. CORS Configuration

Backend allows specific Vite dev ports (5173-5175). Update `backend/app/main.py` if using different ports.

### 6. Wokwi Elements Integration

Wokwi elements are Web Components. React wrappers declare custom elements:
```typescript
declare global {
  namespace JSX {
    interface IntrinsicElements {
      'wokwi-led': any;
    }
  }
}
```

## Testing

### Backend Testing
Test compilation directly:
```bash
cd backend
python test_compilation.py
```

### Frontend Testing
No test suite currently implemented. Manual testing via dev server.

## Common Development Scenarios

### Adding a New Electronic Component

1. Check if wokwi-elements has the component (see `wokwi-libs/wokwi-elements/src/`)
2. Create React wrapper in `frontend/src/components/components-wokwi/`
3. Add component type to `useSimulatorStore` interface
4. Update SimulatorCanvas to render the component
5. Register pin callbacks in PinManager if interactive

### Adding a New API Endpoint

1. Create route in `backend/app/api/routes/`
2. Include router in `backend/app/main.py`
3. Add corresponding service in `backend/app/services/` if needed
4. Create API client function in `frontend/src/services/`

### Debugging Simulation Issues

Common issues:
- **LED doesn't blink**: Check port listeners are firing (console logs), verify pin mapping
- **Compilation fails**: Check arduino-cli is in PATH, verify `arduino:avr` core is installed
- **CPU stuck at PC=0**: Ensure `avrInstruction()` is being called in execution loop
- **Wire positions wrong**: Check `calculatePinPosition()` uses correct component coordinates

Enable verbose logging:
- AVRSimulator logs port changes and CPU state every 60 frames
- Backend logs all compilation steps and arduino-cli output

## Project Status

**Implemented:**
- Full Arduino code editing with Monaco Editor
- Compilation via arduino-cli to .hex files
- Real AVR8 emulation with avr8js
- Pin state tracking and component updates
- Dynamic component system with 48+ wokwi-elements components
- Component picker modal with search and categories
- Component property dialog (single-click interaction)
- Component rotation (90° increments)
- Wire creation and rendering (orthogonal routing)
- Segment-based wire editing (drag segments perpendicular to orientation)
- Real-time wire preview with grid snapping (20px)
- Pin overlay system for wire connections

**In Progress:**
- Functional wire connections (electrical signal routing)
- Wire validation and error handling

**Planned:**
- Serial monitor
- Project persistence (SQLite)
- Multi-board support (Mega, Nano, ESP32)
- Undo/redo functionality

## Additional Resources

- Main README: [README.md](README.md)
- Architecture Details: [ARCHITECTURE.md](ARCHITECTURE.md)
- Wokwi Integration: [WOKWI_LIBS.md](WOKWI_LIBS.md)
- Wokwi Elements Repo: https://github.com/wokwi/wokwi-elements
- AVR8js Repo: https://github.com/wokwi/avr8js
- Arduino CLI Docs: https://arduino.github.io/arduino-cli/
