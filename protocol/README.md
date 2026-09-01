# Lunora wire protocol

A **language-independent** specification of the Lunora client↔server protocol,
extracted from the reference TypeScript client (`@lunora/client`) and the Worker
runtime (`@lunora/runtime` + `@lunora/do`). It exists so an SDK in **any**
language can talk to a Lunora deployment.

This document is normative. The golden frames under [`fixtures/`](./fixtures) are
the machine-checkable form of it: the TS client is tested against them
(`packages/client/__tests__/protocol-conformance.test.ts`) and every non-TS SDK
targets the same files (see `sdks/README.md`).

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
- **Map entries** are exactly two elements. A shorter or LONGER entry is
  refused — a decoder that reads slots 0 and 1 out of a 3-element entry accepts
  a frame the reference throws on.
- **Duplicate map keys collapse, last value wins, at the FIRST occurrence's
  position** — the reference decodes into a real `Map`, and `Map.prototype.set`
  on a key already present overwrites in place. So
  `[TAG, "map", [["a",1],["b",2],["a",3]]]` decodes to two entries and
  re-encodes as `[["a",3],["b",2]]`. Keys collapse under SameValueZero: the
  scalar kinds (`null`, `undefined`, boolean, number — `NaN` equal to itself —
  string, `bigint`) compare by VALUE, and everything else (`Date`, `URL`, bytes,
  a nested `Map`/`Set`, an object or array) compares by REFERENCE, so two
  structurally identical non-scalar keys stay two entries.
- **Error** `ownProps` is neither optional nor nullable: the reference reads it
  with `Object.keys`, which throws on a missing or `null` slot, so a 4-element
  error tag and `[TAG, "error", n, m, null]` are both refused.
- **Typed arrays** must carry a whole number of elements: a payload whose byte
  length is not a multiple of the named view's element size is refused, because
  the reference builds the view with its real constructor and
  `new Float32Array(buffer)` raises a `RangeError` on 3 bytes.
- **Forward-compat**: an unknown tag is decoded as an ordinary array; an unknown
  typed-array ctor name decodes to raw bytes, DROPPING the name — so it
  re-encodes as the 3-element `Uint8Array` form, not as the 4-element form it
  arrived in. (A name it does not recognise carries no element size, so the
  alignment rule above does not apply to it.)

### 2.2 Native-type mapping for a non-TS SDK

TypeScript has distinct `bigint` / `number` / `Map` / `Set` / `Date` types; most
languages do not. A port SHOULD provide lightweight wrappers (`WireBigInt`,
`WireDate`, `WireMap`, `WireSet`, `WireUrl`, `WireBytes`, `WireError`,
`Undefined`) so that (a) users can explicitly mark a value as a `bigint`/etc.,
and (b) `decode` produces a value that re-`encode`s to the identical tag —
guaranteeing `encode(decode(x)) == x` (the conformance contract, modulo the two
shapes in §2.3 that are not fixed points of it). Plain ints/floats/dicts/lists
map to JSON numbers/objects/arrays.

Golden cases: [`fixtures/wire-codec.json`](./fixtures/wire-codec.json).

### 2.3 Conformance fixture schema (`reencoded`, `rejected[]`)

`fixtures/wire-codec.json` carries two fields beyond `cases[].encoded`, and all
eight SDK suites are driven by them. The file's own `$comment` is the
authoritative description; this is the summary.

- **`cases[].reencoded`** — the expected re-encoding, for the shapes that are
  legitimately NOT fixed points of `encode(decode(encoded)) == encoded`. There
  are four: a bare `[TAG]` array, which is escaped on the way back out as
  `[TAG, "arr", [TAG]]`; an object field holding the `undefined` tag, which is
  dropped (matching `JSON.stringify`); a `bytes` tag naming an unknown
  typed-array ctor, which decodes to raw bytes and re-encodes without the name;
  and a `map` carrying a duplicate key, which collapses last-wins. When a case
  carries `reencoded` the assertion becomes
  `encode(decode(encoded)) == reencoded`. Without it those shapes were
  untestable, so no port was held to them — and four ports decoded the first two
  differently, while all eight kept the ctor name and both duplicate entries.
