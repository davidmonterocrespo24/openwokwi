# Wokwi Libraries Integration

This project uses the official Wokwi repositories cloned locally, which allows keeping them up-to-date and compatible with the latest versions. The local repositories power both AVR emulation and the dynamic component system with 48+ electronic elements.

## Cloned Repositories

### wokwi-elements
- **Location**: `wokwi-libs/wokwi-elements/`
- **Description**: Web Components (Lit) for 48+ electronic elements (LEDs, resistors, buttons, LCDs, sensors, etc.)
- **Repository**: https://github.com/wokwi/wokwi-elements
- **License**: MIT
- **Current usage**: Visual rendering of all components on the simulation canvas. A metadata generation script (`scripts/generate-component-metadata.ts`) parses the TypeScript source code to automatically discover all components, their properties, and pins.

### avr8js
- **Location**: `wokwi-libs/avr8js/`
- **Description**: Complete AVR8 microcontroller emulator (ATmega328p) in JavaScript
- **Repository**: https://github.com/wokwi/avr8js
- **License**: MIT
- **Current usage**: Real CPU emulation at 16MHz, with Timer0/1/2, USART, ADC, and GPIO ports (PORTB/C/D). Runs ~267,000 cycles per frame at ~60fps.

### rp2040js
- **Location**: `wokwi-libs/rp2040js/`
- **Description**: Raspberry Pi Pico (RP2040) emulator in JavaScript
- **Repository**: https://github.com/wokwi/rp2040js
- **License**: MIT
- **Usage**: Cloned for future Raspberry Pi Pico support

### wokwi-features
- **Location**: `wokwi-libs/wokwi-features/`
- **Description**: Wokwi documentation and feature tracking
- **Repository**: https://github.com/wokwi/wokwi-features

## Project Configuration

### Frontend (Vite)

The `frontend/vite.config.ts` file is configured to use the local repositories via aliases:

```typescript
resolve: {
  alias: {
    'avr8js': path.resolve(__dirname, '../wokwi-libs/avr8js/dist/esm'),
    '@wokwi/elements': path.resolve(__dirname, '../wokwi-libs/wokwi-elements/dist/esm'),
  },
},
optimizeDeps: {
  include: ['avr8js', '@wokwi/elements'],
}
```

The `frontend/package.json` file references the local packages:

```json
{
  "dependencies": {
    "@wokwi/elements": "file:../wokwi-libs/wokwi-elements",
    "avr8js": "file:../wokwi-libs/avr8js"
  }
}
```

### Automatic Metadata Generation

The `scripts/generate-component-metadata.ts` script parses the wokwi-elements source code using the TypeScript AST to extract:
- Tag name (`@customElement('wokwi-led')` → `wokwi-led`)
- Properties (`@property()` decorators → type, default value)
- Number of pins
- Category, description, and tags

The result is stored in `frontend/public/components-metadata.json` and consumed by the `ComponentRegistry` at runtime.

## Updating the Wokwi Libraries

To keep your project up-to-date with the latest versions of Wokwi:

### Option 1: Update all libraries (Recommended)

```bash
# Script to update all repositories
update-wokwi-libs.bat
```

### Option 2: Update each repository manually

```bash
cd wokwi-libs

# Update wokwi-elements
cd wokwi-elements
git pull origin main
npm install
npm run build

# Update avr8js
cd ../avr8js
git pull origin main
npm install
npm run build

# Update rp2040js
cd ../rp2040js
git pull origin main
npm install
npm run build
```

### Option 3: Update to a specific version

```bash
cd wokwi-libs/wokwi-elements

# View available versions
git tag -l

# Switch to a specific version
git checkout v1.9.2

# Rebuild
npm install
npm run build
```

### After Updating wokwi-elements

If you updated wokwi-elements, regenerate the component metadata so that new components appear in the UI:

```bash
cd frontend
npx tsx ../scripts/generate-component-metadata.ts
```

## Automatic Update Script

The `update-wokwi-libs.bat` script simplifies updates:

