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
client.set_auth_token(Some("…".into())); // redacted from the client's `{:?}`
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

An RPC POST has no legitimate 3xx: configure the poster to refuse redirects, or a
redirect would replay your bearer token to another host. With `reqwest`:

```rust
let http = reqwest::blocking::Client::builder().redirect(reqwest::redirect::Policy::none()).build()?;
```

`handle_frame(raw)` is what you call with each inbound WebSocket message;
`resend_subscriptions()` re-subscribes everything after a reconnect — queries
from their resume cursor and shape views from their checkpoint and epoch. A
`data`/`delta` payload the wire codec refuses is reported on that subscription's
own `on_error` as `INVALID_FRAME` rather than returned from `handle_frame`, so
one bad frame cannot end your read loop and with it every other subscription.
The same goes for a poke: a shape whose part carries a row the codec refuses
keeps its view, checkpoint and epoch untouched and hears `WIRE_DECODE_FAILED` on
its `on_error`, while every other shape in the poke applies. A later poke whose
`baseCheckpoint` (or epoch) no longer matches the view's — the server believes
it delivered the refused rows — is not spliced on: the view is emptied, its
`on_rows` told `[]`, and a cold `shape_subscribe` goes out at once so the server
re-seeds it (a `reset` part is exempt: it replaces the view anyway). A frame shaped like no
server frame is ignored, and a `cursor` that is not an integer never replaces
the tracked one.
Send `build_connect_frame(client_id, context, token)` as the first frame on every open,
before `resend_subscriptions()`. A deployment with `LUNORA_WS_BEARER` closes a socket
whose first frame is not that `connect` with a matching `token` (close code 4003). The
session credential never goes in the socket URL; `ws_url` carries only an admin ticket.

