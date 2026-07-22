"""Runnable example for the Lunora Python SDK.

Talks to a live Lunora deployment: runs a query and a mutation over HTTP RPC,
then opens the live WebSocket and prints subscription updates.

    export LUNORA_URL=https://my-app.example.com
    export LUNORA_TOKEN=...            # optional bearer for RPC
    export LUNORA_WS_TOKEN=...         # optional WS ?token= credential
    python examples/quickstart.py

The live subscription (``connect_and_run``) needs the ``websockets`` package:

    pip install websockets

Everything except ``connect_and_run`` works with only the Python standard library.
"""

from __future__ import annotations

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lunora import LunoraClient, WireBigInt  # noqa: E402


async def main() -> None:
    url = os.environ.get("LUNORA_URL", "http://127.0.0.1:8787")

    # An async WS token provider (mirrors the TS WsTokenProvider): resolved fresh
    # on every (re)connect, so a short-lived credential can be re-minted.
    async def ws_token_provider() -> str | None:
        return os.environ.get("LUNORA_WS_TOKEN")

    client = LunoraClient(
        url=url,
        auth_token=os.environ.get("LUNORA_TOKEN"),
        ws_token=ws_token_provider,
        client_id="python-example",
    )

    # --- HTTP RPC round-trips ------------------------------------------------
    try:
        messages = await client.query("messages:list", {"channel": "general", "limit": 20})
        print("query messages:list ->", messages)

        created = await client.mutation("messages:send", {"channel": "general", "text": "hi from python"})
        print("mutation messages:send ->", created)

        # A bigint argument is marked explicitly so it rides the wire as v.bigint().
        await client.mutation("ledger:add", {"amount": WireBigInt(1000)})
    except Exception as exc:  # noqa: BLE001 - example: surface any transport error
        print("RPC failed (is the dev server running?):", exc)

    # --- Live subscription ---------------------------------------------------
    def on_data(value: object) -> None:
        print("subscription update ->", value)

    def on_error(error: object) -> None:
        print("subscription error ->", error)

    client.subscribe("messages:list", {"channel": "general"}, on_data, on_error)

    try:
        await asyncio.wait_for(client.connect_and_run(), timeout=10)
    except asyncio.TimeoutError:
        print("(stopped listening after 10s)")
    except RuntimeError as exc:
        print(exc)  # websockets not installed


if __name__ == "__main__":
    asyncio.run(main())
