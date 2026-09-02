"""
IoT Gateway — HTTP reverse proxy for ESP32 web servers running in QEMU.

When an ESP32 sketch starts a WebServer on port 80, QEMU's slirp
networking with hostfwd exposes it on a dynamic host port.  This
endpoint proxies HTTP requests from the browser to that host port,
enabling users to interact with their simulated ESP32 HTTP server.

URL pattern:
    /api/gateway/{client_id}/{path}
    →  http://127.0.0.1:{hostfwd_port}/{path}

The board's page is served under that prefix, not at the origin root, and
sketches do not know it. See _rewrite_html below for what that breaks and
how the injected shim fixes it without touching the sketch.
"""
import asyncio
import json
import logging
import re

import httpx
from fastapi import APIRouter, Request, Response

from app.core.hooks import dispatch_gateway_proxy, iot_gateway_gate
from app.services.esp32_lib_manager import esp_lib_manager

router = APIRouter()
logger = logging.getLogger(__name__)


# ── Serving a root-relative page under a path prefix ────────────────────────
# A sketch's page is written for a board that owns its whole origin, so it
# asks for "/led?state=1". Served from /api/gateway/<client_id>/ that resolves
# against velxio.dev, misses the proxy entirely, and hits the SPA — which
# answers with its own index.html. The request "succeeds", so the page's own
# .catch() never fires: buttons respond, nothing reaches the board, no error
# anywhere (reported as "webinterface shows the webpage but doesn't send
# information back", velxio#274).
#
# Rewriting the sketch is not an option: root-relative paths are what every
# ESP32 tutorial teaches, and the same sketch must stay correct on real
# hardware. So the shim below is injected into HTML responses and rewrites
# requests in the browser, at the only place that knows the prefix.
#
# It deliberately leaves alone anything already correct: relative paths
# ("led") resolve under the prefix on their own, and so do URLs that already
# carry it.

_GATEWAY_SHIM = """<script>(function(){
var P=%PREFIX%;
if(window.__velxioGatewayShim)return;window.__velxioGatewayShim=P;
/* The emulated subnets: ESP32 via QEMU slirp, Pico W via the virtual net.
   A sketch that prints its own IP into the page hard-codes one of these. */
var BOARD=/^(192\\.168\\.4\\.\\d{1,3}|10\\.13\\.37\\.\\d{1,3})$/;
function rw(u){
  try{
    if(u==null)return u;
    var s=String(u);
    if(!s)return u;
    if(s.slice(0,2)==='//'||/^[a-z][a-z0-9+.-]*:/i.test(s)){
      try{
        var a=new URL(s,location.href);
        if((a.protocol==='http:'||a.protocol==='https:')&&BOARD.test(a.hostname))
          return P+a.pathname.replace(/^\\//,'')+a.search+a.hash;
      }catch(e){}
      return u;
    }
    if(s.charAt(0)!=='/')return u;      /* relative: already resolves right */
    if(s.indexOf(P)===0)return u;       /* already prefixed */
    return P+s.slice(1);
  }catch(e){return u;}
}
window.__velxioGatewayRewrite=rw;
var of=window.fetch;
if(of)window.fetch=function(i,o){
  try{
    if(typeof i==='string'||i instanceof URL)i=rw(String(i));
    else if(typeof Request!=='undefined'&&i instanceof Request){
      var n=rw(i.url);if(n!==i.url)i=new Request(n,i);
    }
  }catch(e){}
  return of.call(this,i,o);
};
var ox=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){
  var a=Array.prototype.slice.call(arguments);
  try{a[1]=rw(u);}catch(e){}
  return ox.apply(this,a);
};
if(window.EventSource){
  var OE=window.EventSource;
  var NE=function(u,c){return new OE(rw(u),c);};
  NE.prototype=OE.prototype;
  ['CONNECTING','OPEN','CLOSED'].forEach(function(k){NE[k]=OE[k];});
  window.EventSource=NE;
}
if(window.WebSocket){
  /* The proxy is plain HTTP: it cannot carry an Upgrade. Say so once, in the
     place the developer is already looking, instead of failing silently. */
  var OW=window.WebSocket;
  var NW=function(u,p){
    try{
      var a=new URL(String(u),location.href);
      if(BOARD.test(a.hostname))
        console.warn('[velxio] WebSocket to '+a.host+' cannot be proxied: the '+
          'IoT gateway forwards HTTP only. HTTP routes and Server-Sent Events work.');
    }catch(e){}
    return p===undefined?new OW(u):new OW(u,p);
  };
  NW.prototype=OW.prototype;
  ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(k){NW[k]=OW[k];});
  window.WebSocket=NW;
}
function fix(el){
  ['src','href','action'].forEach(function(at){
    if(!el.getAttribute)return;
    var v=el.getAttribute(at);
    if(v==null||v==='')return;
    if(v.charAt(0)==='#')return;
    var n=rw(v);
    if(n!==v)el.setAttribute(at,n);
  });
}
function sweep(root){
  try{
    if(root.querySelectorAll)
      Array.prototype.forEach.call(root.querySelectorAll('[src],[href],[action]'),fix);
    if(root.nodeType===1)fix(root);
  }catch(e){}
}
if(document.readyState==='loading')
  document.addEventListener('DOMContentLoaded',function(){sweep(document);});
else sweep(document);
try{
  new MutationObserver(function(ms){
    ms.forEach(function(m){
      Array.prototype.forEach.call(m.addedNodes,function(n){if(n.nodeType===1)sweep(n);});
      if(m.type==='attributes'&&m.target)fix(m.target);
    });
  }).observe(document.documentElement,{childList:true,subtree:true,
    attributes:true,attributeFilter:['src','href','action']});
}catch(e){}
})();</script>"""

