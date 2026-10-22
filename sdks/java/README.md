# Lunora Java SDK

A **protocol-conformant** Java client for a Lunora deployment, implementing the
transport specified in [`protocol/README.md`](../../protocol/README.md):

- `query` / `mutation` / `action` round-trips over `POST /_lunora/rpc`.
- Live `subscribe` — and `stream`, a closeable `Iterable` — over the WebSocket `data`/`delta`/`ack`/`error`/`resume`/
  `settled` frames.
- `subscribeShape` over the poke (`pokeStart`/`pokePart`/`pokeEnd`) partial-
  replication path.
- A full `Wire.encode` / `Wire.decode` value codec (bigint, bytes, `Date`,
  `Map`/`Set`, `URL`, `NaN`/`Infinity`, `undefined`) plus the stable subscription
  key.
- `submit` — the offline-capable write path: cursor-gated optimistic updates
  (`Optimistic.java`) over the durable replay queue (`Offline.java`).

> **Not a pnpm/TS package.** This lives under `sdks/java/` and is plain sources
> compiled with `javac`. **JDK only** — no build tool, no dependencies, not even
> a JSON library (`Json.java` is part of the transport).

```bash
javac -sourcepath ./sdk/java …
```

## Usage

HTTP and the socket are **injected**, so you keep your own client, timeouts,
retries and socket library:

```java
Client client = new Client("https://my-app.example.com", myPoster);
client.identity(currentUserId);
client.authToken(currentBearer);
client.wsToken(() -> currentBearer); // the session credential, sent in the first connect frame
// The client id is minted per instance. Pin a stable per-device one only when
// the offline queue is durable — a replayed write is namespaced server-side
// under the id that issued it.

Object messages = client.query("messages:list", Map.of("channel", "general"), null);
client.mutation("messages:send", Map.of("channel", "general", "text", "hi"), null, null);

// Live subscription: attach your socket, then feed it frames.
// attachSocket sends the connect frame itself, carrying the wsToken supplier: do not send another.
client.attachSocket(frame -> socket.send(Json.write(frame)));
Runnable unsubscribe = client.subscribe("messages:list", args, onData, onError, null);
```

An RPC POST has no legitimate 3xx: configure the poster to refuse redirects, or a
redirect would replay your bearer token to another host. `java.net.http.HttpClient`
already refuses them (`HttpClient.Redirect.NEVER` is its default); keep it that way
and do not set `followRedirects(...)` on the builder.

