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
client.auth_token = Some("…".into()); // redacted from the client's `{:?}`
client.set_identity(Some(current_user_id));
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
The same goes for a poke: a shape whose part carries a row the codec refuses
keeps its view, checkpoint and epoch untouched and hears `INVALID_FRAME` on its
`on_error`, while every other shape in the poke applies. A frame shaped like no
server frame is ignored, and a `cursor` that is not an integer never replaces
the tracked one.

An RPC reply the call cannot read — a body that is not JSON, or JSON that is not
an object (`null`, `[]`, a string), at any status — fails with
`ClientError::Api` coded `INTERNAL`, never a success with a null result; `{}` is
the void result. `close()` also drops every subscription, which ends every
`stream()` receiver after the values already delivered.

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

// Read the query back before the write borrows the client mutably.
let listed = client.query_value("messages:list", &list_args, None).cloned();

let outcome = client.submit(
    SubmitOptions::new("messages:send", args)
        // Constant overrides that NAME the queries this write affects — the
        // general form. (`with_optimistic` takes a transform instead, but layers
        // it onto subscriptions registered under the write's OWN path and args:
        // the shorthand for a counter or a document by id, and a no-op for a
        // `send`/`list` pair.)
        .with_optimistic_query("messages:list", list_args, append_pending(listed))
        .with_optimistic_query("messages:unread", unread_args, WireValue::Number(4.0)),
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

One rule classifies a failed replay, whether the write went out alone or in a
batch: a CODED envelope is classified by its code alone, whatever the HTTP
status — `SHARD_UNAVAILABLE`, `SHARD_ERROR`, `RATE_LIMITED` and
`TOO_MANY_REQUESTS` re-queue, every other code (a coded 500 included) settles
`rejected` — and a reply with no envelope re-queues, except a 413.

A flush chunks itself by bytes as well as by entries, and a chunk refused with a
413 — the worker's coded `PAYLOAD_TOO_LARGE` or a proxy's HTML page alike — is
halved and retried rather than settled `rejected` whole; a lone write still
refused settles `rejected` with `PAYLOAD_TOO_LARGE`. A rate-limited replay
(`TOO_MANY_REQUESTS`) is re-queued, not dropped: `FlushReport::retry_after_ms`
reports the envelope's delay and the client holds the next flush off until it
passes.

A replayed write the server committed but whose result does not decode settles
`Committed` — overlay confirmed, durable record removed — with no value and the
decode error coded `WIRE_DECODE_FAILED` on its settled event. It is never
retried: the replay could only return the same result.

The identity is an opaque, **non-secret** stamp — a user id, not a bearer token
— set with `client.set_identity(…)`. It is persisted with every queued write and
re-checked before that write replays, so a restart cannot push one user's queued
writes as another. Changing it FROM a set identity (another user, or signed out)
evicts the previous session: every query and shape resubscribes cold, and every
shape view is emptied and its `on_rows` told so with `[]`.

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

A number off the wire is the double `JSON.parse` reads: the crate enables
`serde_json`'s `float_roundtrip`, whose parser is correctly rounded (the default
one reads about one double in six one ulp off), and an integer literal past 2^53
decodes to the nearest `Number`, never a `BigInt`. The stable key spells it as
`String(v)` does — shortest round-trip digits, an exact tie broken to the even
digit. Only `from_json`, the MODEL side, keeps an over-range integer's digits as a
`BigInt`.

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
