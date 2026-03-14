"""
EspLibManager — ESP32 emulation via lcgamboa libqemu-xtensa.dll.

Exposes the same public API as EspQemuManager so simulation.py can
transparently switch between the two backends:
  - DLL available  → full GPIO + ADC + UART + WiFi (this module)
  - DLL missing    → serial-only via subprocess (esp_qemu_manager.py)

Activation: set environment variable QEMU_ESP32_LIB to the DLL path.
"""
import asyncio
import logging
import os
from typing import Callable, Awaitable

from .esp32_lib_bridge import Esp32LibBridge, _DEFAULT_LIB

logger = logging.getLogger(__name__)

# Path to libqemu-xtensa.dll — env var takes priority, then auto-detect beside this module
LIB_PATH: str = os.environ.get('QEMU_ESP32_LIB', '') or (
    _DEFAULT_LIB if os.path.isfile(_DEFAULT_LIB) else ''
)

EventCallback = Callable[[str, dict], Awaitable[None]]

# lcgamboa machine names (esp32-picsimlab has the GPIO callback bridge)
_MACHINE: dict[str, str] = {
    'esp32':    'esp32-picsimlab',
    'esp32-s3': 'esp32s3-picsimlab',
    'esp32-c3': 'esp32c3-picsimlab',
}


class _InstanceState:
    """Tracks one running ESP32 instance."""
    def __init__(self, bridge: Esp32LibBridge, callback: EventCallback, board_type: str):
        self.bridge     = bridge
        self.callback   = callback
        self.board_type = board_type


class EspLibManager:
    """
    Manager for ESP32 emulation via libqemu-xtensa.dll.

    Uses Esp32LibBridge to load the lcgamboa QEMU shared library.
    GPIO, ADC, UART, and WiFi events are delivered via the callback
    function registered at start_instance().
    """

    def __init__(self):
        self._instances: dict[str, _InstanceState] = {}

    # ── Availability check ───────────────────────────────────────────────────

    @staticmethod
    def is_available() -> bool:
        """Return True if the DLL path is configured and the file exists."""
        return bool(LIB_PATH) and os.path.isfile(LIB_PATH)

    # ── Public API (mirrors EspQemuManager) ─────────────────────────────────

    def start_instance(
        self,
        client_id:    str,
        board_type:   str,
        callback:     EventCallback,
        firmware_b64: str | None = None,
    ) -> None:
        if client_id in self._instances:
            logger.warning('start_instance: %s already running', client_id)
            return

        loop = asyncio.get_event_loop()
        bridge = Esp32LibBridge(LIB_PATH, loop)

        # ── GPIO listener → emit gpio_change events ──────────────────────────
        async def _on_gpio(pin: int, state: int) -> None:
            await callback('gpio_change', {'pin': pin, 'state': state})

        # ── UART listener → accumulate bytes, emit serial_output ─────────────
        uart_buf: bytearray = bytearray()

        async def _on_uart(uart_id: int, byte_val: int) -> None:
            if uart_id == 0:
                uart_buf.append(byte_val)
                # Flush on newline or if buffer gets large
                if byte_val == ord('\n') or len(uart_buf) >= 256:
                    text = uart_buf.decode('utf-8', errors='replace')
                    uart_buf.clear()
                    await callback('serial_output', {'data': text})

        bridge.register_gpio_listener(
            lambda p, s: loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(_on_gpio(p, s), loop=loop)
            )
        )
        bridge.register_uart_listener(
            lambda i, b: loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(_on_uart(i, b), loop=loop)
            )
        )

        machine = _MACHINE.get(board_type, 'esp32-picsimlab')
        state = _InstanceState(bridge, callback, board_type)
        self._instances[client_id] = state

        asyncio.ensure_future(callback('system', {'event': 'booting'}))

        if firmware_b64:
            try:
                bridge.start(firmware_b64, machine)
                asyncio.ensure_future(callback('system', {'event': 'booted'}))
            except Exception as e:
                logger.error('start_instance %s: bridge.start failed: %s', client_id, e)
                self._instances.pop(client_id, None)
                asyncio.ensure_future(callback('error', {'message': str(e)}))
        else:
            # No firmware yet — instance registered, waiting for load_firmware()
            logger.info('start_instance %s: no firmware, waiting for load_firmware()', client_id)

    def stop_instance(self, client_id: str) -> None:
        state = self._instances.pop(client_id, None)
        if state:
            try:
                state.bridge.stop()
            except Exception as e:
                logger.warning('stop_instance %s: %s', client_id, e)

    def load_firmware(self, client_id: str, firmware_b64: str) -> None:
        """Hot-reload firmware: stop current bridge, start fresh with new firmware."""
        state = self._instances.get(client_id)
        if not state:
            logger.warning('load_firmware: no instance %s', client_id)
            return
        board_type = state.board_type
        callback   = state.callback
        self.stop_instance(client_id)

        async def _restart() -> None:
            await asyncio.sleep(0.3)
            self.start_instance(client_id, board_type, callback, firmware_b64)

        asyncio.create_task(_restart())

    def set_pin_state(self, client_id: str, pin: int | str, state: int) -> None:
        """Drive a GPIO pin from an external board (e.g. Arduino output → ESP32 input)."""
        inst = self._instances.get(client_id)
        if inst:
            inst.bridge.set_pin(int(pin), state)

    async def send_serial_bytes(self, client_id: str, data: bytes) -> None:
        """Send bytes to the ESP32 UART0 RX (user serial input)."""
        inst = self._instances.get(client_id)
        if inst:
            inst.bridge.uart_send(0, data)


esp_lib_manager = EspLibManager()
