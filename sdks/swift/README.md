# Lunora Swift SDK

A **protocol-conformant** Swift client for a Lunora deployment, implementing the
transport specified in [`protocol/README.md`](../../protocol/README.md):

- `query` / `mutation` / `action` round-trips over `POST /_lunora/rpc`.
- Live `subscribe` — and `stream`, which hands back an `AsyncStream` — over the WebSocket `data`/`delta`/`ack`/`error`/`resume`/
  `settled` frames.
- `subscribeShape` over the poke (`pokeStart`/`pokePart`/`pokeEnd`) partial-
  replication path.
- A full `encodeWire` / `decodeWire` value codec (bigint, bytes, `Date`,
  `Map`/`Set`, `URL`, `NaN`/`Infinity`, `undefined`) plus the stable subscription
  key.
- `submit` — the offline-capable write path: cursor-gated optimistic updates
  (`Optimistic.swift`) over the durable replay queue (`Offline.swift`).

> **Not a pnpm/TS package.** This lives under `sdks/swift/` and is a standalone
> SwiftPM package. **Foundation only** — nothing to install.

```swift
// Package.swift
.package(path: "./sdk/swift"),
.product(name: "LunoraApi", package: "swift"),
```

SwiftPM identifies a path dependency by its **directory name** and ignores the
manifest's `name:`, so `package:` is spelled as whatever directory you generated
into.

## Usage

HTTP and the socket are **injected**, so you keep your own client, timeouts,
retries and socket library:

```swift
let client = LunoraClient(url: "https://my-app.example.com", post: myPoster, authToken: "…")
client.identity = currentUserID
// `clientID` is minted per instance. Pin a stable per-device one only when the
// offline queue is durable — a replayed write is namespaced server-side under
// the id that issued it.

let messages = try client.query("messages:list", args: ["channel": "general"])
_ = try client.mutation("messages:send", args: ["channel": "general", "text": "hi"])

// Live subscription: attach your socket, then feed it frames.
client.attachSocket { frame in try socket.send(frame) }
let unsubscribe = client.subscribe("messages:list", args: args, onData: render)
```

`handleFrame(raw)` is what you call with each inbound WebSocket message;
`resendSubscriptions()` re-subscribes everything after a reconnect — queries and
shape views alike — carrying each one's resume cursor or checkpoint.

## Optimistic updates and offline writes

`mutation` is the direct write path: one round-trip that throws when the
deployment is unreachable. `submit` is the one that survives a dropped socket —
it queues the write, shows a predicted value immediately, and replays in order
once the socket is back.

```swift
// Capacity, an app version, and a durable store are all optional; the default is
// an in-memory queue of 1000 writes.
client.offlineQueue = LunoraOfflineQueue(maxItems: 500, persistence: myStore, version: "v2")

let outcome = try client.submit(
    LunoraSubmitOptions(
        functionPath: "messages:send",
        args: ["channel": "general", "text": "hi"],
        // Layered onto the subscription registered under the same (path, args,
        // shard). Re-run on every server frame, so derive from `current` rather
        // than closing over a value.
        optimistic: { current in appendPending(current) },
        // Re-checked just before a QUEUED write replays: false drops it instead
        // of replaying a write that can only fail.
        precondition: { channelStillExists("general") },
        onSettled: { event in print(event.status, event.mutationID) }
    )
)

if outcome.status == .queued {
    // durably queued, not committed — don't report success yet
}
```

The overlay drops the moment a frame whose `cursor` reaches the write's echoed
`commitCursor` arrives, so the confirming frame never double-counts it; a failed
write rolls back. `client.flushOfflineQueue(shardKey:)` replays a shard's queued
writes when its socket returns, and `client.hydrateOfflineQueue()` restores what
a prior session persisted, returning the shard keys to flush.

A queued write whose args cannot be wire-encoded settles terminally on the first
flush (`OFFLINE_WRITE_UNENCODABLE`) rather than being retried forever, a restored
record whose stored args no longer decode is purged and settled
(`OFFLINE_WRITE_UNDECODABLE`) rather than replayed with substitute arguments, and
every discard — including one the capacity cap evicts out of a _restored_ queue,
which has no caller left to tell — reaches `client.onMutationSettled`.

A flush that comes back rate-limited — whole response or one batch slot —
re-queues rather than dropping, reports the server's `error.data.retryAfterMs` as
`LunoraFlushReport.retryAfterMs` (clamped at `lunoraMaxRetryAfterMs`, 60 s), and
holds the next flush off until it passes. The `Retry-After` HEADER is not read:
`LunoraHTTPPoster` surfaces `(status, body)` only. A batch the worker refuses for size (`413 PAYLOAD_TOO_LARGE`) is
split in half and retried, so no write is dropped for the size of the batch it
shared.

`client.identity` is an opaque, **non-secret** stamp — a user id, not a bearer
token. It is persisted with every queued write and re-checked before that write
replays, so a restart cannot push one user's queued writes as another.

`LunoraOfflineQueue` is not internally locked: the client already holds a
**non-recursive** `NSLock` over the registry the queue is settled against, so
every queue method that discards a write RETURNS it for the client to report once
unlocked. Consumer callbacks — a transform, a `precondition`, a settled listener
— likewise run outside that lock. See [`sdks/README.md`](../README.md).

## Wire types

Swift's `Codable` cannot express JS's `bigint`/`Map`/`Set`/`Date` distinctions,
so mark those explicitly; plain values map to JSON directly:

| Lunora / `v.*`                         | Swift                                                    |
| -------------------------------------- | -------------------------------------------------------- |
| `v.string/number/boolean/object/array` | `String` / `Double` / `Bool` / `[String: Any]` / `[Any]` |
| `v.bigint()`                           | `WireBigInt`                                             |
| `v.bytes()`                            | `WireBytes`                                              |
| `Date`                                 | `WireDate`                                               |
| `Map` / `Set`                          | `WireMap` / `WireSet`                                    |
| `URL`                                  | `WireURL`                                                |

`decodeWire` returns these same wrappers so values round-trip exactly.

### One thing to know about generated models

`JSONEncoder` omits a `nil` struct property, which is right for an unset
`v.optional()` and wrong for a required `v.nullable()` set to null — the
validator rejects an absent key there. So the generated call site is handed the
NULLABLE paths computed from your schema and restores those nulls after
encoding. `sdks/README.md` records how the other ports draw the same line.

## Tests

The suite drives the SDK against the **shared** golden fixtures in
`protocol/fixtures/` — the identical files the TypeScript client is tested
against — and against `protocol/conformance-cases.json`, which lists the cases
every SDK's suite must exercise. XCTest has no after-all hook that can fail, so
here the manifest **drives** the run: a required name with no dispatch arm fails.

```bash
cd sdks/swift
swift test
```
