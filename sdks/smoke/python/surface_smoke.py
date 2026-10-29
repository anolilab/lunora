"""Call every function of the `sdk-surface` spec through a generated SDK.

`generated_smoke.py` proves a call reaches the wire. This proves the generated
surface handles every SHAPE a model backend renders differently: a no-arg
function, id / number / array / record / null results, a nullable object, an
array of objects, a union argument, an unset optional, bigint arguments and
results (top level and nested), and functions named after keywords.

Run by `sdks/generated-check.sh python`; see `generated_smoke.py` for why
LUNORA_SDK_OUT is the only path on `sys.path`.
"""

import asyncio
import json
import os
import sys

sys.path.insert(0, os.environ["LUNORA_SDK_OUT"])

from lunora_api.api import Api
from lunora_api.models import ItemsCreateArgs, ItemsFindArgs, ItemsMatchArgs, ItemsPickArgs

from lunora.client import LunoraClient
from lunora.wire import WireBigInt, stable_stringify

BIG_FIVE = '["$lunora.wire$","bigint","5"]'

frames: list = []
reply: dict = {"value": "null"}


def fake_post(_url: str, _headers: dict, body: bytes) -> tuple:
    frames.append(stable_stringify(json.loads(body)))

    return 200, json.loads('{"result":' + reply["value"] + "}")


async def call(result: str, invocation) -> object:
    reply["value"] = result

    return await invocation


def expect(what: str, got: object, want: object) -> None:
    if got != want:
        raise AssertionError(f"{what}: got {got!r}, want {want!r}")


async def main() -> None:
    api = Api(LunoraClient("https://app.example", http_post=fake_post))
    items = api.items

    expect("count", await call("2", items.count({})), 2)
    summary = await call('{"size":2,"title":"t"}', items.summary({}))
    expect("summary", (summary.size, summary.title), (2, "t"))
    detail = await call('{"title":"t","value":"x"}', items.detail({}))
    expect("detail", (detail.title, detail.value), ("t", "x"))
    expect("create", await call('"items_1"', items.create(ItemsCreateArgs(title="t"))), "items_1")
    expect("clear", await call("null", items.clear({})), None)
    expect("tags", await call('["a"]', items.tags({})), ["a"])
    expect("labels", await call('["b"]', items.labels({})), ["b"])
    expect("stats", await call('{"a":1}', items.stats({})), {"a": 1})
    expect("totals", await call('{"b":2}', items.totals({})), {"b": 2})
    expect("find", await call("null", items.find(ItemsFindArgs(id="items_1"))), None)
    expect("page", await call('[{"kind":"a","title":"t"}]', items.page({})), [{"kind": "a", "title": "t"}])
    choice = ItemsPickArgs.from_dict({"choice": {"a": 1, "kind": "x"}})
    expect("pick", await call('"x"', items.pick(choice)), "x")
    expect("match", await call("1", items.match(ItemsMatchArgs(pattern="p"))), 1)
    expect("type", await call("1", items.type({})), 1)
    expect("self", await call("1", items.self({})), 1)

    charged = await call(BIG_FIVE, api.ledger.charge({"amount": WireBigInt(5)}))
    expect("charge", charged, WireBigInt(5))
    balances = await call(
        '{"rows":[{"amount":' + BIG_FIVE + '}],"total":' + BIG_FIVE + "}",
        api.ledger.balances({"accounts": [{"id": "acc", "limit": WireBigInt(5)}]}),
    )
    expect("balances", balances, {"rows": [{"amount": WireBigInt(5)}], "total": WireBigInt(5)})

    want = [
        '{"args":{},"functionPath":"items:count"}',
        '{"args":{},"functionPath":"items:summary"}',
        '{"args":{},"functionPath":"items:detail"}',
        '{"args":{"title":"t"},"functionPath":"items:create"}',
        '{"args":{},"functionPath":"items:clear"}',
        '{"args":{},"functionPath":"items:tags"}',
        '{"args":{},"functionPath":"items:labels"}',
        '{"args":{},"functionPath":"items:stats"}',
        '{"args":{},"functionPath":"items:totals"}',
        '{"args":{"id":"items_1"},"functionPath":"items:find"}',
        '{"args":{},"functionPath":"items:page"}',
        '{"args":{"choice":{"a":1,"kind":"x"}},"functionPath":"items:pick"}',
        '{"args":{"pattern":"p"},"functionPath":"items:match"}',
        '{"args":{},"functionPath":"items:type"}',
        '{"args":{},"functionPath":"items:self"}',
        '{"args":{"amount":' + BIG_FIVE + '},"functionPath":"ledger:charge"}',
        '{"args":{"accounts":[{"id":"acc","limit":' + BIG_FIVE + '}]},"functionPath":"ledger:balances"}',
    ]

    expect("frame count", len(frames), len(want))

    for index, (got, wanted) in enumerate(zip(frames, want)):
        expect(f"frame {index}", got, wanted)

    print("OK — every sdk-surface shape reaches the wire and decodes")


asyncio.run(main())
