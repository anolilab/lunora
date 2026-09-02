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
shape views alike — carrying each one's resume cursor or checkpoint.

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
    // Layered onto the subscription registered under the same (path, args,
    // shard). Re-run on every server frame, so derive from `current` rather than
    // closing over a value.
    Optimistic: func(current any) any {
        return append(current.([]any), map[string]any{"text": "hi", "pending": true})
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

`client.SetIdentity` records an opaque, **non-secret** stamp — a user id, not a bearer
token. It is persisted with every queued write and re-checked before that write
replays, so a restart cannot push one user's queued writes as another.

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
