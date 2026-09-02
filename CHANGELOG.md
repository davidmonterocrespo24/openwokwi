# Changelog

All notable changes to Velxio will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [3.0.5] - 2026-09-02

### Added
- Added a light theme for the editor, canvas, and shell, with dark islands and a theme switch in the header.
- Added wire junction nodes so wires can connect to other wires.
- Added scope probing on any wire, digital or analog.
- Added `.vlx` project export from the File menu.
- Added a plan-priority build queue with a visible progress card.
- Added an optional File-menu row for connecting an external AI agent (Claude/Codex).
- Added an ESP32-P4 Preview starter card and picker entry.
- Added partner board sections to the starter dialog (Seeed, DFRobot, Pimoroni, Espressif).
- Added ONLINE cards for every closed component in the picker.
- Expanded custom-chip support with optional face images, `chip.c`/`chip.json` as ordinary editor files, Wokwi zip round-trip, live controls, bit-banged UART TX on GPIO, drop-as-copy, and a CUSTOM badge.

### Changed
- Reworked the WiFi badge into a split button that appears before a run and opens the WiFi overlay panel.
- The automatic SSID rewriter now stands down when a project defines its own WiFi airspace.
- Moved the S3 Sense into the ESP32 starter section instead of a separate Seeed block.

### Fixed
- Fixed theme and header issues: transistor symbols no longer vanish on the light canvas, exports follow the theme, dark-mode cards and pill labels are readable, the flash dialog uses the correct accent color, and the toolbar stays compact without dropping the theme switch.
- Fixed wire positions not syncing while dragging components.
- Fixed board-less project handling: projects stay board-less, a live custom chip click opens its sensor panel, and custom chips re-attach when compiling in board-less mode.
- Fixed custom-chip stability and compatibility: closed sync data-loss races, made digital outputs visible to the board’s `digitalRead`, titled the sensor panel with the chip’s own name, and stopped the chip body from overlapping itself.
- Fixed SPICE/scoping probes and overlays so they read the net the solver actually solved.
- Fixed library builds and uninstall: a library’s `extras/` no longer drags unrelated code into the build, and uninstall can no longer reach into the shared cache.
- Fixed multiple ESP-IDF build issues: TFT_eSPI builds on the S3, tight-buffer `sprintf` is no longer a hard error, build-config headers such as `lv_conf.h` no longer pull unrelated libraries into the build, custom WiFi SSIDs are threaded through compilation, cloud-built P4 sketches no longer start an interactive REPL, and ESP32-P4 builds include the esp-hosted-mcu sync-RPC race fix.
- Fixed Run all / Compile all so MicroPython boards are no longer routed through arduino-cli.
- Fixed an ESP32 worker race in host-thread pin injection.
- Fixed board identity and artwork issues: Raspberry Pi Zero/1B+/2B are no longer presented as a Pi 3, QEMU-Linux overlay boards are not shown as Raspberry Pis, and ESP32 variants with dedicated art no longer borrow the DevKit V1 drawing.
- Fixed the WiFi badge so it follows the run state.
- Fixed gateway and board-linking issues: root-relative board pages work under a proxy prefix, and SoftAP-only sketches no longer offer an unreachable link.
- Fixed blank-NVS WiFi failures by explaining the cause and detecting WiFi in stripped firmware images.

### Security
- Hardened CI by pinning third-party actions to commit SHAs, fixing the CodeQL language configuration, and making incoming pull requests safe to process before trusting them.

## [3.0.4] - 2026-08-25

### Added
- Added ESP32-P4 and ESP32-C5 targets to the ESP-IDF build lane, with PSRAM enabled by default on ESP32-P4 and the CDCOnBoot menu option honored in four-part FQBNs.
- Added ESP-IDF component support for the layers Espressif board demos depend on, including LVGL and esp_lvgl_port.
- Added intellisense class/type lookup endpoints, inheritance-aware type queries, and answers from the local sketchbook.
- Added board picker cards and online badges for the Pimoroni Stellar Unicorn, ESP32-S3-EYE, ESP-EYE, ESP-SensAirShuttle, ESP-VoCat, ESP32-P4-Function-EV, ESP32-C3-LCDkit, and the remaining closed-catalogue parts.
- Added board declarations for fitted RAM/flash, built-in cameras, power-management ICs, display autodetect identities, and starter code shipped with a board.
- Added MicroPython v1.28.0 firmware for the ESP32 family and library installation from the micropython-lib index.
- Added browser Web Serial flashing and a MicroPython web-flash flow, with compile-before-flash and stale-build warnings.
- Added compact file explorer, an auto-save indicator in the Save button, and M5Stack/Nano/ESP32-CAM entries to the starter picker.
- Added What's New announcement modal/toast and interaction tracking, plus session entry points in the File and Account menus.
- Added server-side matrix keypad support and PIO peripherals that consume words directly from the PIO stream.

