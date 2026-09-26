# Lunora Go SDK

A **protocol-conformant** Go client for a Lunora deployment, implementing the
transport specified in [`protocol/README.md`](../../protocol/README.md):

- `Query` / `Mutation` / `Action` round-trips over `POST /_lunora/rpc`.
- Live `Subscribe` — and `Stream`, which hands back a receive channel — over the WebSocket `data`/`delta`/`ack`/`error`/`resume`/
  `settled` frames.
- `SubscribeShape` over the poke (`pokeStart`/`pokePart`/`pokeEnd`) partial-
  replication path.
- A full `EncodeWire` / `DecodeWire` value codec (bigint, bytes, `Date`,
  `Map`/`Set`, `URL`, `NaN`/`Infinity`, `undefined`) plus the stable
  subscription key.
- `Submit` — the offline-capable write path: cursor-gated optimistic updates
  (`optimistic.go`) over the durable replay queue (`offline.go`).

> **Not a pnpm/TS package.** This lives under `sdks/go/` and is a standalone Go
> module. **Standard library only** — no third-party dependencies at all.

## Layout

`lunora sdk generate --lang go` emits a module (`lunorasdk`) holding this
transport as `lunora/` beside the generated surface as `lunoraapi/`. Two packages
rather than one flat package, because the transport exports `Error`, `Map`,
`Set`, `Date`, `URL`, `Bytes` and `Client` — a table named `error` or a result
model named `Map` would otherwise be a redeclaration.

```go
// go.mod
require lunorasdk v0.0.0

replace lunorasdk => ./sdk/go
```

## Usage

HTTP and the socket are **injected**, so you keep your own client, timeouts,
retries and socket library:

```go
client := lunora.NewClient("https://my-app.example.com", myPoster)
client.AuthToken = "…"
// ClientID is minted per instance. Pin a stable per-device one only when the
// offline queue is durable — a replayed write is namespaced server-side under
// the id that issued it.

messages, err := client.Query("messages:list", map[string]any{"channel": "general"}, "")
_, err = client.Mutation("messages:send", map[string]any{"channel": "general", "text": "hi"}, "", "")
_, err = client.Mutation("ledger:add", map[string]any{"amount": lunora.BigInt{Value: big.NewInt(1000)}}, "", "")

// Live subscription: attach your socket, then feed it frames.
client.AttachSocket(func(frame map[string]any) error { return conn.WriteJSON(frame) })
unsubscribe := client.Subscribe("messages:list", args, onData, onError, "")
```

