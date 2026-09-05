# Non-JS client SDKs

One hand-written transport per language, plus a generated surface produced by
`lunora sdk generate --lang <id>`.

Browser and Node consumers should use `@lunora/client`, which is hand-written,
richer than anything generated, and not covered here.

This file is the CONTRIBUTOR side: how the three layers fit together, where the
ports deliberately differ, and what the gates are. For using one transport —
wiring, examples, its own wire-type table — read that language's own README:
[python](./python/README.md) · [go](./go/README.md) · [ruby](./ruby/README.md) ·
[rust](./rust/README.md) · [swift](./swift/README.md) · [java](./java/README.md)
· [kotlin](./kotlin/README.md) · [dart](./dart/README.md).

## The three layers

| Layer          | Where                                        | Generated?                                     |
| -------------- | -------------------------------------------- | ---------------------------------------------- |
| Models         | `quicktype-core`, per target                 | yes, where the backend can express them        |
| Method surface | `packages/codegen/src/sdk/targets/<lang>.ts` | yes                                            |
| Transport      | `sdks/<lang>/`                               | **no** — hand-written, and COPIED into `--out` |

`packages/codegen/src/sdk/target.ts` documents the conventions every target must
follow, and `packages/codegen/__tests__/sdk-targets.test.ts` enforces them — a
convention that only exists in prose gets violated silently, which is exactly how
three of them were.

## The transport is copied, not installed

`lunora sdk generate` writes the transport into its output directory beside the
generated surface, so the result runs with **no Lunora package installed
anywhere**. This is the same copy-in model as `lunora registry add`, and it is not
a preference: the runtime packages the generated code used to import do not exist.
`lunora` 404s on PyPI, RubyGems, crates.io and pub.dev, `dev.lunora:lunora` 404s
on Maven Central, and `github.com/anolilab/lunora-go` 404s too — so the Go
surface could not resolve its own import in a user's project at all, and only
compiled in CI because the generated package happened to sit inside this repo's
module. Publishing eight registries (Maven Central alone needs a build tool these
transports do not have, plus groupId ownership and signing) is a larger project
than the SDKs.

### Layout per language

Each language gets the arrangement its own toolchain resolves, which is not the
same shape as this repo's. `targets/<lang>.ts` carries the reasoning; the summary:

| Language | Output layout                                              | How a consumer wires it up                                |
| -------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| python   | `lunora/` + `lunora_api/`                                  | put `<out>` on `sys.path`, `import lunora_api`            |
| go       | `go.mod` (module `lunorasdk`) + `lunora/` + `lunoraapi/`   | `require lunorasdk v0.0.0` + `replace lunorasdk => <out>` |
| ruby     | `lunora.rb` + `lunora/` + `api.rb` + `models.rb`           | `$LOAD_PATH.unshift(<out>)`, `require "lunora"` / `"api"` |
| rust     | `Cargo.toml` (`lunora-api`) + `src/` + `lunora/`           | `lunora-api = { path = "<out>" }`                         |
| swift    | `Package.swift` + `Sources/Lunora/` + `Sources/LunoraApi/` | `.package(path: "<out>")` + `.product(name:package:)`     |
| java     | `dev/lunora/*.java` + `lunoraapi/Api.java`                 | `javac -sourcepath <out>`                                 |
| kotlin   | `dev/lunora/*.kt` + `lunoraapi/Api.kt`                     | `kotlinc <out> …`                                         |
| dart     | `pubspec.yaml` (`lunora_sdk`) + `lib/`                     | `lunora_sdk: {path: <out>}` in `dependencies`             |

Two of those cost the consumer a line they would not otherwise write. Go needs the
`replace`, because two packages in one module beat one flat package: the transport
exports `Error`, `Map`, `Set`, `Date`, `URL`, `Bytes` and `Client`, so a table
named `error` or a result model named `Map` would be a redeclaration — a schema in
a user's project breaking the SDK's own compile. Swift needs `package:` spelled as
the output DIRECTORY's name, because SwiftPM takes a path dependency's identity
from the last path component and ignores the manifest's `name:`; a bare product
name does not resolve either. Both measured, both recorded in their target file. Dart is the counter-example
worth naming beside Swift, because the two look alike and are not: pub takes a
path dependency's identity from the DEPENDED-ON `pubspec.yaml`'s `name:` field,
not from the directory, so `lunora_sdk` is what a consumer writes no matter where
they generated into. It is also the only target that emits ONE package rather
than two units — `import 'lunora.dart'` inside `lib/` is a file import, not a
module import, so the generated surface and the vendored transport coexist with
no boundary to cross. The price is that nothing under `sdks/dart/lib/` may name
its own package: every import there is relative, because the copy resolves under
whatever name the emitted manifest declares and a `package:lunora/…`
self-import would dangle in every generated SDK.

### What a consumer must install

Six of eight: nothing.

| Language     | Install                                                            |
| ------------ | ------------------------------------------------------------------ |
| python       | nothing — stdlib only                                              |
| go           | nothing — stdlib only                                              |
| java, kotlin | nothing — JDK only                                                 |
| swift        | nothing — Foundation only                                          |
| dart         | nothing — `dart:convert` / `dart:typed_data` only                  |
| rust         | `serde` (derive) + `serde_json`, declared in the emitted manifests |
| ruby         | `dry-struct` + `dry-types`, and only when models are emitted       |

The two that are not empty are quicktype's, not the transports': the Ruby backend
renders `Dry::Struct` types with no renderer option to avoid them, and Rust models
are `serde` types. Dart's models are quicktype's too and still add nothing — its
backend renders hand-rolled `fromJson`/`toJson` over `dart:convert` rather than
annotations needing a codec package. Cargo resolves Rust's from the emitted `Cargo.toml`, so only
Ruby's is a manual step.

### Which vintage did I get

A copy cannot be upgraded by bumping a version, so the fetch is pinned to the
CLI's own release tag (`@lunora/cli@<version>`) and every output carries a
`lunora-transport.json` recording the ref that was actually used:

```json
{ "cliVersion": "1.0.0-alpha.159", "ref": "@lunora/cli@1.0.0-alpha.159", "versionMatched": true, … }
```

`versionMatched` is the field that matters — it says whether the transport and the
surface above it came from one release. Regenerating with a newer CLI is the
upgrade path. When the tag carries no transport for that language (a language
added since the last release), the CLI falls back to the release branch, warns
loudly naming both refs, and records `versionMatched: false`. `--ref <tag>` pins
explicitly and never falls back; `--from <dir>` copies from a local checkout of
this directory and is what CI uses.

## Capability matrix

This table exists for the same reason `PlatformCapabilities` does (see
`CLAUDE.md`): eight independently hand-written transports drift, and silence is
what lets the next consumer discover a gap at runtime. Update it in the same
change that adds or removes a capability.

| Capability                    | python | go  | ruby | rust | swift | java | kotlin | dart |
| ----------------------------- | ------ | --- | ---- | ---- | ----- | ---- | ------ | ---- |
| Wire codec (all tags)         | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| Stable subscription key       | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| RPC query / mutation / action | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| Live subscriptions            | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| Shapes + poke protocol        | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| Resume across reconnect       | ✅⁶    | ✅⁶ | ✅⁶  | ✅⁶  | ✅⁶   | ✅⁶  | ✅⁶    | ✅⁶  |
| Typed argument models         | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| Typed result models           | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| Concurrency-safe client       | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| Subscription as a stream      | ✅¹    | ✅¹ | ✅¹  | ✅¹  | ✅¹   | ✅¹  | ✅¹    | ✅¹  |
| Unset `v.optional()` omitted  | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| Required `v.nullable()` sent  | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| Optimistic updates            | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| Offline mutation queue        | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| Durable offline queue         | ✅²    | ✅² | ✅²  | ✅²  | ✅²   | ✅²  | ✅²    | ✅²  |
| Per-shard drain               | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| Batched offline replay        | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| Rate-limit backoff            | ✅⁵    | ✅⁵ | ✅⁵  | ✅⁵  | ✅⁵   | ✅⁵  | ✅⁵    | ✅⁵  |
| Row-delta merge into a list   | ❌⁷    | ❌⁷ | ❌⁷  | ❌⁷  | ❌⁷   | ❌⁷  | ❌⁷    | ❌⁷  |
| `chunk` / `whisper` frames    | ❌⁸    | ❌⁸ | ❌⁸  | ❌⁸  | ❌⁸   | ❌⁸  | ❌⁸    | ❌⁸  |
| Multi-tab leader election     | ❌     | ❌  | ❌   | ❌   | ❌    | ❌   | ❌     | ❌   |
| Built-in HTTP / socket        | ✅⁴    | ❌  | ❌   | ❌   | ❌    | ❌   | ❌     | ❌   |
| Several sockets per client    | ❌³    | ❌³ | ❌³  | ❌³  | ❌³   | ❌³  | ❌³    | ❌³  |

