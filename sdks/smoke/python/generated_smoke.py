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


async def main() -> None:
    client = LunoraClient("https://app.example", http_post=fake_post)

    await Api(client).messages.list(MessagesListArgs(channel_id="chan_1"))

    want = '{"args":{"channelId":"chan_1"},"functionPath":"messages:list"}'
    got = stable_stringify(captured["body"])

    if got != want:
        raise AssertionError(f"generated call produced {got}, want {want}")

    print("OK — the generated surface reaches the wire")


asyncio.run(main())