- **`rejected[]`** — wire values every conforming codec MUST refuse to decode.
  These are data for the same reason the case list is: a rejection each suite
  hard-codes for itself is a rejection only some suites have. The base64 entries
  are what a lenient hand-rolled decoder lets through — the reference decodes via
  `atob`, which fails any input whose length is 1 mod 4 once ASCII whitespace is
  removed, so a truncated or padding-corrupted payload is an error rather than
  valid-looking short bytes. (Whitespace INSIDE the payload is deliberately not
  listed: `atob` strips it, so the reference accepts it, and a fixture demanding
  rejection would be asserting against the reference.)

Language-native construction checks — a native bigint `7` producing the bigint
tag, an integer past the exact-`float64` range being refused — live in each SDK's
own suite, keyed by [`conformance-cases.json`](./conformance-cases.json),
because native values are not
uniformly JSON-representable.

## 3. Stable subscription key

Subscriptions are de-duplicated by a stable key over `(functionPath, args,
shardKey)`:

```
key = functionPath + "::" + stableWireKey(args) + "::" + (shardKey ?? "")
stableWireKey(v) = stableStringify(encodeWire(v))
```

`stableStringify` is a canonical JSON encoding: **object keys sorted at every
depth** (UTF-16 **code-unit** order), arrays keep order, `null` fields are kept,
and `undefined` object fields are dropped. Two structurally-equal arg records
with different key insertion order collapse to one key.

Code-unit order, not code-point order: the reference implementation is
`Object.keys(record).sort()`, whose default comparator compares UTF-16 code
units. The two orders disagree for any key that starts with a surrogate — an
emoji key sorts **before** a U+E000..U+FFFF key under code units and **after**
it under code points. A port must therefore not use its language's natural
string ordering if that ordering is by code point (Python `sorted`, Go
`sort.Strings`, Rust `str` `Ord`): re-key on the UTF-16 code units first. The
`key-order-surrogate-vs-pua` golden case below is the one that catches this;
every other ordering case is ASCII, where the two orders agree.

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

### 4.3 Batched RPC (`POST /_lunora/rpc-batch`)

**Optional.** A client that does not implement it is fully conformant — every
call it carries can be made one at a time over §4.1. It exists for one case: a
client replaying an offline queue on reconnect, where N queued writes would
otherwise cost N round trips.

Request:

```json
{
    "calls": [
        {
            "functionPath": "messages:send",
            "args": <encodeWire(args)>,
            "id": 0,
            "mutationId": "<key?>",
            "clientId": "<id?>",
            "shardKey": "<key?>"
        }
    ]
}
```

`id` is the caller-assigned slot the result comes back in; absent, it defaults to
the array index. `args` MUST be an object (absent → `{}`) — a string, number or
array is rejected at the boundary. `mutationId` is per ENTRY, never a header on
the outer request: a batch is one transport hop, but its entries are dispatched
as independent single calls, so each carries its own idempotency key.

`clientId` is per entry for the same reason, and a client replaying a durable
write MUST send it. The shard namespaces an idempotency row by the caller's
verified user id; an ANONYMOUS caller has none and falls back to this, and with
neither there is no namespace and the row cannot be read back — so the write
re-runs on every retry, which is precisely what the rules below rely on not
happening. Send the id that ISSUED the write, not the one the current session
minted, or a replay after a restart lands in a different namespace and applies
twice. The single-call endpoint carries the same value in the
`x-lunora-client-id` header. Reserved
`__lunora_relation__:` / `__lunora_admin__` paths cannot be batched. A batch is
capped at **500** entries; a longer flush chunks, and the chunks must be sent
sequentially to preserve order.

Response:

```json
{ "results": [{ "id": 0, "body": { "result": <wire>, "commitCursor": <int?> } }] }
```

Each slot's `body` is exactly a §4.2 envelope — `{ result }` or `{ error }` — so
a client classifies a slot the way it classifies a whole single-call response.
Three rules a conforming client MUST follow, because each one is a durable write:

