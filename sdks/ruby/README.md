# Lunora Ruby SDK

A **protocol-conformant** Ruby client for a Lunora deployment, implementing the
transport specified in [`protocol/README.md`](../../protocol/README.md):

- `query` / `mutation` / `action` round-trips over `POST /_lunora/rpc`.
- Live `subscribe` — and `stream`, which hands back an `Enumerator` — over the WebSocket `data`/`delta`/`ack`/`error`/`resume`/
  `settled` frames.
- `subscribe_shape` over the poke (`pokeStart`/`pokePart`/`pokeEnd`) partial-
  replication path.
- A full `encode_wire` / `decode_wire` value codec (bigint, bytes, `Date`,
  `Map`/`Set`, `URL`, `NaN`/`Infinity`, `undefined`) plus the stable
  subscription key.
- `submit` — the offline-capable write path: cursor-gated optimistic updates
  (`lunora/optimistic.rb`) over the durable replay queue (`lunora/offline.rb`).

> **Not a pnpm/TS package.** This lives under `sdks/ruby/` and is a standalone
> Ruby project. The transport is **standard-library only**; `dry-struct` and
> `dry-types` are needed only when `lunora sdk generate` emits typed models,
> because that is what quicktype's Ruby backend renders.

## Usage

HTTP and the socket are **injected**, so you keep your own client, timeouts,
retries and socket library:

```ruby
require "lunora"

client = Lunora::Client.new(
  "https://my-app.example.com",
  http_post: my_poster,
  auth_token: "…",
  identity: current_user_id,
  # client_id is minted per instance. Pin a stable per-device one only when the
  # offline queue is durable — a replayed write is namespaced server-side under
  # the id that issued it.
)

messages = client.query("messages:list", { "channel" => "general" })
client.mutation("messages:send", { "channel" => "general", "text" => "hi" })
client.mutation("ledger:add", { "amount" => Lunora::WireBigInt.new(1000) })

# Live subscription: attach your socket, then feed it frames.
client.attach_socket(->(frame) { socket.send(JSON.generate(frame)) })
unsubscribe = client.subscribe("messages:list", { "channel" => "general" }, method(:render))
```

`client.handle_frame(raw)` is what you call with each inbound WebSocket message;
`client.resend_subscriptions` re-subscribes everything after a reconnect —
queries and shape views alike — carrying each one's resume cursor or checkpoint.

## Optimistic updates and offline writes

`mutation` is the direct write path: one HTTP round-trip that raises when the
deployment is unreachable. `submit` is the one that survives a dropped socket —
it queues the write, shows a predicted value immediately, and replays in order
once the socket is back.

```ruby
# Capacity, an app version, and a durable store are all optional; the default is
# an in-memory queue of 1000 writes.
client.offline_queue = Lunora::OfflineQueue.new(max_items: 500, persistence: my_store, version: "v2")

client.subscribe("messages:list", { "channel" => "general" }, method(:render))

outcome = client.submit(
  "messages:send",
  { "channel" => "general", "text" => "hi" },
  # Layered onto the subscription registered under the same (path, args, shard).
  # Re-run on every server frame, so derive from `current` rather than closing
  # over a value.
  optimistic: ->(current) { [*current, { "text" => "hi", "pending" => true }] },
  # Re-checked just before a QUEUED write replays: false drops it instead of
  # replaying a write that can only fail.
  precondition: -> { channel_still_exists?("general") },
  on_settled: ->(event) { puts("#{event.status} #{event.mutation_id}") },
)

return if outcome.queued? # durably queued, not committed — don't report success yet
```

The overlay drops the moment a frame whose `cursor` reaches the write's echoed
`commitCursor` arrives, so the confirming frame never double-counts it; a failed
write rolls back. `client.flush_offline_queue(shard_key)` replays a shard's
queued writes when its socket returns, and `client.hydrate_offline_queue`
restores what a prior session persisted, returning the shard keys to flush.

A queued write whose args cannot be wire-encoded settles terminally on the first
flush (`OFFLINE_WRITE_UNENCODABLE`) rather than being retried forever, and every
discard — including one the capacity cap evicts out of a _restored_ queue, which
has no caller left to tell — reaches `client.on_mutation_settled`.

The durable record holds the **wire** form of the args, so a store that
serialises (a file, a SQLite text column) round-trips a `WireBigInt`,
`WireBytes`, `WireDate` or `WireMap` argument unchanged. A restored record whose
args no longer decode is purged and settled `OFFLINE_WRITE_UNDECODABLE` rather
than replayed with substitute args.

A replay the server rate-limits (`RATE_LIMITED` / `TOO_MANY_REQUESTS`) is
re-queued, never dropped; `FlushReport#retry_after_ms` carries the envelope's
`data.retryAfterMs`, and a flush inside that window is a no-op that reports the
time remaining.

`client.identity` is an opaque, **non-secret** stamp — a user id, not a bearer
token. It is persisted with every queued write and re-checked before that write
replays, so a restart cannot push one user's queued writes as another.

Ruby's `Mutex` is **not reentrant**, so every consumer callback — a transform, a
`precondition`, a settled listener — runs with the client's lock released. That
is not a style choice: an eviction that rejected a write in place once raised a
`ThreadError` the queue's own rescue swallowed, and the write silently never
rolled back. See [`sdks/README.md`](../README.md).

## Wire types

Ruby lacks JS's distinct `bigint`/`Map`/`Set`/`Date`, so mark those explicitly;
plain values map to JSON directly:

| Lunora / `v.*`                         | Ruby                                                               |
| -------------------------------------- | ------------------------------------------------------------------ |
| `v.string/number/boolean/object/array` | `String` / `Integer`\|`Float` / `true`\|`false` / `Hash` / `Array` |
| `v.bigint()`                           | `Lunora::WireBigInt.new(1000)`                                     |
| `v.bytes()`                            | `Lunora::WireBytes.new(data, "Float32Array")`                      |
| `Date`                                 | `Lunora::WireDate.new(epoch_ms)`                                   |
| `Map` / `Set`                          | `Lunora::WireMap.new(pairs)` / `Lunora::WireSet.new(items)`        |
| `URL`                                  | `Lunora::WireUrl.new("https://…")`                                 |

`decode_wire` returns these same wrappers so values round-trip exactly.

## Tests

The suite drives the SDK against the **shared** golden fixtures in
`protocol/fixtures/` — the identical files the TypeScript client is tested
against — and against `protocol/conformance-cases.json`, which lists the cases
every SDK's suite must exercise. A `Minitest.after_run` hook aborts if a required
case did not execute, so run the whole suite rather than one file:

```bash
cd sdks/ruby
ruby -Ilib -e 'Dir["test/test_*.rb"].each { |f| require "./#{f}" }'
```
