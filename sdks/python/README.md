# Lunora Python SDK

A minimal, **protocol-conformant** Python client for a Lunora deployment — the
first non-TypeScript SDK, proving the Lunora wire protocol is not TS-bound.

It implements the transport specified in
[`protocol/README.md`](../../protocol/README.md):

- `query` / `mutation` round-trips over `POST /_lunora/rpc`.
- Live `subscribe` over the WebSocket `data`/`delta`/`ack`/`error`/`resume`/
  `settled` frames.
- `subscribe_shape` over the poke (`pokeStart`/`pokePart`/`pokeEnd`) partial-
  replication path.
- An async WS **token provider** mirroring the TS `WsTokenProvider`.
- A full `encode_wire` / `decode_wire` value codec (bigint, bytes, `Date`,
  `Map`/`Set`, `URL`, `NaN`/`Infinity`, `undefined`) plus the stable
  subscription key.
- `submit` — the offline-capable write path: cursor-gated optimistic updates
  (`lunora.optimistic`) over the durable replay queue (`lunora.offline`).

> **Not a pnpm/TS package.** This lives under `sdks/python/` and is a standalone
> Python project. The core (RPC + codec + framing) is **standard-library only**;
> only the live WebSocket loop needs the optional `websockets` package.

## Install

```bash
cd sdks/python
pip install -e .            # core only (stdlib)
pip install -e ".[live]"    # + websockets for the live WS loop
```

## Usage

```python
import asyncio
from lunora import LunoraClient, WireBigInt


async def main():
    client = LunoraClient(
        url="https://my-app.example.com",
        auth_token="…",  # bearer for HTTP RPC (optional)
        ws_token=lambda: mint_ephemeral(),  # str | callable | async callable
        client_id="python-client",
        timeout=30,  # seconds; the default transport's `urlopen` timeout, raise for slow actions
    )

    # HTTP RPC
    messages = await client.query("messages:list", {"channel": "general"})
    await client.mutation("messages:send", {"channel": "general", "text": "hi"})
    await client.mutation("ledger:add", {"amount": WireBigInt(1000)})  # v.bigint()

    # Live subscription (needs `websockets`)
    client.subscribe("messages:list", {"channel": "general"}, print)
    await client.connect_and_run()


asyncio.run(main())
```

See [`examples/quickstart.py`](./examples/quickstart.py) for a runnable script.

## Optimistic updates and offline writes

`mutation` is the direct write path: one HTTP round-trip that raises when the
deployment is unreachable. `submit` is the one that survives a dropped socket —
it queues the write, shows a predicted value immediately, and replays in order
once the socket is back.

```python
from lunora import LunoraClient, OfflineQueue

client = LunoraClient(url="https://my-app.example.com", identity=current_user_id)
# Capacity, an app version, and a durable store are all optional; the default is
# an in-memory queue of 1000 writes.
client.offline_queue = OfflineQueue(max_items=500, persistence=my_store, version="v2")

client.subscribe("messages:list", {"channel": "general"}, render)

outcome = await client.submit(
    "messages:send",
    {"channel": "general", "text": "hi"},
    # Layered onto the subscription registered under the same (path, args, shard).
    # Re-run on every server frame, so derive from `current` rather than closing
    # over a value.
    optimistic=lambda current: [*(current or []), {"text": "hi", "pending": True}],
    # Re-checked just before a QUEUED write replays: False drops it instead of
    # replaying a write that can only fail.
    precondition=lambda: channel_still_exists("general"),
    on_settled=lambda event: print(event.status, event.mutation_id),
)

if outcome.queued:
    ...  # durably queued, not committed — don't report success yet
```

The overlay drops the moment a frame whose `cursor` reaches the write's echoed
`commitCursor` arrives, so the confirming frame never double-counts it; a failed
write rolls back. `client.flush_offline_queue(shard_key)` replays a shard's queued
writes when its socket returns (`connect_and_run` does it for you), and
`client.hydrate_offline_queue()` restores what a prior session persisted.

`client.identity` is an opaque, **non-secret** stamp — a user id, not a bearer
token. It is persisted with every queued write and re-checked before that write
replays, so a restart cannot push one user's queued writes as another.

`sdks/README.md` records where these deliberately differ from `@lunora/client`
(chiefly: `submit` returns as soon as the write is queued rather than staying
pending until it replays).

## Wire types

Python lacks TS's distinct `bigint`/`Map`/`Set`/`Date` types, so mark those
explicitly with wrappers; plain values map to JSON directly:

| Lunora / `v.*`                         | Python                                              |
| -------------------------------------- | --------------------------------------------------- |
| `v.string/number/boolean/object/array` | `str` / `int`\|`float` / `bool` / `dict` / `list`   |
| `v.bigint()`                           | `WireBigInt(1000)`                                  |
| `v.bytes()`                            | `bytes` (or `WireBytes(data, "Float32Array")`)      |
| `Date`                                 | `WireDate(epoch_ms)` / `WireDate.from_datetime(dt)` |
| `Map` / `Set`                          | `WireMap([(k, v)])` / `WireSet([...])`              |
| `URL`                                  | `WireUrl("https://…")`                              |

`decode_wire` returns these same wrappers so values round-trip exactly.

## Tests

The suite drives the SDK against the **shared** golden fixtures in
`protocol/fixtures/` — the identical files the TypeScript client is tested
against (`packages/client/__tests__/protocol-conformance.test.ts`).

```bash
cd sdks/python
python -m unittest discover -s tests     # stdlib, no extra deps
# or, if pytest is installed:
python -m pytest
```
