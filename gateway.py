#!/usr/bin/env python3
"""NRO Web VT15 - fixed-target WebSocket <-> TCP gateway.

This gateway intentionally only connects to the configured VT15 endpoint.
It is not an open TCP proxy.
"""

import asyncio
import logging
import os
from pathlib import Path

from aiohttp import web, WSMsgType

TARGET_HOST = "dragon15.teamobi.com"
TARGET_PORT = 14445
LISTEN_HOST = os.getenv("HOST", "0.0.0.0")
LISTEN_PORT = int(os.getenv("PORT", "8765"))
WEB_DIR = Path(__file__).parent / "web"
MAX_WS_MESSAGE = 1 << 20  # 1 MiB per WS message

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("nro-vt15-gateway")


async def index(_request: web.Request) -> web.FileResponse:
    return web.FileResponse(WEB_DIR / "index.html")


async def tcp_to_ws(reader: asyncio.StreamReader, ws: web.WebSocketResponse) -> None:
    try:
        while not ws.closed:
            data = await reader.read(65536)
            if not data:
                break
            await ws.send_bytes(data)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        log.info("TCP -> WS stopped: %s", exc)
    finally:
        if not ws.closed:
            await ws.close(code=1000, message=b"TCP closed")


async def websocket_proxy(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(max_msg_size=MAX_WS_MESSAGE, heartbeat=30)
    await ws.prepare(request)

    peer = request.remote or "unknown"
    log.info("Browser connected from %s; opening %s:%d", peer, TARGET_HOST, TARGET_PORT)

    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(TARGET_HOST, TARGET_PORT), timeout=8
        )
    except Exception as exc:
        log.warning("Could not connect to VT15: %s", exc)
        await ws.send_str(f"GATEWAY_ERROR:{type(exc).__name__}:{exc}")
        await ws.close(code=1011, message=b"Target connect failed")
        return ws

    pump = asyncio.create_task(tcp_to_ws(reader, ws))
    try:
        async for msg in ws:
            if msg.type == WSMsgType.BINARY:
                writer.write(msg.data)
                await writer.drain()
            elif msg.type == WSMsgType.TEXT:
                # Browser protocol uses only binary frames. Ignore normal text.
                if msg.data == "PING":
                    await ws.send_str("PONG")
            elif msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED, WSMsgType.ERROR):
                break
    finally:
        pump.cancel()
        try:
            await pump
        except (asyncio.CancelledError, Exception):
            pass
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        log.info("Browser disconnected from %s", peer)

    return ws


async def health(_request: web.Request) -> web.Response:
    return web.json_response({
        "ok": True,
        "target": TARGET_HOST,
        "port": TARGET_PORT,
        "mode": "fixed-target",
    })


def build_app() -> web.Application:
    app = web.Application(client_max_size=MAX_WS_MESSAGE)
    app.router.add_get("/", index)
    app.router.add_get("/ws", websocket_proxy)
    app.router.add_get("/health", health)
    app.router.add_static("/static/", WEB_DIR, show_index=False)
    return app


if __name__ == "__main__":
    print(f"NRO Web VT15 listening on {LISTEN_HOST}:{LISTEN_PORT}")
    print(f"Target: {TARGET_HOST}:{TARGET_PORT}")
    web.run_app(build_app(), host=LISTEN_HOST, port=LISTEN_PORT, print=None)
