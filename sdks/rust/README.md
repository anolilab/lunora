# Lunora Rust SDK

A **protocol-conformant** Rust client for a Lunora deployment, implementing the
transport specified in [`protocol/README.md`](../../protocol/README.md):

- `query` / `mutation` / `action` round-trips over `POST /_lunora/rpc`.
- Live `subscribe` — and `stream`, which hands back an `mpsc::Receiver` — over the WebSocket `data`/`delta`/`ack`/`error`/`resume`/
  `settled` frames.
- `subscribe_shape` over the poke (`pokeStart`/`pokePart`/`pokeEnd`) partial-
  replication path.
- A full `encode_wire` / `decode_wire` value codec (bigint, bytes, `Date`,
  `Map`/`Set`, `URL`, `NaN`/`Infinity`, `undefined`) plus the stable
  subscription key.
- `submit` — the offline-capable write path: cursor-gated optimistic updates
  (`optimistic.rs`) over the durable replay queue (`offline.rs`).

> **Not a pnpm/TS package.** This lives under `sdks/rust/` and is a standalone
> crate. It needs `serde` (derive) and `serde_json`, both declared in the emitted
> `Cargo.toml`, so `cargo` resolves them with no manual step.

```toml
# Cargo.toml
lunora-api = { path = "./sdk/rust" }
```

## Usage

HTTP and the socket are **injected**, so you keep your own client, timeouts,
retries and socket library:

```rust
let mut client = Client::new("https://my-app.example.com", Some(my_poster));
client.auth_token = Some("…".into());
client.identity = Some(current_user_id);
// `client_id` is minted per instance. Pin a stable per-device one only when the
// offline queue is durable — a replayed write is namespaced server-side under
// the id that issued it.

let messages = client.query("messages:list", &args, None)?;
client.mutation("messages:send", &args, None, None)?;

// Live subscription: attach your socket, then feed it frames.
client.attach_socket(Box::new(|frame| conn.send_json(frame)));
let id = client.subscribe("messages:list", args, on_data, on_error);
```

`handle_frame(raw)` is what you call with each inbound WebSocket message;
`resend_subscriptions()` re-subscribes everything after a reconnect — queries
from their resume cursor and shape views from their checkpoint and epoch. A
`data`/`delta` payload the wire codec refuses is reported on that subscription's
own `on_error` as `INVALID_FRAME` rather than returned from `handle_frame`, so
one bad frame cannot end your read loop and with it every other subscription.

## Optimistic updates and offline writes

`mutation` is the direct write path: one HTTP round-trip that fails when the
deployment is unreachable. `submit` is the one that survives a dropped socket —
it queues the write, shows a predicted value immediately, and replays in order
once the socket is back.

```rust
// Capacity, an app version, and a durable store are all optional; the default is
// an in-memory queue of 1000 writes.
client.offline_queue = OfflineQueue::new()
    .with_max_items(500)
    .with_persistence(Box::new(my_store))
    .with_version("v2");

let outcome = client.submit(
    SubmitOptions::new("messages:send", args)
        // Layered onto every subscription registered under the same (path, args,
        // shard). An `Arc`, because each of those gets its own layer and each
        // rebases independently onto its own base.
        .with_optimistic(Arc::new(|current| append_pending(current)))
        // A constant override for a differently-named query.
        .with_optimistic_query("messages:unread", list_args, WireValue::Number(4.0)),
)?;

if outcome.status == MutationStatus::Queued {
    // durably queued, not committed — don't report success yet
}
```

The overlay drops the moment a frame whose `cursor` reaches the write's echoed
`commitCursor` arrives, so the confirming frame never double-counts it; a failed
write rolls back. `client.flush_offline_queue(shard_key)` replays a shard's
queued writes when its socket returns, and `client.hydrate_offline_queue()`
restores what a prior session persisted, returning the shard keys to flush.

A queued write whose args cannot be wire-encoded settles terminally on the first
flush (`OFFLINE_WRITE_UNENCODABLE`) rather than being retried forever, and a
_restored_ record whose args no longer decode is purged and settled
`OFFLINE_WRITE_UNDECODABLE` rather than replayed with substitute arguments. Every
discard — including one the capacity cap evicts out of a restored queue, which
has no caller left to tell — reaches `client.on_mutation_settled`.

A flush chunks itself by bytes as well as by entries, and a chunk the worker
refuses with `413 PAYLOAD_TOO_LARGE` is halved and retried rather than settled
`rejected` whole. A rate-limited replay (`TOO_MANY_REQUESTS`) is re-queued, not
dropped: `FlushReport::retry_after_ms` reports the envelope's delay and the
client holds the next flush off until it passes.

`client.identity` is an opaque, **non-secret** stamp — a user id, not a bearer
token. It is persisted with every queued write and re-checked before that write
replays, so a restart cannot push one user's queued writes as another.

### Two shapes the borrow checker chose

Both are the language talking, not a divergence in behaviour, and
[`sdks/README.md`](../README.md) records them:

- A settle handle is a `(subscription id, layer id)` **pair** rather than an
  object, because storing a `&mut` borrow of the subscription for later use is
  exactly what the borrow checker exists to reject. A `Transform` returns
  `Option<WireValue>` rather than throwing, because Rust has no exceptions and a
  layer that cannot produce a value already has a way to say so.
- The multi-query patch set is declared **up front** (`optimistic_queries`) and
  read with `query_value` / `all_queries` beforehand, rather than through a
  callback handed a `&mut` store. Nothing in the queue holds a rejection callback
  either: every method that discards a write returns it, which is also what lets
  the compiler prove none is dropped silently. The client carries no lock — `&mut
self` is the exclusion.

## Wire types

`WireValue` is the codec's own enum, so every JS type round-trips exactly rather
than being flattened into `serde_json::Value`:

| Lunora / `v.*`                         | `WireValue`                                          |
| -------------------------------------- | ---------------------------------------------------- |
| `v.string/number/boolean/object/array` | `String` / `Number` / `Bool` / `Object` / `Array`    |
| `v.bigint()`                           | `BigInt`                                             |
| `v.bytes()`                            | `Bytes`, or `TypedBytes` for a non-`Uint8Array` view |
| `Date`                                 | `Date`                                               |
| `Map` / `Set`                          | `Map` / `Set`                                        |
| `URL`                                  | `Url`                                                |

`undefined`, `NaN` and the infinities are their own variants, distinct from
`Null`.

## Tests

The suite drives the SDK against the **shared** golden fixtures in
`protocol/fixtures/` — the identical files the TypeScript client is tested
against — and against `protocol/conformance-cases.json`, which lists the cases
every SDK's suite must exercise. libtest has no after-all hook that can fail, so
here the manifest **drives** the run: a required name with no dispatch arm fails.

```bash
cd sdks/rust
cargo test
```