`client.handleFrame(raw)` is what you call with each inbound WebSocket message;
no frame makes it throw — one that is not JSON, not an object, or not shaped
like any server frame is ignored, and a cursor that is not an integer never replaces
the tracked one. `client.resendSubscriptions()` re-subscribes everything after a
reconnect — queries carrying their resume cursor and shapes their checkpoint and
epoch. A poke is applied to each shape whole or not at all: if any row for a
shape does not decode, that shape's view, checkpoint and epoch stay as they
were and its `onError` receives `WIRE_DECODE_FAILED`. A later part whose
`baseCheckpoint` (or its `pokeStart`'s) is not the checkpoint the view is at, or
whose epoch differs from the view's, is not spliced on: unless it is a `reset`,
the view is emptied (its `onRows` told `[]`), its checkpoint and epoch cleared,
and a cold `shape_subscribe` sent at once so the server re-seeds it.
`client.close()` also ends every open `stream`.

Reconnect with exponential backoff capped at 30 s, jittered, reset on an `ack`
(`handleFrame` returns the frame's type):

```java
int attempt = 0;
String shard = null; // this socket's shard key; null is the default shard
while (!Thread.currentThread().isInterrupted()) {
    Thread retry = null;
    Integer closeCode = null; // the close frame's code; null when the socket failed without one
    String closeReason = null;
    try (Socket socket = connect()) { // your socket library
        // attachSocket sends connect before it attaches the sender, so a subscribe on another thread cannot write ahead of it.
        client.attachSocket(frame -> socket.send(Json.write(frame)));
        client.resendSubscriptions();
        var report = client.flushOfflineQueue(shard);
        if (!report.requeued.isEmpty() || report.retryAfterMs != null) {
            // Requeued writes never stop the read loop: retry on a daemon thread, stopped below.
            Long first = report.retryAfterMs;
            retry = new Thread(() -> {
                Long wait = first;
                long backoff = 1_000L;
                try {
                    while (true) {
                        Thread.sleep(wait != null ? wait : backoff / 2 + ThreadLocalRandom.current().nextLong(backoff / 2 + 1));
                        var again = client.flushOfflineQueue(shard);
                        if (again.requeued.isEmpty() && again.retryAfterMs == null) return;
                        // a persistent transient failure backs off instead of replaying every second
                        backoff = Math.min(30_000L, backoff * 2);
                        wait = again.retryAfterMs;
                    }
                } catch (InterruptedException e) {
                    // the socket run ended
                }
            });
            retry.setDaemon(true);
            retry.start();
        }
        for (String raw; (raw = socket.receive()) != null; ) {
            if ("ack".equals(client.handleFrame(raw))) attempt = 0;
        }
        closeCode = socket.closeCode(); // your socket library's close frame
        closeReason = socket.closeReason();
    } catch (Exception e) {
        if (e instanceof InterruptedException) { // a socket call may throw it
            Thread.currentThread().interrupt();
            break;
        }
    } finally {
        if (retry != null) {
            retry.interrupt();
            // Wait out an in-flight flush: if it requeues a write, the next run's flush must see it.
            try {
                retry.join();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        client.detachSocket(closeCode, closeReason);
    }
    long ms = Math.min(30_000L, 1_000L << Math.min(attempt++, 5));
    try {
        Thread.sleep(ms / 2 + ThreadLocalRandom.current().nextLong(ms / 2 + 1));
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        break;
    }
}
```

A requeued or rate-limited replay must not tear the socket down: the loop keeps reading live updates while a background timer retries the flush, and that timer is stopped when the socket run ends.

`detachSocket(closeCode, reason)` reports how the socket closed; pass `null, null` when there was no close frame. Every detach leaves the client offline.

Token expiry is reported to `client.onTokenExpired(Runnable)` (it returns an unregister handle; a listener that throws is contained):

- a `4001` close, and a `TOKEN_EXPIRED` error frame, always report. The error frame is not routed to its subscription;
- a `4003` close reports once per session credential. Calling `wsToken(...)` starts a new credential, so the next refusal reports again;
- a `4003` with the reason `connect deadline` refuses no credential and reports nothing;
- an `UNAUTHENTICATED` error frame reports nothing and is routed to its subscription like any other error.

Whispers are ephemeral messages between the members of a topic. `whisperSubscribe(topic, listener)` joins a topic and returns an unregister handle, and every attach rejoins each registered topic right after `connect`. `whisper(topic, data)` sends and returns `false`, sending nothing, when no socket is attached: a whisper is never queued. `connectRoom(name, listener)` joins the topic `room:<name>` and returns a `Room` with `send(message)` and `close()`. A room topic is never acknowledged, so a send does not wait for the join.

## Optimistic updates and offline writes

`mutation` is the direct write path: one round-trip that throws when the
deployment is unreachable. `submit` is the one that survives a dropped socket —
it queues the write, shows a predicted value immediately, and replays in order
once the socket is back.

```java
// Capacity, an app version, and a durable store are all optional; the default is
// an in-memory queue of 1000 writes.
client.offlineQueue(new Offline.OfflineQueue()
        .maxItems(500)
        .persistence(myStore)
        .version("v2"));

Submit.MutationOutcome outcome = client.submit(
        new Submit.SubmitOptions("messages:send", Map.of("channel", "general", "text", "hi"))
                // Layered onto the subscription registered under the same (path,
                // args, shard). Re-run on every server frame, so derive from
                // `current` rather than closing over a value.
                .optimistic(current -> appendPending(current))
                // Re-checked just before a QUEUED write replays: false drops it
                // instead of replaying a write that can only fail.
                .precondition(() -> channelStillExists("general"))
                .onSettled(event -> log(event.status(), event.mutationId())));

if (outcome.status() == Submit.MutationStatus.QUEUED) {
    // durably queued, not committed — don't report success yet
}
```

The overlay drops the moment a frame whose `cursor` reaches the write's echoed
`commitCursor` arrives, so the confirming frame never double-counts it; a failed
write rolls back. `client.flushOfflineQueue(shardKey)` replays a shard's queued
writes when its socket returns, and `client.hydrateOfflineQueue()` restores what
a prior session persisted, returning the shard keys to flush.

A queued write whose args cannot be wire-encoded settles terminally on the first
flush (`OFFLINE_WRITE_UNENCODABLE`) rather than being retried forever, and every
discard — including one the capacity cap evicts out of a _restored_ queue, which
has no caller left to tell — reaches `client.onMutationSettled`. A persisted
record whose args no longer decode is purged and settled
`OFFLINE_WRITE_UNDECODABLE` rather than replayed with substitute args, which
would commit a different write than the caller made.

A write that must never sit on disk — a credential, a one-time token — is built
with `.onlineOnly(true)` on its `SubmitOptions`. It is never queued, persisted or
replayed: where a normal write would be queued, `submit` throws an
`OfflineException` coded `Offline.OFFLINE_NOT_QUEUED` before any optimistic layer
is installed, and its arguments never reach the persistence adapter. It does not
wait for a flush or queue behind pending writes, so it may land before an older
queued write to the same document. A transport failure on such a write, sent
directly while the connection is down, is refused the same way, with the
transport error as its `cause`.

The durable record holds the **wire** form of a write's args, so a store that
serialises — a file, a SQLite column, a preferences store — round-trips a
`bigint`, `bytes`, date or map argument intact.

A replay the server rate-limits is re-queued rather than dropped, and the
envelope's `data.retryAfterMs` comes back as `FlushReport.retryAfterMs`; the
client also holds the next flush off until that delay passes.

A replay failure is classified the same way whether the write went out alone or
in a batch: a coded error envelope by its code alone, whatever the HTTP status —
only `SHARD_ERROR`, `SHARD_UNAVAILABLE`, `DELIVERY_FENCED`, `RATE_LIMITED`, `TOO_MANY_REQUESTS` and
the refused-credential codes `UNAUTHORIZED`, `TOKEN_EXPIRED` and
`UNAUTHENTICATED` (held until a token refresh, never settled — set the fresh
`client.authToken(token)` and call `flushOfflineQueue` yourself: this client
never flushes on its own, on a reconnect or on a new token) re-queue, so a
coded 5xx is terminal; an envelope whose `data` does not decode keeps its code
with the `data` dropped — and a reply with no envelope by its
status: re-queued, except a 413. A 413 is `PAYLOAD_TOO_LARGE` whatever its body,
so a batch refused with an edge's HTML 413 is halved and retried, and a lone
write still refused settles terminally with that code.

A write the server committed whose `result` does not decode settles `COMMITTED`
with no value and an `ApiException` coded `WIRE_DECODE_FAILED` on its settled
event; its overlay confirms against the echoed cursor and it is never retried.
A direct `query`/`mutation`/`action` raises that same coded error, and one whose
body is not a JSON object at all (an HTML page, `null`, `[]`) raises an
`ApiException` coded `INTERNAL`. A flush interrupted by an unexpected exception
puts every write it had drained but not yet settled back on the queue.

`client.identity(id)` sets an opaque, **non-secret** stamp — a user id, not a
bearer token. It is persisted with every queued write and re-checked before that
write replays, so a restart cannot push one user's queued writes as another. Left
`null`, a write is stamped with a digest of `client.authToken()` instead
(`Identity.tokenStamp`, persisted as `{"tokenDigest": …}` — the reference
client's digest, never the token itself), and signed out only when there is no
token either — so a write queued under one token is never sent with another.
Under a different token it is rejected `OFFLINE_IDENTITY_CHANGED`; with no token
at all it is held, unsettled, until one is set. A flush sends each write with
the token its identity was checked against, so a token set mid-flush applies
from the next flush, never to the rest of the current one. Setting `identity` is
what lets a token refresh keep the queue. A record persisted by an earlier build
with a `null` stamp is rejected the same way once a token is held, since `null`
then said nothing about whose write it was. `identity` may be any string: a
token stamp is a separate component of `Identity`, so no identity, however it is
spelled, can match a token's writes, nor a token stamp an identity's.
Changing it from a set value to a different one (another user, or `null` for
signed out) also evicts the previous session: every query and shape
subscription drops its resume cursor and epoch, and every shape view is emptied
and its `onRows` told `[]`. A first sign-in and re-setting the same value evict
nothing. With `identity` unset, setting a different `authToken` (or clearing it)
evicts the same way, since the token's digest is then the identity.

`synchronized` is reentrant, so a consumer callback invoked under the client's
monitor would not deadlock — it would instead run inside the critical section
guarding the subscription registry, which is its own hazard. So every consumer
callback (a transform, a `precondition`, a settled listener) runs with the
monitor released, and each queue method that discards a write RETURNS it for the
client to report. See [`sdks/README.md`](../README.md).

## Wire types

Java has no distinct `bigint`/`Map`/`Set`/`Date` matching JS's, so mark those
explicitly; plain values map to JSON directly:

| Lunora / `v.*`                         | Java                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `v.string/number/boolean/object/array` | `String` / `Double` / `Boolean` / `Map<String,Object>` / `List<Object>` |
| `v.bigint()`                           | `new Wire.WireBigInt(BigInteger.valueOf(1000))`                         |
| `v.bytes()`                            | `new Wire.WireBytes(data, ctor)`                                        |
| `Date`                                 | `new Wire.WireDate(epochMs)`                                            |
| `Map` / `Set`                          | `new Wire.WireMap(entries)` / `new Wire.WireSet(items)`                 |
| `URL`                                  | `new Wire.WireUrl("https://…")`                                         |

`Wire.decode` returns these same records so values round-trip exactly.

Strings are written exactly as `JSON.stringify` writes them, on the wire and in
the stable key alike: a lone UTF-16 surrogate goes out as a lowercase `\udXXX`
escape, never the `?` the JDK's UTF-8 encoder would substitute for it.

### One thing to know about generated models

The Java models are **not** rendered by quicktype, unlike most targets:
quicktype's Java backend renames properties (a wire `channelId` becomes
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
cd sdks/java
PATH="$JDK_BIN:$PATH" bash build.sh
```

On macOS, `/usr/bin/java` is Apple's stub and is not a JDK — point `JDK_BIN` at a
real one (`$(/usr/libexec/java_home)/bin`).