```batch
@echo off
echo ========================================
echo Updating Wokwi Libraries
echo ========================================

cd wokwi-libs

echo [1/3] Updating wokwi-elements...
cd wokwi-elements
git pull origin main
npm install
npm run build
cd ..

echo [2/3] Updating avr8js...
cd avr8js
git pull origin main
npm install
npm run build
cd ..

echo [3/3] Updating rp2040js...
cd rp2040js
git pull origin main
npm install
npm run build
cd ..

echo ========================================
echo Update complete!
echo ========================================
pause
```

## How the Libraries Are Used

### avr8js — AVR Emulation

The `AVRSimulator` (`frontend/src/simulation/AVRSimulator.ts`) uses avr8js to create:

```typescript
import { CPU, avrInstruction, AVRTimer, AVRUSART, AVRADC, AVRIOPort } from 'avr8js';
```typescript
import { CPU, avrInstruction, AVRTimer, AVRUSART, AVRADC, AVRIOPort } from 'avr8js';

// ATmega328p CPU at 16MHz
const cpu = new CPU(programMemory);

// Peripherals
const timer0 = new AVRTimer(cpu, timer0Config);
const timer1 = new AVRTimer(cpu, timer1Config);
const timer2 = new AVRTimer(cpu, timer2Config);
const usart  = new AVRUSART(cpu, usart0Config, CLOCK);
const adc    = new AVRADC(cpu, adcConfig);
const portB  = new AVRIOPort(cpu, portBConfig);  // pins 8-13
const portC  = new AVRIOPort(cpu, portCConfig);  // A0-A5
const portD  = new AVRIOPort(cpu, portDConfig);  // pins 0-7

// Simulation loop (~60fps)
function runFrame() {
  const cyclesToRun = Math.floor(267000 * speed);
  for (let i = 0; i < cyclesToRun; i++) {
    avrInstruction(cpu);  // Execute AVR instruction
    cpu.tick();            // Update peripherals
  }
  requestAnimationFrame(runFrame);
}
```

### wokwi-elements — Visual Components

Components are rendered in two ways:

**1. DynamicComponent (current system — 48 components)**

```typescript
import { ComponentRegistry } from './services/ComponentRegistry';

// Load metadata from /components-metadata.json
const registry = ComponentRegistry.getInstance();
const metadata = registry.getById('led');

