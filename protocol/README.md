# Lunora wire protocol

A **language-independent** specification of the Lunora client↔server protocol,
extracted from the reference TypeScript client (`@lunora/client`) and the Worker
runtime (`@lunora/runtime` + `@lunora/do`). It exists so an SDK in **any**
language can talk to a Lunora deployment.

This document is normative. The golden frames under [`fixtures/`](./fixtures) are
the machine-checkable form of it: the TS client is tested against them
(`packages/client/__tests__/protocol-conformance.test.ts`) and every non-TS SDK
targets the same files (e.g. `sdks/python/tests/test_conformance.py`).

- Reference implementation anchors:
    - Worker endpoints / RPC + WS handshake: `packages/runtime/src/create-worker.ts`
    - RPC + WS client: `packages/client/src/lunora-client.ts`
    - Live-subscription state: `packages/client/src/subscription.ts`
    - Value codec: `shared/wire-codec.ts`; stable key: `shared/wire-key.ts`
    - HTTP-SSE stream framing: `packages/client/src/http-stream.ts`
    - Ephemeral WS admin token (plan 095): `shared/ws-admin-token.ts`

## 1. Transport overview

A deployment exposes one Worker origin (e.g. `https://app.example.com`).

| Concern                     | Transport | Endpoint                       |
| --------------------------- | --------- | ------------------------------ |
| query / mutation / action   | HTTP POST | `POST /_lunora/rpc`            |
| batched RPC                 | HTTP POST | `POST /_lunora/rpc-batch`      |
| live subscriptions, shapes  | WebSocket | `GET /_lunora/ws`              |
| HTTP streaming routes (SSE) | HTTP GET  | `<user route>` (SSE body)      |
| health probe                | HTTP GET  | `GET /_lunora/status`          |
| ephemeral WS token          | HTTP POST | `POST /_lunora/admin/ws-token` |

All JSON bodies are UTF-8 `application/json`. Every value that crosses the wire
is first run through the **wire value codec** (§2): pure-JSON values are
byte-identical, and JSON-hostile leaves (bigint, bytes, Date, …) become tagged
tokens.

The WebSocket URL is derived from the origin by swapping the scheme
(`https`→`wss`, `http`→`ws`) and appending `/_lunora/ws`. Query params:
`?shard=<key>` selects a non-default shard (omitted for the default shard);
`?token=<credential>` carries the WS credential (§6).

## 2. The wire value codec (`encodeWire` / `decodeWire`)

The wire is JSON with **no reviver**. To carry values JSON cannot represent, each
such leaf is encoded as a self-delimiting tagged array whose first element is the
sentinel string:

```
TAG = "$lunora.wire$"
```

A JSON array is "tagged" **only** when its first element equals `TAG`. Pure-JSON
values (objects, arrays, strings, finite numbers, booleans, `null`) encode to a
structurally identical tree — a pre-codec peer interops unchanged.

### 2.1 Encoding grammar

| JS / native value                    | Wire form                                                      |
| ------------------------------------ | -------------------------------------------------------------- |
| `null`, boolean, string, finite num  | itself (identity)                                              |
| `bigint`                             | `[TAG, "bigint", "<decimal string>"]`                          |
| `NaN`                                | `[TAG, "nan"]`                                                 |
| `Infinity`                           | `[TAG, "inf"]`                                                 |
| `-Infinity`                          | `[TAG, "-inf"]`                                                |
| `undefined` **in an array position** | `[TAG, "undefined"]`                                           |
| `undefined` as an **object field**   | field is **dropped** (matches `JSON.stringify`)                |
| `Date`                               | `[TAG, "date", <epoch-ms, itself wire-encoded>]`               |
| `URL`                                | `[TAG, "url", "<href>"]`                                       |
| `Map`                                | `[TAG, "map", [[k, v], …]]` (entries recurse, insertion order) |
| `Set`                                | `[TAG, "set", [item, …]]` (insertion order)                    |
| `Uint8Array`                         | `[TAG, "bytes", "<base64>"]`                                   |
| `ArrayBuffer`                        | `[TAG, "bytes", "<base64>", "ArrayBuffer"]`                    |
| other typed array (`Float32Array`…)  | `[TAG, "bytes", "<base64>", "<CtorName>"]`                     |
| `Error`                              | `[TAG, "error", name, message, ownProps {}, cause?]`           |
| array literally starting with `TAG`  | `[TAG, "arr", [<encoded elements>]]` (escape)                  |
| plain object / array                 | recurse                                                        |

Notes that a port MUST honour:

- **base64** is standard (padded) base64, as produced by `btoa` /
  `base64.b64encode`.
- **Date** epoch-ms is routed back through the encoder, so an _invalid_ Date
  (`NaN` time) encodes as `[TAG, "date", [TAG, "nan"]]` and round-trips exactly.