- A slot whose `error.code` is `SHARD_UNAVAILABLE` or `SHARD_ERROR` is
  **transient**: the server reached no verdict on that entry, so it is retried
  rather than reported failed. Every other coded error is a verdict, and terminal.
- A slot the server never returned is **retried** — it may or may not have
  committed, and the entry's `mutationId` is what makes that safe.
- A body with **no** `results` array is a whole-batch outcome: a coded `{ error }`
  is a verdict on every entry and terminal, anything else (a non-JSON body, a
  bare 5xx) is transient and retries the whole chunk.

No golden fixtures, and no case in `conformance-cases.json`: the endpoint is
optional, so requiring it would fail the seven SDKs that correctly do not
implement it. `sdks/README.md` records which do.

## 5. WebSocket subscription protocol (`GET /_lunora/ws`)

Frames are JSON text. A keepalive is the literal non-JSON string `lunora-ping`
(the server auto-responds `lunora-pong` without waking the DO); non-JSON frames
are ignored by the client parser.

### 5.1 Client → server frames

| `type`                                      | Shape                                                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `connect`                                   | `{ type, id: "connect", clientId?, caps?, context? }` — one-shot, first on open     |
| `subscribe`                                 | `{ type, id, query: { functionPath, args, table, sinceSeq?, sinceEpoch? } }`        |
| `unsubscribe`                               | `{ type, id }`                                                                      |
| `shape_subscribe`                           | `{ type, id, shape: { name, args? }, sinceCheckpoint?, sinceEpoch? }`               |
| `shape_unsubscribe`                         | `{ type, id }`                                                                      |
| `stream`                                    | `{ type, id, query: { functionPath, args?, shardKey? }, sinceChunk?, generation? }` |
| `whisper_subscribe` / `whisper_unsubscribe` | `{ type, topic }`                                                                   |
| `whisper`                                   | `{ type, topic, data? }`                                                            |

`subscribe.query.args` is `encodeWire(args)`. `table` defaults to
`functionPath` (unless codegen surfaced a distinct table). `sinceSeq` /
`sinceEpoch` ride along only on a resume. Subscription ids are conventionally
`sub_<n>`; shape ids `shape_<n>`; stream ids `stream_<n>`.

`stream.sinceChunk` is the **durable-stream** resume watermark and is unrelated
to `subscribe.query.sinceSeq` (a CDC cursor): it is the highest `chunk.seq` the
client already holds for this run. A run is identified by `(functionPath, args)`,
so re-sending the same start frame with `sinceChunk` re-attaches to the run
already in flight, replays the chunks after that watermark from the server's
transcript, and then continues live. A server that did not declare the procedure
durable ignores `sinceChunk` and emits chunks without `seq`.

`stream.generation` names **which** run the `sinceChunk` watermark belongs to:
it is the run stamp the server put on every durable `chunk` frame, echoed back
verbatim on a resume. Because the run key is shared across a caller's tabs, the
transcript under it can be replaced between disconnect and resume (another tab
asked fresh and started a new run); a `generation` that does not match the
stored run — or a resume whose run row no longer exists — fails with the
existing `STREAM_INTERRUPTED` error instead of splicing the new run's chunks
onto the prefix the client already holds. Omitting `generation` (older clients)
keeps the previous attach behaviour; ephemeral streams ignore the field
entirely, exactly as they ignore `sinceChunk`.

The `connect` frame is sent once per socket open, **before** resubscribing, so
`onConnect`/`onDisconnect` lifecycle hooks fire symmetrically.

#### 5.1.1 `connect.caps` — capability negotiation

`caps` is an optional array of string tokens naming wire behaviours the client
can handle that older clients cannot. **Omitting it is always safe**, and it is
what an SDK should do until it implements a token: the server then keeps to the
behaviour every client has always understood. A server that does not recognise a
token ignores it, so the field is additive in both directions.

| Token       | The client guarantees                                                                     |
| ----------- | ----------------------------------------------------------------------------------------- |
| `pageDelta` | It can merge a `delta` frame's `RowOp` into the `page` array of a paginated query result. |