// DynamicComponent creates the web component dynamically
// document.createElement(metadata.tagName) → <wokwi-led>
// Syncs React props → web component
// Extracts pinInfo from the DOM for wire connections
```

**2. Legacy React wrappers (5 components)**

```tsx
// ArduinoUno.tsx — still actively used for the main board
<wokwi-arduino-uno ref={ref} led13={led13} />
```

### PartSimulationRegistry — Simulation Behaviors

16 parts have registered simulation logic that connects the web components to the AVR emulator:

| Part | Type | Behavior |
|------|------|----------|
| `led` | Output | Pin state → `element.value` |
| `rgb-led` | Output | Digital + PWM on R/G/B |
| `led-bar-graph` | Output | 10 independent LEDs |
| `7segment` | Output | 8 segments (A-G + DP) |
| `pushbutton` | Input | Press/release → `setPinState()` |
| `pushbutton-6mm` | Input | Same as pushbutton |
| `slide-switch` | Input | Change event → pin state |
| `dip-switch-8` | Input | 8 independent switches |
| `potentiometer` | Input | Value → ADC voltage |
| `slide-potentiometer` | Input | Same logic via SIG/OUT |
| `photoresistor-sensor` | Input/Output | Analog voltage + digital LED |
| `analog-joystick` | Input | VRX/VRY (ADC) + SW (digital) |
| `servo` | Output | OCR1A/ICR1 registers → angle 0-180° |
| `buzzer` | Output | Web Audio API + Timer2 |
| `lcd1602` | Output | Full HD44780 4-bit protocol (16×2) |
| `lcd2004` | Output | Full HD44780 4-bit protocol (20×4) |

## Available Wokwi Components (48)

### Boards (4)
- `wokwi-arduino-uno` — Arduino Uno R3
- `wokwi-arduino-mega` — Arduino Mega 2560
- `wokwi-arduino-nano` — Arduino Nano
- `wokwi-esp32-devkit-v1` — ESP32 DevKit v1

### Sensors (6)
- `wokwi-dht22` — Temperature and humidity sensor
- `wokwi-hc-sr04` — Ultrasonic distance sensor
- `wokwi-pir-motion-sensor` — PIR motion sensor
- `wokwi-photoresistor-sensor` — Photoresistor (LDR)
- `wokwi-ntc-temperature-sensor` — NTC temperature sensor
- `wokwi-analog-joystick` — Analog joystick

### Displays (3)
- `wokwi-lcd1602` — LCD 16x2 with HD44780 protocol
- `wokwi-lcd2004` — LCD 20x4 with HD44780 protocol
- `wokwi-7segment` — 7-segment display

### Input (5)
- `wokwi-pushbutton` — Push button
- `wokwi-pushbutton-6mm` — 6mm push button
- `wokwi-slide-switch` — Slide switch
- `wokwi-dip-switch-8` — 8-position DIP switch
- `wokwi-potentiometer` — Potentiometer

### Output (5)
- `wokwi-led` — Colored LED
- `wokwi-rgb-led` — RGB LED
- `wokwi-led-bar-graph` — LED bar graph (10 LEDs)
- `wokwi-buzzer` — Piezoelectric buzzer
- `wokwi-neopixel` — Addressable RGB LED (WS2812)

### Motors (2)
- `wokwi-servo` — Servo motor
- `wokwi-stepper-motor` — Stepper motor

### Passive (4)
- `wokwi-resistor` — Resistor with color code
- `wokwi-slide-potentiometer` — Slide potentiometer
- `wokwi-led-ring` — LED ring
- `wokwi-membrane-keypad` — Matrix keypad

### Other (19)
- Various components including `wokwi-ir-receiver`, `wokwi-ds1307`, breadboards, etc.

## Advantages of This Approach

### Advantages

1. **Easy Updates**: A simple `git pull` + rebuild gives you the latest improvements
2. **Wokwi Compatible**: Uses exactly the same code as Wokwi.com
3. **Automatic Discovery**: New components appear automatically after regenerating metadata
4. **Version Control**: You can checkout to specific versions
5. **Flexible Development**: Source code available for debugging and modifications
6. **No npm Dependency**: You don't depend on npm package publications
7. **100% Offline**: Works completely without internet after initial setup

### Considerations

1. **Disk Space**: Cloned repositories take more disk space (~200MB)
2. **Compilation**: You must rebuild the repositories after updating them
3. **Metadata**: Regenerate `components-metadata.json` after updating wokwi-elements

## Troubleshooting

### Error: "Module not found: @wokwi/elements"

Make sure wokwi-elements is built:

```bash
cd wokwi-libs/wokwi-elements
npm install
npm run build
```

### Error: "Cannot find module 'avr8js'"

Verify that the alias in `vite.config.ts` is correct and that avr8js is built:

```bash
cd wokwi-libs/avr8js
npm install
npm run build
```

### Components are not shown in the picker

Regenerate the component metadata:

```bash
cd frontend
npx tsx ../scripts/generate-component-metadata.ts
```

### New wokwi-elements component does not appear

1. Update wokwi-elements: `cd wokwi-libs/wokwi-elements && git pull && npm run build`
2. Regenerate metadata: `cd frontend && npx tsx ../scripts/generate-component-metadata.ts`
3. If it needs simulation, register its behavior in `frontend/src/simulation/parts/`

### Components are visible but do not respond to simulation

Verify that the component has simulation logic registered in `PartSimulationRegistry` (files `BasicParts.ts` or `ComplexParts.ts`). Only the 16 registered components have interactive behavior.

## References

- [Wokwi Elements Documentation](https://elements.wokwi.com/)
- [AVR8js Repository](https://github.com/wokwi/avr8js)
- [Wokwi Simulator](https://wokwi.com)
- [Lit Documentation](https://lit.dev/) — Framework used by wokwi-elements
- [Web Components Guide](https://developer.mozilla.org/en-US/docs/Web/Web_Components)
