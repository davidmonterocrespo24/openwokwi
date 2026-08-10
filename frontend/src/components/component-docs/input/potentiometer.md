---
brand: Generic / Bourns
buy: https://www.amazon.com/s?k=10k+linear+potentiometer
---
Rotary potentiometer wired as an adjustable voltage divider. The wiper
outputs 0 V…VCC as you turn it — read it on an analog input.

| Pin | Role |
| --- | --- |
| VCC | one end of the track (+) |
| SIG | wiper — to an ADC / analog pin |
| GND | other end of the track (−) |

- `analogRead()` maps the wiper to **0–1023** on a 10-bit AVR ADC.
- Drag the knob on the canvas to change `value` live while simulating.

**Tip:** typical hookup — `5V → VCC`, `wiper → A0`, `GND → GND`.
