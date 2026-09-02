# Custom Chips — Velxio Developer Guide

Velxio supports **user-defined chips** written in C and compiled to WebAssembly.
Drop a chip on the canvas, wire its pins like any other component, and your chip
runs alongside the simulated Arduino sketch.

This is Velxio's equivalent of Wokwi's Custom Chips API — but with a clean-room
header (`velxio-chip.h`), our own runtime, and zero code from third-party
simulators. The toolchain (clang + WASI-SDK) is 100 % open source.

---

## Table of contents

- [What you get](#what-you-get)
- [The 30-second example: an inverter](#the-30-second-example-an-inverter)
- [Anatomy of a chip](#anatomy-of-a-chip)
- [The 11 example chips](#the-11-example-chips)
- [Where to read next](#where-to-read-next)

---

## What you get

A custom chip can:

| Feature | Use it for |
|---|---|
| **Digital GPIO** (`vx_pin_*`) | Logic gates, level translators, level-triggered effects |
| **Pin watch with edge detection** (`vx_pin_watch`) | Reactive chips: counters, debouncers, edge-triggered FSMs |
| **Initialized output state** (`VX_OUTPUT_LOW`/`HIGH`) | Pin defaults to a known value at chip boot — no glitch |
| **Analog out (DAC)** (`vx_pin_dac_write`) | Programmable voltage references, function generators |
| **I2C slave** (`vx_i2c_attach`) | EEPROMs, RTCs, IO expanders, sensors |
| **SPI slave** (`vx_spi_attach`/`start`/`stop`) | Shift registers, ADCs, displays, flash chips |
| **UART** (`vx_uart_attach`/`vx_uart_write`) | GPS modules, BT/WiFi modems, anything that talks Serial |
| **User-editable attributes** (`vx_attr_*`) | Knobs the user tweaks: gain, threshold, baud, etc. |
| **Timers** (`vx_timer_*`) | Periodic events, oscillators, watchdogs |
| **Framebuffer / display** (`vx_framebuffer_init`/`vx_buffer_write`) | Custom LCDs, OLEDs, dot-matrix displays |
| **Logging** (`vx_log` and `printf`) | Debug output to the chip console |

Every API call is documented in
[`wiki/custom-chips-api-reference.md`](./wiki/custom-chips-api-reference.md).

---

## The 30-second example: an inverter

A chip with one input and one output. `OUT` is always the inverse of `IN`.

### `inverter.c`

```c
#include "velxio-chip.h"
#include <stdlib.h>

typedef struct {
  vx_pin in;
  vx_pin out;
} chip_state_t;

static void on_in_change(void *ud, vx_pin pin, int value) {
  chip_state_t *s = (chip_state_t*)ud;
  vx_pin_write(s->out, value ? VX_LOW : VX_HIGH);
}

void chip_setup(void) {
  chip_state_t *s = (chip_state_t*)malloc(sizeof(chip_state_t));
  s->in  = vx_pin_register("IN",  VX_INPUT);
  s->out = vx_pin_register("OUT", VX_OUTPUT);

  vx_pin_write(s->out, vx_pin_read(s->in) ? VX_LOW : VX_HIGH);
  vx_pin_watch(s->in, VX_EDGE_BOTH, on_in_change, s);

  vx_log("inverter ready");
}
```

### `inverter.chip.json`

```json
{
  "schema": "velxio-chip/v1",
  "name": "Inverter",
  "author": "you",
  "license": "MIT",
  "description": "OUT = !IN.",
  "pins": ["IN", "OUT", "GND", "VCC"],
  "attributes": []
}
```

### Try it in the editor

1. Open Velxio. Click **Add Component** → search "Custom Chip" → select.
2. The examples gallery opens. Click **Inverter**.
3. You land in the common editor: the chip owns its own section in the
   file explorer with `chip.c` and `chip.json` — edit them like any board
   file (chip.json is schema-validated as you type).
4. Wire `IN` to your Arduino's pin 13 and `OUT` to a LED.
5. Click **Run** — the chip compiles automatically (or use the hammer
   button in the chip's file-explorer section to compile on its own).
6. The LED toggles inverse to the built-in LED. Edit `chip.c` and Run
   again — the chip recompiles whenever its source changed.


---

## Anatomy of a chip

A chip is **two files**:

```
mychip.c           // C source — the logic of the chip
mychip.chip.json   // Metadata — pin layout, attributes, optional display
```

### Lifecycle

The chip exports exactly **one** function:

```c
void chip_setup(void);
```

Velxio calls `chip_setup()` once per chip instance after the simulation starts.
Inside it the chip:

1. **Allocates state** — typically one `malloc(sizeof(chip_state_t))` per instance.
2. **Registers pins** with `vx_pin_register(name, mode)`.
3. **Attaches peripherals** if needed: `vx_i2c_attach`, `vx_uart_attach`, `vx_spi_attach`.
4. **Subscribes to events** with `vx_pin_watch` and/or `vx_timer_create` + `vx_timer_start`.
5. Returns. **No event loop.** The chip is purely reactive.

After setup, the chip runs **only** inside callbacks the host invokes:

- A pin watch fires → your callback runs → maybe writes other pins.
- The I2C bus addresses your slave → your `on_connect`/`read`/`write`/`stop` runs.
- A timer expires → your callback runs.
- A UART byte arrives → your `on_rx_byte` runs.

This means your chip never blocks, never loops forever, and uses zero CPU
between events.

### State per instance

If the user drops two of your chips on the canvas, they each get their own
`WebAssembly.Instance` with **separate memory**. Inside `chip_setup()` you
`malloc` a new state struct — there's no shared global state to worry about.

### `chip.json` schema

```json
{
  "schema":      "velxio-chip/v1",
  "name":        "Display name",
  "author":      "Your name",
  "license":     "MIT",
  "description": "Short text shown in the picker tooltip",

  "pins": [
    "IN",                         // string  — auto-laid out left/right
    "OUT",
    { "name": "SCL", "x": 0, "y": 24 },   // object — explicit position
    { "name": "SDA", "x": 0, "y": 36 }
  ],

  "attributes": [
    { "name": "threshold", "type": "int",   "default": 4, "min": 1, "max": 1024 },
    { "name": "gain",      "type": "float", "default": 1.0, "min": 0, "max": 10, "step": 0.1 }
  ],

  "display": { "width": 128, "height": 64 }   // optional — for chips with a screen
}
```

Empty strings in `pins` skip a slot (so your DIP layout matches a real chip).
`attributes` show up as sliders/inputs in the chip's properties dialog.
`display` enables the framebuffer API.

---

## The 11 example chips

The Custom Chip designer ships a gallery with 11 ready-to-go examples,
covering every protocol the runtime supports:

| Chip | Protocol | What it shows |
|---|---|---|
| **Inverter** | GPIO + watch | Simplest possible chip — start here |
| **XOR Gate** | GPIO + 2 inputs | Multiple watches, recompute output on any edge |
| **CD4094** | GPIO state machine | Edge detection (RISING vs BOTH), multi-pin shift register |
| **Pulse Counter** | GPIO + attributes | User-configurable threshold via slider |
| **74HC595** | SPI slave | SPI transfer with re-arm pattern |
| **MCP3008** | SPI + analog | SPI ADC: read voltage, return 10-bit result |
| **24C01 EEPROM** | I2C slave | Tiny memory device with pointer auto-increment |
| **24LC256 EEPROM** | I2C slave | 16-bit addressing + page writes |
| **PCF8574** | I2C IO expander | Reading/writing 8 pins atomically |
| **DS3231 RTC** | I2C state | 19 registers, BCD encoding, register pointer |
| **ROT13 UART** | UART | Receive a byte, transmit transformed byte |

Each is fully explained in
[`wiki/custom-chips-examples.md`](./wiki/custom-chips-examples.md).

---

## Where to read next

| If you want to … | Read |
|---|---|
| Understand every host function in detail | [API reference](./wiki/custom-chips-api-reference.md) |
| See the 11 chip examples worked through | [Examples walkthrough](./wiki/custom-chips-examples.md) |
| Set up the toolchain or write tests | [Build & test guide](./wiki/custom-chips-build-and-test.md) |
| Run custom chips on ESP32 (backend runtime architecture) | [ESP32 backend runtime](./wiki/custom-chips-esp32-backend-runtime.md) |
| Know which boards support which protocols | [Board support matrix](../test/autosearch/07_multi_board_support.md) |

### Quick links to source

- C SDK header — [`backend/sdk/velxio-chip.h`](../backend/sdk/velxio-chip.h)
- Frontend runtime — [`frontend/src/simulation/customChips/`](../frontend/src/simulation/customChips/)
- Example chips — [`test/test_custom_chips/sdk/examples/`](../test/test_custom_chips/sdk/examples/)
- Backend compile service — [`backend/app/services/chip_compile.py`](../backend/app/services/chip_compile.py)
- Sandbox test suite — [`test/test_custom_chips/`](../test/test_custom_chips/)

---

## Design philosophy

A few decisions worth knowing:

- **Reactive, not procedural.** Your chip never has a `loop()`. The host calls
  your callbacks; you do small bits of work and return. This guarantees the
  chip can't hang the simulator.
- **Shared-nothing memory.** Each chip instance gets its own WASM linear memory.
  Two instances of the same chip can't accidentally share state — no globals
  to worry about.
- **The C type system is your friend.** `velxio-chip.h` declares concrete
  types (`vx_pin`, `vx_attr`, `vx_i2c_config`) and uses `_Static_assert` to
  guarantee the struct layouts match between your chip and the host. If you
  add a field, the assertion fires and you fix the runtime accordingly.
- **No dependency on Wokwi.** This is a clean-room implementation. The
  toolchain is `clang` + `wasi-sdk`, both Apache-2.0. Our header and runtime
  are Velxio-original.