**`pageDelta` in detail.** A paginated read (`.paginate()`) returns
`{ page: [...], isDone, continueCursor }` — an object, not an array. Without this
token the server must re-send that whole object as a `data` snapshot on every
write touching the query's tables, because a client that cannot merge into `page`
does not _ignore_ such a delta — the reference client replaces the entire query
value with the raw delta object. Announcing `pageDelta` lets the server send one
`delta` per changed row instead.

A conforming `pageDelta` client applies a delta to a paginated value by merging
the `RowOp` into `page` **by `_id`**, exactly as it would for a bare array
result, and returning the surrounding fields unchanged. The server only sends
page deltas when every field outside `page` is byte-identical to the last
delivered value, so a moved `continueCursor` or a flipped `isDone` always arrives
as a full `data` snapshot instead.

**Insert placement.** An `insert` op carries no index, so a merging client
decides the position itself: if the new row and its neighbours all carry a
numeric `_creationTime`, insert before the first neighbour that breaks the
list's own direction (ascending → first larger, descending → first smaller);
otherwise append. This rule is normative, and the server depends on it — before
sending any batch containing an `insert` it replays this exact placement and
falls back to a `data` snapshot when the result would not match the order its
query returned. A read ordered by a `.withIndex()` field rather than by
`_creationTime` is the common case where it does not match.

That is what makes the merge exact: apply the frames for one push and a
conforming client holds precisely the value the `data` snapshot would have
carried. An SDK that implements a _different_ placement rule breaks the
guarantee silently — the server will have cleared a batch your merge then
misplaces, and it advances its diff baseline as if you had applied it — so
implement this rule as written, and assert it against the `pageDeltaFrames`
goldens in [`fixtures/ws-frames.json`](./fixtures/ws-frames.json).

Those cases live under their own key rather than in `serverFrames` because they
**merge** into a cached `baseWire` instead of replacing it, and an SDK that has
not implemented `pageDelta` must keep applying `serverFrames` by replacement.
Run `pageDeltaFrames` only once you announce the token.

### 5.2 Server → client frames

| `type`     | Shape                                                           | Effect                                                                     |
| ---------- | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `ack`      | `{ type, id }`                                                  | subscription acknowledged                                                  |
| `data`     | `{ type, id, data: <wire>, cursor?, epoch?, lastMutationId? }`  | deliver `decodeWire(data)` as the new value                                |
| `delta`    | `{ type, id, delta: <wire>, cursor?, epoch?, lastMutationId? }` | merge delta into server base; the LAST frame of a run carries the cursor   |
| `resume`   | `{ type, id, cursor?, epoch?, lastMutationId? }`                | nothing changed; keep value, advance cursor                                |
| `settled`  | `{ type, id, cursor?, epoch?, lastMutationId? }`                | write touched tables, byte-identical result; advance only                  |
| `error`    | `{ type, id?, error: { code?, message? }, message? }`           | subscription/stream-scoped error (`4001`/`TOKEN_EXPIRED` = token expired)  |
| `complete` | `{ type, id }`                                                  | subscription/stream closed server-side                                     |
| `chunk`    | `{ type, id, data: <wire>, seq?, generation? }`                 | one streaming-query chunk (`seq` + run `generation` on a durable run only) |
| `whisper`  | `{ type, topic, data: <wire>, from? }`                          | ephemeral relay                                                            |

### 5.3 Shape poke protocol (partial replication)

A poke is an atomically-applied batch of shape diffs:

1. `{ type: "pokeStart", pokeId, baseCheckpoint?, epoch? }`
2. zero+ `{ type: "pokePart", pokeId, shapeId, rowsPatch: RowOp[], lastMutationId?, baseCheckpoint?, reset? }`
3. `{ type: "pokeEnd", pokeId, checkpoint?, epoch? }`

A `RowOp` is `{ op: "insert"|"update"|"delete", key, table, value? }`. The client
**buffers** every part per `pokeId` and applies them in one transaction at
`pokeEnd`: `insert`/`update` set `key → decodeWire(value)` in the shape's keyed
view; `delete` removes `key` (a value-less upsert is a membership-only no-op).
The view's checkpoint advances to `pokeEnd.checkpoint`. A socket that drops
mid-poke discards the buffer and re-seeds on reconnect (no torn view). An
`epoch` mismatch or a `baseCheckpoint` gap forces a full re-seed.