- **Error** omits `stack` (untrusted-peer redaction). `ownProps` is an object of
  the error's own enumerable keys (e.g. a `LunoraError`'s `code`/`data`). A 6th
  element carries `cause` when present.
- **Depth** is capped at 64 levels (throw beyond). On decode, a `bigint` digit
  string is rejected beyond 1024 digits, and `__proto__` keys are assigned as
  plain data properties (never via the prototype setter).
- **Forward-compat**: an unknown tag is decoded as an ordinary array; an unknown
  typed-array ctor name decodes to raw bytes.

### 2.2 Native-type mapping for a non-TS SDK

TypeScript has distinct `bigint` / `number` / `Map` / `Set` / `Date` types; most
languages do not. A port SHOULD provide lightweight wrappers (`WireBigInt`,
`WireDate`, `WireMap`, `WireSet`, `WireUrl`, `WireBytes`, `WireError`,
`Undefined`) so that (a) users can explicitly mark a value as a `bigint`/etc.,
and (b) `decode` produces a value that re-`encode`s to the identical tag —
guaranteeing `encode(decode(x)) == x` (the conformance contract). Plain
ints/floats/dicts/lists map to JSON numbers/objects/arrays.

Golden cases: [`fixtures/wire-codec.json`](./fixtures/wire-codec.json).

## 3. Stable subscription key

Subscriptions are de-duplicated by a stable key over `(functionPath, args,
shardKey)`:

```
key = functionPath + "::" + stableWireKey(args) + "::" + (shardKey ?? "")
stableWireKey(v) = stableStringify(encodeWire(v))
```

`stableStringify` is a canonical JSON encoding: **object keys sorted at every
depth** (code-point order), arrays keep order, `null` fields are kept, and
`undefined` object fields are dropped. Two structurally-equal arg records with
different key insertion order collapse to one key.

Golden cases: [`fixtures/stable-wire-key.json`](./fixtures/stable-wire-key.json).

## 4. RPC envelope (`POST /_lunora/rpc`)

### 4.1 Request

Headers:

- `content-type: application/json`
- `authorization: Bearer <token>` — when an auth token is set.
- `x-lunora-mutation-id: <id>` — idempotency key for a mutation replay (optional).
- `x-lunora-client-id` / `x-lunora-client-seq` — custom-mutator push path (optional).
- `x-d1-bookmark: <bookmark>` — D1 read-your-writes (optional).

Body:

```json
{ "args": <encodeWire(args)>, "functionPath": "<file>:<fn>", "shardKey": "<key?>" }
```

`shardKey` is omitted when routing to the default shard. `functionPath` is the
`"<file>:<function>"` identifier codegen emits (e.g. `"messages:list"`).

Golden cases: [`fixtures/rpc.json`](./fixtures/rpc.json) → `request`.

### 4.2 Response

Success:

```json
{ "result": <encodeWire(value)>, "commitCursor": <int?>, "lastMutationId": <int?> }
```

The client returns `decodeWire(result)`. `commitCursor` (CDC commit position)
and `lastMutationId` (per-client watermark) are optional echoes.

Failure — the body carries an `error` envelope (HTTP status also non-2xx):

```json
{ "error": { "code": "<CODE>", "message": "<msg>", "data": <encodeWire(data)?>, "hint": <string|string[]?>, "docsUrl": <string?> } }
```

The client raises an error carrying `code`, `message`, and `decodeWire(data)`.
A non-2xx response whose JSON body has no `error` envelope is surfaced as an
`INTERNAL` transport error.

Golden cases: [`fixtures/rpc.json`](./fixtures/rpc.json) → `responseOk`, `responseError`.

## 5. WebSocket subscription protocol (`GET /_lunora/ws`)

Frames are JSON text. A keepalive is the literal non-JSON string `lunora-ping`
(the server auto-responds `lunora-pong` without waking the DO); non-JSON frames
are ignored by the client parser.

### 5.1 Client → server frames

| `type`                                      | Shape                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `connect`                                   | `{ type, id: "connect", clientId?, context? }` — one-shot, first on open     |
| `subscribe`                                 | `{ type, id, query: { functionPath, args, table, sinceSeq?, sinceEpoch? } }` |
| `unsubscribe`                               | `{ type, id }`                                                               |
| `shape_subscribe`                           | `{ type, id, shape: { name, args? }, sinceCheckpoint?, sinceEpoch? }`        |
| `shape_unsubscribe`                         | `{ type, id }`                                                               |
| `stream`                                    | `{ type, id, query: { functionPath, args?, shardKey? } }`                    |
| `whisper_subscribe` / `whisper_unsubscribe` | `{ type, topic }`                                                            |
| `whisper`                                   | `{ type, topic, data? }`                                                     |

