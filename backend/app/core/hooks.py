"""
Extension hooks for the velxio backend.

Routes that stay in OSS (compile, libraries, simulation, iot_gateway) used to
import directly from `app.core.dependencies`, `app.database.session`,
`app.models.*` and `app.services.metrics`. That made the OSS image impossible
to ship without the auth/DB stack — deleting any of those modules would
crash the route layer at import time.

This module is the seam. OSS routes import only from here. Each hook is a
no-op by default; a private overlay (e.g. velxio-prod's `app.pro`) calls the
`register_*` setter inside its own `register_pro(app)` to plug in a real
implementation. When the overlay is absent, the routes still load and the
hooks just return None / yield no events.

Adding a new extension point: define a Protocol/Callable type, a module-level
slot, a `register_*` setter, and a public callable that invokes the slot if
present. Do NOT import from `app.database`, `app.models`, or `app.services` here.
"""
from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable, Optional

from fastapi import Request, Response

logger = logging.getLogger(__name__)


# ── record_compile ───────────────────────────────────────────────────────────
# Fires once per compile attempt. Overlay implementations own their own DB
# session and decide what to persist. The compile route only knows about
# metadata (user_id, project_id, board fqbn, timing, error classification).

RecordCompileHook = Callable[
    ...,  # accepts the kwargs below; using ... avoids over-constraining overlays
    Awaitable[None],
]

_record_compile_hook: Optional[RecordCompileHook] = None


def register_record_compile(hook: RecordCompileHook) -> None:
    """Install the compile-metric recorder. Called by overlays in register_pro."""
    global _record_compile_hook
    _record_compile_hook = hook


async def record_compile(
    *,
    user_id: Optional[str],
    project_id: Optional[str],
    board_fqbn: str,
    success: bool,
    duration_ms: int,
    error_kind: Optional[str],
    extra: dict,
    request: Any = None,
) -> None:
    """Record a compile event. No-op when no overlay is loaded."""
    if _record_compile_hook is None:
        return
    try:
        await _record_compile_hook(
            user_id=user_id,
            project_id=project_id,
            board_fqbn=board_fqbn,
            success=success,
            duration_ms=duration_ms,
            error_kind=error_kind,
            extra=extra,
            request=request,
        )
    except Exception:
        # A failing metric must never break the compile response.
        logger.exception("record_compile hook failed (swallowed)")


# ── get_current_user_id ───────────────────────────────────────────────────────
# FastAPI dependency: resolves the current user's id from the request (typically
# by decoding a JWT cookie). Returns None for anonymous requests OR when no auth
# overlay is loaded. Routes that need an id but accept anonymous use the
# returned value directly; routes that require auth wrap with require_auth_hook.

GetCurrentUserIdHook = Callable[[Any], Awaitable[Optional[str]]]

_get_current_user_id_hook: Optional[GetCurrentUserIdHook] = None


def register_get_current_user_id(hook: GetCurrentUserIdHook) -> None:
    """Install the auth resolver. Called by overlays in register_pro."""
    global _get_current_user_id_hook
    _get_current_user_id_hook = hook


async def get_current_user_id(request: Request) -> Optional[str]:  # FastAPI dependency
    if _get_current_user_id_hook is None:
        return None
    try:
        return await _get_current_user_id_hook(request)
    except Exception:
        logger.exception("get_current_user_id hook failed (treating as anonymous)")
        return None


# ── get_project_libraries ─────────────────────────────────────────────────────
# Returns the declared library manifest (list of library names) SAVED with a
# project. The ESP-IDF compiler uses it as the resolution SCOPE so a project
# only merges its own declared libraries — never another user's, or another
# project's, stray install in the shared library dir. Sourced authoritatively
# from the project record (not the client), so it is robust regardless of what
# the frontend sends. Returns None for an unknown project, an empty manifest,
# or when no overlay is loaded (→ legacy scan-all).

GetProjectLibrariesHook = Callable[[str], Awaitable[Optional[list[str]]]]

_get_project_libraries_hook: Optional[GetProjectLibrariesHook] = None