### Changed
- The Save button now doubles as the auto-save indicator, replacing the old header pill.
- Editor layout switching now lives in the View menu.
- The starter picker now places the M5Stack section ahead of STM32.
- The landing page now advertises 35 boards across 6 architectures.
- Updated shipped BadgeOS 2.0.2 factory images and MicroPython firmware for esp32c6, rp2040w, and rp2350-arm.

### Fixed
- Fixed ESP-IDF compilation: included IDF-tree headers in Arduino sketches, removed header-shadow conflicts, concatenated all .ino tabs with Arduino semantics, broadened merged-component REQUIRES, generated forward declarations, linked the task-WDT API, enabled BLE 4.2 legacy APIs, and prevented unknown `#if` branches from pruning `#else`.
- Fixed MicroPython behavior: raw REPL answers are no longer buffered, project libraries upload in bounded steps, unknown SSIDs route to the emulated AP, the real WiFi driver is no longer shadowed, and sleepy `isconnected()`/`status()` no longer busy-wait.
- Fixed WiFi/radio reliability: CYW43 WiFi works after the first Run, the emulated ESP32 keeps its radio regardless of scan results, and in-browser WiFi boards stay reachable through the IoT gateway.
- Fixed simulator and SPICE behavior: overlay boards no longer get solved as 5 V Arduinos, VIN/5V rails are no longer clamped to 3.3 V, sensor-line resistor dividers no longer hide board pins, multi-pin writes reach all pins, raw-byte UART data is handled correctly, programmatic property changes reach the running simulation, and illumination sliders are logarithmic.
- Fixed SSD1306 rendering and picker presentation: the display is drawn as glass bonded to the PCB, the thumbnail matches the redrawn part, and each variant has its own datasheet and pinout.
- Fixed picker/assets: ad-card art now matches real boards, and Pi 4/5 photos no longer have opaque white backgrounds.
- Fixed board/pin handling: pads that resolved to nothing, supply pads driving GPIOs, overlay boards entering ESP-IDF mode, board-corner wire anchors, and all compile sites reading the Arduino FQBN.
- Fixed compile pipeline: build-directory locking prevents concurrent compiles from swapping binaries, scan-all retry errors are reported, the sync endpoint tolerates client disconnects, and vendor example code no longer fails `-Werror`.
- Fixed editor/canvas UX: toolbar overlap on narrow bars, workspace panel stacking, modal z-order, marker hovers, split-drag desync, quick suggestions in snippet placeholders, boards landing in the visible corner, and persisted ImageData no longer clobbering live display frames.
- Fixed project handling and messaging: exports use the actual board, imports match the board from file names, uploaded binaries explain when they cannot find a network, Bluetooth errors are explained directly, Arduino library search/install failures become one actionable sentence, and bare emulated-subnet IPs are linkified.
- Fixed examples: repaired the 100 Days of IoT batch, Bluetooth LED, common-emitter amplifier, night-light LDR, RGB mixer, code-only languageMode handling, and missing components/wires so one malformed example doesn't take the gallery down.
- Fixed matrix keypad behavior with an active-row model, idempotent install, and gap-free listeners.
- Fixed intellisense access labels for statements that open nested braces.
- Fixed M5Stack Core header pins and PWM tones.

### Performance
- Arduino-cli and ESP-IDF builds now run independently instead of queueing behind one another.
- Memoized linker-fragment parsing in ESP-IDF builds, cached built artifacts, skipped the PSRAM boot memtest, and rebalanced compile disk from build variants to ccache.
- Optimized idle-spin handling so the interpreter's dispatch loop answers the common case first instead of busy-waiting.

### Removed
- Removed the in-app /docs pages from routes and the sitemap.
- Removed the Nano RP2040 Connect shell from the picker until simulator artwork exists.

## [Unreleased]

