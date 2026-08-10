---
brand: Generic 5 mm LED
buy: https://www.amazon.com/s?k=5mm+LED+assortment+kit
---
Standard 5 mm through-hole LED. Lights when forward-biased above its
threshold voltage. **Always drive it through a series resistor** — otherwise
it burns out (and in electrical mode the circuit verifier blocks Run).

| Pin | Role |
| --- | --- |
| A (anode) | + terminal — to the resistor / MCU pin |
| C (cathode) | − terminal — to GND (short leg / flat side) |

- Forward voltage ≈ **1.8–3.2 V** depending on `color`.
- Typical current **~10–20 mA**; use **~220–330 Ω** on 5 V logic.
- `color` sets the emitted light; `brightness` scales PWM dimming.

**Tip:** on an Arduino, `pin 13 → 220 Ω → anode`, `cathode → GND`.
