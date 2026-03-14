"""
Esp32LibBridge — ESP32 emulation via lcgamboa QEMU shared library (libqemu-xtensa.dll).

Enables full GPIO, ADC, UART, and WiFi emulation using the PICSimLab callback bridge.

C API exposed by the library:
  qemu_init(argc, argv, envp)
  qemu_main_loop()
  qemu_cleanup()
  qemu_picsimlab_register_callbacks(callbacks_t*)
  qemu_picsimlab_set_pin(pin: int, value: int)
  qemu_picsimlab_set_apin(channel: int, value: int)
  qemu_picsimlab_uart_receive(id: int, buf: bytes, size: int)

callbacks_t struct (from hw/xtensa/esp32_picsimlab.c):
  void (*picsimlab_write_pin)(int pin, int value);
  void (*picsimlab_dir_pin)(int pin, int value);
  int  (*picsimlab_i2c_event)(uint8_t id, uint8_t addr, uint16_t event);
  uint8_t (*picsimlab_spi_event)(uint8_t id, uint16_t event);
  void (*picsimlab_uart_tx_event)(uint8_t id, uint8_t value);
  const short int *pinmap;
  void (*picsimlab_rmt_event)(uint8_t channel, uint32_t config0, uint32_t value);
"""
import asyncio
import base64
import ctypes
import logging
import os
import pathlib
import tempfile
import threading

logger = logging.getLogger(__name__)

# MinGW64 bin — Windows needs this on the DLL search path for glib2/libgcrypt deps
_MINGW64_BIN = r"C:\msys64\mingw64\bin"

# Default DLL path: same directory as this module (copied there after build)
_DEFAULT_LIB = str(pathlib.Path(__file__).parent / "libqemu-xtensa.dll")

# ── Callback function types ─────────────────────────────────────────────────
_WRITE_PIN = ctypes.CFUNCTYPE(None, ctypes.c_int, ctypes.c_int)
_DIR_PIN   = ctypes.CFUNCTYPE(None, ctypes.c_int, ctypes.c_int)
_I2C_EVENT = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_uint8, ctypes.c_uint8, ctypes.c_uint16)
_SPI_EVENT = ctypes.CFUNCTYPE(ctypes.c_uint8, ctypes.c_uint8, ctypes.c_uint16)
_UART_TX   = ctypes.CFUNCTYPE(None, ctypes.c_uint8, ctypes.c_uint8)
_RMT_EVENT = ctypes.CFUNCTYPE(None, ctypes.c_uint8, ctypes.c_uint32, ctypes.c_uint32)


class _CallbacksT(ctypes.Structure):
    _fields_ = [
        ('picsimlab_write_pin',     _WRITE_PIN),
        ('picsimlab_dir_pin',       _DIR_PIN),
        ('picsimlab_i2c_event',     _I2C_EVENT),
        ('picsimlab_spi_event',     _SPI_EVENT),
        ('picsimlab_uart_tx_event', _UART_TX),
        ('pinmap',                  ctypes.c_void_p),
        ('picsimlab_rmt_event',     _RMT_EVENT),
    ]


