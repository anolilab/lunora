# Lunora Dart SDK

A **protocol-conformant** Dart/Flutter client for a Lunora deployment,
implementing the transport specified in
[`protocol/README.md`](../../protocol/README.md):

- `query` / `mutation` / `action` round-trips over `POST /_lunora/rpc`.
- Live `subscribe` — and `watch`, which hands back a `Stream` — over the
  WebSocket `data`/`delta`/`ack`/`error`/`resume`/`settled` frames.
- `subscribeShape` over the poke (`pokeStart`/`pokePart`/`pokeEnd`) partial-
  replication path.
- A full `encodeWire` / `decodeWire` value codec (bigint, bytes, `Date`,
  `Map`/`Set`, `URL`, `NaN`/`Infinity`, `undefined`) plus the stable subscription
  key.
- Cursor-gated optimistic updates (`optimistic.dart`) over the durable replay
  queue (`offline_queue.dart`), replayed by `replay.dart` — including **batched
  replay** over `/_lunora/rpc-batch`.

> **Not a pnpm/TS package.** This lives under `sdks/dart/` and is a standalone
> pub package. It imports `dart:convert`, `dart:typed_data` and `dart:async` and
> **nothing else**, so it runs unchanged on every Flutter target — iOS, Android,
> web, macOS, Windows, Linux — with no FFI and no conditional import.

```yaml
# pubspec.yaml
dependencies:
    lunora_sdk: { path: ./sdk/dart }
```

pub takes a path dependency's identity from the depended-on `pubspec.yaml`'s
`name:`, not from the directory, so `lunora_sdk` is what you write no matter
where you generated into.

## Usage

HTTP and the socket are **injected**, so you keep your own client, timeouts,
retries and socket library:

```dart
final client = LunoraClient(url: 'https://my-app.example.com', post: myPoster, authToken: '…')
  ..attachSocket((frame) => socket.add(jsonEncode(frame)))
  ..setConnected(true);

final messages = await client.query('messages:list', args: {'channel': 'general'});
await client.mutation('messages:send', args: {'channel': 'general', 'text': 'hi'});
```

`client.handleFrame(raw)` is what you call with each inbound WebSocket message;
`client.resendSubscriptions()` re-subscribes everything after a reconnect,
carrying each subscription's resume cursor.

### A live query is a `Stream`

The row that is the reason this port exists. Each listener opens its own
subscription, which starts when it listens and is torn down when it cancels, so
disposing the widget disposes exactly its own subscription and there is no
`dispose()` override to forget — at the price of one server subscription, and one
re-execution per write, for every listener:

```dart
StreamBuilder<Object?>(
  stream: client.watch('messages:list', args: {'channel': 'general'}),
  builder: (context, snapshot) => MessageList(snapshot.data),
);
```

The callback-shaped `client.subscribe(...)` every sibling port has is there too,
for a value whose lifetime is not a widget's. `client.close()` ends every
`watch()` stream still open, so a listener sees `done` rather than waiting on a
client that will never feed it again.

Changing the identity from a set one — `authSubject` or, with no subject,
`authToken` — to a different one or to none retires the previous session: every
subscription resubscribes cold (no `sinceSeq`/`sinceCheckpoint`), and every
shape view is emptied, its `onRows` called with `[]`. A first sign-in and
re-setting the same identity change nothing.

## Optimistic updates and offline writes

Unlike the sibling ports, which add a separate `submit`, the queue is built into
`mutation`: a write issued while disconnected is held and replayed in order on
reconnect, under the same idempotency key the call minted, so a write the server
already committed is not applied twice.

```dart
// Capacity, an app version, and a durable store are all optional; the default is
// an in-memory queue of 1000 writes.
final client = LunoraClient(
  url: 'https://my-app.example.com',
  post: myPoster,
  authSubject: currentUserId,
  offlineQueue: OfflineQueue(maxItems: 500, persistence: myStore, version: 'v2'),
);

await client.hydrate(); // restore what a prior session persisted

await client.mutation(
  'messages:send',
  args: {'channel': 'general', 'text': 'hi'},
  // Patches any number of subscribed queries. The general form — see the warning
  // below for when the per-call `optimistic` shorthand applies instead.
  optimisticUpdate: (store, _) => store.setQuery(
    'messages:list',
    [...(store.getQuery('messages:list', args: listArgs)! as List<Object?>), pending],
    args: listArgs,
  ),
  // Re-checked just before a QUEUED write replays: false drops it instead of
  // replaying a write that can only fail.
  precondition: () => channelStillExists('general'),
);
```

> A per-call `optimistic` patches the query subscribed under the **mutation's
> own** path and args — the shorthand for a counter or a document-by-id, where a
> query and a mutation share both. To patch a differently-named query, which is
> the usual case, use `optimisticUpdate`: its store names its targets.

The overlay drops the moment a frame whose `cursor` reaches the write's echoed
`commitCursor` arrives, so the confirming frame never double-counts it; a failed
write rolls back. A queued write whose args cannot be wire-encoded settles
terminally on the first flush (`OFFLINE_WRITE_UNENCODABLE`) rather than being
retried forever, and every discard — including one the capacity cap evicts out of
a _restored_ queue, which has no caller left to tell — reaches the queue's
`onSettled`.

