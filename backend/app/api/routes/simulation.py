import json
import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from app.services.qemu_manager import qemu_manager
from app.services.esp_qemu_manager import esp_qemu_manager
from app.services.esp32_lib_manager import esp_lib_manager

router = APIRouter()
logger = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self):
        self.active_connections: dict[str, WebSocket] = {}

    async def connect(self, websocket: WebSocket, client_id: str):
        await websocket.accept()
        self.active_connections[client_id] = websocket

    def disconnect(self, client_id: str):
        self.active_connections.pop(client_id, None)

    async def send(self, client_id: str, message: str):
        ws = self.active_connections.get(client_id)
        if ws:
            await ws.send_text(message)


manager = ConnectionManager()


@router.websocket('/ws/{client_id}')
async def simulation_websocket(websocket: WebSocket, client_id: str):
    await manager.connect(websocket, client_id)

    async def qemu_callback(event_type: str, data: dict) -> None:
        payload = json.dumps({'type': event_type, 'data': data})
        await manager.send(client_id, payload)

    try:
        while True:
            raw = await websocket.receive_text()
            message = json.loads(raw)
            msg_type: str = message.get('type', '')
            msg_data: dict = message.get('data', {})

            if msg_type == 'start_pi':
                board = msg_data.get('board', 'raspberry-pi-3')
                qemu_manager.start_instance(client_id, board, qemu_callback)

            elif msg_type == 'stop_pi':
                qemu_manager.stop_instance(client_id)

            elif msg_type == 'serial_input':
                # bytes: list[int]  — characters typed by the user / sent by Arduino
                raw_bytes: list[int] = msg_data.get('bytes', [])
                if raw_bytes:
                    await qemu_manager.send_serial_bytes(client_id, bytes(raw_bytes))

            elif msg_type == 'gpio_in':
                # External (e.g. Arduino) drives a Pi GPIO pin
                pin   = msg_data.get('pin', 0)
                state = msg_data.get('state', 0)
                qemu_manager.set_pin_state(client_id, pin, state)

            elif msg_type == 'pin_change':
                # Legacy alias for gpio_in
                pin   = msg_data.get('pin', 0)
                state = msg_data.get('state', 0)
                qemu_manager.set_pin_state(client_id, pin, state)

            # ── ESP32 messages ──────────────────────────────────────────────
            elif msg_type == 'start_esp32':
                board = msg_data.get('board', 'esp32')
                firmware_b64 = msg_data.get('firmware_b64')
                if esp_lib_manager.is_available():
                    esp_lib_manager.start_instance(client_id, board, qemu_callback, firmware_b64)
                else:
                    esp_qemu_manager.start_instance(client_id, board, qemu_callback, firmware_b64)

            elif msg_type == 'stop_esp32':
                esp_lib_manager.stop_instance(client_id)
                esp_qemu_manager.stop_instance(client_id)

            elif msg_type == 'load_firmware':
                firmware_b64 = msg_data.get('firmware_b64', '')
                if firmware_b64:
                    if esp_lib_manager.is_available():
                        esp_lib_manager.load_firmware(client_id, firmware_b64)
                    else:
                        esp_qemu_manager.load_firmware(client_id, firmware_b64)

            elif msg_type == 'esp32_serial_input':
                raw_bytes: list[int] = msg_data.get('bytes', [])
                if raw_bytes:
                    if esp_lib_manager.is_available():
                        await esp_lib_manager.send_serial_bytes(client_id, bytes(raw_bytes))
                    else:
                        await esp_qemu_manager.send_serial_bytes(client_id, bytes(raw_bytes))

            elif msg_type == 'esp32_gpio_in':
                pin   = msg_data.get('pin', 0)
                state = msg_data.get('state', 0)
                if esp_lib_manager.is_available():
                    esp_lib_manager.set_pin_state(client_id, pin, state)
                else:
                    esp_qemu_manager.set_pin_state(client_id, pin, state)

    except WebSocketDisconnect:
        manager.disconnect(client_id)
        qemu_manager.stop_instance(client_id)
        esp_lib_manager.stop_instance(client_id)
        esp_qemu_manager.stop_instance(client_id)
    except Exception as e:
        logger.error('WebSocket error for %s: %s', client_id, e)
        manager.disconnect(client_id)
        qemu_manager.stop_instance(client_id)
        esp_lib_manager.stop_instance(client_id)
        esp_qemu_manager.stop_instance(client_id)
