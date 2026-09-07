---
brand: WS2812B ("NeoPixel")
buy: https://www.adafruit.com/category/168
---
One addressable RGB LED. Colour arrives as a 24-bit serial stream on `DIN`
rather than as a voltage on three pins, so what lights it is **data**, not a
level — and which boards can produce that data is the thing worth knowing.

| Pin | Role |
| --- | --- |
| VDD | + supply |
| VSS | ground |
| DIN | data in — any free GPIO |
| DOUT | chains to the NEXT pixel's `DIN` (leave unwired for one) |

- `strip.show()` pushes the buffer. Colours never change without it.
- The colour-order flag (`NEO_GRB` / `NEO_RGB` / `NEO_BRG`) permutes three
  bytes. **It cannot turn a dark pixel on** — if nothing lights, the order is
  not the problem.
- Real hardware wants 5 V on `VDD` and a level shifter on a 3.3 V data line.
  The simulator models neither, so `3V3 → VDD` is fine here.

## How each board drives it

The library picks the mechanism per core, and the simulator has to follow:

- **AVR (Uno, Nano, Mega)** — bit-banged. The pad really does toggle at bit
  rate and the part decodes the pulse widths.
- **ESP32 (all variants)** — the RMT peripheral. The pad never toggles at bit
  rate, so the engine decodes the stream and hands the finished frame over.
  Under the QEMU engine (`?esp32sim=qemu`) those frames do not reach the canvas
  yet, so the pixel stays dark there whatever the sketch does.
- **RP2040 / RP2350 (Pico)** — PIO, same idea as RMT.
- **Raspberry Pi and UNIHIKER (Linux boards)** — not supported, and it is not a
  gap that will close: those boards carry pin LEVELS with no timing over a
  serial link, and a WS2812 bit cell is 1.25 µs. The editor says so in Circuit
  check rather than leaving the part quietly dark.

If a pixel is dark, the useful question is which board and which engine — not
the colour order, the supply pad, or the pin number.
