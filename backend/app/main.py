import logging
import sys
import asyncio
from contextlib import asynccontextmanager

logging.basicConfig(level=logging.INFO, format='%(levelname)s %(name)s: %(message)s')

# On Windows, asyncio defaults to SelectorEventLoop which does NOT support
# create_subprocess_exec (raises NotImplementedError). Force ProactorEventLoop.
if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import compile, compile_chip, compile_rom, flash, libraries
from app.core.config import settings
from app.core.hooks import run_lifespan_startup

logger = logging.getLogger(__name__)


def _asyncio_exception_handler(loop: asyncio.AbstractEventLoop, context: dict) -> None:
    """Prevent unhandled asyncio task exceptions from killing the uvicorn process.

    Normally uvicorn re-raises unhandled task exceptions at the event-loop level,
    which can crash the whole process. The main culprit is a race condition in
    websockets <12.0 (legacy/protocol.py AssertionError during keepalive ping).
    Upgrading websockets>=12.0 is the primary fix; this handler is a safety net.
    """
    exc = context.get("exception")
    msg = context.get("message", "")
    if exc is not None:
        logger.error("Unhandled asyncio task exception (swallowed): %s — %r", msg, exc)
    else:
        # No exception object — let default handler deal with it
        loop.default_exception_handler(context)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    asyncio.get_event_loop().set_exception_handler(_asyncio_exception_handler)
    # Each module that needs async startup (DB schema creation, legacy column
    # migrations, cache warmers, …) registers a hook with
    # register_lifespan_startup() at import time. The OSS auth/DB stack
    # registers the create_all + ALTER TABLE migration block above; the
    # private overlay's register_pro() can add more. Running zero hooks is
    # the expected behavior of a stateless OSS image.
    await run_lifespan_startup()
    yield


app = FastAPI(
    title="Arduino Emulator API",
    description="Compilation and project management API",
    version="1.0.0",
    lifespan=lifespan,
    # Moved from /docs to /api/docs so the frontend /docs/* documentation
    # routes are served by the React SPA without any nginx conflict.
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

# CORS — local Vite dev, the prod web origin, AND the Velxio Desktop
# Tauri origins. The desktop bundle runs from a non-http scheme so
# every fetch to velxio.dev is cross-origin and the browser blocks
# preflight unless we explicitly allow the Tauri scheme(s).
#
# Tauri origin per OS:
#   - macOS / Linux: `tauri://localhost`
#   - Windows:       `http://tauri.localhost`
#   - older Tauri:   `https://tauri.localhost`
# All three are listed so the desktop bundle works regardless of
# host OS or Tauri version.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:5175",
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
        settings.FRONTEND_URL,
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(compile.router, prefix="/api/compile", tags=["compilation"])
app.include_router(compile_chip.router, prefix="/api/compile-chip", tags=["custom-chips"])
app.include_router(compile_rom.router, prefix="/api/compile-rom", tags=["custom-chips"])
app.include_router(libraries.router, prefix="/api/libraries", tags=["libraries"])
# Hardware flash: subprocesses arduino-cli upload to write a compiled
# sketch to a real USB-attached board. Desktop-only in practice (the
# web build has no access to local serial ports without WebSerial),
# but the route lives in OSS so self-hosters with a sidecar reach
# get it too.
app.include_router(flash.router, prefix="/api/flash", tags=["flash"])

# Auth / projects / admin / metrics routers used to be wired up here, gated
# on the auth/DB stack being importable. Phase 2 of the OSS split moved
# them out of upstream entirely — they now live under the private overlay's
# pro/backend/app/api/routes/ and are registered by register_pro(app)
# below. The OSS image carries none of them: anonymous, stateless.

# WebSockets
from app.api.routes import simulation
app.include_router(simulation.router, prefix="/api/simulation", tags=["simulation"])

# IoT Gateway — HTTP proxy for ESP32 web servers
from app.api.routes import iot_gateway
app.include_router(iot_gateway.router, prefix="/api/gateway", tags=["iot-gateway"])

# Product news ("What's New" modal) — cached proxy of velxio.dev's public
# feed so self-hosted users get product news without their browsers ever
# leaving this server. Anonymous, no identifiers sent; opt out with
# VELXIO_NEWS=off (an offline host just serves an empty feed).
from app.api.routes import news
app.include_router(news.router, prefix="/api/news", tags=["news"])

# Optional pro extension. The `app.pro` package only exists in private builds
# (overlaid at Docker build time by an external repo) — its absence in the
# open-source image is expected and silently ignored. Anyone with private
# extensions can drop a package at `backend/app/pro/` exposing
# `register_pro(app)` and have it auto-loaded here without further edits.
try:
    from app.pro import register_pro  # type: ignore[import-not-found]
    register_pro(app)
except ImportError:
    pass

@app.get("/")
def root():
    return {
        "message": "Arduino Emulator API",
        "version": "1.0.0",
        "docs": "/api/docs",
    }


@app.get("/health")
def health_check():
    return {"status": "healthy"}