¹ Each in the language's own PULL type, not one shape forced onto eight — an
async generator in Python, a receive channel in Go, an `Enumerator` in Ruby, an
`mpsc::Receiver` in Rust, an `AsyncStream` in Swift, a closeable `Iterable` in
Java, a closeable `Sequence` in Kotlin, a `Stream` in Dart. The values and their
order are the same everywhere, which is what
`subscription_stream_yields_frame_values_in_order` asserts.

² Through an injected adapter, like HTTP and the socket — see below.

³ **One client holds one socket, and this is load-bearing.** Every port has a
single sender field (`attach_socket`/`AttachSocket`/`attachSocket` replaces it
rather than adding one), and every inbound frame arrives through a
`handleFrame(raw)` that carries no connection identity — there is none on the
wire either, since a poke frame names only its `pokeId`. An app spanning several
shards builds one client per shard, which is also what keeps
`protocol/README.md` §5.3's `(connection, pokeId)` rule satisfied here: each
client owns its own poke buffers, so two shards' concurrent `poke-1` frames can
never meet. Routing two sockets into one client is not merely unscoped for
pokes — the second `attachSocket` orphans the first socket, and
`resendSubscriptions` then blasts every shard's subscriptions down whichever one
attached last. Do not add a connection key to the buffer map without first
giving these clients a real multi-socket model; a key alone would quiet one
symptom of a configuration that is broken in several other places.

⁴ **python is the exception, and this row said otherwise for a long time.**
`LunoraClient` defaults `http_post` to a real `urllib` transport rather than
requiring one to be injected, and `connect_and_run` drives a live socket through
the optional `websockets` package. Every other port takes both from the caller.
The row read ❌ for all eight because that is what the seven were, and nobody
re-read the eighth — a matrix is only worth its accuracy in the direction it does
not expect to be wrong. Injecting `http_post` still overrides the default
everywhere it is passed.

⁵ **From the envelope only.** `protocol/README.md` §4.3 says a rate-limited
retry SHOULD wait out `error.data.retryAfterMs` **or** the `Retry-After` header;
these eight honour the first and none of them can see the second. Every port
takes HTTP as an injected `(url, headers, body) -> (status, body)` poster, and a
response header is not on that return — reading one means changing the contract a
consumer already implements, in eight languages, for a value the RPC plane's own
envelope carries. It is a real gap in front of an edge or a proxy that rate-limits
with the header alone: the write is still re-queued and never dropped, but the
retry is not paced. Widening the poster is the fix, and it is a change to make
once for all eight rather than piecemeal.

⁶ **Queries and shapes both.** `resendSubscriptions` walks the shape registry as
well as the query one, carrying each shape's `sinceCheckpoint`/`sinceEpoch`. This
row read ✅ for a long time while seven of the eight resent only queries, so
after the first socket drop every `subscribeShape` view stopped receiving pokes
for the life of the process — silently, because a shape is only ever fed by pokes
the server had stopped sending. `shape_subscriptions_resend_after_reconnect` in
`conformance-cases.json` is what makes the claim checkable rather than asserted.

⁷ **A `delta` frame REPLACES the value here; the reference MERGES it.** All eight
route `data` and `delta` through one arm and publish `frame.data ?? frame.delta`,
while `@lunora/client` recognises a `{ key, op, table, row }` row change
(`delta-merge.ts`) and splices it into the cached list by `_id`, falling back to
replacement only when it cannot. So on the `broadcastDelta` fan-out these clients
publish the row-change envelope itself over a query result. It is a missing
FEATURE rather than a wire divergence — the frames are decoded correctly — and it
is a row here rather than a conformance case because `conformance-cases.json` may
only require behaviour every port has. Closing it is one merge implementation per
language against the placement rule in `protocol/README.md` §5.1.1, which the
`pageDeltaFrames` goldens already carry.

⁸ **Neither frame is handled.** `chunk` (a streaming-query chunk, with the durable
`seq`/`generation` resume watermark) and `whisper` (the ephemeral topic relay) are
in `protocol/README.md` §5.2 and reach the default arm of every port's frame
switch, where they are ignored. No port sends `stream`, `whisper_subscribe` or
`whisper` either, so nothing arrives to drop; the gap is that a deployment using
those features has no non-JS client for them.

**The two argument rows are one problem with two halves, and no port can pass
both by a rule applied at the transport.** An unset `v.optional()` must reach the
wire as an ABSENT key, because the validator rejects an explicit null; a required
`v.nullable()` set to null must reach it as a PRESENT key holding null, because
the validator requires it. Both were measured against `@lunora/values`, not
assumed: an absent key for the second raises `Expected string at nickname,
received undefined`, and an explicit null for the first raises `Expected number
at limit, received null`.

All eight get both right, and every one draws the line where the
required-versus-optional distinction still exists — which, for three of them, is
nowhere in the rendered model:

| Port         | How                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| python       | quicktype's own `to_dict`: `if self.x is not None:` for optional, `result["x"] = …` for required        |
| go           | quicktype's own struct tags: `omitempty` on optional fields only                                        |
| java, kotlin | `jvm-models.ts` emits from the JSON Schema, which carries `required` outright                           |
| dart         | `guardOptionalFields` puts `if (x != null)` on optional entries, keyed on quicktype's `required this.x` |
| ruby, rust   | the generated call site passes the OPTIONAL paths, and the projection prunes only there                 |
| swift        | the generated call site passes the NULLABLE paths, and the projection restores those nulls              |

The last three had no marker to key on at all — Ruby declares both
`Types::X.optional`, Rust renders both a bare `Option<T>` with no serde
attribute, and Swift renders both `T?` and lets synthesized `Codable` omit a nil
(`{"id":"r1"}` for a struct whose `nickname` was explicitly null, measured). So
they are handed the answer instead, as a list of PATHS computed from the schema
by `ModelNullPaths` in `packages/codegen/src/sdk/spec.ts` and emitted at the call
site. A path is a run of keys from the model's root, with `*` for an array
element or a record value, so a nested or in-array property is covered as exactly
as a top-level one.

What "optional" means is quicktype's answer, not the schema's read literally.
It MERGES the branches of an `anyOf` into one class whose every property is
nullable unless every branch requires it, so `v.union(v.object({a}),
v.object({b}))` renders one class emitting both — one of them null. A walk that
took each branch's own `required` at face value would emit no paths, and the
inactive branch's null would reach a server that accepts neither shape. So the
walk intersects across merged branches, and a `{type:"null"}` branch contributes
no shape at all, which is what stops `.nullable()` on an object making its
properties optional.

Ruby and Rust take the OPTIONAL paths and prune only there. Swift takes the
NULLABLE ones and restores, because `JSONEncoder` has already dropped every
struct-property nil before the transport sees a tree — and at a required path an
absent key can only have been a nil, so putting the null back is exact rather
than a guess. Neither list names a `*` position: no port drops a null there, and
listing one would make Swift's restore invent record keys that were never sent.

Pruning only where the schema says also closed a second, quieter bug in the two
pruning ports. A blanket prune walked the whole tree, so a deliberate null inside
a `v.record()` or an array — a value the caller chose, nothing to do with
optionality — disappeared with the rest.

**Subscription as a Stream, dart.** The one row where a target does something the
others do not, and it is the reason the port exists: `client.watch(path, args)`
and the generated `watchX(args)` return a `Stream`, which a Flutter
`StreamBuilder` consumes with no adapter. The stream subscribes on first listen
and unsubscribes when the last listener cancels, so disposing a widget disposes
the subscription and there is no `dispose()` override to forget. The
callback-shaped `subscribe`/`subscribeX` every sibling has is still there, for a
value whose lifetime is not a widget's.

