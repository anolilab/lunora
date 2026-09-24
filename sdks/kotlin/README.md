# Lunora Kotlin SDK

A **protocol-conformant** Kotlin client for a Lunora deployment, implementing the
transport specified in [`protocol/README.md`](../../protocol/README.md):

- `query` / `mutation` / `action` round-trips over `POST /_lunora/rpc`.
- Live `subscribe` — and `stream`, a closeable `Sequence` — over the WebSocket `data`/`delta`/`ack`/`error`/`resume`/
  `settled` frames.
- `subscribeShape` over the poke (`pokeStart`/`pokePart`/`pokeEnd`) partial-
  replication path.
- A full `encodeWire` / `decodeWire` value codec (bigint, bytes, `Date`,
  `Map`/`Set`, `URL`, `NaN`/`Infinity`, `undefined`) plus the stable subscription
  key.
- `submit` — the offline-capable write path: cursor-gated optimistic updates
  (`Optimistic.kt`) over the durable replay queue (`Offline.kt`).

> **Not a pnpm/TS package.** This lives under `sdks/kotlin/` and is plain sources
> compiled with `kotlinc`. **JDK + Kotlin stdlib only** — no build tool, no
> dependencies, not even a JSON library (`Json.kt` is part of the transport).

```bash
kotlinc ./sdk/kotlin …
```

## Usage

HTTP and the socket are **injected**, so you keep your own client, timeouts,
retries and socket library:

```kotlin
val client = Client("https://my-app.example.com", post = myPoster, authToken = "…")
client.identity = currentUserId
// `clientId` is minted per instance. Pin a stable per-device one only when the
// offline queue is durable — a replayed write is namespaced server-side under
// the id that issued it.

val messages = client.query("messages:list", args)
client.mutation("messages:send", args)

// Live subscription: attach your socket, then feed it frames.
client.attachSocket { frame -> socket.send(Json.write(frame)) }
val unsubscribe = client.subscribe("messages:list", args, onData = ::render)
```

`client.handleFrame(raw)` is what you call with each inbound WebSocket message;
`client.resendSubscriptions()` re-subscribes everything after a reconnect —
queries and shapes alike — carrying each one's resume cursor or checkpoint.

## Optimistic updates and offline writes

`mutation` is the direct write path: one round-trip that throws when the
deployment is unreachable. `submit` is the one that survives a dropped socket —
it queues the write, shows a predicted value immediately, and replays in order
once the socket is back.

```kotlin
// Capacity, an app version, and a durable store are all optional; the default is
// an in-memory queue of 1000 writes.
client.offlineQueue = OfflineQueue(maxItems = 500, persistence = myStore, version = "v2")

val outcome = client.submit(
    SubmitOptions("messages:send", args).apply {
        // Layered onto the subscription registered under the same (path, args,
        // shard). Re-run on every server frame, so derive from `current` rather
        // than closing over a value.
        optimistic = { current -> appendPending(current) }
        // Re-checked just before a QUEUED write replays: false drops it instead
        // of replaying a write that can only fail.
        precondition = { channelStillExists("general") }
        onSettled = { event -> log(event.status, event.mutationId) }
    },
)

if (outcome.status == MutationStatus.QUEUED) {
    // durably queued, not committed — don't report success yet
}
```

The overlay drops the moment a frame whose `cursor` reaches the write's echoed
`commitCursor` arrives, so the confirming frame never double-counts it; a failed
write rolls back. `client.flushOfflineQueue(shardKey)` replays a shard's queued
writes when its socket returns, and `client.hydrateOfflineQueue()` restores what
a prior session persisted, returning the shard keys to flush.

A queued write whose args cannot be wire-encoded settles terminally on the first
flush (`OFFLINE_WRITE_UNENCODABLE`) rather than being retried forever, and a
restored record whose args cannot be wire-_decoded_ is purged and settled
(`OFFLINE_WRITE_UNDECODABLE`) rather than replayed with substitute arguments.
Every discard — including one the capacity cap evicts out of a _restored_ queue,
which has no caller left to tell — reaches `client.onMutationSettled`.

A replay the server rate-limits is re-queued, not dropped: `FlushReport.retryAfterMs`
carries the delay the envelope named, and the next flush is a no-op until it has
passed.

`client.identity` is an opaque, **non-secret** stamp — a user id, not a bearer
token. It is persisted with every queued write and re-checked before that write
replays, so a restart cannot push one user's queued writes as another.

`synchronized` is reentrant, so a consumer callback invoked under the client's
monitor would not deadlock — it would instead run inside the critical section
guarding the subscription registry, which is its own hazard. So every consumer
callback (a transform, a `precondition`, a settled listener) runs with the
monitor released, and each queue method that discards a write RETURNS it for the
client to report. See [`sdks/README.md`](../README.md).

## Wire types

`WireValue` is the codec's own sealed class, so every JS type round-trips exactly
rather than being flattened into a `Map<String, Any?>`:

| Lunora / `v.*`                         | `WireValue`                                          |
| -------------------------------------- | ---------------------------------------------------- |
| `v.string/number/boolean/object/array` | `Text` / `Num` / `Bool` / `Obj` / `Arr`              |
| `v.bigint()`                           | `BigInt`                                             |
| `v.bytes()`                            | `Bytes`, or `TypedBytes` for a non-`Uint8Array` view |
| `Date`                                 | `Date`                                               |
| `Map` / `Set`                          | `WireMap` / `WireSet`                                |
| `URL`                                  | `Url`                                                |

`Undefined`, `NaN` and the infinities are their own objects, distinct from
`Null`.

### One thing to know about generated models

The Kotlin models are **not** rendered by quicktype, unlike most targets:
quicktype's Kotlin backend renames properties (a wire `channelId` becomes
`channelID`) and emits no mapping metadata under `just-types`, so a model it
rendered could not be projected back onto the wire. They are emitted from the
JSON Schema instead, which carries `required` outright — which is also what lets
an unset `v.optional()` reach the wire as an absent key while a required
`v.nullable()` reaches it as a present null.

## Tests

The suite drives the SDK against the **shared** golden fixtures in
`protocol/fixtures/` — the identical files the TypeScript client is tested
against — and against `protocol/conformance-cases.json`, which lists the cases
every SDK's suite must exercise. The end of `main` is the after-all hook that
fails the run if a required case did not execute.

```bash
cd sdks/kotlin
PATH="$JDK_BIN:$PATH" bash build.sh
```

On macOS, `/usr/bin/java` is Apple's stub and is not a JDK — point `JDK_BIN` at a
real one (`$(/usr/libexec/java_home)/bin`).