A buffer is released at `pokeEnd`, and a poke abandoned mid-flight never sends
one — so a client MUST bound its pending buffers and evict oldest-first, rather
than let them accumulate for its lifetime. This is not only a leak: `pokeId`
resets when the DO is evicted, so a stale buffer can be reached by a LATER
poke's `pokeEnd` and apply rows the client should never have seen.

**`pokeId` is unique per shard socket, not per client.** It comes from a per-DO
counter that also resets when the DO is evicted, so a client holding one socket
per shard MUST key its poke buffers by `(connection, pokeId)`. Keying by `pokeId`
alone merges two shards' concurrent `poke-1` frames into one buffer: one shape
applies the other's epoch and the other's parts find no buffer at all.

A client that holds a SINGLE socket satisfies this by construction — its buffer
map is already per-connection, and the frames carry no shard identity for it to
key on anyway. The requirement binds only a client that multiplexes several
shard sockets, and such a client must model the connection throughout (its
subscription registry and resend path too), not just in the buffer map. All
eight non-JS SDKs are single-socket today; see `sdks/README.md`.

**`pokePart.reset: true`** means `rowsPatch` is the shape's COMPLETE membership,
not a diff. The client MUST drop its current view for that `shapeId` before
applying the ops. A seed is inserts-only, so merging it leaves any row that left
the shape while the client was disconnected on screen permanently. `reset` is
never inferred from a missing `baseCheckpoint` — the live poke paths legitimately
carry no base. It is set on the full-membership branch of an op-log shape seed
(the client's `sinceSeq` fell outside CDC retention, or it sent none) and on every
`.global()` shape seed, which always re-seeds in full.

**`pokePart.baseCheckpoint`** is the checkpoint THAT SHAPE's view must be at for
the part to splice on cleanly, and takes precedence over `pokeStart.baseCheckpoint`
(a single-part fallback). It is per shape because each shape on a socket has its
own delivered-through cursor. Absent means the sender cannot name a base and the
gap check is disarmed for that part.

> **Outstanding in the non-JS ports.** Only `@lunora/client` acts on this field:
> on a mismatch it drops the shape's view, clears its cursor, skips the ops and
> re-subscribes. None of the eight SDKs implements the comparison — one stores
> the value and never reads it, the rest only mention it in a comment about
> `reset`. A poke can genuinely be dropped on the cross-DO owner→relay POST, so
> until a port adds the check its shape views can diverge where the JS client
> recovers. A port adding it needs no wire change; the field is already sent.

### 5.4 Delta runs and the resume cursor

One value change can go out as a RUN of `delta` frames (one per changed row).
Unlike a poke the run has no start/end envelope — the client applies each frame
as it arrives — so `cursor`/`epoch` ride only the **last** frame of the run, and a
client MUST NOT advance its resume position on a frame that omits them.
`lastMutationId` is the opposite and rides every frame (it is idempotent and
monotonic on the read side).

Without that split, a socket dying mid-run left the client having ACKed a
checkpoint whose remaining rows it never received: its next `sinceSeq` resolved
as "already current" and the half-applied list was never re-snapshotted.

A single-frame run is its own last frame and carries the cursor as before; so
does the `data` snapshot.

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

1. `encode(decode(encoded)) == encoded` for every `wire-codec.json` case — or
   `== reencoded` for the cases that carry it — and every `rejected[]` entry
   fails to decode (§2.3).
2. `stableWireKey` matches every `stable-wire-key.json` case.
3. RPC request bodies and response parsing match `rpc.json`.
4. Client WS frame builders and the server-frame consumer match `ws-frames.json`,
   including the poke sequence materialising `shape.expectedRows`.

The TS reference test is `packages/client/__tests__/protocol-conformance.test.ts`.
Every SDK under `sdks/` runs the same fixtures — see `sdks/README.md` for the
per-language suites and the capability table.