**Optimistic updates and the offline queue, dart.** All eight ports carry these
now — the shared behaviour, and the six places every port departs from
`@lunora/client`, are one section down under
[Optimistic updates and the offline write queue](#optimistic-updates-and-the-offline-write-queue).
Dart landed them first, and it is the target that most needs them: a mobile
client is disconnected routinely rather than exceptionally, so a write it cannot
send yet and a value it can show before the server confirms are the difference
between a usable app and one that spins.

Three things are Dart's alone, and each follows from this transport's own shape
rather than from taste:

- **Connectivity is told, not observed.** The other seven flush on the socket
  attach/detach they are already handed; this one does not take a socket, so
  `setConnected(true|false)` is how it learns, and the transition to connected is
  what flushes the queue. It sits beside `attachSocket` and `resendSubscriptions`
  in the same reconnect recipe.
- **Persistence is ASYNCHRONOUS.** `LunoraPersistence` is four `Future`-returning
  methods a consumer implements over `shared_preferences`, `sqflite`, Drift, a
  file — whichever the app already has; the sibling ports take a synchronous
  adapter. Dart's async-by-default IO is why, and the queue does not await an
  `append`, so an adapter that reorders can let a `remove` land before the append
  it cancels. `MemoryPersistence` ships for tests. With no adapter the queue
  survives a dropped socket but not a restart.

**The targeting rule for a per-call `optimistic` is a trap worth stating.** It
patches the subscription opened under the MUTATION's own path and args — not
"whatever the write affects", which no client can know. So it is the shorthand
for a query and a mutation that share a path (a counter, a document by id) and
it silently finds nothing to patch otherwise. The general case — a `send`
mutation updating a `list` query — is `optimisticUpdate`, whose store names its
targets. That is the reference client's rule, kept verbatim rather than
"improved", because a port that quietly widens it makes two SDKs disagree about
what a prediction applies to.

**Batched replay** is ported too, and it is the reason `protocol/README.md` grew
a §4.3: the endpoint was in that document's transport table with no section
describing it, so the envelope existed only in the TypeScript client. A flush of
two or more writes now coalesces into `/_lunora/rpc-batch` round trips, chunked
at the worker's own 500-entry cap AND under a byte budget of 1 MiB less 64 KiB of
headroom, sent sequentially so FIFO survives a flush longer than one batch; a
lone write still rides the single-call path, which is the proven one. The four
rules that make it safe for a DURABLE write — a slot coded
`SHARD_UNAVAILABLE`/`SHARD_ERROR`/`RATE_LIMITED`/`TOO_MANY_REQUESTS` is
transient, an unanswered slot is retried under its original idempotency key, a
body with no `results` is a whole-batch outcome classified the same way, and a
`413` is a verdict on the REQUEST rather than on the writes inside it — are in
§4.3 and asserted here.

The byte budget and the `413` rule are the same defect from two directions, and
it cost 500 durable writes at a time. The worker reads a batch body under a 1 MiB
cap (`packages/runtime/src/body-readers.ts`) and answers
`413 PAYLOAD_TOO_LARGE`; a chunker that counts entries and never weighs them
sends a megabyte as soon as a backlog averages a couple of KiB per write, and a
whole-batch coded envelope is otherwise terminal for every entry — so a flush
settled the lot `rejected` although each write would have committed alone. Both
halves are needed: the budget is an estimate that cannot see the framing the
worker measures, so a chunk that is refused anyway is halved and retried rather
than settled.

`offline_flush_batches_multiple_writes` and
`offline_flush_batch_splits_on_payload_too_large` in `conformance-cases.json` are
what keep the eight agreeing about it: the round-trip count, the per-entry
envelope, the transient-slot rule that only a batch can express, and the split.

Deliberately not ported, and none of it is a gap a mobile client feels: cross-tab
leader election and the `BroadcastChannel` mirror (there are no tabs), the
IndexedDB read cache, the service-worker path, and the `@lunora/db` unified
outbox.

**Typed models, dart.** Dart is the target where quicktype's default output was
expected to fail the way the JVM backends do and did not. Its backend renames
properties exactly as Java's and Kotlin's do — a wire `2fa` becomes a `the2Fa`
field — but its DEFAULT render (that is, without `just-types`) writes the exact
wire key as a string literal inside `fromJson`/`toJson`, and an enum keeps its
wire value in an `EnumValues` table. Measured against the same adversarial key
set that defeated the JVM backends (`2fa`, `ID`, `URLs`, `some-key`, `user_name`,
`channelId`, and an `image-url` enum); all seven survived, over `dart:convert`
and no other dependency. So `targets/dart.ts` is a normal quicktype target and
there is no third hand-written model emitter.

What that output gets WRONG is fixed in the emitter, the way `narrowBareExcept`
fixes Python's swallowed `KeyboardInterrupt`. Two defects, both reachable by no
renderer option and both already familiar from sibling ports:

- **An unset optional list is sent as `[]`.** `field == null ? [] : List<…>` in
  `toJson`, and its mirror in `fromJson`, so `v.optional(v.array(…))` left unset
  arrives as an empty array rather than an absent key — and an absent key decodes
  to `[]` rather than to null. The same class of bug as Rust's `"limit": null`.
- **An unset optional map THROWS.** `Map.from(field!)` for a `v.record()` — a
  null-assertion on a field quicktype just declared nullable — so constructing OR
  serialising a model whose optional record is unset dies with "Null check
  operator used on a null value". Not a divergence: a hard crash on the first
  call, in every generated Dart SDK whose schema carries one.

The `!` is what tells the two cases apart, and it is quicktype's own nullability
marker rather than a guess: a REQUIRED record renders `Map.from(field)` with no
`!` at all. Both repairs are pinned in `packages/codegen/__tests__/sdk-dart.test.ts`
against quicktype's real output, so a version bump that changes the emitted shape
turns that test red instead of silently restoring the crash.

There is a third repair, and it is the one the other seven ports get wrong too.
An unset `v.optional()` must reach the wire as an ABSENT key — `v.optional()`
rejects an explicit null — while a `v.nullable()` set to null must reach it as a
PRESENT key holding null, because the validator requires it. quicktype writes
`"x": x` for both, so no rule applied at the transport can be right for both
halves: dropping nulls (which this target did at first, and which Swift's
`JSONEncoder` does by omitting a nil) breaks every nullable argument, and keeping
them breaks every unset optional.

Only the MODEL still knows which is which, and quicktype says so plainly —
`required this.x` in the constructor for one, plain `this.x` for the other. So
`guardOptionalFields` puts an `if (x != null)` in front of exactly the optional
entries and `LunoraClient.wireValue` projects `toJson()` through untouched. It
matches entries to constructor parameters BY POSITION, because the wire key is
not derivable from the field name (`some-key` is `someKey`, and an optional
enum's entry reads `"kind": kindValues.reverse[kind]`, which does not begin with
its field at all); a class whose two blocks do not line up is left alone rather
than half-rewritten, and that failure is loud because `sdks/smoke/dart` asserts
an unset optional never reaches the wire.
**Typed models, JVM.** The two JVM targets are the only ones whose models are NOT
rendered by quicktype, and the exception is measured rather than stylistic:
quicktype's Java and Kotlin backends rename properties (a wire `channelId` becomes
`channelID`) and emit no mapping metadata under `just-types`, so a model they render
cannot be projected back onto the wire. `acronym-style: original` fixes `channelId`
and still renames 5 of 14 realistic wire keys (`2fa`, `ID`, `URLs`, `some-key`,
`user_name`); Kotlin's `just-types` additionally erases enum wire values outright.
The backends do emit the exact wire name the moment `just-types` is dropped — as a
Jackson, Klaxon or kotlinx annotation, every one of which needs a library on the
classpath, which is the one thing these JDK-only transports do not have.

So `packages/codegen/src/sdk/jvm-models.ts` emits them from the JSON Schema
instead, whose property names ARE the wire names — there is no renamer to fight,
and `toWire()`/`fromWire()` write the schema's own key as a string literal. A local
field identifier is still derived (`2fa` cannot be a Java field, and becomes
`value2fa`), but it is cosmetic and never reaches the wire. Enums keep their value
(`enum class Kind(val wireValue: String)`, and `toValue()`/`forValue()` in Java),
an unset optional is OMITTED rather than sent as null, and Java gets one file per
class because its single-file form is not compilable Java. `targets/java.ts` records
every renderer option that was measured and why the alternative — subclassing
quicktype's `JavaRenderer`/`KotlinRenderer` — was not taken.

