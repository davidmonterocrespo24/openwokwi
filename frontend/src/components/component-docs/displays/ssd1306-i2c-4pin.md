---
brand: Solomon Systech
buy: https://www.amazon.com/s?k=SSD1306+128x64+OLED+I2C+4+pin
---
SSD1306 monochrome OLED (128×64) on the **4-pin I²C module** — the cheap
0.96" board most people have. The glass panel is bonded onto the PCB, so the
part is a single piece: no separate display to wire.

| Pin | Role |
| --- | --- |
| GND | ground |
| VCC | 3.3–5 V |
| SCL | I²C clock |
| SDA | I²C data |

- Default I²C address **0x3C** (some boards are 0x3D — check the silk).
- 128×64 pixels, ~1 KB framebuffer, self-emitting: no backlight, so an unlit
  pixel is truly off.
- Drive it with Adafruit_SSD1306 (`&Wire`, reset `-1`) or U8g2.

**Tip:** need the SPI pins, or a reset line? Use the 8-pin **SSD1306 OLED
(Adafruit breakout)** part instead — same controller, more pins broken out.