`HandleFrame(raw)` is what you call with each inbound WebSocket message;
`ResendSubscriptions()` re-subscribes everything after a reconnect — queries and
shape views alike — carrying each one's resume cursor or checkpoint. A frame
that is not shaped like any server frame is ignored without panicking, and a
cursor that is not an integer never replaces the tracked one. A poke applies
per shape whole or not at all: a row that will not decode leaves that shape's
view, checkpoint and epoch untouched and reaches its error callback as
`WIRE_DECODE_FAILED`. A later poke whose `baseCheckpoint` (the part's, else its
`pokeStart`'s) differs from the view's checkpoint, or whose epoch differs from
the view's, is not spliced on: unless it is a `reset`, the view is emptied, its
callback receives `[]`, and a cold `shape_subscribe` (no `sinceCheckpoint` or
`sinceEpoch`) goes out at once so the server re-seeds it.

`Stream` returns a channel for `for event := range …`; it closes when the
returned `Unsubscribe` runs or when `client.Close()` does, and closing it never
races a frame being delivered.

Any reply the RPC cannot read a result or an error envelope out of (a non-JSON
body, or JSON that is not an object — `null`, `[]`, `"ok"`) fails with an
`APIError` coded `INTERNAL`; `{}` is a void result. A success whose `result`
does not decode fails with `WIRE_DECODE_FAILED` (for `Submit`, alongside the
committed outcome). An error envelope whose `data` does not decode is still
that coded error, with `Data` nil.

`client.String()`/`GoString()` redact `AuthToken`, so `%v`, `%+v`, `%#v` and
`%s` of a `*Client` never print the bearer token.

## Optimistic updates and offline writes

`Mutation` is the direct write path: one HTTP round-trip that fails when the
deployment is unreachable. `Submit` is the one that survives a dropped socket —
it queues the write, shows a predicted value immediately, and replays in order
once the socket is back.

```go
client.SetIdentity(&currentUserID)
// Capacity, an app version, and a durable store are all optional; the default is
// an in-memory queue of 1000 writes.
client.SetOfflineQueue(lunora.NewOfflineQueue(lunora.OfflineQueueOptions{
    MaxItems:    500,
    Persistence: myStore,
    Version:     "v2",
}))

outcome, err := client.Submit(lunora.SubmitOptions{
    FunctionPath: "messages:send",
    Args:         map[string]any{"channel": "general", "text": "hi"},
    // Names the query the write affects. The `Optimistic` shorthand is for the
    // narrower case where the write and the subscription share a path and args
    // (a counter, a document by id) — it patches nothing here, where `send` and
    // `list` are different functions. Every transform re-runs on each server
    // frame, so derive from what it is handed rather than closing over a value.
    OptimisticUpdate: func(store *lunora.OptimisticLocalStore, args any) {
        listArgs := map[string]any{"channel": "general"}
        current, _ := store.GetQuery("messages:list", listArgs).([]any)

        store.SetQuery("messages:list", listArgs, append(current, map[string]any{"text": "hi", "pending": true}))
    },
    // Re-checked just before a QUEUED write replays: false drops it instead of
    // replaying a write that can only fail.
    Precondition: func() bool { return channelStillExists("general") },
    OnSettled:    func(event lunora.MutationSettled) { log.Println(event.Status, event.MutationID) },
})

if outcome.Status == lunora.MutationQueued {
    // durably queued, not committed — don't report success yet
}
```

The overlay drops the moment a frame whose `cursor` reaches the write's echoed
`commitCursor` arrives, so the confirming frame never double-counts it; a failed
write rolls back. `client.FlushOfflineQueue(shardKey)` replays a shard's queued
writes when its socket returns, and `client.HydrateOfflineQueue()` restores what
a prior session persisted, returning the shard keys to flush.

A queued write whose args cannot be wire-encoded settles terminally on the first
flush (`OFFLINE_WRITE_UNENCODABLE`) rather than being retried forever, and every
discard — including one the capacity cap evicts out of a _restored_ queue, which
has no caller left to tell — reaches `client.OnMutationSettled`.

A replay failure is classified by ONE rule on the single-call and batch paths:
a coded envelope by its code alone (`SHARD_UNAVAILABLE`, `SHARD_ERROR`,
`RATE_LIMITED`, `TOO_MANY_REQUESTS` re-queue, and so do the refused-credential
codes `UNAUTHORIZED`, `TOKEN_EXPIRED`, `UNAUTHENTICATED` — the write is held
until a fresh token replays it; every other code — a coded 5xx included — is
terminal), a reply with no envelope by its status (re-queued). A
413 is `PAYLOAD_TOO_LARGE` with or without an envelope: a batch splits and
retries, a lone write still refused settles terminally. A write the server
committed whose result THIS client could not decode settles `committed`,
carrying a `WIRE_DECODE_FAILED` error on its settled event, and is never
re-sent; a `WIRE_DECODE_FAILED` envelope the SERVER sends is a refusal and
settles rejected. A panic escaping a flush puts every drained write not yet
recorded as settled back at the front of the queue before it propagates; a
write is recorded before its settle callbacks run, so a panicking callback
never re-queues a write that already committed.

`client.SetIdentity` records an opaque, **non-secret** stamp — a user id, not a bearer
token. It is persisted with every queued write and re-checked before that write
replays, so a restart cannot push one user's queued writes as another. Changing
it FROM a set identity to a different one (or to nil) evicts the previous
session: every subscription drops its resume cursor and epoch (query callbacks
see the value re-folded over no server base), and every shape view is emptied,
its callback receiving `[]`. A first sign-in and a same-value set evict nothing.

`OfflineQueue` is deliberately not internally locked: the client that owns it
already holds a mutex over its subscription registry, and no queue method settles
a write — each returns what it let go of as a `Discarded` for the client to
report once unlocked. See [`sdks/README.md`](../README.md) for why.

## Wire types

Go has no distinct `bigint`/`Map`/`Set`/`Date`, so mark those explicitly; plain
values map to JSON directly:

| Lunora / `v.*`                         | Go                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| `v.string/number/boolean/object/array` | `string` / `float64` / `bool` / `map[string]any` / `[]any`                             |
| `v.bigint()`                           | `lunora.BigInt{Value: big.NewInt(1000)}`                                               |
| `v.bytes()`                            | `[]byte`, or `lunora.Bytes{Data: b, Ctor: "Float32Array"}` for a non-`Uint8Array` view |
| `Date`                                 | `lunora.Date{EpochMs: 1700000000000}`                                                  |
| `Map` / `Set`                          | `lunora.Map{Entries: …}` / `lunora.Set{Items: …}`                                      |
| `URL`                                  | `lunora.URL{Href: "https://…"}`                                                        |

`DecodeWire` returns these same types so values round-trip exactly.

## Tests

The suite drives the SDK against the **shared** golden fixtures in
`protocol/fixtures/` — the identical files the TypeScript client is tested
against — and against `protocol/conformance-cases.json`, which lists the cases
every SDK's suite must exercise. `TestMain` fails the run if a required case did
not execute.

```bash
cd sdks/go
go test ./... -race -count=1
```