### Added
- Browser flashing seam (`lib/proWebFlash.ts`): the board context menu's
  "Flash to real board" and the FlashModal can now be backed by a Web Serial
  flasher installed at runtime (used by velxio.dev for ESP32-family boards);
  without one, web builds keep the desktop-only behavior (#248)
- Hardware serial seams: `appendHardwareSerial` feeds real-UART bytes through
  the serial batcher, and `lib/proHardwareSerial.ts` lets an installed monitor
  intercept a board's serial input while attached

## [3.0.3] - 2026-08-10

### Added
- Added an online board showcase to the picker with cards for online-only boards and components, including Seeed Studio XIAO, reSpeaker, and UNIHIKER M10.
- Added a runtime overlay registry so private board packs can register boards, components, sensors, datasheets, built-in peripherals, and QEMU-Linux board kinds.
- Added ESP-IDF v5.5 compile support for the entire ESP32 family, ESP32 bridge seams, and S3/C3 gallery examples.
- Added serial-as-USB-CDC behavior when boards.txt declares it, and the real Arduino variant now reaches sdkconfig.
- Added a starter-template picker for the pristine editor and New workspace, with circuit thumbnails, a blank canvas behind, a prominent + for Blank, an Arduino Mega card, and one ESP32 per chip.
- Added File/Edit/View/Language/Help menus in the editor header, translated in all nine locales, with full desktop-menu parity.
- Added folder trees in the file explorer, with create/delete folder support.
- Added the Part Inspector, merging the right-click dialog with the picker card; pins remain visible and traceable, and boards open it too.
- Added example links in the Properties tab and dynamic board tabs in the examples gallery.
- Added a What's New modal with a product news feed, once-per-user queue, inline images/GIFs, YouTube click-to-play previews, and bare image URLs rendered inline.
- Added microphone streaming into boards with an on-board mic.
- Added camera toggles for component-owned webcams, including ESP32-CAM and XIAO ESP32S3 Sense; the webcam starts automatically when running an ESP32-CAM.
- Added live SD card contents in the SD panel, letting users list and download files written by sketches; boards and parts with built-in microSD/TF slots accept uploads.
- Added board-agnostic speaker and microphone seams, a speaker-sink gate, electrical seated sockets, and tilt/battery controls for boards with IMUs or gauges.
- Added 4-level greyscale rendering in the SSD168xDecoder for e-paper panels.
- Added canvas drop feedback, meaningful clicks, drag-to-front, a socket magnet, a board-status slot, and floating zoom controls.
- Added Raspberry Pi display output, serial over the header in Linux mode, complete Pi peripheral plumbing, unified editor UX (Monaco/explorer/xterm), one-click run, quiet boot, and guest setup.
- Added QEMU guest session ceiling, optional restricted guest egress via guestfwd tunnel, per-session extra drives, and start_pi payload passthrough.
- Added a serial-actions slot in the monitor toolbar.
- Added a pluggable browser MicroPython path for pro simulators.

### Changed
- Reworked the editor shell: the toolbar now rides inside the header, the overflow menu folded into File, and marketing navigation moved out of the editor.
- Replaced the top-level Language menu with an Account menu; language and account controls moved to a bottom-left corner box.
- SD auto-copy now puts only project data files on the card; source files stay off it.
- Reordered picker contents maker-first, with passives, analog, and logic gates moved to the end.
- Renamed component camera toggles to "Camera" to match the board toggle.
- Softened datasheet purchase links from "Buy" to a localized "Product page" with UTM attribution and click reporting.
- Made the inspector and datasheet share one action bar, use one height, and avoid sideways scroll.
- Translated remaining raw editor/examples strings into all nine locales; leftover Spanish in gallery code was translated to English.
- Cleaned up compile logs to tell the story once, without CMake's diary, and with the final flush speaking in whole lines from the real buffer.
- Online-only showcase cards now use compile/run context (board kind, gallery example, engine) to stay quiet when irrelevant.

### Fixed
- Fixed ESP-IDF environment issues: the Python venv now matches the IDF tree's version and works in Docker; header-only libraries no longer break ESP32 builds; quoted header includes resolve libraries; esp_camera.h was restored.
- Fixed compiler failures caused by missing board_fqbn and sdkconfig writes not following defaults.
- Fixed ESP32 simulator bridge issues: rebuilt boards re-sync the flat simulator field and adopt I2C devices; SPI completeTransfer now delivers MISO; ADC and GPIO-to-ADC channel mapping consult the bridge; the M5 Cardputer header resolves to real GPIO numbers.
- Fixed ESP32 button handling: active-low is decided by the circuit, not a constant.
- Fixed compile-output false positives: IDF "Project commit: HEAD-HASH-NOTFOUND" banners are no longer errors.
- Fixed wire endpoint races: both halves of the load-time endpoint race close, and endpoints recalculate when a late-defined element upgrades.
- Fixed canvas stacking and socket interactions: seated boards stack as one piece, sockets latch at drag start, boards stay above their socket, boards paint only when seated and above components, and touchscreen swipes no longer pan the canvas while running.
- Fixed socket seating tolerance so a board that is slightly off the seat stays plugged in.
- Fixed e-paper rendering: refresh tears gone by persisting the window union, vertical orientation correct for descending-Y panels, custom B/W waveform LUTs honored, and 4-level greyscale works.
- Fixed NTC temperature sensor readings on 3.3V boards and corrected three backwards-decoded examples.
- Fixed MicroPython prompt handshake: the \r poke no longer fires after the prompt is already up.
- Fixed the Libraries manager: Escape now closes it.
- Fixed Part Inspector rendering: no more flicker on every render, dropped labels for inset pin columns, clipped tall pin stacks, crowded pin headers drawn vertically, and a column is recognized as a run of pads.
- Fixed the inspector "no datasheet" state: parts now say they have no datasheet instead of showing an empty tab.
- Fixed right-clicking a board while running so it opens the board inspector.
- Fixed picker overlay issues: late overlay registration re-renders the picker without a reload, version hooks are declared before memos, previews match variants, the datasheet popover appears above the modal, duplicate Pi cards are removed, Pi Zero/1/2 are wired as real boards, and many-pin inspectors are readable.
- Fixed Pi/QEMU-Linux issues: booting without a bridge no longer fails silently, restarting in Linux mode boots the guest, serial TX hooks survive simulator rebuilds, overlays no longer hijack Pi drawing, per-tab client_id is stable, Pi board ids are parsed correctly, and Run stays enabled on running QEMU-Linux boards for fast re-runs.
- Fixed SPICE pin mapping for micro:bit-style P<n> pad names.
- Fixed example gallery: direct pro-example URLs no longer hang or flash a 404, LED examples have series resistors,

## [3.0.2] - 2026-08-05

### Added
- Added a pure ESP-IDF language mode for the ESP32 family.
- Added support for the DS3231 RTC module and the GPS NEO-6M NMEA talker.
- Added library manifest auto-migration, name-affinity ranking, and install declarations.
- Added Wokwi-style parts-on-breadboard workflow: hole snapping, invisible seating wires, hover-gated labels, full-footprint seating solver, green connection dots, one-hole-one-wire selection rules, and jumper colors.
- Added Wokwi-style wire routing: first-time auto-routing around components, avoidance of existing wires, and live routed preview.
- Added pre-flight verification checks for unpowered nets, open source loops, and relay coil voltage mismatch.
- Added a running weather-station demo GIF to the landing page hero.

### Changed
- Made resistors default to vertical orientation when added on the canvas.
- Updated wire styling and editing to use Wokwi-style rounded bends, fuse sub-pixel jogs, snap segment drags to the wire's own runs, and clean up degenerate paths.
- Updated Docker images to include the ESP32-S3 ROM.

### Fixed
- Fixed ESP-IDF library resolution so generic platform headers are never resolved against user libraries and foreign libraries no longer leak into user_libs_all.
- Fixed the ESP-IDF architecture guard skipping usable libraries.
- Fixed ESP32-S3 ADC channel mapping in setAdcVoltage/setAdcWaveform.
- Fixed STM32 output pins in SPICE by stamping them as voltage sources and unifying silkscreen-to-GPIO mapping; this also fixes nano-ESP32 buttons and ESP32-family SPICE analog.
- Initialized INPUT_PULLUP pins to their resting level when pull is enabled.
- Fixed frozen LEDs on QEMU-based boards after resubscription.
- Fixed run-after-agent restarts by forcing a clean ESP32 bridge reconnect and a clean restart on Run.
- Fixed display bodies occluding crossing wires.
- Fixed 7-segment displays rebuilding per-element simulation state when digit count changes.
- Fixed brand-prefixed metadata IDs (e.g., wokwi-lcd2004) resolving to their base part.
- Fixed Raspberry Pi component cards and Pi 4/5 board thumbnails to show full illustrations and clearer PRO badges.
- Fixed router corner cases for endpoints inside obstacles and checked-elbow parity.
- Fixed pin tracing to recognise runtime boards and same-hole junctions.
- Fixed breadboard seating edge cases: run-before-seating race and agent-seated parts landing under rotation.
- Fixed component property handling to type-coerce strings and reseat on pininfo changes.
- Fixed editor URL sync after New workspace and clearing project identity on .vlx import.
- Fixed ESP32 GFX examples to declare the Adafruit BusIO dependency.
- Fixed autosave not starting for already-mounted hooks.

### Performance
- Improved editor responsiveness during fast-toggling simulations by unfreezing the ESP32 clock update path.

## [3.0.1] - 2026-07-18

### Added
- Added keyboard mapping for pushbuttons – assign a key from the component property dialog; keycap badge shows the mapping on the canvas.
- Introduced global message dialog and confirm modal replacing native `confirm()` and `alert()` calls across the editor, file explorer, and other modals.
- Preserved in-progress workspace across login redirect using sessionStorage (stashed as `.vlx` and restored after authentication).
- Added full 830-point and mini 170-point breadboard parts with Fritzing artwork (CC-BY-SA 3.0) and computed pin geometry.
- Added built-in internal connectivity for breadboard strips and power rails (netlist merging).
- Added new 4-pin I2C SSD1306 OLED module and gallery examples for Uno, ESP32, Pico, and STM32.
- Added auto-detecting SSD1306 part that automatically selects I2C or SPI protocol based on wiring.
- Added ESP32 WiFi + MQTT (PubSubClient) gallery example that round-trips through a public broker.
- Added ESP32-S3 ILI9341 TFT display example.
- Added multi-board “Run All” button with split-menu to run only the active board.
- Added wire color discoverable UI on desktop: context menu with color swatches and floating palette when a wire is selected.
- Added featured component sorting – breadboards now lead the component picker.
- Added per-component pin hover highlighting (only the pin under the cursor lights up, matching the breadboard behaviour).
- Added runtime burnout for resistors, electrolytic capacitors, and LEDs (sustained overload destroys the part; charred visual and open circuit).
- Added pre-flight circuit verifier rules: missing power, dangling two‑terminal parts, power shorts, over‑voltage warnings for boards and electrolytic capacitors.
- Added Pico W WiFi emulation (paid feature): virtual DHCP/ARP net, IoT gateway, internet bridge, and full associaton.
- Added AVR EEPROM emulation (fixes hangs on `EEPROM.read/write/update`).
- Added ATtiny85 USI I2C bridge enabling SSD1306 OLED support via TinyWireM.
- Added feedback mechanisms: star banner follow-up for users who dismissed the first prompt, and circuit verification results now appear in the output console.

### Changed
- Redesigned the examples page: compact toolbar, denser grid with 5:3 thumbnails (no black bars), and filter chips with dropdown selects.
- Unified editor toolbar controls now collapse by container width instead of viewport, preventing overlap when the AI chat panel is open.
- Removed redundant file-tabs bar from the toolbar; file switching is now done exclusively from the left explorer.
- Breadboards now always sit behind all other components (z‑index -1) to reflect their physical role.
- Pin overlays stack within their component group and no longer leak through covering components.
- Board pins stay clickable – hover handlers moved to the component wrapper, not the drag overlay.
- Slide-switch model corrected from SPST to genuine SPDT with pin‑1/pin‑3 throws and a common wiper.
- NTC temperature sensor SPICE model fixed (pull‑up on top, NTC to GND) so the decode matches the example sketch.
- SPICE pre-flight and runtime electrical re-solve now triggered on all output pin edges (ESP32, STM32, Raspberry Pi) and on component burnout.
- Circuit verifier findings are now logged to the output console instead of a toolbar toast.
- Virtual file system upload now auto‑starts the Pi and waits for the shell before sending files.
- The Run button shows a spinner and stays disabled while circuit verification is in progress.
- Non‑English locales (zh‑cn, pt‑br) now load correctly on direct navigation.
- `/en/*` routes are redirected to the prefix‑free path instead of rendering a blank page.
- Star banner flags are now separate for dismissal and click‑through, allowing one follow‑up prompt.
- Built‑In breadboard and minimap artwork switched to the Fritzing parts‑library (CC‑BY‑SA 3.0).
- ESP32 digital inputs are now driven from the real SPICE solve for accurate `digitalRead()`; AVR inputs include modeled internal pull‑up resistors; RP2040 and STM32 also benefit from SPICE‑driven inputs.
- Pico W board now loads the `RPI_PICO_W` firmware variant (with `network` module) when a CYW43 peripheral is present.

### Fixed
- Fixed keyboard‑mapped buttons firing while typing in the Monaco code editor (focus sink detection improved).
- Fixed board pins being unclickable when the cursor moved from the drag overlay onto a pin square.
- Fixed wire colour changes from the UI being a no‑op (`applyNow` was `false`).
- Fixed `recordUpdateWire` being undefined in `SimulatorCanvas` causing JavaScript reference errors.
- Fixed rotated component pin positions being wrong for wire starting, undo/redo, and import (three separate bugs).
- Fixed Delete/Backspace key inadvertently triggering board removal instead of only deleting selected components.
- Fixed ESP32 UART pin classification missing for multi‑board Serial interconnect (TX/RX, TX2/RX2 now properly mapped).
- Fixed ESP32‑C3 digital inputs not resolving from SPICE (spiceDrivenInputs enabled).
- Fixed ESP32 dual 3V3/5V pins (e.g., DevKitM‑1) not being tied to the supply rail.
- Fixed ATtiny85 pin name mapping and Timer0 PWM register addresses (blink/PWM works).
- Fixed AVR EEPROM not instantiated – `EEPROM.read/write` no longer hangs.
- Fixed SSD1306 page‑addressing mode (default memory mode set to 2) so Tiny4kOLED and U8g2 render correctly.
- Fixed breadboard holes not connecting during netlist building (5‑hole strips and power rails now merge).
- Fixed breadboard pins invisible for dense components – only the pin under the cursor lights up (consistent with other components).
- Fixed Pico W WiFi emulation: gSPI framing, F2 byte order, host‑wake IRQ, event frames (BDC headers), and virtual DHCP/ARP.
- Fixed Pico W MicroPython file writing (UTF‑8 byte length for LittleFS) – multi‑byte characters no longer truncate files.
- Fixed ESP32‑C3/‑S3 compiling with wrong target (`esp32` instead of `esp32s3`) and missing GPIO pins 40‑48.
- Fixed ESP32 firmware download fast‑path for WiFi emulation (inDiscardableWriteData).
- Fixed SPICE re‑solve not being triggered on ESP32/STM32/Pi output pin edges (LED stayed stuck on).
- Fixed SPICE re‑solve not being triggered when a component burns out (burnt part stayed in the circuit).
- Fixed circuit verifier being blind to current faults in production (branch currents not enumerated via ngspice AllVecs).
- Fixed circuit pre‑flight verification never running on Run button click (click event mistaken for `skipVerify` argument).
- Fixed verification findings being wiped when Run auto‑compiled after verification.
- Fixed tooltip/text fields not being respected when Backspace was used to delete wires (AI chat, etc.).
- Fixed window blur not releasing keyboard‑mapped buttons (no stuck keys after Alt‑Tab).
- Fixed minimap red viewport rectangle not updating during canvas drag (now live‑tracked via `requestAnimationFrame`).
- Fixed Docker build artifact upload exhausting Actions storage quota (disabled).
- Fixed QEMU/ROM downloads failing on transient deploy blips (added retries).
- Fixed backend E2E tests failing on fork PRs due to missing secrets (gated gracefully).
- Fixed non‑English locale bundles not loading on direct navigation (i18next initialisation and case matching corrected).
- Fixed `/en/*` routes rendering blank (redirected to prefix‑free canonical path).
- Fixed UI: toolbar controls overlapping on narrow bar when AI chat panel was open (container query collapse).
- Fixed UI: neon decorative outlines replaced with solid tokenized `#0071e3` accent across editor and landing page.
- Fixed UI: “Circuit check” findings preserved across Run auto‑compile, no longer cleared.
- Fixed UI: breadboards now always behind components, and pin overlays stack correctly with their group.
- Fixed UI: pinned overlays pickers (Add Component, board picker) now render above AI chat panel (z‑index 9000).
- Fixed UI: rotated component pin boxes incorrect after import/undo/load (re‑measure after layout).
- Fixed UI: star banner tracking distinguished between dismissal and actual click‑through.
- Fixed UI: file tab bar removed from toolbar to free up horizontal space.
- Fixed examples: ESP32 Blink LED example now includes a series resistor.
- Fixed examples: 8 MicroPython WiFi examples changed from plain Pico to Pico‑W board type.
- Fixed examples: slide‑switch wiring in digital and circuit examples updated to match corrected SPDT model.

## [3.0.0] - 2026-06-11

### Added
- Custom retro CPU chips (Z80, 8080, 4004, 4040, 8086) with programmable ROM, board-less operation, and in-editor assembly support
- MicroSD card emulation over SPI for AVR, RP2040, and ESP32 with FAT16 image and upload panel
- Library Manager with per-board manifests, content-addressed cache, version management, uninstall, and autocomplete
- ePaper display emulation for SSD168x (B/W, tri-colour), UC8159c (ACeP 7-colour), and UC8179 (mono) panels
- Undo/redo for canvas operations (components, wires, moves, rotations, property changes)
- PinResolver abstraction enabling SPICE-resolved digital inputs for mixed-mode simulation
- Full ngspice WASM migration: one solver path across browser and Node tests
- SignalRouter for ESP32 GPIO Matrix routing, replacing the per‑peripheral ad‑hoc cache
- Oscilloscope trigger modes (Auto / Normal / Single) with edge selection and position control
- RP2040 real-time performance: IdleSpinDetector elides busy‑wait loops, WFI sleeps are bounded
- ESP32‑CAM emulation with real webcam frame bridge via QEMU
- Multi‑board wire‑aware interconnect (UART, I2C, SPI, digital pins) across all supported boards
- GitHub Sync, Share/Embed modal, BOM CSV export, schematic PNG export (Pro features)
- Desktop app welcome page, grace/license gating, native menubar bridge, in‑app update toast
- i18n support for 9 locales (en, es, pt‑br, it, fr, zh‑cn, de, ja, ru) across the UI
- Extension hooks for private overlays: auth/DB split, session, save action, agent chat slot
- .vlx project export/import for stateless OSS self‑hosters
- Board options modal, per‑target compilation console with status grouping
- Live compile log streaming for ESP‑IDF (cmake/ninja output) and arduino‑cli
- Visual LED test harness (CDP‑driven) and netlist snapshot tests for all gallery examples
- Over 100 new gallery examples (Pico Doom, ESP32‑CAM preview, ePaper dashboards, retro CPU demos, 100 Days of IoT, analog circuits, etc.)

### Changed
- Library Manager redesigned: single unified tab with state‑aware row actions (Add to project, In project toggle, Uninstall/Remove)
- Compilation system: async job model with status polling, request dedup, concurrency semaphore, persistent ESP‑IDF build directory
- ESP‑IDF builds now use ccache with 8 GB cap, per‑variant persistent directories, and graceful fallback for incomplete manifests
- Server‑side library resolution scoped to content‑addressed cache; global volume retired
- ePaper rendering improved: native‑window compose, proper rotation, byte‑aware orientation, paged window union
- Canvas interactions enhanced: wires follow component rotation, minimap with draggable viewport, drag‑to‑move parts during simulation
- Bundle size reduced via manualChunks: main entry dropped from ~23 MB to ~2.68 MB; wokwi‑elements, PiTerminal, mcu‑emulators split
- Landing page refreshed with AI agent section, updated pricing tiers, licensing cards, and live editor hero screenshot
- Pricing copy updated to multiplier messaging (Pro = 20×, Pro Max = 50×)
- Desktop app hides marketing nav, redirects / → /editor, shows splash screen during boot
- CHANGELOG.md entries reflect all new features and changes for v3.0.0

### Fixed
- ESP32: WiFi/HTTP client link by enabling mbedTLS PSK; BLE stack switched to Bluedroid; LEDC duty routing for multi‑servo; flash image trimming (10× smaller JSON); sdkconfig defaults for cleaner serial output
- RP2040: delay()‑based sketches now run in real‑time on slow hosts; SPI0 routing fixed for Arduino init; UART TX waveform synthesized
- AVR: serial RX queue so `Serial.readStringUntil` sees full input; UART TX waveform at bit level; INPUT_PULLUP pin state; LED visualization through SPICE
- Multi‑board: initSimulator no longer wipes Interconnect’s UART wrapper; board removal reconciles `running` flag
- Canvas: wires follow component rotation; undo/redo state restored; component deletion cascades to wires; sensor panel opens on desktop click; wire color palette works
- i18n: index.html SEO fallback div removed after mount; missing locale keys for admin/user pages added
- Desktop: openExternal works via cascade of IPC paths; native menu routes navigate in‑window
- CI: Frontend Tests restored by patching RP2040 mocks and install‑libraries payload; backend e2e re‑enabled; worker heap limit bumped; cache storage growth limited
- Library: ArduinoJson and other src/‑layout libraries compile correctly by preserving directory structure
- ePaper: BUSY polarity per controller family; RAM Y‑counter wraps at window end; orientation correct across all boards
- Visual LED: RGB LED, 7‑segment, and PWM fade now correctly driven through SPICE‑resolved pins
- PinManager: updatePort respects DDR mask so INPUT_PULLUP does not falsely mark pin as output
- Many other bug fixes across compilation, simulation, UI, and platform compatibility

### Performance
- Bundle size reduced by 88% for main entry via manualChunks
- ESP‑IDF warm compiles drop from 5–7 min to 5–30 s with ccache + persistent build dir
- Compilation dedup prevents multiple ninja jobs from racing on the same sketch
- Spice/I2C waveform rendering speed improved by batching SPI bytes in the worker
- Minimap and canvas rendering optimised for mid‑range hardware

### Removed
- Legacy SpiceEngine (eecircuit‑engine) and CircuitScheduler replaced by ngspice WASM
- Dead auth/DB dependencies from OSS image (SQLAlchemy, JWT, etc.)
- Per‑board LEDC update fallback after SignalRouter rollout
- Unused files: `wireOffsetCalculator`, `wirePathGenerator`, `wireSegments`
- Global arduino‑libraries volume no longer needed for library resolution
## [2.0.1] - 2026-04-22

### Added
- Enhanced electrical simulation with ngspice-WASM engine for accurate analog circuit analysis
- Expanded component catalog with 44 SPICE-compatible parts including logic gates, transistors, op-amps, regulators, and electromechanical components
- Added 40 new circuit examples demonstrating analog, digital, and electromechanical concepts
- Introduced custom web components for electronic elements (relays, resistors, capacitors, inductors, transistors)
- Implemented ESP32 ADC waveform simulation with periodic 12-bit waveform look-up tables and interpolation
- Added voltmeter and ammeter instrument components for real-time circuit measurements
- Created comprehensive end-to-end tests for electrical simulation including capacitor charging, rectifier behavior, and waveform analysis
- Added GitHub Actions workflow for circuit simulation testing on every push and PR

### Changed
- Renamed all components to use 'velxio-' prefix for consistency
- Enabled electrical simulation by default (always-on SPICE mode) instead of requiring manual activation
- Enhanced LED brightness simulation to reflect actual current flow from SPICE calculations
- Updated backend to handle unhandled asyncio exceptions and prevent process crashes
- Improved component metadata generation to prevent CI drift and enforce up-to-date metadata
- Refactored property synchronization in simulation parts to use event-based system
- Expanded ADC pin mapping to support all 18 board types for full microcontroller integration

### Fixed
- Fixed sitemap generation to include all circuit examples for better SEO visibility
- Resolved floating input node issues in RC low-pass filter circuits that caused SPICE singular matrix errors
- Updated proxy configuration to use 127.0.0.1 for improved compatibility
- Fixed metadata regeneration to properly include custom components in the component picker
- Improved backend entrypoint script to ensure clean container restarts when processes die

## [2.0.1] - 2026-04-17

### Added
- Added ATtiny85 support with examples and simulation tests
- Added BMP280 sensor component with circuit preview and SVG representation
- Added example detail pages with improved SEO and sitemap generation
- Added MicroPython support for RP2040 (Pico), ESP32, ESP32-S3, and ESP32-C3 boards
- Added ability to upload precompiled firmware files (.hex, .bin, .elf) directly into the emulator
- Added ability to remove boards from workspace with confirmation dialog
- Added I2C sensor support with slave emulation for MPU6050, BMP280, DS1307, and DS3231 sensors
- Added ESP32 WiFi/BLE emulation with ESP-IDF compilation pipeline
- Added VS Code extension skeleton for local simulation
- Added comprehensive documentation for ESP32 GPIO sensor simulation, Docker infrastructure, and MicroPython implementation
- Added auto-compile feature that triggers compilation when pressing Play if code changed or no firmware loaded
- Added share functionality for projects and examples with visibility toggle
- Added component metadata overrides and enhanced property controls
- Added new CI/CD workflows for backend unit tests, end-to-end tests, and automated Discord release notifications
- Added Docker multi-architecture support (amd64 + arm64) and pre-built ESP-IDF toolchain image

### Changed
- Enhanced auto-compile to use board's file group for WiFi detection instead of legacy global files
- Updated CircuitPreview component and implemented ShareModal using createPortal
- Enhanced Arduino pin tracing in DynamicComponent and updated LittleFS WASM initialization
- Enhanced ESP-IDF compiler library resolution logic and added support for dynamic library detection
- Enhanced wire connection handling and GND checks for components
- Enhanced logging for library loading and WiFi progress
- Updated Docker build processes with optimized build contexts and multi-architecture support
- Changed WiFi SSID normalization to match QEMU access points for reliable ESP32 WiFi connection
- Refactored I2C slave tests for ESP32 with improved event handling and ACK/NACK responses

### Fixed
- Fixed container restart issue by monitoring both backend and nginx processes
- Fixed project saving to use active board files/kind and improved error messages
- Fixed ESP32 boot stability with deterministic instruction counting
- Fixed ESP32 Run button to auto-compile and recover firmware after page refresh
- Fixed LED ground check to require cathode wired to GND (or LOW GPIO) to light up
- Fixed MPU6050Slave I2C handling with improved WHO_AM_I read tracking
- Fixed ESP32 WiFi SSID/channel alignment with QEMU access_points array
- Fixed RISC-V toolchain paths for ESP32-C3 compilation
- Fixed ESP-IDF Python requirements installation in Docker
- Fixed SaveProjectModal to prevent saving to `/api/projects/none` when project ID is invalid
- Fixed ESP32 compilation by adding missing dependencies (cmake, ninja-build, git, packaging, libusb)

[2.0.1]: https://github.com/davidmonterocrespo24/velxio/releases/tag/v2.0.1

[3.0.0]: https://github.com/davidmonterocrespo24/velxio/releases/tag/v3.0.0
[3.0.1]: https://github.com/davidmonterocrespo24/velxio/releases/tag/v3.0.1
[3.0.2]: https://github.com/davidmonterocrespo24/velxio/releases/tag/v3.0.2
[3.0.3]: https://github.com/davidmonterocrespo24/velxio/releases/tag/v3.0.3
[3.0.4]: https://github.com/davidmonterocrespo24/velxio/releases/tag/v3.0.4
[3.0.5]: https://github.com/davidmonterocrespo24/velxio/releases/tag/v3.0.5