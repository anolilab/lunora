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
        auth_token="…",                       # bearer for HTTP RPC (optional)
        ws_token=lambda: mint_ephemeral(),    # str | callable | async callable
        client_id="python-client",
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

## Wire types

Python lacks TS's distinct `bigint`/`Map`/`Set`/`Date` types, so mark those
explicitly with wrappers; plain values map to JSON directly:

| Lunora / `v.*`     | Python                                             |
| ------------------ | -------------------------------------------------- |
| `v.string/number/boolean/object/array` | `str` / `int`\|`float` / `bool` / `dict` / `list` |
| `v.bigint()`       | `WireBigInt(1000)`                                 |
| `v.bytes()`        | `bytes` (or `WireBytes(data, "Float32Array")`)     |
| `Date`             | `WireDate(epoch_ms)` / `WireDate.from_datetime(dt)` |
| `Map` / `Set`      | `WireMap([(k, v)])` / `WireSet([...])`             |
| `URL`              | `WireUrl("https://…")`                             |

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
