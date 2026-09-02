"""
Pro board-access gate — server-side enforcement seam.

STM32 and the QEMU-backed Raspberry Pi boards are Pro-only on velxio.dev. The
frontend gate (picker add + run) is the UX layer; this is the server-side
enforcement for the WebSocket simulation start, because on velxio.dev the QEMU
binary is present for every session, so the frontend gate alone is bypassable.

OSS / self-hosted has no binary at all (the start fails with a Pro-framed
message regardless), so this gate is a no-op there.

The pro overlay calls ``register_board_access_gate()`` from ``register_pro()``
with an implementation that resolves the user from the WebSocket cookies and
returns False for a non-paid web user. The desktop sidecar (VELXIO_DESKTOP=1)
always allows — the Tauri license already gates the whole app. Default with no
overlay installed: allow.

This mirrors the existing ``try: from app.pro import register_pro`` extension
pattern — a generic seam any private extension could populate.
"""
from __future__ import annotations

import logging
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

# gate(websocket, board_kind) -> True to allow, False to block (Pro-gated).
BoardAccessGate = Callable[[object, str], Awaitable[bool]]

_gate: Optional[BoardAccessGate] = None

# Deliberately names the families, not one board: the QEMU-Linux lane also
# carries boards that are not Raspberry Pis (the UNIHIKER M10 boots through
# the same bridge), and telling their user that "Raspberry Pi emulation" is
# gated is a message about a board they did not place.
PRO_BOARD_MESSAGE = (
    'STM32 and QEMU-emulated Linux boards (Raspberry Pi, UNIHIKER) are '
    'Velxio Pro features. Use them on velxio.dev with a paid plan, or '
    'install Velxio Desktop.'
)


def register_board_access_gate(fn: Optional[BoardAccessGate]) -> None:
    """Install the gate (pro overlay) or clear it (None)."""
    global _gate
    _gate = fn


async def board_allowed(websocket: object, board_kind: str) -> bool:
    """True if this session may start the given Pro board. No gate -> allow."""
    if _gate is None:
        return True
    try:
        return await _gate(websocket, board_kind)
    except Exception as exc:  # fail-open: a gate bug must never wedge the sim
        logger.warning('board_access gate raised, allowing: %r', exc)
        return True
