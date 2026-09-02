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

The row that is the reason this port exists. `watch` subscribes on first listen
and unsubscribes when the last listener cancels, so disposing the widget disposes
the subscription and there is no `dispose()` override to forget:

```dart
StreamBuilder<Object?>(
  stream: client.watch('messages:list', args: {'channel': 'general'}),
  builder: (context, snapshot) => MessageList(snapshot.data),
);
```

The callback-shaped `client.subscribe(...)` every sibling port has is there too,
for a value whose lifetime is not a widget's.

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