class Esp32LibBridge:
    """
    Wraps one libqemu-xtensa.dll instance for a single ESP32 board.

    The QEMU event loop runs in a daemon thread so it does not block asyncio.
    GPIO and UART callbacks are injected back into the asyncio event loop via
    call_soon_threadsafe(), keeping the asyncio side thread-safe.
    """

    def __init__(self, lib_path: str, loop: asyncio.AbstractEventLoop):
        # On Windows, add MinGW64/bin to DLL search path so glib2/gcrypt deps are found
        if os.name == 'nt' and os.path.isdir(_MINGW64_BIN):
            os.add_dll_directory(_MINGW64_BIN)
        self._lib:           ctypes.CDLL = ctypes.CDLL(lib_path)
        self._loop:          asyncio.AbstractEventLoop = loop
        self._thread:        threading.Thread | None = None
        self._callbacks_ref: _CallbacksT | None = None   # keep alive (GC guard)
        self._firmware_path: str | None = None
        self._gpio_listeners: list = []   # fn(pin: int, state: int)
        self._uart_listeners: list = []   # fn(uart_id: int, byte_val: int)

    # ── Listener registration ────────────────────────────────────────────────

    def register_gpio_listener(self, fn) -> None:
        self._gpio_listeners.append(fn)

    def register_uart_listener(self, fn) -> None:
        self._uart_listeners.append(fn)

    # ── Lifecycle ────────────────────────────────────────────────────────────

    def start(self, firmware_b64: str, machine: str = 'esp32-picsimlab') -> None:
        """Decode firmware, init QEMU, start event loop in daemon thread."""
        # Write firmware to temp file
        fw_bytes = base64.b64decode(firmware_b64)
        tmp = tempfile.NamedTemporaryFile(suffix='.bin', delete=False)
        tmp.write(fw_bytes)
        tmp.close()
        self._firmware_path = tmp.name

        # Build argv (bytes)
        args_bytes = [
            b'qemu',
            b'-M', machine.encode(),
            b'-nographic',
            b'-drive', f'file={self._firmware_path},if=mtd,format=raw'.encode(),
        ]
        argc = len(args_bytes)
        argv = (ctypes.c_char_p * argc)(*args_bytes)

        # Build and register callbacks BEFORE qemu_init
        cbs = _CallbacksT(
            picsimlab_write_pin     = _WRITE_PIN(self._on_pin_change),
            picsimlab_dir_pin       = _DIR_PIN(lambda _p, _v: None),
            picsimlab_i2c_event     = _I2C_EVENT(lambda *_a: 0),
            picsimlab_spi_event     = _SPI_EVENT(lambda *_a: 0),
            picsimlab_uart_tx_event = _UART_TX(self._on_uart_tx),
            pinmap                  = None,
            picsimlab_rmt_event     = _RMT_EVENT(lambda *_a: None),
        )
        self._callbacks_ref = cbs   # prevent GC while QEMU is running
        self._lib.qemu_picsimlab_register_callbacks(ctypes.byref(cbs))

        # Initialize QEMU (sets up machine, loads firmware)
        self._lib.qemu_init(argc, argv, None)

        # Run QEMU event loop in a daemon thread
        self._thread = threading.Thread(
            target=self._lib.qemu_main_loop,
            daemon=True,
            name=f'qemu-esp32-{machine}',
        )
        self._thread.start()
        logger.info('lcgamboa QEMU started: machine=%s firmware=%s', machine, self._firmware_path)

    def stop(self) -> None:
        """Terminate the QEMU instance and clean up firmware temp file."""
        try:
            self._lib.qemu_cleanup()
        except Exception as e:
            logger.debug('qemu_cleanup: %s', e)
        self._callbacks_ref = None
        if self._firmware_path and os.path.exists(self._firmware_path):
            try:
                os.unlink(self._firmware_path)
            except Exception:
                pass
            self._firmware_path = None
        logger.info('Esp32LibBridge stopped')

    # ── GPIO / ADC / UART control ────────────────────────────────────────────

    def set_pin(self, pin: int, value: int) -> None:
        """Drive a digital GPIO pin (from an external source, e.g. connected Arduino)."""
        self._lib.qemu_picsimlab_set_pin(pin, value)

    def set_adc(self, channel: int, value: int) -> None:
        """Set ADC channel (0-9). value is 12-bit raw (0-4095)."""
        self._lib.qemu_picsimlab_set_apin(channel, value)

    def uart_send(self, uart_id: int, data: bytes) -> None:
        """Send bytes to the ESP32's UART (simulated RX)."""
        buf = (ctypes.c_uint8 * len(data))(*data)
        self._lib.qemu_picsimlab_uart_receive(uart_id, buf, len(data))

    # ── Internal callbacks (called from QEMU thread) ─────────────────────────

    def _on_pin_change(self, pin: int, value: int) -> None:
        """Called by QEMU whenever the ESP32 drives a GPIO output."""
        for fn in self._gpio_listeners:
            self._loop.call_soon_threadsafe(fn, pin, value)

    def _on_uart_tx(self, uart_id: int, byte_val: int) -> None:
        """Called by QEMU for each byte the ESP32 transmits on UART."""
        for fn in self._uart_listeners:
            self._loop.call_soon_threadsafe(fn, uart_id, byte_val)