_HEAD_RE = re.compile(rb'<head[^>]*>', re.IGNORECASE)
_HTML_RE = re.compile(rb'<html[^>]*>', re.IGNORECASE)


def _gateway_prefix(request: Request, path: str) -> str:
    """The '/api/gateway/<client_id>/' this request came through, taken from
    the request itself so it carries the browser's own encoding of the id."""
    req_path = request.url.path
    if path and req_path.endswith(path):
        prefix = req_path[: len(req_path) - len(path)]
    else:
        prefix = req_path
    return prefix if prefix.endswith('/') else prefix + '/'


def _rewrite_html(resp: Response, prefix: str) -> Response:
    """Inject the shim into an HTML response. Any other content type, or a
    body we cannot decode, is passed through untouched."""
    ctype = resp.media_type or resp.headers.get('content-type') or ''
    if 'html' not in ctype.lower():
        return resp
    body = resp.body
    if not body:
        return resp
    shim = _GATEWAY_SHIM.replace('%PREFIX%', json.dumps(prefix)).encode('utf-8')

    m = _HEAD_RE.search(body) or _HTML_RE.search(body)
    # Straight after <head> (or <html>) so the shim is installed before any of
    # the page's own script runs; a fragment with neither gets it up front.
    new_body = body[: m.end()] + shim + body[m.end():] if m else shim + body

    headers = {
        k: v for k, v in resp.headers.items()
        # Recomputed by the Response below; a stale one truncates the page.
        if k.lower() not in ('content-length', 'content-encoding')
    }
    return Response(
        content=new_body,
        status_code=resp.status_code,
        headers=headers,
        media_type=resp.media_type or ctype,
    )


