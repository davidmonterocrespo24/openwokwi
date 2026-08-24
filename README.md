# Velxio: Arduino & Embedded Board Emulator

**Live at [velxio.dev](https://velxio.dev)**

An open-source multi-board emulator and circuit simulator. Write Arduino C++, MicroPython, ESP-IDF or Python, compile it, and run it against real CPU emulation with 150+ interactive electronic components — all in your browser.

**40 boards &middot; 5 CPU families**: AVR8 (ATmega / ATtiny), ARM Cortex-M (RP2040 / RP2350 / STM32), Xtensa LX6/LX7 (ESP32 / ESP32-S3), RISC-V (ESP32-C3 / ESP32-C6) and ARM Cortex-A Linux (Raspberry Pi Zero to 5).

![Visitors](https://visitor-badge.laobi.icu/badge?page_id=davidmonterocrespo24/velxio)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-velxio.dev-007acc?style=for-the-badge)](https://velxio.dev)
[![Docker Image](https://img.shields.io/badge/Docker-ghcr.io%2Fdavidmonterocrespo24%2Fvelxio-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://github.com/davidmonterocrespo24/velxio/pkgs/container/velxio)
[![GitHub stars](https://img.shields.io/github/stars/davidmonterocrespo24/velxio?style=for-the-badge)](https://github.com/davidmonterocrespo24/velxio/stargazers)
[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/3mARjJrh4E)
[![License: AGPLv3](https://img.shields.io/badge/License-AGPL%20v3-blue?style=for-the-badge)](LICENSE)
[![Commercial License](https://img.shields.io/badge/Commercial%20License-Available-green?style=for-the-badge)](COMMERCIAL_LICENSE.md)

---

[![Product Hunt](https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1092514&theme=dark&t=1772998619179)](https://www.producthunt.com/products/velxio)

---

## Support the Project

Velxio is free and open-source. Building and maintaining a full multi-board emulator takes a lot of time — if it saves you time or you enjoy the project, sponsoring me directly helps keep development going.

| Platform | Link |
| --- | --- |
| **GitHub Sponsors** (preferred) | [github.com/sponsors/davidmonterocrespo24](https://github.com/sponsors/davidmonterocrespo24) |
| **PayPal** | [paypal.me/odoonext](https://paypal.me/odoonext) |

Your support helps cover server costs, library maintenance, and frees up time to add new boards, components, and features. Thank you!

---

## Hardware Partners

These companies have supported Velxio and provided their hardware so their components can be emulated accurately:

<p align="center">
  <a href="https://www.dfrobot.com/"><img src="docs/partners/dfrobot.png" alt="DFRobot" width="150"></a>&nbsp;
  <a href="https://www.espressif.com/"><img src="docs/partners/espressif.png" alt="Espressif" width="150"></a>&nbsp;
  <a href="https://m5stack.com/"><img src="docs/partners/m5stack.png" alt="M5Stack" width="150"></a>&nbsp;
  <a href="https://www.seeedstudio.com/"><img src="docs/partners/seeed-studio.png" alt="Seeed Studio" width="150"></a>&nbsp;
  <a href="https://pimoroni.com/"><img src="docs/partners/pimoroni.png" alt="Pimoroni" width="150"></a>
</p>

Their hardware is in the catalog today: the M5Stack Cardputer and Core, the Pimoroni Badger 2350 and Galactic Unicorn, the Seeed Studio XIAO family and Grove modules, the DFRobot UNIHIKER and Gravity sensors, and the whole Espressif ESP32 line up to the ESP32-C6.

---

## Try it now

**[https://velxio.dev](https://velxio.dev)** — no installation needed. Open the editor, write your sketch, and simulate directly in the browser.

To self-host with Docker (single command):

```bash
docker run -d \
  --name velxio \
  -p 3080:80 \
  -v velxio-data:/app/data \
  -v velxio-arduino-libs:/root/.arduino15 \
  -v velxio-arduino-user-libs:/root/Arduino \
  -v velxio-ccache:/var/cache/ccache \
  -v velxio-build:/var/lib/velxio-build \
  ghcr.io/davidmonterocrespo24/velxio:master
```

Then open <http://localhost:3080>. Tail logs any time with
`docker logs -f velxio`.

The named volumes are what make compile times reasonable on subsequent
runs — without them, every container restart wipes the ESP-IDF build
cache and the first compile after each restart takes 5-7 minutes
instead of 5-30 seconds.

---

## Screenshots

<p align="center"><img src="docs/img/screens/weather-station.gif" width="520" alt="ESP32 weather station driving an ILI9341 TFT"></p>

ESP32 weather station — a BMP280 over I2C, a DHT22 on a GPIO and an ILI9341 TFT over SPI wired on the canvas, three buses working at once while the display updates live.

![ESP32 Blink running with the Serial Monitor open](docs/img/screens/editor-esp32-blink.png)

The editor: Monaco on the left, the circuit canvas on the right, compiler output and Serial Monitor at the bottom. Here an ESP32 DevKit blinks an external LED and prints over UART.

![Component picker with boards and modules](docs/img/screens/component-picker.png)

Component picker — every board and module with a live preview, search and category filters. The catalog is over 150 parts: displays, sensors, motors, logic ICs, analog parts, breadboards and branded modules.

![Examples gallery](docs/img/screens/examples-gallery.png)

Examples gallery — more than 400 ready-to-run projects filtered by board, difficulty and topic, including the [100 Days 100 IoT Projects](https://github.com/velxio/100_Days_100_IoT_Projects) collection.

![MicroPython on ESP32 with the REPL](docs/img/screens/micropython.png)

MicroPython — the same ESP32, now running `main.py`, with the REPL in the terminal panel. ESP32 boards also accept pure ESP-IDF projects.

![ESP32 WiFi with MQTT publish/subscribe](docs/img/screens/esp32-wifi-mqtt.png)

Emulated WiFi — the ESP32 joins the virtual access point, gets an IP and round-trips messages through a public MQTT broker.

![Oscilloscope tracing a GPIO](docs/img/screens/oscilloscope.png)

Instruments — oscilloscope channels on any pin, plus a SPICE-based electrical layer that shows currents, voltages and shorts on the wires you draw.

![Custom chip editor](docs/img/screens/custom-chip.png)

Custom chips — write your own IC in C, compile it to WebAssembly and drop it on the canvas next to the boards.

---

## Supported Boards

<table>
<tr>
  <td align="center"><img src="docs/img/boards/arduino-uno.png" width="120" alt="Arduino Uno"/><br/><b>Arduino Uno</b></td>
  <td align="center"><img src="docs/img/boards/arduino-nano.png" width="120" alt="Arduino Nano"/><br/><b>Arduino Nano</b></td>
  <td align="center"><img src="docs/img/boards/arduino-mega.png" width="120" alt="Arduino Mega 2560"/><br/><b>Arduino Mega 2560</b></td>
  <td align="center"><img src="docs/img/boards/attiny85.png" width="120" alt="ATtiny85"/><br/><b>ATtiny85</b></td>
  <td align="center"><img src="docs/img/boards/raspberry-pi-3.png" width="120" alt="Raspberry Pi 3"/><br/><b>Raspberry Pi 3</b></td>
  <td align="center"><img src="docs/img/boards/raspberry-pi-5.png" width="120" alt="Raspberry Pi 5"/><br/><b>Raspberry Pi 5</b></td>
</tr>
<tr>
  <td align="center"><img src="docs/img/boards/raspberry-pi-pico.png" width="70" alt="Raspberry Pi Pico"/><br/><b>Raspberry Pi Pico</b></td>
  <td align="center"><img src="docs/img/boards/pi-pico-w.png" width="70" alt="Raspberry Pi Pico W"/><br/><b>Raspberry Pi Pico W</b></td>
  <td align="center"><img src="docs/img/boards/esp32.png" width="80" alt="ESP32 DevKit V1"/><br/><b>ESP32 DevKit V1</b></td>
  <td align="center"><img src="docs/img/boards/esp32-s3.png" width="70" alt="ESP32-S3"/><br/><b>ESP32-S3</b></td>
  <td align="center"><img src="docs/img/boards/esp32-c3.png" width="80" alt="ESP32-C3"/><br/><b>ESP32-C3</b></td>
  <td align="center"><img src="docs/img/boards/esp32-cam.png" width="80" alt="ESP32-CAM"/><br/><b>ESP32-CAM</b></td>
</tr>
<tr>
  <td align="center"><img src="docs/img/boards/xiao-esp32-s3.png" width="90" alt="XIAO ESP32-S3"/><br/><b>XIAO ESP32-S3</b></td>
  <td align="center"><img src="docs/img/boards/xiao-esp32-c3.png" width="90" alt="XIAO ESP32-C3"/><br/><b>XIAO ESP32-C3</b></td>
  <td align="center"><img src="docs/img/boards/arduino-nano-esp32.png" width="120" alt="Arduino Nano ESP32"/><br/><b>Arduino Nano ESP32</b></td>
  <td align="center"><img src="docs/img/boards/stm32-bluepill.png" width="70" alt="STM32 Blue Pill"/><br/><b>STM32 Blue Pill</b></td>
  <td align="center"><img src="docs/img/boards/stm32-blackpill.png" width="70" alt="STM32 Black Pill"/><br/><b>STM32 Black Pill</b></td>
  <td align="center"><img src="docs/img/boards/stm32-f4-discovery.png" width="90" alt="STM32F4 Discovery"/><br/><b>STM32F4 Discovery</b></td>
</tr>
<tr>
  <td align="center"><img src="docs/img/boards/cardputer-adv.png" width="120" alt="M5 Cardputer ADV"/><br/><b>M5 Cardputer ADV</b></td>
  <td align="center"><img src="docs/img/boards/m5stack-core.png" width="110" alt="M5Stack Core"/><br/><b>M5Stack Core</b></td>
  <td align="center"><img src="docs/img/boards/badger-2350.png" width="120" alt="Pimoroni Badger 2350"/><br/><b>Pimoroni Badger 2350</b></td>
  <td align="center"><img src="docs/img/boards/xiao-esp32s3-sense.png" width="90" alt="XIAO ESP32S3 Sense"/><br/><b>XIAO ESP32S3 Sense</b></td>
  <td align="center"><img src="docs/img/boards/esp32-c6.png" width="70" alt="ESP32-C6 DevKit"/><br/><b>ESP32-C6 DevKit</b></td>
  <td align="center"><img src="docs/img/boards/unihiker-m10.png" width="90" alt="DFRobot UNIHIKER M10"/><br/><b>DFRobot UNIHIKER M10</b></td>
</tr>
</table>

Boards run in one of two places. **Browser boards** (AVR, RP2040) are emulated entirely in the page with avr8js and rp2040js — nothing leaves your machine. **Server boards** (ESP32 family, STM32, Raspberry Pi Linux) boot a real QEMU machine on the backend and stream GPIO and serial to the canvas. Both feel the same: press Play.

| Family | Boards | Languages | Where it runs |
| --- | --- | --- | --- |
| **Arduino / AVR** | Uno, Nano, Mega 2560, ATtiny85 | Arduino C++ | Browser — self-hosted and velxio.dev |
| **Raspberry Pi Pico** | Pico, Pico W | Arduino C++, MicroPython | Browser — self-hosted and velxio.dev |
| **ESP32** | ESP32 DevKit V1, DevKit-C V4, ESP32-CAM, Wemos Lolin32 Lite | Arduino C++, MicroPython, ESP-IDF | Self-hosted (QEMU) and velxio.dev |
| **ESP32-S3** | ESP32-S3 DevKit, XIAO ESP32-S3, Arduino Nano ESP32 | Arduino C++, MicroPython, ESP-IDF | Self-hosted (QEMU) and velxio.dev |
| **ESP32-C3** | ESP32-C3 DevKit, XIAO ESP32-C3, ESP32-C3 SuperMini | Arduino C++, MicroPython, ESP-IDF | Self-hosted (QEMU) and velxio.dev |
| **STM32** | Blue Pill (F103C8 / F103CB), Black Pill (F411CE / F401CE), STM32F4 Discovery, Olimex STM32-H405, Netduino 2 / Plus 2 | Arduino C++ | velxio.dev (paid plan) or Velxio Desktop |
| **Raspberry Pi (Linux)** | Zero, 1B+, 2B, 3B, 4B, 5 — boot a real Linux and run Python in a full terminal | Python | velxio.dev (paid plan) or Velxio Desktop |
| **Branded boards** | M5Stack Cardputer ADV and Core, Pimoroni Badger 2350, Galactic Unicorn and Pico Plus 2 W, Seeed XIAO ESP32S3 Sense, XIAO ESP32C6 and XIAO RP2040, Espressif ESP32-C6 DevKit, DFRobot UNIHIKER M10 | Arduino C++, MicroPython, ESP-IDF | velxio.dev only (free plan; UNIHIKER needs a paid plan) |

The self-hosted image runs the first five families out of the box. STM32 and Raspberry Pi Linux are hosted features (their emulators need licensed binaries and multi-GB boot images). The branded boards boot their factory firmware (the M5 launcher, BadgeOS) and live in the hosted catalog only; the OSS picker shows them as links to the online editor. The full list with pinouts, languages and quirks is in the [boards reference](https://velxio.dev/docs/boards/overview/).

---

## Features

### Code Editing

- **Monaco Editor** — Full C++ / Python editor with syntax highlighting, autocomplete, minimap, and dark theme
- **Multi-file workspace** — create, rename, delete, and switch between multiple `.ino` / `.h` / `.cpp` / `.py` files
- **Arduino compilation** via `arduino-cli` backend — compile sketches to `.hex` / `.bin` files
- **Compile / Run / Stop / Reset** toolbar buttons with status messages
- **Compilation console** — resizable output panel showing full compiler output, warnings, and errors

### Multi-Board Simulation

#### AVR8 (Arduino Uno / Nano / Mega / ATtiny85)

- **Real ATmega328p / ATmega2560 / ATtiny85 emulation** at native clock speed via avr8js
- **Full GPIO** — PORTB, PORTC, PORTD (Uno/Nano/Mega); all ATtiny85 ports (PB0–PB5)
- **Timer0/Timer1/Timer2** — `millis()`, `delay()`, PWM via `analogWrite()`
- **USART** — full transmit and receive, auto baud-rate detection
- **ADC** — `analogRead()`, voltage injection from potentiometers on canvas
- **SPI** — hardware SPI peripheral (ILI9341, SD card, etc.)
- **I2C (TWI)** — hardware I2C with virtual device bus
- **ATtiny85** — all 6 I/O pins, USI (Wire), Timer0/Timer1, 10-bit ADC; uses `AttinyCore`
- ~60 FPS simulation loop via `requestAnimationFrame`

#### RP2040 (Raspberry Pi Pico / Pico W)

- **Real RP2040 emulation** at 133 MHz via rp2040js — ARM Cortex-M0+
- **All 30 GPIO pins** — input/output, event listeners, pin state injection
- **UART0 + UART1** — serial output in Serial Monitor; Serial input from UI
- **ADC** — 12-bit on GPIO 26–29 (A0–A3) + internal temperature sensor (ch4)
- **I2C0 + I2C1** — master mode with virtual device bus (DS1307, TMP102, EEPROM)
- **SPI0 + SPI1** — loopback default; custom handler supported
- **PWM** — available on any GPIO pin
- **WFI optimization** — `delay()` skips ahead in simulation time instead of busy-waiting
- **Oscilloscope** — GPIO transition timestamps at ~8 ns resolution
- Compiled with the [earlephilhower arduino-pico](https://github.com/earlephilhower/arduino-pico) core

See [docs/RP2040_EMULATION.md](docs/RP2040_EMULATION.md) for full technical details.

#### ESP32, STM32 and Raspberry Pi Linux

The ESP32 family (Xtensa and RISC-V), the STM32 family and the Raspberry Pi Linux boards run on QEMU-based backends with the same canvas, Serial Monitor and instruments as the browser boards. Their setup, peripherals and quirks are covered board by board in the [documentation](https://velxio.dev/docs/boards/overview/); the technical notes for the QEMU bridges live in [docs/ESP32_EMULATION.md](docs/ESP32_EMULATION.md), [docs/RISCV_EMULATION.md](docs/RISCV_EMULATION.md) and [docs/RASPBERRYPI3_EMULATION.md](docs/RASPBERRYPI3_EMULATION.md).

### Example Projects

- Hundreds of ready-to-run examples in the gallery (400+ on velxio.dev), filtered by board, difficulty and topic — from Blink and Traffic Light to TFT dashboards, e-paper displays, MQTT over emulated WiFi and Pi + Arduino serial links
- The [100 Days 100 IoT Projects](https://github.com/velxio/100_Days_100_IoT_Projects) collection, imported as runnable projects
- One-click loading into the editor

---

## Self-Hosting

Pick the install path that matches your appetite for setup. **All three
work out-of-the-box without an `.env` file** — defaults are picked
automatically.

| Path | Boards available | Build time | Best for |
| --- | --- | --- | --- |
| **A. Docker (prebuilt image)** | AVR, RP2040 and the whole **ESP32** family (Xtensa + RISC-V) | ~30 s download | Just want it running |
| **B. Docker Compose (build from source)** | Same as A | ~10–15 min first build | Want to modify the code |
| **C. Manual install** | Browser-only boards (AVR, RP2040) | ~5 min | Frontend / backend dev |

> ESP32 emulation relies on QEMU `.so` libraries that ship inside the
> Docker image. Manual installs get the browser-side boards out of the
> box — **for ESP32 you'll want Docker** (or follow
> [docs/ESP32_EMULATION.md](docs/ESP32_EMULATION.md) to wire up the QEMU
> binaries by hand). STM32 and Raspberry Pi Linux emulation are hosted
> features — use them on velxio.dev or in Velxio Desktop.

---

### Option A: Docker (prebuilt image)

```bash
docker run -d \
  --name velxio \
  -p 3080:80 \
  -v velxio-data:/app/data \
  -v velxio-arduino-libs:/root/.arduino15 \
  -v velxio-arduino-user-libs:/root/Arduino \
  -v velxio-ccache:/var/cache/ccache \
  -v velxio-build:/var/lib/velxio-build \
  ghcr.io/davidmonterocrespo24/velxio:master
```

Open <http://localhost:3080>.

The five named volumes persist:

- `velxio-data` → `/app/data`: SQLite DB, project sketch files, auto-generated `SECRET_KEY`
- `velxio-arduino-libs` → `/root/.arduino15`: arduino-cli config + installed
  cores (saves a 5–10 min reinstall on every container restart)
- `velxio-arduino-user-libs` → `/root/Arduino`: Library Manager-installed
  Arduino libraries (e.g. Adafruit_BMP280, DHT, GFX). Without this,
  every container restart re-downloads them on next compile.
- `velxio-ccache` → `/var/cache/ccache`: ccache C/C++ object cache for
  ESP-IDF compiles. Empty on first compile, populated as you go;
  subsequent compiles hit the cache and finish in seconds instead of
  minutes.
- `velxio-build` → `/var/lib/velxio-build`: persistent ESP-IDF build dir
  (one subdir per target — esp32, esp32c3, esp32s3). Lets ninja's
  incremental build skip everything that hasn't changed; a re-compile
  of an unchanged sketch finishes in 2-5 seconds.

If you skip the volume flags, the Dockerfile declares all five paths as
`VOLUME`, so docker creates anonymous volumes and the caches still
survive container restarts (just harder to inspect/back up than named
ones). Only `docker rm -v` or `docker volume prune` would wipe them.

---

### Option B: Docker Compose (build from source)

```bash
git clone https://github.com/davidmonterocrespo24/velxio.git
cd velxio
docker compose up -d --build
```

First build takes ~10–15 minutes (downloads ESP-IDF, builds the frontend).
Subsequent builds are cached and take ~1 min.

Then open <http://localhost:3080>. The container generates a random
`SECRET_KEY` on first boot and persists it in `./data/`, so **no `.env` is
required** to get going.

#### Optional: customize environment

The OSS image has almost no configuration — there's no database, no auth,
no third-party integrations. Create `backend/.env` only if you want to
change the CORS origin used during local development.

| Variable | Default | Description |
| --- | --- | --- |
| `FRONTEND_URL` | `http://localhost:5173` | Origin allowed by CORS for local Vite dev |
| `VELXIO_NEWS` | `on` | Product news: the backend fetches release notes and product news from velxio.dev's public feed (cached ~6h, anonymous, no identifiers sent) and the editor shows each item once as a "What's New" modal. Posts may embed remote media (screenshots, GIFs, YouTube previews) which the viewer's browser loads directly from the hosting site; video players only load after an explicit click. Set to `off` to disable entirely; an offline host degrades to no news automatically. |

> **Deploying behind a reverse proxy?** The container listens on plain HTTP
> on port 80 and accepts any `Host` header — no `server_name` whitelist.

> **Running velxio.dev itself?** Production-only configuration (host nginx
> + HTTPS, backups, pinned upstream commit) lives in its own repo:
> [github.com/velxio/velxio-prod](https://github.com/velxio/velxio-prod).

---

### Option C: Manual Setup (frontend + backend separately)

**Prerequisites:** Node.js 18+, Python 3.12+, arduino-cli

```bash
git clone https://github.com/davidmonterocrespo24/velxio.git
cd velxio
```

> No `--recurse-submodules` needed. `@wokwi/elements`, `avr8js` and
> `rp2040js` come from the npm registry. Board SVGs live in
> `frontend/public/boards/`. The folders under `third-party/` are
> reference-only — you only need to clone wokwi-elements if you're adding
> a new component to the catalog (the metadata generator scans its `src/`).

```bash
# Terminal 1 — backend
cd backend
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8001
```

```bash
# Terminal 2 — frontend
cd frontend
npm install
npm run dev
```

Open <http://localhost:5173>.

**arduino-cli setup (first time):**

```bash
arduino-cli core update-index
arduino-cli core install arduino:avr

# For Raspberry Pi Pico / Pico W:
arduino-cli config add board_manager.additional_urls \
  https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json
arduino-cli core install rp2040:rp2040

# For ATtiny85:
arduino-cli config add board_manager.additional_urls \
  http://drazzy.com/package_drazzy.com_index.json
arduino-cli core install ATTinyCore:avr
```

> ESP32 (Xtensa) compilation in manual install requires the ESP-IDF 4.4.7
> toolchain installed locally. The Docker image bundles this — for manual
> installs see [docs/ESP32_EMULATION.md](docs/ESP32_EMULATION.md). If you
> only need AVR / RP2040 boards you can skip ESP-IDF entirely.

---

## Documentation

The user documentation lives at **[velxio.dev/docs](https://velxio.dev/docs/)** — getting started, every board and part, the circuit editor, programming in Arduino / MicroPython / ESP-IDF, WiFi and IoT, instruments, custom chips and the AI assistant, in 9 languages. Its source is the public [velxio/velxio_docs](https://github.com/velxio/velxio_docs) repository; corrections and new pages are welcome there.

The `docs/` folder of this repository keeps the technical notes for contributors (emulator internals, QEMU bridges, MCP server, roadmap).

---

## Community

Join the Discord server to ask questions, share projects, and follow updates:

**[discord.gg/3mARjJrh4E](https://discord.gg/3mARjJrh4E)**

## Contributing

Suggestions, bug reports, and pull requests are welcome at [github.com/davidmonterocrespo24/velxio](https://github.com/davidmonterocrespo24/velxio).

If you'd like to support the project financially, see the [Support the Project](#support-the-project) section above or sponsor directly at [github.com/sponsors/davidmonterocrespo24](https://github.com/sponsors/davidmonterocrespo24).

> **Note:** All contributors must sign a Contributor License Agreement (CLA) so that the dual-licensing model remains valid. A CLA check runs automatically on pull requests.

## License

Velxio uses a **dual-licensing** model:

| Use case | License | Cost |
| --- | --- | --- |
| Personal, educational, open-source (AGPLv3 compliant) | [AGPLv3](LICENSE) | Free |
| Proprietary / closed-source product or SaaS | [Commercial License](COMMERCIAL_LICENSE.md) | Paid |

The AGPLv3 is a certified Open Source license. It is free for all uses — including commercial — as long as any modifications or network-accessible deployments make their source code available under the same license. Companies that cannot comply with that requirement can purchase a Commercial License.

For commercial licensing inquiries: [davidmonterocrespo24@gmail.com](mailto:davidmonterocrespo24@gmail.com)

See [LICENSE](LICENSE) and [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md) for full terms.

## Star History

<a href="https://www.star-history.com/?type=date&repos=davidmonterocrespo24%2Fvelxio">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=davidmonterocrespo24/velxio&type=date&theme=dark&legend=top-left&sealed_token=kw0zv7Q1xq7XgYk9MJ3Tzg2RixZ8GK74heH5o8WfUzvGZyY1UbCJox3XLfg2vDtHGdDd-5NE5XQWgC57joU_MyrfKxZkvcehtOQNjmT-PuG2p6d3dUkNM2r41KRyPjthNj3bZ_geKv4v7cnQLV7sll4lQDqxwO7ViC3G" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=davidmonterocrespo24/velxio&type=date&legend=top-left&sealed_token=kw0zv7Q1xq7XgYk9MJ3Tzg2RixZ8GK74heH5o8WfUzvGZyY1UbCJox3XLfg2vDtHGdDd-5NE5XQWgC57joU_MyrfKxZkvcehtOQNjmT-PuG2p6d3dUkNM2r41KRyPjthNj3bZ_geKv4v7cnQLV7sll4lQDqxwO7ViC3G" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=davidmonterocrespo24/velxio&type=date&legend=top-left&sealed_token=kw0zv7Q1xq7XgYk9MJ3Tzg2RixZ8GK74heH5o8WfUzvGZyY1UbCJox3XLfg2vDtHGdDd-5NE5XQWgC57joU_MyrfKxZkvcehtOQNjmT-PuG2p6d3dUkNM2r41KRyPjthNj3bZ_geKv4v7cnQLV7sll4lQDqxwO7ViC3G" />
 </picture>
</a>

## References

- [Wokwi](https://wokwi.com) — Inspiration
- [avr8js](https://github.com/wokwi/avr8js) — AVR8 emulator
- [wokwi-elements](https://github.com/wokwi/wokwi-elements) — Electronic web components
- [wokwi-boards](https://github.com/wokwi/wokwi-boards) — Board SVG assets
- [wokwi-features](https://github.com/wokwi/wokwi-features) — Wokwi feature definitions
- [rp2040js](https://github.com/wokwi/rp2040js) — RP2040 emulator
- [ngspice-wasm](https://github.com/wokwi/ngspice-wasm) — ngspice compiled to WebAssembly (electrical simulation)
- [lcgamboa/qemu](https://github.com/lcgamboa/qemu) — QEMU fork for ESP32 Xtensa emulation
- [espressif/qemu](https://github.com/espressif/qemu) — Espressif QEMU ESP32 emulator
- [esp32-camera](https://github.com/espressif/esp32-camera) — ESP32 camera driver reference
- [fritzing-parts](https://github.com/fritzing/fritzing-parts) — Electronic component SVG assets
- [picowi](https://github.com/jbentham/picowi) — Raspberry Pi Pico W WiFi reference
- [100 Days 100 IoT Projects](https://github.com/velxio/100_Days_100_IoT_Projects) — IoT example projects collection
- [arduino-cli](https://github.com/arduino/arduino-cli) — Arduino compiler
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) — Code editor
- [QEMU](https://www.qemu.org) — Machine emulator (Raspberry Pi 3)
