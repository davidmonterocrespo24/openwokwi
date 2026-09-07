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
decides for a non-paid web user. The desktop sidecar (VELXIO_DESKTOP=1)
always allows — the Tauri license already gates the whole app. Default with no
overlay installed: allow.

A gate answers ``True`` (allow), ``False`` (refuse with the generic
``PRO_BOARD_MESSAGE``) or a :class:`BoardAccessDenial` carrying its own words
and a machine-readable ``code`` — a quota that ran out is refused with a
different sentence than a feature that was never free, and the client can key
a prompt on the code. ``board_allowed`` keeps the boolean view for callers
that only need to know whether to start.

This mirrors the existing ``try: from app.pro import register_pro`` extension
pattern — a generic seam any private extension could populate.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Awaitable, Callable, Optional, Union

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class BoardAccessDenial:
    """A refusal with its own words. ``code`` names the reason for machines
    (the client shows ``message`` and may key a prompt on ``code``)."""

    message: str
    code: str = 'pro_board'


# gate(websocket, board_kind) -> True to allow, False to refuse with the
# generic Pro message, or a BoardAccessDenial to refuse with specific words.
BoardAccessGate = Callable[[object, str], Awaitable[Union[bool, BoardAccessDenial]]]

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


def owner_key(websocket: object) -> "str | None":
    """Stable, opaque id for "the same person" across tabs.

    The session cookie is hashed rather than stored: this is only used to
    count concurrent guests per user, so the value never needs to be read
    back. Falls back to the client host when there is no cookie (desktop
    sidecar, tests), and to None when there is neither.

    Lives here rather than in the simulation route because the QEMU board
    lane, which enforces the per-owner guest capacity, is a pluggable
    extension and must not import the route (that would be a cycle).
    """
    import hashlib

    try:
        token = websocket.cookies.get('access_token')  # type: ignore[attr-defined]
    except Exception:
        token = None
    if token:
        return 'u:' + hashlib.sha256(token.encode()).hexdigest()[:16]
    host = getattr(getattr(websocket, 'client', None), 'host', None)
    return f'h:{host}' if host else None


def register_board_access_gate(fn: Optional[BoardAccessGate]) -> None:
    """Install the gate (pro overlay) or clear it (None)."""
    global _gate
    _gate = fn


async def board_access_denial(
    websocket: object, board_kind: str,
) -> Optional[BoardAccessDenial]:
    """Why this session may NOT start the given Pro board, or None when it
    may. No gate -> allow."""
    if _gate is None:
        return None
    try:
        verdict = await _gate(websocket, board_kind)
    except Exception as exc:  # fail-open: a gate bug must never wedge the sim
        logger.warning('board_access gate raised, allowing: %r', exc)
        return None
    if isinstance(verdict, BoardAccessDenial):
        return verdict
    if verdict:
        return None
    return BoardAccessDenial(PRO_BOARD_MESSAGE)


async def board_allowed(websocket: object, board_kind: str) -> bool:
    """True if this session may start the given Pro board. No gate -> allow."""
    return await board_access_denial(websocket, board_kind) is None