`subscribe.query.args` is `encodeWire(args)`. `table` defaults to
`functionPath` (unless codegen surfaced a distinct table). `sinceSeq` /
`sinceEpoch` ride along only on a resume. Subscription ids are conventionally
`sub_<n>`; shape ids `shape_<n>`; stream ids `stream_<n>`.

The `connect` frame is sent once per socket open, **before** resubscribing, so
`onConnect`/`onDisconnect` lifecycle hooks fire symmetrically.

### 5.2 Server → client frames

| `type`     | Shape                                                          | Effect                                                                    |
| ---------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `ack`      | `{ type, id }`                                                 | subscription acknowledged                                                 |
| `data`     | `{ type, id, data: <wire>, cursor?, epoch?, lastMutationId? }` | deliver `decodeWire(data)` as the new value                               |
| `delta`    | `{ type, id, delta: <wire>, cursor?, epoch? }`                 | merge delta into server base (falls back to replace)                      |
| `resume`   | `{ type, id, cursor?, epoch?, lastMutationId? }`               | nothing changed; keep value, advance cursor                               |
| `settled`  | `{ type, id, cursor?, epoch?, lastMutationId? }`               | write touched tables, byte-identical result; advance only                 |
| `error`    | `{ type, id?, error: { code?, message? }, message? }`          | subscription/stream-scoped error (`4001`/`TOKEN_EXPIRED` = token expired) |
| `complete` | `{ type, id }`                                                 | subscription/stream closed server-side                                    |
| `chunk`    | `{ type, id, data: <wire> }`                                   | one streaming-query chunk                                                 |
| `whisper`  | `{ type, topic, data: <wire>, from? }`                         | ephemeral relay                                                           |

### 5.3 Shape poke protocol (partial replication)

A poke is an atomically-applied batch of shape diffs:

1. `{ type: "pokeStart", pokeId, baseCheckpoint?, epoch? }`
2. zero+ `{ type: "pokePart", pokeId, shapeId, rowsPatch: RowOp[], lastMutationId? }`
3. `{ type: "pokeEnd", pokeId, checkpoint?, epoch? }`

A `RowOp` is `{ op: "insert"|"update"|"delete", key, table, value? }`. The client
**buffers** every part per `pokeId` and applies them in one transaction at
`pokeEnd`: `insert`/`update` set `key → decodeWire(value)` in the shape's keyed
view; `delete` removes `key` (a value-less upsert is a membership-only no-op).
The view's checkpoint advances to `pokeEnd.checkpoint`. A socket that drops
mid-poke discards the buffer and re-seeds on reconnect (no torn view). An
`epoch` mismatch or a `baseCheckpoint` gap forces a full re-seed.

Golden cases: [`fixtures/ws-frames.json`](./fixtures/ws-frames.json).

## 6. Auth & the ephemeral WS token (plan 095)

- **HTTP RPC** auth is the `authorization: Bearer <token>` header.
- **WebSocket** auth rides the `?token=` query param (browsers cannot set WS
  headers). The server matches it against `LUNORA_WS_BEARER` (upgrade gate) and/or
  `LUNORA_ADMIN_TOKEN` (admin subscriptions).

Because a URL token lands in logs/history, the studio path uses a short-lived
**ephemeral sub-token**. `POST /_lunora/admin/ws-token` (authenticated by the
master admin token in the `Authorization` **header**) returns
`{ token, expiresAtMs }`, where:

```
token = "v1." + expEpochMs + "." + base64url(HMAC_SHA256(key = LUNORA_ADMIN_TOKEN, msg = "v1." + expEpochMs))
```

Default TTL 60s. Verification is stateless (worker and DO both hold the master
token in `env`); rotating the master token invalidates all outstanding
sub-tokens.

A client SHOULD accept an **async token provider** (`() -> token`) resolved fresh
on every (re)connect, so a short-lived credential is re-minted after a `4001`
`token_expired` close. The TS contract is `WsTokenProvider`
(`packages/client/src/types.ts`).

## 7. HTTP streaming routes (SSE)

`httpRoute.<verb>(path).stream()` routes stream Server-Sent Events: one
`data: <json>\n\n` frame per chunk, a terminal `event: complete` frame, and an
`event: error` frame carrying `{ code, message }` on throw. Frames are separated
by `\n\n`; multiple `data:` lines join with `\n`; one optional space after the
field colon is stripped. See `packages/client/src/http-stream.ts`.

## 8. Conformance

An SDK is protocol-conformant when it passes, against the shared fixtures:

1. `encode(decode(encoded)) == encoded` for every `wire-codec.json` case.
2. `stableWireKey` matches every `stable-wire-key.json` case.
3. RPC request bodies and response parsing match `rpc.json`.
4. Client WS frame builders and the server-frame consumer match `ws-frames.json`,
   including the poke sequence materialising `shape.expectedRows`.

The TS reference test is `packages/client/__tests__/protocol-conformance.test.ts`;
the Python port is `sdks/python/tests/test_conformance.py`.