@router.api_route(
    '/{client_id}/{path:path}',
    methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
)
async def gateway_proxy(client_id: str, path: str, request: Request) -> Response:
    """Reverse-proxy an HTTP request to the ESP32's web server."""
    # Plan gate (overlay-supplied). OSS image has no gate → allow everyone.
    # When the velxio-prod overlay is loaded, the gateway is a Maker+ feature;
    # free / anonymous callers get a 402 with an upgrade pointer.
    block_detail = await iot_gateway_gate(request)
    if block_detail is not None:
        # The frontend opens the gateway via window.open(_blank), so a raw
        # JSON 402 would dump in a new tab. Content-negotiate: serve a tiny
        # HTML upgrade page to browser navigations, JSON to programmatic
        # (fetch/XHR) callers.
        accepts_html = 'text/html' in (request.headers.get('accept') or '')
        upgrade_url = block_detail.get('upgrade_url', '/pricing')
        msg = block_detail.get('message', 'This is a paid feature.')
        if accepts_html:
            html = (
                '<!doctype html><html><head><meta charset="utf-8">'
                '<title>Velxio — upgrade required</title>'
                '<meta name="viewport" content="width=device-width, initial-scale=1">'
                '<style>body{background:#1e1e1e;color:#ddd;font-family:-apple-system,'
                'BlinkMacSystemFont,sans-serif;display:flex;min-height:100vh;margin:0;'
                'align-items:center;justify-content:center;text-align:center}'
                '.box{max-width:440px;padding:32px}h1{font-size:20px;color:#fff}'
                'p{color:#aaa;line-height:1.6}a{display:inline-block;margin-top:16px;'
                'background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;'
                'text-decoration:none;font-weight:600}</style></head><body><div class="box">'
                '<h1>IoT gateway is a Maker feature</h1>'
                f'<p>{msg} Upgrade to access live ESP32 web servers running in your '
                'simulated circuit.</p>'
                f'<a href="https://velxio.dev{upgrade_url}">See plans</a>'
                '</div></body></html>'
            )
            return Response(content=html, status_code=402, media_type='text/html')
        return Response(
            content=json.dumps({'error': 'pro_required', 'detail': block_detail}),
            status_code=402,
            media_type='application/json',
        )

    # Registration races the sketch printing its URL: the in-browser engines
    # dial their net bridge only on 'got_ip', which lands at the same moment
    # "Server started at: ..." appears in the serial monitor — a fast click
    # reaches here before the bridge exists. Poll briefly before giving up.
    for attempt in range(5):
        if attempt:
            await asyncio.sleep(0.25)

        # ── ESP32: the server runs in QEMU, reachable via slirp hostfwd. ──
        inst = esp_lib_manager.get_instance(client_id)
        if inst and inst.wifi_enabled and inst.wifi_hostfwd_port != 0:
            return _rewrite_html(
                await _proxy_esp32(inst, path, request),
                _gateway_prefix(request, path),
            )

        # ── Pico W (and any other overlay-provided board): the server runs in
        #    the browser-side lwIP, reachable only by the overlay proxying TCP
        #    into the chip over the WS bridge. OSS has no resolver -> None. ──
        overlay_resp = await dispatch_gateway_proxy(client_id, path, request)
        if overlay_resp is not None:
            # Same treatment for the Pico W path: its lwIP server serves
            # root-relative pages through this very prefix too.
            return _rewrite_html(overlay_resp, _gateway_prefix(request, path))

    # Wording matters here. The old text said "make sure your sketch connected
    # to WiFi", which reads as an accusation to the one sketch that most often
    # lands on this branch: a captive-portal / provisioning sketch that called
    # WiFi.softAP() and deliberately did NOT join a network. Such a board is
    # the access point, so it never gets a DHCP lease, never reaches 'got_ip',
    # and never registers the bridge this proxy looks up — there is nothing to
    # reach and nothing the user did wrong. Name that case first.
    return Response(
        content=json.dumps({
            'error': 'no_reachable_board',
            'message': (
                'Nothing is registered for this client, so there is no server '
                'to reach. If your sketch calls WiFi.softAP(), that is why: '
                'the simulator can reach a board that JOINED a network, not a '
                'board that created one. Join a simulated network instead '
                '(WiFi.begin("Velxio-GUEST") — open, no password) and start '
                'your server on port 80. If the sketch does join a network, '
                'wait for it to print its IP before opening the gateway.'
            ),
        }),
        status_code=404,
        media_type='application/json',
    )


async def _proxy_esp32(inst, path: str, request: Request) -> Response:
    """Reverse-proxy to an ESP32 web server via QEMU slirp hostfwd."""
    target_url = f'http://127.0.0.1:{inst.wifi_hostfwd_port}/{path}'
    body = await request.body()

    # Forward relevant headers (skip hop-by-hop)
    skip_headers = {'host', 'transfer-encoding', 'connection'}
    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in skip_headers
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.request(
                method=request.method,
                url=target_url,
                content=body,
                headers=headers,
            )
    except httpx.ConnectError:
        return Response(
            content='{"error":"ESP32 HTTP server is not responding. Make sure your sketch starts a WebServer on port 80."}',
            status_code=502,
            media_type='application/json',
        )
    except httpx.TimeoutException:
        return Response(
            content='{"error":"ESP32 HTTP server timed out"}',
            status_code=504,
            media_type='application/json',
        )

    # Forward response back to browser
    resp_headers = dict(resp.headers)
    # Remove hop-by-hop headers
    for h in ('transfer-encoding', 'connection', 'content-encoding'):
        resp_headers.pop(h, None)

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        headers=resp_headers,
        media_type=resp.headers.get('content-type'),
    )
