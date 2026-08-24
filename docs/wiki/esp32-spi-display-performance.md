# ESP32 QEMU display performance — the SPI latency bottleneck

> How the ESP32 Doom / ILI9341 raycaster went from **~0.04 FPS** (one full
> 320×240 redraw every ~25 s) to **~1 FPS (≈20–37×)** by collapsing the
> per-event SPI **C→Python ctypes crossings**, plus a full record of what was
> tried, what failed, and why — so nobody re-runs the dead ends.
>
> Bottom line: ESP32 display slowness in Velxio is **not** the QEMU TCG compute,
> **not** the libqemu `-O` level, **not** the backend→frontend WebSocket
> transport, and **not** the arduino-esp32 core version. It is the **number of
> times QEMU calls back into the Python worker per SPI event** (one per byte,
> plus one per chip-select toggle). Reduce that count and the emulation speeds
> up almost linearly.

Measured 2026-06 with the chrome-devtools MCP + py-spy on the live `esp32-doom`
example (Velxio frontend + backend from this repo). All FPS numbers are
**wall-clock game FPS** = `spi_batch bytes received / 153600` (320×240×16bpp =
one full ILI9341 frame) over a fixed 25–30 s steady-state window.

---

## Table of Contents

1. [The pipeline (where the bytes go)](#1-the-pipeline)
2. [Symptom and measurement method](#2-symptom-and-measurement)
3. [Dead ends — what we ruled out and why](#3-dead-ends)
4. [The real bottleneck — per-event C→Python crossings](#4-the-real-bottleneck)
5. [Fix #1 — batch SPI data in C (≈5×)](#5-fix-1-batch-spi-data)
6. [Fix #2 — gate the chip-select crossings (≈6× more)](#6-fix-2-gate-cs)
7. [Results](#7-results)
8. [Things that must NOT be done](#8-do-not)
9. [Remaining headroom](#9-remaining-headroom)
10. [Build & test playbook](#10-build-and-test-playbook)
11. [Key files and symbols](#11-key-files)
12. [Open issues / regression notes](#12-open-issues)

---

## 1. The pipeline

The ESP32 family runs inside the forked `qemu-lcgamboa` (loaded as
`libqemu-xtensa.dll` / `.so` via ctypes from `esp32_worker.py`, a per-sim
subprocess). A TFT redraw flows like this:

```
guest firmware (Adafruit_ILI9341 over hardware VSPI)
  └─ writes the SPI peripheral FIFO / data register
       └─ esp32_spi.c  (the SPI controller model)
            └─ ssi_transfer() per byte  ── SSI bus ──► PICSIMLAB_SPI_transfer()
                 └─ picsimlab_spi_event(id, byte<<8)         ← C function pointer
                      └─ ctypes/libffi trampoline ──► Python _on_spi_event()
                           └─ buffer the byte; flush as a base64 `spi_batch`
                                └─ WebSocket ──► frontend ILI9341 decoder ──► canvas
```

A full 320×240×16bpp frame is **153,600 bytes**. The crucial fact: every one of
those bytes was crossing the **C→Python boundary** (a libffi closure call into
the worker), **153k times per frame**. On top of that, the SPI peripheral
toggles **chip-select** around each transaction, and each CS toggle was *also*
a separate C→Python crossing (`spi_cs_irq_handler` → `picsimlab_spi_event(..|0x01)`).

The frontend ILI9341 decoder (`frontend/src/simulation/parts/ComplexParts.ts`)
needs the **DC pin** (command vs data) interleaved with the byte stream; DC
arrives as a separate `gpio_change` WebSocket message. Keeping the byte stream
and the DC stream correctly ordered on the single WS channel is what makes the
flush timing load-bearing (see §8).

---

## 2. Symptom and measurement

**Symptom:** the `esp32-doom` raycaster (a deliberate full-screen-redraw
benchmark) painted a frame column-by-column over ~25 s — visually ~0.04 FPS.
The user perceives "muy lento".

**Method (reproducible):**

- Front + back running locally; load `/example/esp32-doom`, click **Run**.
- In the page, wrap `CanvasRenderingContext2D.prototype.putImageData` to count
  blits, and wrap `window.WebSocket` to tally message types and sum `spi_batch`
  base64 payload bytes.
- **wall-clock game FPS** = `Δ(spi_batch bytes) / 153600 / Δt`. This is robust
  because the Doom redraws the whole screen every frame, so bytes-per-frame is
  constant regardless of the frontend's flush coalescing.
- For where-the-time-goes: `py-spy record --native --pid <worker>` (the worker
  is `python … esp32_worker.py`), plus temporary `fprintf(stderr,…)` /
  `_log()` counters in the C and Python hot paths.

**lcgamboa singleton gotcha:** the ctypes-loaded libqemu keeps process-global
state and `qemu_init` is one-shot. Running the sim **twice in one backend
process** corrupts the SPI peripheral (CS events stop firing → black screen).
To measure honestly: deploy the DLL → **restart the backend** (fresh process) →
**reload the page** → **Run once** → read the FPS. Never trust results after
repeated Run/Stop cycling in one backend lifetime.

---

## 3. Dead ends

Three plausible hypotheses were each implemented, measured, and **gave zero
gain**. Documented here so they are not retried.

### 3.1 "The synchronous `_emit` blocks QEMU on the stdout pipe" → no gain

`_emit` does `sys.stdout.write(json.dumps(obj)); flush()` under a lock, on the
QEMU thread. Hypothesis: a full pipe stalls `qemu_main_loop()` inside `flush()`
(the rebind note in `esp32_worker.py::main()` worries about exactly this for
UART). Fix tried: rewrite `_emit` to enqueue onto a `queue.Queue` drained by a
single writer thread, so producers never touch stdout.

**Result: 0.040 → 0.039 FPS. Nothing.** The frontend drains the pipe fast
enough that it never fills, so the flush never actually blocked. Re-tested again
*after* the batching fixes (when event rates were higher): still nothing — the
JSON/stdout work was never the bottleneck. **Reverted.**

### 3.2 "The shipped libqemu is a debug `-O0` build" → no gain

True observation: both build scripts pass `--enable-debug`
(`build_libqemu-esp32.sh:20`, `build_libqemu-esp32-win.sh:52`), which in this
QEMU (`configure:770-775`) forces `-Doptimization=0` **and** `CONFIG_DEBUG_TCG`.
So the shipped DLL is an unoptimized build of the emulator runtime. Fix tried:
rebuild release — drop `--enable-debug`, keep `--enable-debug-info`, add
`--disable-qom-cast-debug`. Verified the result: **1515 objects at `-O2`, zero
`-O0`, no `CONFIG_DEBUG_TCG`**, correct 58.6 MB DLL loaded by the worker, worker
CPU-bound at ~1.5 cores.

**Result: 0.040 → 0.041 FPS. Nothing.** Why: the time is **not in libqemu's C**.
It is in the `python312.dll` / `_ctypes.pyd` / `libffi-8.dll` boundary (see §4),
which `-O2` on libqemu cannot touch. The guest raycaster runs as TCG-JITted host
code whose speed is set by TCG's code generator, also independent of the `-O`
level. **Reverted to the pristine debug DLL** before the real fix.

> Lesson: a CPU-bound worker that does **not** speed up under `-O2` is a strong
> signal the cost is in the ctypes/Python layer, not in the emulator's C.

### 3.3 "Kill the CS storm by suppressing the per-CS flush" → BREAKS rendering

Early attempt: stop flushing the SPI byte buffer on every CS toggle and stop
emitting the CS `spi_event`. **This produced random pixels / no walls** — the
"cosas aleatorias" symptom. Reason: the per-CS flush was **load-bearing for
ordering**. The frontend decoder keys command-vs-data off the DC `gpio_change`
interleaved with the byte stream; flushing per transaction is what kept the two
streams correctly ordered. Lumping bytes from many DC phases into one batch that
lands after several DC toggles decodes as garbage. **The correct fix (§6) keeps
ordering by moving the flush to DC changes — it does not just delete it.**

---

## 4. The real bottleneck

`py-spy --native` on the worker during a Doom run (release build, with symbols):

| Frame (inclusive) | Share |
|---|---|
| `ffi_call_go` / `ffi_prep_go_closure` (libffi — the ctypes crossing) | **~62%** |
| `ssi_transfer` (libqemu — the per-byte SSI transfer) | ~23% |
| `_emit` → `json.dumps` → cp1252 encode | ~12% |
| guest TCG code (anonymous JIT addresses) + softmmu `helper_st*_mmu` | ~21% |

Read past the skew (py-spy fell behind on the heavy native unwind): the dominant
**non-libqemu** cost is the **C→Python boundary**, reached once per SPI byte and
once per CS toggle. Temporary counters confirmed the volume directly: **~150k
per-byte `_on_spi_event` calls per frame**, plus **~9,300 CS `spi_event`/s**.

That reconciles every dead end:
- `-O2` didn't help → the cost is in python/ctypes/libffi, not libqemu's C.
- async `_emit` didn't help → it offloads the *emit*, not the *crossing count*.
- The only lever that moves the needle is **reducing how many times QEMU calls
  into Python.**

---

## 5. Fix #1 — batch SPI data

**Idea:** the SPI controller already has the whole transfer buffer in C *before*
it loops `ssi_transfer` per byte. Hand the whole write-only buffer to Python in
**one** call instead of one libffi crossing per byte.

**C side (`hw/xtensa/esp32_picsimlab.c`):** a new callback, appended as the last
field of `callbacks_t` and registered opt-in (same "only if non-NULL" pattern as
`gpio_matrix_cb`, so older workers see no change):

```c
void (*picsimlab_spi_event_batch)(const uint8_t id, const uint8_t *mosi, const int len);
```

**C side (`hw/ssi/esp32_spi.c::esp32_spi_txrx_buffer`):** before the per-byte
loop, take the fast path when the transfer is write-dominant and the bus
peripheral is the host shim:

```c
if (rx_bytes <= 1 && tx_bytes > 1 && picsimlab_spi_event_batch) {
    BusState *b = BUS(s->spi);
    BusChild *ch = b ? QTAILQ_FIRST(&b->children) : NULL;
    if (ch && object_dynamic_cast(OBJECT(ch->child), "picsimlab_spi")) {
        picsimlab_spi_event_batch(0, (const uint8_t *) buf, tx_bytes);
        if (rx_bytes >= 1) ((uint8_t *) buf)[0] = 0xFF;  /* dummy MISO, ignored */
        return;
    }
}
```

The same batching is applied to the write-only **DMA** data loops in
`esp32_spi_do_command` (gated on `addr_in == 0`).

**Worker side (`esp32_worker.py`):** `_on_spi_batch(bus_id, mosi_ptr, length)`
reads the buffer with `ctypes.string_at` and replays the per-byte side effects
in bulk — custom-chip routing, then ePaper feed, then the `spi_batch` buffer.
Registered as a new `_SPI_BATCH` `CFUNCTYPE` appended to `_CallbacksT` (same
field order as `callbacks_t`).

### The gate detail that cost ~6 rebuilds

The first version gated on `rx_bytes == 0` and **never fired** — counters showed
the batch path at 0 while the per-byte path ran 150k×/frame. The reason, found
by printing `object_get_typename` + rx/tx inside `esp32_spi_txrx_buffer`:

```
[DBG-TXRX] rx=1 tx=64 child=picsimlab_spi
```

The Doom's pixel writes arrive as **`tx=64, rx=1`**, not `rx=0`. The Adafruit /
arduino-esp32 SPI driver enables MISO with `miso_dlen=0`, which
`bitlen_to_bytes(0)` turns into **one dummy status byte** the driver ignores. So
the gate must be `rx_bytes <= 1` and write a dummy `0xFF` back for that one byte.
Also confirmed by elimination: the Doom uses the `use_cs=true` path
(`esp32_picsimlab.c:696-697`), **not** DMA (`[DBG-C]` never fired) and **not**
`xfer_32_bits` (commented out at `esp32_picsimlab.c:694-695`); and the
`object_dynamic_cast("picsimlab_spi")` always passed — the cast was never the
blocker, `rx==0` was.

### Safety

- `rx_bytes <= 1` write-only only → the guest isn't reading real MISO, so the
  dummy `0xFF` is correct for displays. Genuine reads (`rx_bytes > 1`) take the
  per-byte path untouched.
- `object_dynamic_cast(…, "picsimlab_spi")` → the **SPI flash** (a `w25x16` /
  `gd25q*` model on SPI1, `esp32_picsimlab.c:1042-1063`) and any real on-bus
  device keep the per-byte path. The host shim lives only on SPI2/SPI3
  (`esp32_picsimlab.c:795-796`).

**Result: 0.04 → ~0.19 FPS (≈5×), render correct.**

---

## 6. Fix #2 — gate the chip-select crossings

After data batching, the next per-event crossing was **CS toggles** at ~9,300/s.
Each Adafruit hardware-SPI transfer toggles the peripheral CS, firing
`spi_cs_irq_handler` → `picsimlab_spi_event(…|0x01)` — another C→Python crossing
that the ILI9341 frontend decoder **does not even use** (it tracks DC, not CS).

**C side (`hw/xtensa/esp32_picsimlab.c`):**

```c
int picsimlab_spi_cs_events = 1;          /* default ON = old behaviour */

static void spi_cs_irq_handler(void *opaque, int n, int level) {
    if (picsimlab_spi_cs_events)
        picsimlab_spi_event(n >> 2, ((((n & 3)<<1)|level)<<8)|0x01);
}

void qemu_picsimlab_enable_spi_cs_events(int enabled) {
    picsimlab_spi_cs_events = enabled ? 1 : 0;
}
```

**Worker side (`esp32_worker.py`):**

- `_sync_cs_events()` turns CS events **OFF for pure-display sims** and **ON when
  an ePaper / custom-chip SPI slave is registered** (`_epaper_state` or
  `_chip_spi_runtimes` non-empty). Called after `'booted'` and at every slave
  registration. No-op on older libqemu (the symbol is absent → `AttributeError`
  caught).
- Because CS no longer signals transaction boundaries, the SPI-batch **flush
  ordering moves into `_on_pin_change`**: flush `_spi_byte_buf` *before* emitting
  any `gpio_change`. Since DC is a `gpio_change`, the byte stream stays correctly
  ordered against the DC pin (this replaces what the per-CS flush used to do —
  it does not delete ordering, see §3.3 / §8).

**Default-ON + worker-opt-out** is deliberate: an old worker or any sim with a CS
consumer sees the original behaviour; only pure-display sims pay nothing for CS.

**Result: 0.19 → ~1.0–1.5 FPS (≈26–37× over baseline), render correct,
`spi_event` rate → 0 for the Doom.**

---

## 7. Results

| Stage | Wall-clock FPS | vs baseline | Notes |
|---|---|---|---|
| Baseline (shipped debug DLL) | 0.040 | 1× | ~6 KB/s pixels, 1 frame / 25 s |
| `-O2` release rebuild | 0.041 | 1× | no gain (§3.2) |
| async `_emit` | 0.039 | 1× | no gain (§3.1) |
| **+ SPI data batching** | ~0.19 | **~5×** | §5 |
| **+ CS crossing gating** | **~1.0–1.5** | **~26–37×** | §6 |

Render verified correct each time by sampling the `wokwi-ili9341` canvas (≥97%
non-black, coherent ceiling/wall/floor scene). At the final state the frontend
blits ~10 `putImageData`/s — the display is visibly moving, not painting over
25 s. (FPS varies 22–37× run-to-run with the auto-demo's wall-following load.)

---

## 8. Things that must NOT be done

- **Do not suppress the per-transaction SPI flush without moving it.** The
  frontend ILI9341 decoder interleaves the DC `gpio_change` with the SPI byte
  stream; some flush trigger must keep them ordered. Fix #2 moves it to
  `_on_pin_change` (before each `gpio_change`). Deleting it → random pixels.
- **Do not chase `-O2` / `--disable-qom-cast-debug` / LTO for display FPS.**
  Measured zero gain — the cost is the ctypes boundary, not libqemu's C. (`-O2`
  is still a reasonable general build choice, just not the lever here.)
- **Do not re-add async `_emit` expecting FPS** — measured zero, twice.
- **Do not bump to arduino-esp32 v3.x for FPS.** Irrelevant to this bottleneck,
  and blocked anyway by the IDF-5 cache-disable panic under lcgamboa + the
  IDF-4.4.x-matched QEMU ROM blobs (see `esp32-cache-disable-runtime-crash.md`).
- **Do not measure after repeated Run/Stop in one backend** (lcgamboa singleton,
  §2) — you'll get a black screen and a false negative.

---

## 9. Remaining headroom

After CS gating, the next per-event cost is the **DC pin `gpio_change`**
(~5.6k/s). This **cannot be gated** — the frontend decoder needs DC to tell
command from data. Going further would require a different approach:

- **Encode DC state into the SPI byte stream** so DC stops being a separate
  per-toggle crossing/message (fold a command/data marker into `spi_batch`).
- **Decode the ILI9341 in the worker** and ship a framebuffer / dirty-rect (like
  ePaper `esp32_spi_slaves.py` and the I2C `I2CWriteSink` already do). Cuts WS +
  frontend cost and removes the DC dependency, but is a larger change.
- **Reduce guest work in the sketch** (lower resolution / framerate) — cheapest,
  but changes the example, not the emulator.

Diminishing returns; ~30× already makes a full-screen software raycaster usable.

---

## 10. Build & test playbook

Building `libqemu-xtensa.dll` on the Windows dev box (MSYS2 MINGW64):

- **QEMU `configure:174` rejects paths with spaces** — the repo path
  `…\velxio release\…` fails. Build through a **space-free junction**:
  `mklink /J C:\qf "E:\…\third-party\qemu-lcgamboa"`, then build from `/c/qf`.
- **Full build:** `./configure --target-list=xtensa-softmmu,riscv32-softmmu …`
  (see `build_libqemu-esp32-win.sh`) + `ninja -C build qemu-system-xtensa.exe
  qemu-system-riscv32.exe`, then re-link as a DLL via the `.rsp` patch. ~20 min /
  1570 objects.
- **`0xC0000142` (`STATUS_DLL_INIT_FAILED`) on `cc` right after a reboot** is a
  transient resource issue from too many parallel compilers — retry with `-j4`.
- **Incremental rebuild** (one `.c` changed): do **not** `rm -rf build`; just
  `ninja -C build qemu-system-xtensa.exe` + relink — ~2–3 min.
- **Deploy:** copy `build/libqemu-xtensa.dll` to `backend/app/services/`. The
  worker loads it fresh per Run; restart the backend to be safe.
- **MinGW DLL deps:** the DLL needs `C:\msys64\mingw64\bin` on the loader path
  (glib, libgcc_s_seh, libffi, pixman, gcrypt, slirp…). The running backend
  resolves these already; a bare `ctypes.CDLL` test needs
  `os.add_dll_directory(r'C:\msys64\mingw64\bin')`.

The Linux/CI build (`build_libqemu-esp32.sh`, whose output is collected from the
workflow artifact and uploaded to velxio.dev) needs the same source change; bump
the prebuilt DLLs there to ship the fix.

---

## 11. Key files and symbols

| File | Role |
|---|---|
| `third-party/qemu-lcgamboa/hw/ssi/esp32_spi.c` | SPI controller; `esp32_spi_txrx_buffer` + DMA loops carry the batch fast path |
| `third-party/qemu-lcgamboa/hw/ssi/picsimlab_spi.c` | `PICSIMLAB_SPI_transfer` → `picsimlab_spi_event` (the old per-byte crossing) |
| `third-party/qemu-lcgamboa/hw/xtensa/esp32_picsimlab.c` | `callbacks_t`, `picsimlab_spi_event_batch`, `spi_cs_irq_handler`, `picsimlab_spi_cs_events`, `qemu_picsimlab_enable_spi_cs_events` |
| `backend/app/services/esp32_worker.py` | `_on_spi_event` (per-byte), `_on_spi_batch` (bulk), `_on_pin_change` (DC flush), `_sync_cs_events`, `_CallbacksT` / `_SPI_BATCH` |
| `backend/app/services/esp32_spi_slaves.py` | worker-side ePaper SSD168x decoder (the framebuffer model worth copying for ILI9341) |
| `frontend/src/simulation/parts/ComplexParts.ts` | frontend ILI9341 decoder (DC-keyed, consumes `spi_batch` + `gpio_change`) |
| `build_libqemu-esp32-win.sh` / `build_libqemu-esp32.sh` | the build scripts |

---

## 12. Open issues / regression notes

- **rx=1 dummy MISO (narrow):** the batch path returns `0xFF` for the one dummy
  MISO byte. Correct for write-only displays and ePaper. A custom SPI chip doing
  a `tx>1, rx=1` *read* would get `0xFF` instead of its real MISO byte (the
  worker still feeds it the data — only the one echoed byte differs). Tighten
  before shipping if any custom chip relies on that pattern.
- **CS opt-in coverage:** `_sync_cs_events()` is called at the current ePaper /
  custom-chip registration sites + after `'booted'`. If new high-dynamic SPI
  slave paths are added, call it there too (it's idempotent).
- **ePaper `epaper-2in9-esp32-weather` renders blank — PRE-EXISTING, unrelated.**
  Verified by testing the pristine shipped DLL **and** `git HEAD` worker: the
  `velxio-epaper` panel is 100% white before any of this work too. `epaper_update`
  fires once but no content is written. Separate bug (likely the SSD168x decoder
  vs the panel's actual controller, or the sketch's CS handling) — not caused by
  the SPI batching / CS gating here.