How a replay reads the reply is one rule for a lone write and a batch alike: a
coded envelope is the server's verdict whatever its HTTP status (so a coded 5xx
is terminal), and only the transient codes (`SHARD_UNAVAILABLE`, `SHARD_ERROR`,
`RATE_LIMITED`, `TOO_MANY_REQUESTS`) re-queue; a reply with no envelope re-queues,
except a `413`, which splits a batch and settles a lone write
`PAYLOAD_TOO_LARGE`. A write the server committed whose result does not decode is
still committed: its overlay confirms, and it settles with `WIRE_DECODE_FAILED`
(the same code a direct call throws) instead of a value, never retried. A flush
that fails unexpectedly part-way puts every write it had not yet settled back on
the queue, and never throws.

Every RPC fails with `LunoraApiException` — coded `INTERNAL` when the body is not
a JSON object (an HTML error page, `null`, `[]`) — never with a raw
`FormatException` or cast error.

### Three things this port does differently

Each follows from what this transport is rather than from taste, and
[`sdks/README.md`](../README.md) records them:

- **Connectivity is told, not observed.** The client does not own a socket, so
  `setConnected(true|false)` is how it learns, and the transition to connected is
  what flushes the queue. It sits beside `attachSocket` and `resendSubscriptions`
  in the same reconnect recipe.
- **Persistence is asynchronous.** `LunoraPersistence` is four `Future`-returning
  methods you implement over `shared_preferences`, `sqflite`, Drift or a plain
  file; the sibling ports take a synchronous adapter. `MemoryPersistence` ships
  for tests. With no adapter the queue survives a dropped socket but not a
  restart. A `PersistedMutation`'s `args` are the WIRE form, so an adapter only
  ever has to move JSON — a queued write carrying a `BigInt`, bytes or a date is
  already encoded by the time it reaches you, and decoded again on hydrate.
- **Connectivity is reported per shard.** `setConnected(true, shardKey: …)`
  flushes only that shard's writes, so one shard reconnecting cannot replay
  another's down a connection that cannot reach it. Omit `shardKey` for the
  default shard; `''` and `null` are the same shard everywhere.

`authSubject` is an opaque, **non-secret** stamp — a user id, not a bearer token.
It is persisted with every queued write and re-checked before that write replays,
so a restart cannot push one user's queued writes as another. Leave it unset to
fall back to a digest of `authToken`; a null token then means signed out, which
is a real identity rather than "unstamped".

## Wire types

Dart lacks JS's distinct `bigint`/`Map`/`Set`/`Date`, so mark those explicitly;
plain values map to JSON directly:

| Lunora / `v.*`                         | Dart                                                                 |
| -------------------------------------- | -------------------------------------------------------------------- |
| `v.string/number/boolean/object/array` | `String` / `num` / `bool` / `Map<String, Object?>` / `List<Object?>` |
| `v.bigint()`                           | `BigInt`                                                             |
| `v.bytes()`                            | `Uint8List`, or `WireBytes(data, ctor)` for another view             |
| `Date`                                 | `WireDate(epochMs)`                                                  |
| `Map` / `Set`                          | `WireMap(entries)` / `WireSet(items)`                                |
| `URL`                                  | `WireUrl('https://…')`                                               |

`decodeWire` returns these same wrappers so values round-trip exactly.

A number off the wire is a float64, whatever its spelling: `JSON.stringify`
writes a double in [2^53, 1e21) as an integer literal, which `jsonDecode` types
as an `int`, so `decodeWire` turns an `int` past ±(2^53−1) into the `double`
`JSON.parse` would have read. An `int` you construct past that range is still
refused by `encodeWire` — wrap it in a `BigInt`.

### Two things to know about generated models

Dart's quicktype output needed two repairs, both pinned in
`packages/codegen/__tests__/sdk-dart.test.ts` against its real output so a
version bump turns that test red rather than silently restoring the bug:

- An unset optional **list** was sent as `[]` rather than as an absent key.
- An unset optional **map** threw — `Map.from(field!)` is a null-assertion on a
  field quicktype had just declared nullable, so constructing or serialising the
  model died on the first call.

A third repair is the one every port needs: an unset `v.optional()` must reach
the wire as an ABSENT key while a required `v.nullable()` must reach it as a
PRESENT null, and quicktype writes `"x": x` for both. Only the model still knows
which is which, so the emitter guards exactly the optional entries.

## Tests

The suite drives the SDK against the **shared** golden fixtures in
`protocol/fixtures/` — the identical files the TypeScript client is tested
against — and against `protocol/conformance-cases.json`, which lists the cases
every SDK's suite must exercise. The end of `main` is the after-all hook that
fails the run if a required case did not execute.

```bash
cd sdks/dart
dart pub get --offline && dart run test/conformance.dart
```

A plain `main()` rather than a `package:test` suite: `package:test` is not in the
SDK, so depending on it would make this package's `dart pub get` reach pub.dev —
and the transport is defined to have no dependencies at all.
