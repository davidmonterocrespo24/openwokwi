"""Product-news feed proxy for self-hosted installs.

The editor shows a once-per-browser "What's New" modal (see
frontend/src/lib/newsSource.ts). Rather than every user's browser
fetching velxio.dev directly, the backend proxies the public feed:

  - the FEED fetch never leaves this server (one cached fetch per
    instance instead of one per visitor, no identifiers sent) — though
    media embedded in a post (images/GIFs, YouTube thumbnails) does
    load in the viewer's browser from wherever it's hosted, as the
    README documents;
  - a single, documented opt-out: VELXIO_NEWS=off (also the automatic
    behavior when the host has no internet — errors degrade to []).

The upstream feed is plain public JSON (no auth).
"""

from __future__ import annotations

import json
import logging
import os
import time

import httpx
from fastapi import APIRouter

logger = logging.getLogger(__name__)

router = APIRouter()

DEFAULT_FEED_URL = "https://velxio.dev/api/pro/news/feed"
_CACHE_TTL_SECONDS = 6 * 60 * 60
# On a failed upstream fetch, don't retry for a while — otherwise every
# anonymous /feed hit while upstream is unreachable opens a fresh 5s
# outbound connection (a request loop would turn this instance into a
# slow hammer against the feed host).
_FAIL_RETRY_SECONDS = 5 * 60
# Upstream body cap. httpx's timeout is per read operation, so a
# byte-dripping upstream could otherwise deliver an unbounded body.
_MAX_FEED_BYTES = 2_000_000

_cache: dict = {"at": 0.0, "posts": None}


def _news_enabled() -> bool:
    return os.environ.get("VELXIO_NEWS", "on").strip().lower() not in (
        "off", "0", "false", "disabled", "no",
    )


def _sanitize(raw: object) -> list[dict]:
    """Keep only the expected shape/fields — the payload gets rendered
    client-side, so an upstream surprise must not leak arbitrary junk."""
    if not isinstance(raw, list):
        return []
    posts: list[dict] = []
    for item in raw[:50]:
        if not isinstance(item, dict):
            continue
        try:
            posts.append({
                "id": str(item["id"])[:64],
                "title": str(item["title"])[:200],
                "body_md": str(item["body_md"])[:20_000],
                "publish_date": str(item["publish_date"])[:10],
                "expires_date": (
                    str(item["expires_date"])[:10]
                    if item.get("expires_date") else None
                ),
            })
        except (KeyError, TypeError):
            continue
    return posts


@router.get("/feed")
async def news_feed() -> list[dict]:
    """Cached proxy of the velxio.dev product-news feed.

    Returns [] when news is disabled, the host is offline, or upstream
    misbehaves — the modal simply never appears.
    """
    if not _news_enabled():
        return []

    now = time.monotonic()
    if _cache["posts"] is not None and now - _cache["at"] < _CACHE_TTL_SECONDS:
        return _cache["posts"]

    url = os.environ.get("VELXIO_NEWS_URL", DEFAULT_FEED_URL)
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            async with client.stream("GET", url) as resp:
                resp.raise_for_status()
                size = 0
                chunks: list[bytes] = []
                async for chunk in resp.aiter_bytes():
                    size += len(chunk)
                    if size > _MAX_FEED_BYTES:
                        raise ValueError("news feed exceeds size cap")
                    chunks.append(chunk)
        posts = _sanitize(json.loads(b"".join(chunks)))
    except Exception as exc:  # offline / DNS / upstream down — all fine
        logger.debug("[news] feed fetch failed (%s); serving stale/empty", exc)
        # Negative cache: keep serving the stale/empty result without
        # touching the network again until the retry window passes.
        _cache["posts"] = _cache["posts"] or []
        _cache["at"] = now - _CACHE_TTL_SECONDS + _FAIL_RETRY_SECONDS
        return _cache["posts"]

    _cache["posts"] = posts
    _cache["at"] = now
    return posts
