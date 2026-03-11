# Example Projects

This folder contains the preview images for the 8 example projects in the gallery.

## Available Examples

| ID | Title | Category | Difficulty | Components |
|----|-------|----------|------------|------------|
| `blink-led` | Blink LED | basics | beginner | Arduino Uno |
| `traffic-light` | Traffic Light | basics | beginner | 3 LEDs (R/Y/G) |
| `button-led` | Button Control | basics | beginner | Button + LED |
| `fade-led` | Fade LED (PWM) | basics | beginner | 1 LED |
| `serial-hello` | Serial Hello World | communication | beginner | Arduino Uno |
| `rgb-led` | RGB LED Colors | basics | intermediate | RGB LED |
| `simon-says` | Simon Says Game | games | advanced | 4 LEDs + 4 buttons |
| `lcd-hello` | LCD 20x4 Display | displays | intermediate | LCD 2004 |

Each example includes:
- Complete Arduino sketch code
- Component definitions with positions
- Wire connections with pin names and colors

The examples are defined in `frontend/src/data/examples.ts` and rendered in the `ExamplesGallery.tsx` gallery with category and difficulty filters.

## How to Create Screenshots

### Method 1: Manual Capture (Recommended)

1. Load the example in the editor (http://localhost:5173/examples)
2. Click the example to load it
3. Adjust the canvas zoom if needed
4. Use a screenshot tool to capture only the simulator area
5. Save the image with the corresponding name

### Method 2: Using DevTools

1. Open the example in the browser
2. Open DevTools (F12)
3. Go to the console and run:
```javascript
const canvas = document.querySelector('.canvas-content');
html2canvas(canvas).then(canvas => {
  const link = document.createElement('a');
  link.download = 'example-name.png';
  link.href = canvas.toDataURL();
  link.click();
});
```

## File Names

Files must follow the example ID:

- `blink-led.png` — Blink LED
- `traffic-light.png` — Traffic Light
- `button-led.png` — Button Control
- `fade-led.png` — Fade LED
- `serial-hello.png` — Serial Hello World
- `rgb-led.png` — RGB LED Colors
- `simon-says.png` — Simon Says Game
- `lcd-hello.png` — LCD 20x4 Display

## Recommended Dimensions

- **Width**: 800px
- **Height**: 500px
- **Format**: PNG with dark background (#1e1e1e)

## Current Placeholder

While no images are available, a placeholder is shown with:
- Category icon (large emoji)
- Number of components (cyan blue)
- Number of wires (yellow)
- Gradient background with dashed border

## Adding a New Example

1. Add the definition in `frontend/src/data/examples.ts` with:
   - `id`, `title`, `description`, `category`, `difficulty`
   - `code`: Complete Arduino sketch
   - `components[]`: Type, position, properties
   - `wires[]`: Connections with `startPinName`, `endPinName`, `color`
2. (Optional) Capture a screenshot and save it here as `{id}.png`
3. The example will automatically appear in the gallery with category and difficulty filtering