**Concurrency.** Go, Ruby, Java, Kotlin, Swift and Python hold a lock over the
subscription registry, the shape views and the id counters, and dispatch frames
and user callbacks after releasing it. Resume frames are BUILT under that lock,
because each one reads a `cursor` the frame handler writes. Every one of those
six has a test that starts a socket reader and four subscriber threads and
asserts on the resulting subscription count — a lost `nextId++` silently forgets
a live subscription, and that is deterministic where waiting for a hash map to
corrupt is not. The Swift leg additionally runs under `--sanitize=thread` in CI
(`SDK_TEST_TSAN=1`, see [Conformance](#conformance)); the
Ruby one gives its injected sender a `Thread.pass`, because MRI's 100ms time
slice otherwise lets four CPU-bound threads each run to completion without ever
interleaving, and the case then passes with the lock removed.

Python's lock is `threading.Lock`, not `asyncio.Lock`: `subscribe`,
`subscribe_shape`, `handle_frame` and `resend_subscriptions` are plain
synchronous methods, so the contention is between real OS threads — the WS read
loop against whatever thread the application subscribes from — and not between
tasks on one event loop. This row previously read "safe by virtue of the GIL",
which was wrong twice over. The GIL makes each bytecode atomic, not each
statement: `self._next_sub_id += 1` followed by a separate read of it lost 830 of
16,000 subscriptions in one unsynchronised run at the stock 5ms switch interval,
and building the reconnect resend by walking `_subs` while another thread
inserted raised `RuntimeError: dictionary changed size during iteration` on 10 of
10 runs. Its test lowers `sys.setswitchinterval` to sample that window often
enough to fail inside one run, which is the CPython counterpart of the Swift
leg's TSan pass — the failures above were measured at the stock interval.

Dart carries no lock either, and for a different reason again: isolates share no
mutable memory, so the socket read loop and the code calling `subscribe` are the
same isolate's event loop, and every method that touches the registry is
synchronous end to end — there is no `await` between reading the id counter and
writing it, and therefore no point for a second event to land in. That is why
this port has no counterpart to the four-thread subscription-count case the other
six run: it would assert nothing the language does not already guarantee.
Reaching one client from two isolates is not supported; give each isolate its
own, as one would with any Dart object.

Rust carries no lock and needs none: every method that touches that state takes
`&mut self`, so two threads reaching it at once is a compile error rather than a
data race, and with no interior mutability, `static` or `unsafe` in the client
that holds totally. Sharing is the caller's `Arc<Mutex<Client>>` — which required
`Client: Send`, so the injected poster, sender and handlers carry a `+ Send`
bound; without it one non-`Send` closure made the whole struct unshareable and no
amount of wrapping helped. Note the difference that follows: the other five
release their lock before invoking your callback and a caller's `Mutex` cannot,
so a Rust handler must not re-lock the client it was called from.

**HTTP and sockets are injected in every language, deliberately.** The
conformance suites run with no network, and a consumer keeps its own transport,
timeouts, retries and socket library rather than inheriting ours.

## Optimistic updates and the offline write queue

The three ✅ write rows above are the client-side write features, ported from
`@lunora/client` (`packages/client/src/optimistic-layers.ts` and
`offline-queue.ts`) into `optimistic.*` and `offline.*` in every transport. Both
are held to `protocol/fixtures/offline-optimistic.json`, which carries the values
and orderings all eight ports must agree on — the same shape as the wire
fixtures, for the same reason.

**Optimistic updates are cursor-gated and rebaseable.** A transform is recorded
as a LAYER on its subscription rather than written once and forgotten, so the
displayed value is always the authoritative server value folded through the
active layers. An incoming frame therefore re-folds the still-pending layers onto
the new base instead of clobbering them (a queued write's predicted value
survives an unrelated delta on the same query), and a layer drops the moment a
frame whose `cursor` has reached the write's echoed `commitCursor` arrives — so
the confirming frame cannot double-count it. The drop keys on the server's
cursor, never on RPC-response timing, which races the socket broadcast.

**The offline queue is a bounded, optionally durable FIFO.** Writes submitted
while the socket is down replay in submission order once it is back, each under
its own `x-lunora-mutation-id` so the server de-duplicates one it already
committed. Overflow evicts the OLDEST entry; a stale precondition drops a write
before it replays; an identity change refuses one; and a flush classifies each
reply — success confirms the overlay, a coded verdict is terminal, a transient
failure re-queues that write and every unreplayed one, in order.

**A durable record holds the WIRE form of its args.** The native form carries the
codec's own wrappers, and every real adapter serialises — a file, a SQLite text
column, a preferences store — so a queued write with a `bigint`, `bytes`, `Date`
or `Map` argument either failed to serialise (reported `queued` with nothing
durable written) or serialised as whatever the adapter made of an opaque object
and replayed after a restart with corrupted args. Encoding at the record boundary
also catches args outside the codec entirely, which is reported as the `append`
it prevented: the write stays in memory with its real args and settles terminally
on the next flush, never persisted as a substitute. A record whose stored args no
longer decode is purged and settled `OFFLINE_WRITE_UNDECODABLE` — replaying it
with substitute args would commit a different write than the caller made.

### Where the ports deliberately differ from `@lunora/client`

Each of these is forced by what these SDKs are rather than chosen:

| Divergence                                                                                                                                                                                                                                                                                                                                                             | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`submit` is a NEW method; `mutation` is unchanged.** `mutation` stays one direct HTTP round-trip that fails when the deployment is unreachable, because the generated surface calls it and a typed wrapper must keep returning a typed result. `submit` is the write path that survives a dropped socket.                                                            | Changing `mutation`'s contract under the generated code would turn "this write failed" into "this write is queued" for every existing caller.                                                                                                                                                                                                                                                                                                                                                                  |
| **`submit` returns immediately with a `status` of `committed` or `queued`.** The browser client's `mutation()` returns a promise that stays PENDING until a queued write finally replays; the eventual verdict here arrives through `onSettled` (per write) or `onMutationSettled` (per client).                                                                       | A pending promise is fine in a browser event loop and bad on a goroutine, a Ruby thread or a JVM thread pool. A caller that must not report success early checks `status`.                                                                                                                                                                                                                                                                                                                                     |
| **The persistence adapter is SYNCHRONOUS** in the seven non-Dart ports. The browser client's is async because IndexedDB is, and Dart's stays async because its IO is.                                                                                                                                                                                                  | A consumer injects whatever it likes — a file, SQLite, a key-value store — and owns its own threading, exactly as it already does for the HTTP poster and the frame sender.                                                                                                                                                                                                                                                                                                                                    |
| **The identity stamp is an opaque string the CONSUMER sets** (`client.identity`) in seven ports — Dart is the exception and mirrors the reference, deriving one from `authSubject` or, failing that, from a non-cryptographic digest of the token (`dart/lib/src/transport.dart`).                                                                                     | These SDKs do not manage auth sessions, so a derived stamp would mean persisting a digest of a bearer token in the consumer's storage. Put a stable, non-secret subject (a user id) there — in Dart, `authSubject`, which is what its fallback exists to avoid needing.                                                                                                                                                                                                                                        |
| **A transient replay failure is classified by code AND by status**: a raw transport error, `SHARD_ERROR`/`SHARD_UNAVAILABLE`, `RATE_LIMITED`/`TOO_MANY_REQUESTS`, any 5xx, and any non-2xx carrying no `{ error }` envelope all re-queue; everything else coded is terminal. One predicate governs the single-call path, a batch slot and a whole-batch outcome alike. | `protocol/README.md` §4.3. A durable write's fate must not depend on how many siblings were queued alongside it, which is exactly what it did: the same envelope-less 502 was transient for a batch and terminal for a lone write. **Behind §4.3 on one half**: an envelope-less **4xx** is a refusal that resending only reproduces, and the spec now settles those terminally rather than parking the outbox head behind them forever. These eight still re-queue every envelope-less non-2xx alike.         |
| **A rate limit defers the next flush rather than dropping the write.** `FlushReport.retryAfterMs` carries the envelope's `data.retryAfterMs`, clamped to 60 s, and a flush inside that window is a no-op reporting the time remaining.                                                                                                                                 | "Not now" is not "no", and a queue that honours a limiter by discarding loses data for being punctual. The `Retry-After` HEADER is not read: the injected poster surfaces `(status, body)` only — see the capability matrix's note ⁵. The window is also **passive and global**: nothing schedules a re-flush when it elapses (the caller's next flush is what tries again), a refusal carrying no hint sets no window at all, and the one field gates every shard rather than the shard that met the limiter. |
| **Every fold notifies.** The TypeScript engine suppresses a notification whose folded result is reference-identical to the value already displayed.                                                                                                                                                                                                                    | Reference identity has no portable meaning across eight languages. A consumer sees at most a few redundant callbacks carrying the same value, never a missing one.                                                                                                                                                                                                                                                                                                                                             |
| **A persistence failure is SILENT unless you wire `on_persistence_error`.** The browser client falls back to `console.warn` when no handler is set.                                                                                                                                                                                                                    | There is no console in a Ruby worker or a JVM service, and writing to stderr from a library is its own bad default. The cost is real, so wire the handler: without it a durable store that has started failing looks exactly like one that is working.                                                                                                                                                                                                                                                         |
| **An unencodable queued write settles with the coded verdict `OFFLINE_WRITE_UNENCODABLE`.** The reference settles the caller with the raw codec exception.                                                                                                                                                                                                             | Every other terminal drop in these ports carries a code, and a consumer classifying by exception type would need to know seven languages' codec error hierarchies to spot this one.                                                                                                                                                                                                                                                                                                                            |

**Multi-tab leader election** is the one browser-only half no port has — a Web
Lock deciding which tab hydrates the shared durable queue, and there are no tabs
here.

### The queue never calls back; it returns what it let go of

In all eight ports, every queue method that lets go of a write — an overflow
eviction, a failed precondition, a close — **returns** the discarded entry with a
coded reason instead of rejecting it in place. The client settles those once it
has released its lock.

This is not stylistic. The queue is called with the owning client's lock held (it
carries none of its own, deliberately), and settling a write rolls its optimistic
layers back — which needs that same lock. Rejecting inside the queue therefore
re-enters it, and the four lock flavours across these ports fail four different
ways:

| Lock                                    | What rejecting in place did                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Go `sync.Mutex`, non-reentrant          | **Self-deadlock.** The second offline write past capacity hung the calling goroutine outright.                                                                     |
| Ruby `Mutex`, non-reentrant             | **Silently swallowed.** It raised `ThreadError`, which the queue's own `rescue StandardError` then ate — so the evicted write never rolled back and never settled. |
| Java / Kotlin `synchronized`, reentrant | No hang, but a consumer's callback ran inside the critical section guarding the subscription registry.                                                             |
| Rust `&mut self`, Swift `NSLock`        | Never expressible — which is why those two were written this way first, and why the other five now match.                                                          |

The Ruby failure is the instructive one: the mechanism that was supposed to stop
an eviction dropping a durable write in silence was itself dropping it in silence.
Every port now has a case asserting that an eviction raised from inside `submit`
settles exactly once, with the documented code.

The same rule is what makes the rest of the write path safe, so all eight ports
hold to it: **on the write path, nothing you supply runs while the client holds
its lock.** The optimistic transform is run against a snapshot and its result
recorded; a queued write's `precondition` is evaluated on a snapshot too; the
lock is then taken only to install what came back. Settle handlers, `on_settled`,
and every subscription and error callback are likewise deferred and invoked after
the lock is released. Four of the seven use a non-reentrant lock, so without this
a callback reading `pending_mutation_count` would deadlock its own thread — a
hazard the reference client cannot have, because it has no lock at all.

Two things you supply do still run under the lock, in every port, and both are
deliberate rather than missed:

- **An optimistic transform re-run when an incoming frame re-folds the pending
  layers.** That fold IS the value the frame delivers, and it has to see a base
  nothing else is mutating, so it cannot be moved out. The callbacks it feeds are
  still deferred; only the transform itself runs inside.
- **The injected `PersistenceAdapter`, and the queue's `on_size_change` /
  `on_persistence_error` observers.** These fire from inside `enqueue` / `drain` /
  `hydrate` / `unpersist`, and the rule above requires those to hold the lock —
  you cannot mutate the queue under the lock and keep its durable mirror outside
  it. Note the practical consequence: your adapter's `append` and `remove` are on
  the critical path, so a slow store makes every other thread wait on it.

So the consumer rule is narrower than "your callbacks may re-enter the client":
**an optimistic transform must be a pure function of the value it is handed, and
neither it, your persistence adapter, nor a queue observer may call back into the
client.** Settle handlers, `on_settled`, subscription and error callbacks may. Note where a violation
surfaces — a re-entering transform passes `submit` cleanly and deadlocks on the
next frame, which is a considerably worse place to find out.

Making those two lock-free needs per-state locking rather than one client lock,
which is a larger change than this one; they are recorded here so the next port
does not quietly assume otherwise.

A discarded write is likewise reported to the client-level settled listener
**whether or not it has a per-entry handler**. A write restored from durable
storage never has one — nobody is awaiting a write submitted in a previous
process — so a port that reported discards only through the entry's own handler
would drop a hydrated write on overflow in total silence, un-persisting it on the
way out. The `hadAwaiter` flag on the settled event is how a consumer tells a
restored write's only report from a live caller's second one.

### Pin the client id if your queue is durable

The client id defaults to a **freshly generated random string per client
instance**, matching the reference. It is not decorative: writes carrying
`x-lunora-mutation-id` also carry `x-lunora-client-id`, and for an unauthenticated
caller the server namespaces its idempotency cache by exactly that value. A
constant shared by every process would put all of them in one keyspace, where one
caller's `mutation_id` can suppress another's write without ever running it.

A durable queue needs nothing extra for this to keep working across a restart:
the persisted record carries the id of the client that ISSUED the write, and the
replay sends that one rather than the new process's, so a write queued before a
crash still de-duplicates against the copy the server may already hold.

Pinning matters for the other case — **caller-supplied mutation ids that mean
something** (`"order-1"` rather than a generated key). Those are only de-duplicated
against writes in the same namespace, so the same semantic id submitted before and
after a restart is two different writes unless the client id is stable. Pin a
per-device id if you rely on that; leave it alone if your mutation ids are
generated.

Two ports carry one further shape change apiece, and both are the language talking
rather than a decision:

- **Rust** hands out a `(subscription id, layer id)` pair instead of a settle
  object, because storing a `&mut` borrow of the subscription for later use is
  exactly what the borrow checker exists to reject; a `Transform` returns
  `Option<WireValue>` rather than throwing, because Rust has no exceptions and a
  layer that cannot produce a value already has a value for saying so. The
  multi-query patch set is declared up front (`optimistic_queries`) and read with
  `query_value` / `all_queries` beforehand, rather than through a callback handed a
  `&mut` store.
- **Swift**'s `LunoraOfflineQueue` is likewise not internally locked, because the
  client already holds a non-recursive `NSLock` over the registry the queue is
  settled against.

Everywhere except Rust, the optimistic engine also never invokes a callback
itself: it appends thunks to a `deferred` list the caller drains once it has left
the critical section, which is the discipline the frame handlers already use. Rust
needs no such thing — its client carries no lock, because `&mut self` is the
exclusion.

## Lint and format

Each transport is held to its own ecosystem's standard tools, run by
`./sdks/lint-all.sh` (same parallel shape as `run-all.sh`; pass language names to
narrow it). CI runs the identical script per leg, so the local check and the gate
cannot drift.

| Language | Format                                | Lint                         | Config                  |
| -------- | ------------------------------------- | ---------------------------- | ----------------------- |
| python   | `ruff format --check`                 | `ruff check`                 | `pyproject.toml`        |
| go       | `gofmt -l`                            | `go vet`                     | — (tool defaults)       |
| ruby     | `rubocop` (layout cops)               | `rubocop`                    | `.rubocop.yml`          |
| rust     | `cargo fmt --check`                   | `cargo clippy -D warnings`   | `rustfmt.toml`          |
| swift    | `swift format lint --strict`          | same                         | `.swift-format`         |
| java     | `google-java-format --aosp --dry-run` | `javac -Xlint:all -Werror`   | — (`--aosp` = 4sp)      |
| kotlin   | `ktlint`                              | `ktlint`                     | `.editorconfig`         |
| dart     | `dart format --set-exit-if-changed`   | `dart analyze --fatal-infos` | `analysis_options.yaml` |

Seven of the eight tools are pinned in CI by version or by SHA-256, so a new
release cannot change the rule set under a green PR. Dart's are pinned by the
same mechanism from the other end — its formatter and linter ARE the SDK, so
`dart-lang/setup-dart` pinning an exact SDK version pins both, and that leg needs
no separate install step. swift-format is the exception, and not by choice: it ships no binary on any release and no versioned
package, so the swift leg uses the Swift toolchain's own copy. Its pin is
therefore an assertion — `SWIFT_FORMAT_VERSION` in `lint-all.sh`, checked against
the version the tool reports, which the summary line prints either way
(`PASS swift [swift-format 6.3.0]`). A different minor is a note locally and,
under `SDK_LINT_REQUIRE_TOOLS=1`, a failure naming both versions, so a runner
image whose Swift moves cannot change the rule set quietly. To lint with a build
of your own, pass it and the version to expect from it —
`SWIFT_FORMAT=<path> SWIFT_FORMAT_VERSION=603.0`, since a standalone build of the
release a toolchain calls `6.3.0` reports `603.0.0`, and `swift format` ignores a
`swift-format` on `PATH`.

Two dart-specific settings, for the same reason rustfmt needs `--config-path`.
`dart format --language-version=3.6` is passed explicitly rather than left to
discovery: the style is chosen by the SDK constraint in the nearest `pubspec.yaml`,
the smoke lives outside `sdks/dart/` and there is no pubspec above `sdks/smoke/`,
so left alone the smoke would be formatted against the LATEST style while the
transport is formatted against 3.6 — two rule sets inside one leg. Keep it in step
with `sdks/dart/pubspec.yaml`. And `dart analyze --fatal-infos`, because
`dart analyze` exits 0 on an info-level lint by default, which is where most of
`analysis_options.yaml` reports.

A tool missing locally reports `SKIP`, never
`PASS` — not everyone has eight toolchains, and a check that did not run must not
read as one that passed. CI sets `SDK_LINT_REQUIRE_TOOLS=1`, which turns that
`SKIP` into a failure: there the install step just ran, so a missing tool means it
broke, and a gate that skips everything is green for the worst possible reason.

Two settings are deliberate rather than default: the line width is 160
everywhere, matching the repo's Prettier `printWidth`, so two ports read the same
side by side; and Java uses `--aosp` for 4-space indentation for the same reason.
Where a rule is switched off, the config says which behaviour of this code the
rule was wrong about — the wire codec's `case`/`when` tables and its
shortest-round-trip float comparison are the recurring two.

**Generated output is excluded from all of it**, and there is no longer any
committed: the models come from quicktype, whose style this repo does not own, and
any correction there is undone by the next regeneration. Correctness in generated
output is enforced in the emitter instead — `narrowBareExcept` in
`targets/python.ts` is one such fix, for a bare `except:` that swallowed
`KeyboardInterrupt` in every generated Python SDK.

What IS linted here, and lives outside every transport's own tree, is
`sdks/smoke/<lang>/`. Those are the consumer programs `generated-check.sh` builds,
and the only code in this repo written against the vendored layout a user gets —
the closest thing to a worked example, and an example nobody formats rots.

## Conformance

Every SDK asserts itself against the golden frames in `protocol/fixtures/`, the
same files the TypeScript client is tested against.
`protocol/conformance-cases.json` lists the cases each suite must exercise —
coverage drifted badly before that list existed, leaving the decode-side bounds
unasserted in two ports for several commits with every gate green.

The `optimistic_*` and `offline_*` names in that list cover the client-side write
features rather than the wire, and assert against
`protocol/fixtures/offline-optimistic.json`. Nothing
in that file goes on a socket: it is the values and orderings eight independently
hand-written ports must agree on — which value is displayed after a rebase, which
cursor drops an overlay, which queue entry an overflow evicts, what a flush leaves
queued. The mechanics are hand-coded per language (a transform is a closure, and
closures are not data), but every assertion reads its expectation from there.

**All eight suites read that file at run time and fail if the run did not cover
it**, so adding a name there turns every language red until it is covered. The
mechanism is whatever each runner offers rather than one shape forced onto all
eight:

| Language | Mechanism                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------- |
| python   | each case calls `covers()`; `tests/test_zz_manifest.py` (sorted last by discovery) compares the two sets |
| go       | each case calls `covers()`; `TestMain` compares after `m.Run()` — a `-run`-filtered run is exempt        |
| ruby     | each case calls `ConformanceManifest.covers`; `Minitest.after_run` aborts on a gap                       |
| rust     | no after-all hook in libtest, so the manifest **drives** the run: each name dispatches to its case       |
| swift    | no after-all hook that can fail in XCTest, so likewise — hence `caseX` methods and one dispatching test  |
| java     | each case calls `covers()`; the end of `main` is the after-all hook                                      |
| kotlin   | as java                                                                                                  |
| dart     | each case calls `covers()`; the end of `main` is the after-all hook, as java                             |

Where the manifest drives the run, a required name with no dispatch arm fails,
which is the same guarantee from the other direction: the only way to go green is
to execute a case under that name.

**What the `covers()` form actually proves is narrower than it looks.** In the
six ports that record rather than dispatch, `covers("x")` is the first statement
of the case body — before the fixture is even loaded — so what it evidences is
that the case FUNCTION WAS INVOKED, not that any assertion inside it ran. A body
whose assertions were deleted still satisfies the check. That is still strictly
more than a hand-kept list of names (which is what this replaced, and which
drifted), and it is what the check is for: catching a manifest name that no case
is wired to at all. It is not a defence against a case being hollowed out — no
coverage mechanism here is, since a suite can always delete an assertion. Read
the row as "a case exists and runs under this name", and rely on the assertions
themselves for the rest.

**The manifest holds a suite to every name in
`protocol/conformance-cases.json` — 40 of them today; it cannot hold one that ran
nothing at all.** Six of these eight test tools exit 0 having collected NO tests
— `unittest discover` finding no matching module, an empty `test/test_*.rb`
glob, a Go package with no `_test.go`, `cargo test` and `swift test` with
nothing to run — and in every one of those the manifest check is itself a test
that did not run either. So `run-all.sh` reads each leg's own summary line for
the number of cases it executed, prints it (`PASS python (85 cases)`), and fails
a leg that exited 0 having executed none. That read is fail-closed: a leg whose
summary cannot be parsed counts as zero, so a change to a runner's output format
turns this red rather than quietly reverting it to an exit-code-only check.

**The dart leg needs two more guards, because Dart's failure mode is silence.** A
case that awaits a future nothing will ever complete does not hang the process:
the event loop drains, `main()` is abandoned part-way, and the VM exits 0 having
printed nothing — indistinguishable from a full green run, and exactly how this
suite once reported PASS with 16 of its 69 cases executed. So `main()` sets
`exitCode = 1` on entry and clears it only at the bottom, which makes every path
that does not reach the end a failure; and `run()` gives each case a 30-second
timeout, so the abandoned one is named rather than merely turning the leg red.

Run all of them at once with `./sdks/run-all.sh`, which fans the suites out in
parallel — they are eight independent toolchains reading the same read-only
fixtures, so the whole set costs about as long as the slowest compiler rather
than the sum of all eight. Pass language names to narrow it
(`./sdks/run-all.sh go rust`). Or one at a time:

| Language | Run the suite                                                           | Toolchain           |
| -------- | ----------------------------------------------------------------------- | ------------------- |
| python   | `python3 -m unittest discover -s tests -t .`                            | stdlib only         |
| go       | `go test ./... -race -count=1`                                          | stdlib only         |
| ruby     | `ruby -Ilib -e 'Dir["test/test_*.rb"].each { \|f\| require "./#{f}" }'` | stdlib minitest     |
| rust     | `cargo test`                                                            | `serde_json`        |
| swift    | `swift test`                                                            | Foundation only     |
| java     | `PATH="$JDK_BIN:$PATH" bash build.sh`                                   | JDK only, see below |
| kotlin   | `PATH="$JDK_BIN:$PATH" bash build.sh`                                   | kotlinc + JDK       |
| dart     | `dart pub get --offline && dart run test/conformance.dart`              | Dart SDK only       |

**The JVM legs need a real JDK on `PATH`.** On macOS `/usr/bin/java` is Apple's
stub, which reports "No Java runtime present" and does not run anything, so
`bash build.sh` on its own fails there. `run-all.sh` and `lint-all.sh` prepend the
Homebrew JDK for you; running `build.sh` directly does not, hence the prefix
above — with Homebrew that is:

```bash
export JDK_BIN=/opt/homebrew/opt/openjdk/bin
```

**Only the full run is held to the manifest.** The ruby command above loads every
`test/test_*.rb` (a single file records coverage but is not held to a list it
cannot cover), and the go check exempts a `-run`-filtered run for the same
reason.

**`-count=1` on the go leg is load-bearing.** Everything these suites assert
against — `protocol/fixtures/*.json` and `protocol/conformance-cases.json` — lives
outside the Go module, so the test cache cannot see those files change and replays
a PASS recorded before the edit. Without it, editing a fixture or the manifest
leaves the go leg green without having run.

### Coverage matrix — what the fixtures actually pin

Derived from the reference source (`shared/wire-codec.ts`, `shared/stable-key.ts`,
`shared/wire-key.ts`, `packages/client/src/lunora-client.ts`) rather than from
the fixtures, so a behaviour the fixtures forgot shows up as a row with no case
against it. The test is "would a port that got this WRONG go red", not "is it
mentioned somewhere" — that distinction is the whole point: `rejected[]` once
listed only null and missing payload slots, so six ports accepting a non-object
`error` props slot was invisible to it for as long as it existed.

Every row below is either pinned by a named case or listed under
[deliberately unpinned](#deliberately-unpinned-and-why). Nothing is silent.

**Codec — encode**

| Reference behaviour                                            | Pinned by                                                                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| identity for `null` / bool / string / finite number            | `null`, `boolean`, `string`, `number-int`, `number-float`, `number-zero`                                          |
| plain object and array recurse                                 | `pure-json-object`, `pure-json-array`, `empty-object`, `empty-array`, `nested-typed`                              |
| `bigint` → `[TAG,"bigint",digits]`                             | `bigint`, `bigint-negative`, `bigint-in-object`                                                                   |
| `NaN` / `Infinity` / `-Infinity` tags                          | `nan`, `inf`, `-inf`                                                                                              |
| `undefined` tagged in an array, DROPPED as an object field     | `undefined-in-array`, `undefined-object-field`                                                                    |
| `Date` → epoch routed back through the encoder                 | `date`, `date-invalid`                                                                                            |
| `URL` → `href`                                                 | `url`                                                                                                             |
| `Map` entries recurse, insertion order                         | `map`, `nested-map-in-set`, `map-empty`                                                                           |
| `Set` items recurse, insertion order                           | `set`, `set-empty`, `nested-map-in-set`                                                                           |
| `Uint8Array` 3-element, `ArrayBuffer` 4-element                | `bytes-uint8`, `bytes-arraybuffer`, `bytes-empty`                                                                 |
| every other view carries its ctor name                         | `bytes-int8`/`-uint8clamped`/`-int16`/`-uint16`/`-int32`/`-uint32`/`-float32`/`-float64`/`-bigint64`/`-biguint64` |
| `Error` → name, message, own props, optional `cause`           | `error`, `error-with-props`, `error-with-cause`, `error-with-null-cause`                                          |
| `Error` drops an `undefined` own prop and an `undefined` cause | `error-prop-undefined`, `error-cause-undefined`                                                                   |
| an array starting with the sentinel is escaped as `"arr"`      | `array-sentinel-escape`, `tag-only-array`, `unknown-tag`                                                          |
| `__proto__` written as an own data property, never by setter   | `proto-key`                                                                                                       |
| `MAX_DEPTH` (64) refused on the way out                        | `depth_cap_enforced` (manifest; native, no fixture can nest 65 deep readably)                                     |
| a non-plain object (`RegExp`, a class instance) is refused     | `offline_flush_unencodable_write_settles_terminal` (manifest; native construction)                                |

**Codec — decode, per tag**

| Tag                    | Accepted, pinned by                                                                                                                                                              | Refused, pinned by                                                                                                                                                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bigint`               | `bigint*`; canonicalised: `bigint-leading-zeros`, `bigint-negative-zero`                                                                                                         | `bigint-payload-number`, `-missing-payload`, `-empty-string`, `-leading-plus`, `-decimal-point`, `-surrounding-space`, `-hex-prefix`, `-non-ascii-digits`; length by `over_long_bigint_rejected`                                                                                                                       |
| `date`                 | `date`, `date-invalid`, TimeClip by `date-epoch-max`, `-past-max`, `-out-of-range`, `-non-finite`, `-fractional`, `-fractional-negative`, `-negative-fraction`, `-negative-zero` | `date-payload-not-number`, `-string`, `-boolean`, `-object`, `-array`, `-bigint-tag`                                                                                                                                                                                                                                   |
| `url`                  | `url`                                                                                                                                                                            | `url-href-not-string`, `url-href-missing`, `url-href-relative`, `-empty`, `-scheme-relative`, `-scheme-empty`, `-scheme-digit-initial`, `-scheme-non-ascii`                                                                                                                                                                                                                           |
| `map`                  | `map`, `map-empty`, `map-duplicate-keys`, `map-duplicate-nonstring-keys`, `map-duplicate-zero-sign-keys`, `map-null-key`, `map-null-value`                                       | `map-payload-not-array`, `-payload-missing`, `-entry-not-array`, `-entry-too-short`, `-entry-too-long`                                                                                                                                                                                                                 |
| `set`                  | `set`, `set-empty`, `set-duplicate-scalars`, `set-duplicate-nonscalars`, `set-duplicate-zero-signs`                                                                              | `set-payload-not-array`, `-payload-missing`, `-payload-object`                                                                                                                                                                                                                                                         |
| `arr`                  | `array-sentinel-escape`, `arr-empty-payload`                                                                                                                                     | `arr-payload-not-array`, `-payload-missing`, `-payload-object`                                                                                                                                                                                                                                                         |
| `bytes`                | the ten ctor cases above, `bytes-unknown-ctor`, `bytes-null-ctor`                                                                                                                | `bytes-payload-not-string`, `-payload-number`, `-outside-alphabet`, `-truncated-quantum`, `-padding-inside`, `-element-misaligned`, `-misaligned-int16`, `-misaligned-float64`; canonicity by `bytes-base64-unpadded`, `-newline`, `-whitespace`, `-noncanonical-pad1`, `-noncanonical-pad2`, `-urlsafe`, `-non-ascii` |
| `error`                | `error*`, allow-listed ctor by `error-with-props` (`TypeError`)                                                                                                                  | `error-props-not-object`, `-missing-props`, `-string`, `-array`, `-number`, `-boolean`; label slots by `error-name-number`, `-name-null`, `error-message-number`, `-message-null`                                                                                                                                      |
| `nan` / `inf` / `-inf` | `nan`, `inf`, `-inf`                                                                                                                                                             | —                                                                                                                                                                                                                                                                                                                      |
| `undefined`            | `undefined-in-array`, `undefined-object-field`                                                                                                                                   | —                                                                                                                                                                                                                                                                                                                      |
| unknown tag            | `unknown-tag` (decodes as an ordinary array, re-encodes escaped)                                                                                                                 | —                                                                                                                                                                                                                                                                                                                      |
| depth                  | `depth_cap_enforced` (manifest)                                                                                                                                                  | same                                                                                                                                                                                                                                                                                                                   |

**Stable key (`stableStringify ∘ encodeWire`)**

| Reference behaviour                                    | Pinned by                                                                                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| keys sorted at every depth, UTF-16 code UNIT order     | `sorted-top-level`, `sorted-nested`, `codepoint-order`, `key-order-surrogate-vs-pua`, `key_order_matches_utf16`              |
| an empty-string key sorts first                        | `empty-string-key`                                                                                                           |
| arrays keep order; nested objects still sort           | `arrays-keep-order`, `nested-array-of-objects`                                                                               |
| `null` field kept, `undefined` field dropped           | `null-field-kept`, `undefined-object-field-arg`                                                                              |
| `undefined` in an array keys as its tag, not as `null` | `undefined-in-array-arg`                                                                                                     |
| string escaping matches `JSON.stringify`               | `string-with-quote`, `escape-set-matches-json-stringify`, `string_escaping_matches_json_stringify`                           |
| number spelling matches `String(v)`                    | `number-exponent-forms`, `format_number_matches_ecmascript`                                                                  |
| a negative zero keys as `-0`, distinct from `0`        | `negative-zero`; meeting TimeClip in `date-arg-negative-fraction-epoch`, `date-arg-negative-zero-epoch`                      |
| empty containers                                       | `empty`, `nested-empty-containers`                                                                                           |
| wire-typed args tokenise rather than throwing          | `bigint-arg`, `date-arg`, `bytes-arg`, `map-arg-keeps-insertion-order`, `set-arg`, `url-arg`, `error-arg`, `non-finite-args` |
| the `(functionPath, args, shardKey)` composition       | `empty_shard_key_is_omitted`                                                                                                 |

**RPC and frames**

| Reference behaviour                                   | Pinned by                                                                                                                                                |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| request body, with and without `shardKey`             | `rpc.request.cases`, `rpc_request_bodies`                                                                                                                |
| `{ result }`, `commitCursor`, `lastMutationId`        | `rpc.responseOk`, `rpc_responses`                                                                                                                        |
| `{ error }` with `code` / `message` / `data`          | `rpc.responseError`                                                                                                                                      |
| a non-2xx body with no envelope is `INTERNAL`         | `non_2xx_without_error_envelope_fails`                                                                                                                   |
| `connect` / `subscribe` / `unsubscribe` frames        | `clientFrames`, `client_frame_builders`                                                                                                                  |
| `shape_subscribe`, resume across reconnect            | `shape_subscribe_frame`, `shape_subscriptions_resend_after_reconnect`                                                                                    |
| `ack` / `data` / `error` / `resume` / `settled`       | `serverFrames`, `server_frame_consumer`                                                                                                                  |
| poke buffering, `reset`, bounded buffers              | `poke_sequence_materialises_rows`, `poke_parts_do_not_apply_before_poke_end`, `shape_reset_poke_replaces_membership`, `pending_poke_buffers_are_bounded` |
| batched replay, its cap and its split                 | `offline_flush_batches_multiple_writes`, `offline_flush_batch_splits_on_payload_too_large`, `batch_entry_cap_matches_protocol`                           |
| `shape_unsubscribe` spelling                          | **unpinned** — see below                                                                                                                                 |
| `delta` merged into a cached list, `chunk`, `whisper` | **not implemented in any port** — see the capability matrix above                                                                                        |

#### Deliberately unpinned, and why

Three rows above resolve to "no case, on purpose". Each is measured, not
assumed:

- **A lone surrogate in a stable key.** The reference escapes one (`\ud800`) via
  `JSON.stringify`, but the fixture cannot carry the input: ruby's `JSON.parse`
  raises `incomplete surrogate pair` on the whole FILE (taking every other
  stable-key case down with it), and go's `encoding/json` silently substitutes
  U+FFFD before the port's key encoder ever sees it. Two of eight cannot express
  it, and the same two refuse the value on a real wire, so it is unreachable
  there rather than mishandled.
- **`Error` own props carrying `__proto__`.** The decode side handles it (an own
  data property, never the setter), but the ENCODE side's Error branch writes
  `properties[key] = …` with no such guard, so the prop lands on the props
  object's prototype and re-encodes as `{}`. That is a defect in the reference,
  not a contract to port — recorded here rather than pinned, because a fixture
  would freeze the bug into eight languages.
- **`shape_unsubscribe`.** All eight emit `{ id, type: "shape_unsubscribe" }`,
  verified by reading each; a golden would need a new assertion in eight suites
  and would catch nothing today. The `clientFrames` goldens that DO exist are the
  ones that once diverged.

The `connect-with-caps` and `pageDeltaFrames` goldens stay opt-in, as
`ws-frames.json`'s own comment declares: a client that has not announced the
`pageDelta` token never receives such a frame, and running those cases would hold
it to a merge it correctly does not do.

### The decoder leniencies, and where they went

Three of them used to sit here unpinned, on the reasoning that a fixture
demanding rejection would assert against the reference. They are pinned now,
because measuring them showed the leniency was not one behaviour but four: the
eight ports had inherited whatever their language's base64 decoder happened to
allow and landed 3-accept / 5-reject on an unpadded payload, 2-accept / 6-reject
on an embedded newline. "Nothing on a conforming wire reaches them" was true and
beside the point — a decoder's job on a NON-conforming wire is exactly what the
`bytes` tag exists to define.

- **base64 is canonical, not merely decodable.** A payload must be exactly the
  string a conforming encoder would have written for those bytes: padded, no
  embedded whitespace, standard alphabet, and no non-zero trailing bits in a
  short final quantum. Every implementation enforces it the same one-line way —
  decode, re-encode, compare — rather than by hand-rolling a validator per
  language. The reference changed too: `atob` accepted `"AQJ="`, decoded it to
  the two bytes `01 02` and re-encoded it as `"AQI="`, which is a silent rewrite
  of the peer's bytes rather than leniency about them.
- **A `url` href must be ABSOLUTE.** The reference builds a real `URL`, which
  throws on an unparseable href; all eight ports stored the string verbatim and
  accepted `"not a url"` — a frame that kills a JS peer's subscription and is
  waved through everywhere else. The reference is the normative side, and the
  ports enforce the FLOOR of it (a scheme, per RFC 3986, then the rest), which
  is what `protocol/README.md` §2.1 states and what the six `url-href-*`
  rejections pin. Three of them exist specifically so that `href.includes(":")`
  does NOT pass: an empty scheme (`":x"`), a digit-initial one (`"1http:x"`) and
  a non-ASCII one (`"é:x"`). The `url-scheme-punctuation` case is their
  counterweight — `a+b-c.1:x` is a legal scheme and must still decode, so a port
  cannot satisfy the three by tightening into an alphanumeric-only check.

What remains unpinned, and why, is href SPELLING: a port puts a non-canonical
href (`HTTPS://EXAMPLE.COM`) on the wire where the reference emits
`new URL(href).href` (`https://example.com/`), and the runtime decodes with the
reference codec. Eight native URL types do not agree with WHATWG parsing on
enough edges to reproduce that — a half-normaliser would be a NINTH behaviour —
so the ports carry the href through untouched and a consumer that needs the
reference's spelling normalises before it constructs the value.

CI runs all eight per PR (`sdk-conformance` in `.github/workflows/test.yml`),
one language per matrix leg — and each leg invokes **this same script**,
`bash sdks/run-all.sh <lang>`, exactly as the lint leg invokes `lint-all.sh`. The
workflow used to carry its own copy of the eight commands, which drifted from
this file in three places and left the zero-executed-cases assertion above
protecting local runs only. There is no second command list to keep in step.

The one flag CI wants and a local run does not is the swift leg's thread
sanitizer, and it is a switch rather than an omission: the step sets
`SDK_TEST_TSAN=1`, `run_suite` adds `--sanitize=thread` for it, and the summary
line names it (`PASS swift [--sanitize=thread] (7 cases)`) so a green leg says
which build ran. Locally it is off, because a TSan build roughly triples the
slowest leg; `SDK_TEST_TSAN=1 ./sdks/run-all.sh swift` reproduces CI's.

Each leg also runs `./sdks/generated-check.sh <lang>` — the generated surface
hardcodes the runtime's call signatures, and nothing else pins that coupling.

## The generated-SDK check

```bash
./sdks/generated-check.sh            # all eight, sequentially
./sdks/generated-check.sh go rust    # a subset
```

It needs a built CLI (`pnpm exec vis run build --query "project=cli"`) and then,
per language: generates an SDK into `mktemp -d`, assembles the consumer project a
real user writes, compiles it, and runs a call.

**The scratch directory is the point, not tidiness.** Since the transport is
copied, the promise is "this output runs with nothing installed" — and that cannot
be tested anywhere `sdks/<lang>` is resolvable. Inside the checkout Python finds
`sdks/python/lunora` on `sys.path`, Go finds a sibling package in the same module,
Swift finds a target in the same package; a pass there would prove nothing. So the
output goes outside the repo and each consumer project wires it up the documented
way and no other.

**Calling is not belt-and-braces.** Two languages shipped a revision whose surface
passed its compile-or-parse check and threw on the first invocation: Java could
not encode its own argument model, and Ruby called a `to_dynamic` the models were
not rendered with. A third — Rust — sent `"limit": null` for an unset optional,
which `v.optional()` rejects; the smoke that calls it is what surfaced that, one
build after the same bug was fixed in Ruby.

**The setup steps in each leg are `&&`-chained, and that is load-bearing.** This
script runs without `set -e`, so an unchained `cp` failure was simply stepped
over — and the two legs that assemble their smoke as a TEST rather than as a
program (go, rust) then ran a project with no tests in it. `cargo test` reported
"0 passed" and exited 0, so a rust leg that had copied nothing read as a PASS;
`cargo test --test generated_smoke` names the target instead, so its absence is
"no test target named `generated_smoke`" and a non-zero exit.

The smoke programs are `sdks/smoke/<lang>/`, and each asserts the same thing: that
a generated call reaches the wire as
`{"args":{"channelId":"chan_1"},"functionPath":"messages:list"}` — note the absent
`limit`, which is what makes this assertion catch the unset-optional bug at all. They sit outside
every transport's tree because that is what they are — consumer code, importing
`lunorasdk/lunoraapi` and `import LunoraApi`, which resolve only against generated
output. `--from sdks` is passed for them, because the default fetch is the CLI's
release tag and seven of the eight transports do not exist at any released tag
yet.

The dart leg runs `dart analyze` in BOTH the generated package and the consumer,
and the first is the one that matters: `dart analyze` only reports on the package
it runs in, so from the consumer it type-checks the smoke's use of the surface
and stays silent about the surface itself — measured, not assumed. Run inside the
generated package it is the counterpart of `swift build`, and it covers
quicktype's models too.
