"""Run a generated call, rather than only importing one.

An import proves the module is syntactically valid and its names resolve. It does
not prove a call reaches the wire: Java shipped a surface that compiled and threw
`cannot encode` on the first invocation, and Ruby shipped one whose every method
raised NoMethodError, both with the compile-or-parse gate green. This closes that
gap for Python.

Run by `sdks/generated-check.sh python`, against an SDK generated into a scratch
directory OUTSIDE this repo — which is the point. `sdks/python/lunora` is
importable from anywhere in this checkout, so a smoke run from inside it would
pass on the repo's transport and prove nothing about the vendored copy.
LUNORA_SDK_OUT is therefore the ONLY path put on `sys.path`.
"""

import asyncio
import json
import os
import sys

sys.path.insert(0, os.environ["LUNORA_SDK_OUT"])

from lunora_api.api import Api
from lunora_api.models import MessagesListArgs

from lunora.client import LunoraClient
from lunora.wire import stable_stringify

captured: dict = {}


def fake_post(_url: str, _headers: dict, body: bytes) -> tuple:
    captured["body"] = json.loads(body)

    return 200, {"result": {"ok": True}}


async def watch_leg() -> None:
    """The generated watch member reaches the primitive with the right function path.

    The subscribe frame is sent at call time, the first data frame is decoded through
    the stream, and closing the generator sends the unsubscribe for the same id.
    """
    frames: list = []
    client = LunoraClient("https://app.example")
    client.attach_socket(frames.append)

    values = Api(client).messages.watch_list(MessagesListArgs(channel_id="chan_1"))

    subscribe = next(frame for frame in frames if frame.get("type") == "subscribe")
    query = subscribe["query"]

    if query["functionPath"] != "messages:list":
        raise AssertionError(f"watch subscribed to {query['functionPath']}, want messages:list")

    if stable_stringify(query["args"]) != '{"channelId":"chan_1"}':
        raise AssertionError(f"watch sent args {stable_stringify(query['args'])}")

    client.handle_frame({"cursor": 1, "data": {"ok": True}, "id": subscribe["id"], "type": "data"})

    if await values.__anext__() != {"ok": True}:
        raise AssertionError("watch did not yield the data frame's value")

    await values.aclose()

    unsubscribes = [frame for frame in frames if frame.get("type") == "unsubscribe"]

    if [frame["id"] for frame in unsubscribes] != [subscribe["id"]]:
        raise AssertionError(f"closing the watch sent {unsubscribes}, want one unsubscribe for {subscribe['id']}")


async def main() -> None:
    client = LunoraClient("https://app.example", http_post=fake_post)

    await Api(client).messages.list(MessagesListArgs(channel_id="chan_1"))

    want = '{"args":{"channelId":"chan_1"},"functionPath":"messages:list"}'
    got = stable_stringify(captured["body"])

    if got != want:
        raise AssertionError(f"generated call produced {got}, want {want}")

    await watch_leg()

    print("OK — the generated surface reaches the wire, and the watch member reaches the primitive")


asyncio.run(main())
