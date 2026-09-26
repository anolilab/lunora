# Lunora Python SDK

A minimal, **protocol-conformant** Python client for a Lunora deployment — the
first non-TypeScript SDK, proving the Lunora wire protocol is not TS-bound.

It implements the transport specified in
[`protocol/README.md`](../../protocol/README.md):

- `query` / `mutation` round-trips over `POST /_lunora/rpc`.
- Live `subscribe` — and `stream`, an async generator for `async for` — over the WebSocket `data`/`delta`/`ack`/`error`/`resume`/
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
        timeout=30,  # seconds; the default transport's `urlopen` timeout, raise for slow actions
        # client_id is minted per instance when omitted. Pin a stable per-device
        # one only when the offline queue is durable — a replayed write is
        # namespaced server-side under the id that issued it.
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

Subscribing before `connect_and_run` is convenient, not required: an outbound
frame is written the moment it is produced, by a writer task running alongside
the read loop, so a `subscribe` / `unsubscribe` / `subscribe_shape` issued from
another coroutine — or another thread — goes out immediately whether or not the
server has anything to say. `connect_and_run` returns when the socket closes and
re-raises a failed write, so the caller reconnects; `resend_subscriptions` (which
it calls for you) puts the subscriptions back with their resume cursors.

**Keepalive is the `websockets` library's, not an application frame.** This
transport never sends `lunora-ping`; `websockets` sends a protocol-level ping
every 20 s and closes the connection when one goes unanswered for another 20 s,
which keeps an idle path open through a NAT or proxy AND ends the read loop on a
peer that has stopped answering — the two jobs the reference client's heartbeat
does. Measured over a 50 s idle connection: two pings and two pongs each way, no
application traffic, socket still open. The inbound `lunora-pong` a differently
configured peer may send is ignored.

## Optimistic updates and offline writes

`mutation` is the direct write path: one HTTP round-trip that raises when the
deployment is unreachable. `submit` is the one that survives a dropped socket —
it queues the write, shows a predicted value immediately, and replays in order
once the socket is back.

```python
from lunora import LunoraClient, OfflineQueue, SubmitOptions

client = LunoraClient(url="https://my-app.example.com", identity=current_user_id)
# Capacity, an app version, and a durable store are all optional; the default is
# an in-memory queue of 1000 writes.
client.offline_queue = OfflineQueue(max_items=500, persistence=my_store, version="v2")

client.subscribe("messages:list", {"channel": "general"}, render)

outcome = await client.submit(
    SubmitOptions(
        function_path="messages:send",
        args={"channel": "general", "text": "hi"},
        # Names the query the write affects. The `optimistic=` shorthand is for
        # the narrower case where the write and the subscription share a path
        # and args (a counter, a document by id) — it patches nothing here,
        # where `send` and `list` are different functions. Keep every transform
        # pure: the fold re-runs inside the client's lock on each server frame.
        optimistic_update=lambda store, args: store.set_query(
            "messages:list",
            {"channel": args["channel"]},
            [*(store.get_query("messages:list", {"channel": args["channel"]}) or []), {"text": args["text"], "pending": True}],
        ),
        # Re-checked just before a QUEUED write replays: False drops it instead
        # of replaying a write that can only fail.
        precondition=lambda: channel_still_exists("general"),
        on_settled=lambda event: print(event.status, event.mutation_id),
    )
)

if outcome.queued:
    ...  # durably queued, not committed — don't report success yet
```

The overlay drops the moment a frame whose `cursor` reaches the write's echoed
`commitCursor` arrives, so the confirming frame never double-counts it; a failed
write rolls back. `client.flush_offline_queue(shard_key)` replays a shard's queued
writes when its socket returns (`connect_and_run` does it for you), and
`client.hydrate_offline_queue()` restores what a prior session persisted.

A queued write whose args cannot be wire-encoded settles terminally on the first
flush (`OFFLINE_WRITE_UNENCODABLE`) rather than being retried forever, and every
discard — including one the capacity cap evicts out of a _restored_ queue, which
has no caller left to tell — is reported to `client.on_mutation_settled`.

`client.identity` is an opaque, **non-secret** stamp — a user id, not a bearer
token. It is persisted with every queued write and re-checked before that write
replays, so a restart cannot push one user's queued writes as another.
Changing it FROM a set value (a sign-out, or another user signing in) evicts the
previous session: every query and shape subscription drops its resume cursor and
epoch, each query's callbacks receive its blanked value (`None` unless an
optimistic layer is pending), and each shape view is emptied with its callbacks
told `[]`. A first sign-in and re-setting the same value evict nothing. The
eviction does not replace the socket — reconnect (`connect_and_run` again) so
the next resubscribe is a cold one under the new credentials.

How a replayed write settles, on the single-call and the batch path alike:

- A **coded** error envelope is the server's verdict and is classified by its
  code alone, whatever the HTTP status: `SHARD_UNAVAILABLE`, `SHARD_ERROR`,
  `RATE_LIMITED` and `TOO_MANY_REQUESTS` re-queue, and so do the refused
  credentials `UNAUTHORIZED`, `TOKEN_EXPIRED` and `UNAUTHENTICATED` (the write
  is held for a fresh token, not destroyed — while `connect_and_run` is live,
  setting a different `client.auth_token` re-flushes its shard; otherwise call
  `flush_offline_queue` after setting it, as on a reconnect. On an account
  switch set `client.identity` first, so the replay is judged against the new
  user); every other code — a coded 500 and
  a server-sent `WIRE_DECODE_FAILED` included — settles `rejected`. An envelope
  whose `data` does not decode keeps its code, with `data` dropped.
- A reply with **no envelope** (an edge page, a proxy, a body that is not a JSON
  object) re-queues, except a **413**, which is `PAYLOAD_TOO_LARGE` whatever its
  body: a batch is halved and retried, and a lone write still refused settles
  `rejected` with that code.
- A **success whose `result` does not decode** committed: it settles
  `committed` with `event.error.code == "WIRE_DECODE_FAILED"` and no value, and
  is never replayed. A direct `query`/`mutation`/`action` raises the same
  `LunoraError`; every failure of those three is a `LunoraError`.
- A flush that is interrupted by an unexpected exception puts every drained write
  it had not settled back at the front of the queue, in order.

`client.close()` also ends every `stream()` loop and makes `connect_and_run`
return. A subscription or shape callback that raises is isolated: the others
queued for the same frame still run. A poke is applied per shape whole or not at
all — a row that does not decode leaves that shape's view and checkpoint as they
were and reports `WIRE_DECODE_FAILED` to its error callbacks. A later poke whose
`baseCheckpoint` is not the view's checkpoint (or whose epoch forked), unless it
is a reset, empties the view, tells its callbacks `[]`, skips its rows and sends
a cold `shape_subscribe` so the server re-seeds it. `connect_and_run`
accepts inbound messages up to 32 MiB (`MAX_WS_FRAME_BYTES`, the Workers
per-message WebSocket limit) instead of `websockets`' 1 MiB default.

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

A JSON number off the wire is a float64 whatever its spelling. `json.loads` types
an integer literal as `int`, so `decode_wire` turns one outside ±(2**53 − 1) into
the `float` `JSON.parse` reads (`9007199254740993` decodes to
`9007199254740992.0`) — `JSON.stringify` writes every double in [2**53, 1e21)
that way. An `int` you construct past that range is still refused by
`encode_wire`: wrap it in `WireBigInt`.

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
