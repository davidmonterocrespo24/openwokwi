---
brand: Generic (HC-SR04)
buy: https://www.amazon.com/s?k=HC-SR04+ultrasonic+sensor
---
HC-SR04 ultrasonic distance sensor. Fire a 10 µs pulse on **TRIG**, then
measure the HIGH width on **ECHO** — distance = time × 0.0343 / 2 (cm).

| Pin | Role |
| --- | --- |
| VCC | 5 V supply |
| TRIG | trigger input (10 µs pulse) |
| ECHO | echo output (width ∝ distance) |
| GND | ground |

- Range **2 cm – 400 cm**, beam ~15°.
- ECHO is a **5 V** signal — level-shift before a 3.3 V board (ESP32/Pico).

**Tip:** `pulseIn(ECHO, HIGH)` returns microseconds; divide by 58 for cm.