def register_get_project_libraries(hook: GetProjectLibrariesHook) -> None:
    """Install the project-manifest resolver. Called by overlays in register_pro."""
    global _get_project_libraries_hook
    _get_project_libraries_hook = hook


async def get_project_libraries(project_id: Optional[str]) -> Optional[list[str]]:
    if _get_project_libraries_hook is None or not project_id:
        return None
    try:
        return await _get_project_libraries_hook(project_id)
    except Exception:
        logger.exception("get_project_libraries hook failed (treating as no manifest)")
        return None


# ── materialize_library_scope ─────────────────────────────────────────────────
# Given a compile's library manifest (the per-board allowed set), materialize a
# per-compile libraries directory the ESP-IDF resolver reads from — instead of
# the single shared global libraries volume. The overlay symlinks each declared
# library from the content-addressed cache (or, while the global volume is being
# retired, the legacy dir as a fallback) into a throwaway dir and returns
# (libraries_dir, content_token). The compiler folds the token into its build-
# variant hash (so a content change resets the build cache) and removes the dir
# after the attempt. Returns None when no overlay is loaded OR the manifest is
# empty -> the compiler uses its single default libraries dir (OSS self-host
# parity / scan-all). SYNC — pure filesystem (symlink creation).

# `owner_id` is the project OWNER's id (NOT the requester's): a shared / embed /
# anonymous compile of someone else's project must resolve THAT user's custom
# (per-user-store) libraries. The overlay treats it as an opaque key; the OSS
# compiler only threads it through. None for unsaved/anon-no-project compiles.
MaterializeLibraryScopeHook = Callable[[set, Optional[str]], Optional[tuple]]

_materialize_library_scope_hook: Optional[MaterializeLibraryScopeHook] = None


def register_materialize_library_scope(hook: MaterializeLibraryScopeHook) -> None:
    """Install the per-compile library-scope materializer. Called in register_pro."""
    global _materialize_library_scope_hook
    _materialize_library_scope_hook = hook


def materialize_library_scope(
    allowed_libraries: Optional[set], owner_id: Optional[str] = None
) -> Optional[tuple]:
    """Return (libraries_dir, content_token) for the manifest, or None to use the
    compiler's default single libraries dir. Never raises (a failing materializer
    degrades to the default dir)."""
    if _materialize_library_scope_hook is None or not allowed_libraries:
        return None
    try:
        return _materialize_library_scope_hook(allowed_libraries, owner_id)
    except Exception:
        logger.exception("materialize_library_scope hook failed (using default libraries dir)")
        return None


# ── resolve_compile_owner ─────────────────────────────────────────────────────
# Resolve WHOSE per-user custom libraries a compile may resolve for a project —
# applying a VISIBILITY gate. A compile of a saved project resolves the OWNER's
# custom libraries (so a shared / embed compile of someone's PUBLIC project still
# finds that owner's uploaded libs), but a requester must NOT be able to pull
# another user's PRIVATE custom libraries by supplying that user's project_id.
# The overlay returns the project owner ONLY when the requester IS the owner OR
# the project is shareable (public / unlisted); otherwise None, and the caller
# falls back to the requester's OWN store. `requester_id` is the authenticated
# caller (None for anon). Returns None for an unknown project or no overlay.

ResolveCompileOwnerHook = Callable[[str, Optional[str]], Awaitable[Optional[str]]]

_resolve_compile_owner_hook: Optional[ResolveCompileOwnerHook] = None


def register_resolve_compile_owner(hook: ResolveCompileOwnerHook) -> None:
    """Install the visibility-gated compile-owner resolver. Called in register_pro."""
    global _resolve_compile_owner_hook
    _resolve_compile_owner_hook = hook


async def resolve_compile_owner(
    project_id: Optional[str], requester_id: Optional[str]
) -> Optional[str]:
    if _resolve_compile_owner_hook is None or not project_id:
        return None
    try:
        return await _resolve_compile_owner_hook(project_id, requester_id)
    except Exception:
        # Fail closed: on any error resolve no foreign owner (caller falls back
        # to the requester's own store), never leak another user's libraries.
        logger.exception("resolve_compile_owner hook failed (treating as requester-only)")
        return None