Reconnect with exponential backoff capped at 30 s, jittered, reset on an `ack`
(`handle_frame` returns the frame's type). Each new socket sends `connect` first, then
resubscribes and flushes that shard's offline queue; if the connect write or the resend
fails, the socket is dropped and the loop backs off.

The loop owns the client. A reader thread forwards inbound frames to it over a channel,
and so do the flush timers, so the client is never shared across threads. `handle_frame`
runs subscription callbacks on the loop's thread without holding any lock another thread
needs. A callback therefore cannot call the client directly: to subscribe from a
callback, send the request over your own channel and let the loop act on it. A failed
flush that requeues writes (or returns `retry_after_ms`) schedules its own timer, or
those writes wait for the next reconnect. A failed socket write shuts the socket down,
which ends the reader and so the run.

```rust
enum Event {
    Frame(String),
    Flush, // a flush timer fired
    Closed, // the reader hit end of stream or an error
}

fn schedule_flush(tx: mpsc::Sender<Event>, retry_after_ms: Option<u64>, backoff: u64) {
    let wait = retry_after_ms.unwrap_or(backoff / 2 + rand::random_range(0..=backoff / 2));
    thread::spawn(move || {
        sleep(Duration::from_millis(wait));
        let _ = tx.send(Event::Flush); // errs once the run has ended, which is fine
    });
}

let mut client = client; // owned by this loop; no shared lock
let mut attempt = 0u32;
loop {
    let mut resend_error = None;
    if let Ok((mut reader, writer)) = dial() { // your socket library: split read / write halves
        let writer = Arc::new(Mutex::new(writer));
        let failed = Arc::new(AtomicBool::new(false)); // set by a failed socket write
        let (tx, rx) = mpsc::channel::<Event>(); // one per run, so an old timer cannot reach a new run
        let reader_tx = tx.clone();
        thread::spawn(move || {
            while let Ok(raw) = reader.recv() {
                if reader_tx.send(Event::Frame(raw)).is_err() { return; }
            }
            let _ = reader_tx.send(Event::Closed);
        });
        if writer.lock().unwrap().send_json(&build_connect_frame(Some(&client.client_id), None)).is_ok() {
            let (w, f) = (Arc::clone(&writer), Arc::clone(&failed));
            client.attach_socket(Box::new(move |frame: &Value| {
                let sent = w.lock().unwrap().send_json(frame).is_ok();
                if !sent {
                    f.store(true, Ordering::SeqCst);
                    w.lock().unwrap().shutdown(); // your socket library: must unblock the reader, and tolerate repeat calls
                }
            }));
            if let Err(err) = client.resend_subscriptions() {
                // A subscription whose arguments the wire cannot encode fails every resend
                // the same way: remove it with `unsubscribe`, then restart this loop.
                resend_error = Some(err);
            }
            if resend_error.is_none() && !failed.load(Ordering::SeqCst) {
                let mut flush_backoff = 1000u64;
                let report = client.flush_offline_queue(None);
                if !report.requeued.is_empty() || report.retry_after_ms.is_some() {
                    schedule_flush(tx.clone(), report.retry_after_ms.map(|ms| ms as u64), flush_backoff);
                }
                while let Ok(event) = rx.recv() {
                    match event {
                        Event::Frame(raw) => match client.handle_frame(&raw) {
                            Ok(kind) if kind.as_deref() == Some("ack") => attempt = 0,
                            Ok(_) => {}
                            Err(_) => break, // ends this run; the cleanup below still runs
                        },
                        Event::Flush => {
                            let next = client.flush_offline_queue(None);
                            if !next.requeued.is_empty() || next.retry_after_ms.is_some() {
                                flush_backoff = (flush_backoff * 2).min(30_000);
                                schedule_flush(tx.clone(), next.retry_after_ms.map(|ms| ms as u64), flush_backoff);
                            }
                        }
                        Event::Closed => break,
                    }
                    if failed.load(Ordering::SeqCst) { break; }
                }
            }
        }
        client.detach_socket();
        if let Some(err) = resend_error {
            eprintln!("lunora: stopping the reconnect loop, a subscription cannot be resent: {err:?}");
            break;
        }
    }
    let ms = (1000u64 << attempt.min(5)).min(30_000);
    sleep(Duration::from_millis(ms / 2 + rand::random_range(0..=ms / 2)));
    attempt += 1;
}
```

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

A write that must never sit on disk — a credential, a one-time token — sets
`online_only = true` on its `SubmitOptions`. It is never queued, persisted or
replayed: where a normal write would be queued, `submit` fails with
`CODE_OFFLINE_NOT_QUEUED` before any optimistic layer is installed, and its
arguments never reach the persistence adapter. A send that gets no reply while
the socket is down is refused the same way, with the transport error as its
`source()`. It does not wait for a flush or
queue behind pending writes, so it may land before an older queued write to the
same document.

One rule classifies a failed replay, whether the write went out alone or in a
batch: a CODED envelope is classified by its code alone, whatever the HTTP
status — `SHARD_UNAVAILABLE`, `SHARD_ERROR`, `DELIVERY_FENCED`, `RATE_LIMITED`,
`TOO_MANY_REQUESTS` and the refused credentials `UNAUTHORIZED`, `TOKEN_EXPIRED`
and `UNAUTHENTICATED` (held for the next token: this client never flushes on its
own, so call `flush_offline_queue` after `set_auth_token`, as on a reconnect; the
identity gate below keeps that flush from sending one user's write with another's
token) re-queue, every other code (a
coded 500, or a server's own `WIRE_DECODE_FAILED`, included) settles `rejected` —
and a reply with no envelope re-queues, except a 413. An envelope whose `data`
does not decode is still that coded error, with `data` dropped (`None`), on
every path including a direct `query`/`mutation`/`action`.

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
retried: the replay could only return the same result. An online `submit` reports
the same thing: `Ok` with status `Committed`, a `Null` value and
`MutationOutcome::error` holding the coded `WIRE_DECODE_FAILED`.

The identity is an opaque, **non-secret** stamp — a user id, not a bearer token
— set with `client.set_identity(…)`. It is persisted with every queued write and
re-checked before that write replays, so a restart cannot push one user's queued
writes as another. Left `None`, a write is stamped `Identity::Token` with a
digest of the bearer token instead (`token_digest`, the reference client's, never
the token itself; persisted as `{"tokenDigest": …}`), and `SignedOut` only when
there is no token either — so a write queued under one token is never sent with
another. Under a different token it is rejected `OFFLINE_IDENTITY_CHANGED`; with
no token at all it is held, unsettled and still persisted, until one is set. A
flush sends every request of a pass with the token its identity was checked
against. Setting an identity is what lets a token refresh keep the queue. A
record persisted by an earlier build with a `null` stamp is rejected the same way
once a token is held, since `null` then said nothing about whose write it was.
The identity may be any string: a token stamp is its own variant, so no identity,
however it is spelled, can match a token's writes, nor a token stamp an
identity's. Changing it FROM a set identity (another user, or signed out) evicts
the previous session: every query and shape resubscribes cold, and every shape
view is emptied and its `on_rows` told so with `[]`. A first sign-in and
re-setting the same value evict nothing. With no identity set,
`set_auth_token` with a different token (or `None`) evicts the same way, since
the token's digest is then the identity. `&str` cannot hold a lone surrogate, so
the digest's UTF-16 walk sees exactly the code units JavaScript's string would.

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