# ── warm_library ──────────────────────────────────────────────────────────────
# "Install" an index library by WARMING the shared content-addressed cache
# (install into a throwaway sketchbook -> publish to the cache) instead of
# mutating the single shared global libraries volume — so the global dir stops
# growing and can be retired. `requester_id` enforces the anon policy (an
# anonymous user may only use libraries already referenced by an example/project,
# i.e. already cached; warming a fresh uncached lib requires sign-in). Returns a
# result dict ({success, error?, ...}) or None when no overlay is loaded -> the
# OSS route falls back to its legacy arduino-cli global install (self-host parity).

WarmLibraryHook = Callable[..., Awaitable[Optional[dict]]]

_warm_library_hook: Optional[WarmLibraryHook] = None


def register_warm_library(hook: WarmLibraryHook) -> None:
    """Install the cache-warm library installer. Called by overlays in register_pro."""
    global _warm_library_hook
    _warm_library_hook = hook


async def warm_library(
    name: str, version: Optional[str] = None, requester_id: Optional[str] = None
) -> Optional[dict]:
    """Warm an index library into the shared cache. None -> no overlay (the OSS
    route does its legacy global install). Never raises."""
    if _warm_library_hook is None:
        return None
    try:
        return await _warm_library_hook(name=name, version=version, requester_id=requester_id)
    except Exception:
        logger.exception("warm_library hook failed")
        return {"success": False, "error": "Library install failed."}


# ── lifespan startup ──────────────────────────────────────────────────────────
# Overlays that need to run async setup during FastAPI lifespan (DB init,
# table creation, legacy column migrations, etc.) register a coroutine here.
# main.py invokes run_lifespan_startup() once during lifespan; if no overlay
# registered anything, nothing happens.

LifespanStartupHook = Callable[[], Awaitable[None]]

_lifespan_startup_hooks: list[LifespanStartupHook] = []


def register_lifespan_startup(hook: LifespanStartupHook) -> None:
    """Queue a coroutine to run during FastAPI lifespan startup."""
    _lifespan_startup_hooks.append(hook)


async def run_lifespan_startup() -> None:
    """Invoked once by main.py's lifespan. Runs hooks in registration order;
    a failing hook is logged but does not abort the others."""
    for hook in _lifespan_startup_hooks:
        try:
            await hook()
        except Exception:
            logger.exception("lifespan startup hook %r failed (swallowed)", hook)


# ── iot_gateway_gate ──────────────────────────────────────────────────────────
# Decides whether a given request may use the private IoT gateway proxy.
# OSS-default: allow everyone (the gateway is a free feature in the open
# image). A private overlay (velxio-prod) registers a real implementation
# that gates it to paid plans + grandfathered users. Returns None to allow,
# or a `detail` dict that the route turns into a 402 response when blocking.

IotGatewayGateHook = Callable[[Request], Awaitable[Optional[dict]]]

_iot_gateway_gate_hook: Optional[IotGatewayGateHook] = None


def register_iot_gateway_gate(hook: IotGatewayGateHook) -> None:
    """Install the IoT-gateway gate. Called by overlays in register_pro."""
    global _iot_gateway_gate_hook
    _iot_gateway_gate_hook = hook


async def iot_gateway_gate(request: Request) -> Optional[dict]:
    """Return None to allow the gateway request, or a detail dict to block
    it with 402. No-op (allow) when no overlay is loaded."""
    if _iot_gateway_gate_hook is None:
        return None
    try:
        return await _iot_gateway_gate_hook(request)
    except Exception:
        # A failing gate must not take the gateway down — fail open.
        logger.exception("iot_gateway_gate hook failed (allowing request)")
        return None


# ── ws_sim_handler ────────────────────────────────────────────────────────────
# Handles simulation-WebSocket messages the OSS route doesn't itself know about
# (e.g. the Pico W picow_* messages, whose userspace network stack lives in the
# overlay). OSS-default: no handler -> the message is ignored. The overlay
# registers one that dispatches start_picow/stop_picow/picow_packet_out to its
# picow_net manager (and gates start_picow behind a paid plan). Returns True if
# it handled the message, False to let the OSS route fall through.

WsSimHandlerHook = Callable[[Any, str, str, dict, Any], Awaitable[bool]]

_ws_sim_handler_hook: Optional[WsSimHandlerHook] = None


def register_ws_sim_handler(hook: WsSimHandlerHook) -> None:
    """Install the simulation-WS message handler. Called in register_pro."""
    global _ws_sim_handler_hook
    _ws_sim_handler_hook = hook


async def dispatch_ws_sim_message(
    websocket: Any, client_id: str, msg_type: str, msg_data: dict, callback: Any,
) -> bool:
    """Let an overlay handle a simulation-WS message. Returns True if handled,
    False (the OSS default) when no overlay is loaded."""
    if _ws_sim_handler_hook is None:
        return False
    try:
        return await _ws_sim_handler_hook(websocket, client_id, msg_type, msg_data, callback)
    except Exception:
        logger.exception("ws_sim_handler hook failed (ignoring message)")
        return False


# ── gateway_proxy ─────────────────────────────────────────────────────────────
# Resolves a gateway request for a board the OSS route can't reach itself (the
# Pico W's HTTP server lives in the browser-side lwIP; the overlay proxies into
# it over the WS bridge). OSS-default: no resolver -> None (the route 404s). The
# overlay returns a Response to use, or None to fall through.

GatewayProxyHook = Callable[[str, str, Request], Awaitable[Optional[Response]]]

_gateway_proxy_hook: Optional[GatewayProxyHook] = None


def register_gateway_proxy(hook: GatewayProxyHook) -> None:
    """Install the overlay gateway-proxy resolver. Called in register_pro."""
    global _gateway_proxy_hook
    _gateway_proxy_hook = hook


async def dispatch_gateway_proxy(
    client_id: str, path: str, request: Request,
) -> Optional[Response]:
    """Let an overlay proxy a gateway request (e.g. into the Pico W chip).
    Returns a Response, or None (the OSS default) to fall through to 404."""
    if _gateway_proxy_hook is None:
        return None
    try:
        return await _gateway_proxy_hook(client_id, path, request)
    except Exception:
        logger.exception("gateway_proxy hook failed")
        return None


# ── compile_priority ──────────────────────────────────────────────────────────
# Where a user's compile sits in the build queue. OSS is single-user and has no
# plans, so with no overlay every build is ordinary and the queue is plain FIFO.
# The overlay maps the signed-in user's plan onto the ladder in
# `app.services.build_queue` (PRIORITY_HIGH / MEDIUM / STANDARD) so paid builds
# are admitted first.
#
# Returns {'priority': int, 'tier': str} or None. `tier` is a DISPLAY label the
# compile-status endpoint echoes back so the frontend can say "priority build"
# vs. offer an upgrade — it is not used for any access decision. Never return
# queue depth or position from here: those stay server-side (see build_queue).

CompilePriorityHook = Callable[[Optional[str]], Awaitable[Optional[dict]]]

_compile_priority_hook: Optional[CompilePriorityHook] = None


def register_compile_priority(hook: CompilePriorityHook) -> None:
    """Install the plan-aware queue-priority resolver. Called in register_pro."""
    global _compile_priority_hook
    _compile_priority_hook = hook


async def compile_priority(user_id: Optional[str]) -> Optional[dict]:
    """Resolve queue priority for a compile. None (the OSS default) means
    'ordinary priority, no plan vocabulary' — the caller supplies it."""
    if _compile_priority_hook is None:
        return None
    try:
        return await _compile_priority_hook(user_id)
    except Exception:
        # A priority lookup must never cost someone their build. Falling back
        # to ordinary priority just means they queue like everyone else.
        logger.exception("compile_priority hook failed (treating as standard)")
        return None
