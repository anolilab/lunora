## @lunora/codegen [1.0.0-alpha.122](https://github.com/anolilab/lunora/compare/@lunora/codegen@1.0.0-alpha.121...@lunora/codegen@1.0.0-alpha.122) (2026-08-25)

### ⚠ BREAKING CHANGES

* **runtime:** `serveStorageObject`'s structural storage parameter now
requires `head` alongside `download`. `@lunora/storage` provides it (with
its own fallback to a 0-length ranged `get()` on a binding with no HEAD);
a hand-rolled double must add it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EjmVJXmP8D1Amh6t49vS4T

* refactor(shared): extract memoizePromise, stop poisoning the HMAC key cache

Three lazily-built async singletons had each hand-rolled the same keyed
memo: look the key up, store the PROMISE so concurrent callers coalesce
onto one run, drop the entry if it rejects. `shared/promise-memo.ts` is
the one definition; `@lunora/mcp`'s per-tool charge middleware,
`@lunora/x402`'s per-procedure one, and the per-secret HMAC key cache now
use it.

It also fixes two bugs the copies had between them.

`shared/hmac-url.ts` never evicted on rejection at all, so a single failed
`crypto.subtle.importKey` stayed in the map and every later verify against
that secret was served the original failure for the isolate's whole life.

The two that did evict deleted whatever sat under the key at rejection
time, not necessarily their own entry. A slow first attempt failing after
a healthy retry had taken the slot would delete that retry. The shared
helper compares identity before deleting, so an entry can only ever evict
itself.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EjmVJXmP8D1Amh6t49vS4T

* feat(runtime): store the declared REST cache policy at the edge

`.expose({ rest: true, cache })` emitted `Cache-Control` and `Vary` and
stopped there. A response a Worker GENERATES is not stored by the colo
cache on its own, so the declared policy bought browser revalidation and
nothing else — every request still paid a shard dispatch. `caches.default`
was used exactly zero times in the repo.

`rest-edge-cache` adds the missing half: a `match` before dispatch and a
`waitUntil`-deferred `put` after, wrapped in the guards that make storing
a procedure-backed response safe rather than a cross-user leak.

- Only a genuinely anonymous, effective-`public` exchange is stored,
  reusing the credential check the header path already applies. A
  declared-`private` policy is never stored: it is caller-specific by
  definition and this cache is shared by everyone hitting the colo.
- `Vary` is enforced in the KEY. Cloudflare's cache honours `Vary` for
  `Accept-Encoding` only, so a body that varies on `x-lunora-shard-key`
  would otherwise be handed to a caller with a different key. Every
  varying header's value is folded into the stored URL, which turns the
  hazard into a miss.
- The lookup runs after the rate-limit gate, the order a CDN uses: a hit
  still costs a Worker invocation and is still the caller's request, so it
  is metered — it just skips the shard.
- A cache read or write that rejects is treated as a miss, never as a
  failed request.

`@lunora/platform` gains the `HttpCacheLike` contract and rates `httpCache`
in both matrices: `native` on Cloudflare, `unsupported` on Node, where the
surface degrades to emitting `Cache-Control` alone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EjmVJXmP8D1Amh6t49vS4T

* fix(runtime): let createWorker reach the REST edge cache, and test the wiring

`buildRestRoutes` took an `edgeCache` dep that `createWorker` never
forwarded, so the documented opt-out was unreachable for anyone going
through the normal entry point — and nothing could inject a double either,
which is why the gap survived review. `restEdgeCache` now plumbs through,
mirroring `restRateLimit`. It is forwarded when PRESENT rather than when
truthy, since `null` is the meaningful opt-out value.

The unit tests covered `rest-edge-cache`'s store/lookup decisions in
isolation but nothing exercised what the route does with them. Added, at
the `createWorker` level where a shard spy can count dispatches:

- a second identical request is served from the cache with NO second shard
  dispatch (this is the whole feature, and it was unasserted)
- a credentialed caller stores nothing and dispatches every time
- the rate-limit gate is consulted BEFORE the cache, so a warm entry does
  not hand a limited caller a free body
- `restEdgeCache: null` keeps the declared `Cache-Control` on the wire
  while storing nothing
- an endpoint with no declared policy is never stored

Plus `defaultHttpCache` (absent `caches`, present, and a throwing accessor),
and one for `serveStorageObject`'s 206 headers coming from the head rather
than the ranged read — a deliberate choice that no test pinned, so nothing
would have caught it flipping.

Each new assertion was mutation-checked: reverting the plumbing, moving the
lookup ahead of the limiter, and swapping the 206 header source each fail
exactly the test that claims to cover them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EjmVJXmP8D1Amh6t49vS4T

* fix(runtime): keep paid and per-caller responses out of the edge cache

The edge cache sat upstream of the x402 charge gate, which runs inside
`invokeExposed`. A hit returned before dispatch, so it ran neither the
challenge nor the settlement — and `x-payment` was in no credential list,
so a payer read as anonymous and their 200 was stored. Every later caller
in that colo got the paid body free, together with the payer's
`X-PAYMENT-RESPONSE` receipt, for the whole `maxAge`.

`x-payment` is now a credential header, so a paid exchange is `private` on
the header path and unstorable on the cache path by the same derivation. A
response carrying a settlement receipt is refused separately — a second
lock on a money path.

That derivation is now singular. `effectiveRestScope` is the one answer to
"may a shared cache have this", called by both halves; the store no longer
re-derives scope and credentials for itself, where gaining a credential
source on one side alone would have silently stored a per-caller body.

Also closed, all of them reachable without an attacker:

- `__lunora_vary` was documented as reserved but nothing reserved it. It
  reached the procedure as an argument while `set` overwrote it in the key,
  making it the one query key a caller could vary without varying the key.
  It is now excluded from args and deleted before the key is built.
- A shard response's `x-d1-bookmark` / `x-lunora-shard-key` were stored and
  replayed, so a caller holding a newer bookmark could adopt a stale one and
  lose read-your-writes. Both are dropped from the stored copy.
- `applyRestCache` merges the procedure's own `Vary` into the emitted
  header, but the key folds only the policy's names, so a response could
  advertise more than the key fenced. Storing now requires the advertised
  set to be fenced; `Vary: *` never stores.
- The store path evaluated the key and `clone()` as arguments, outside its
  `.catch`. A policy with a malformed `vary` (`"Accept Language"`) made
  `Headers.get` throw and turned every request to that endpoint into a 500 —
  for a policy that emitted a valid `Vary` header before. Both paths now
  degrade to a miss, as the read path already did.
- `X-Lunora-Edge-Cache` is CORS-exposed, so the browser clients the docs
  point at it can actually read it.

Structurally, the two `undefined`-threading functions become one per-route
builder: what a policy decides on its own is decided once at construction,
and a route that can never edge-cache has no cache code path at all. Only
the cache handle stays late-bound, since `caches.default` cannot be read at
construction time in workerd. The seven exports with no consumers are gone
from the package surface rather than frozen in two snapshots.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017M3tmDNVKV9Dq3GSVTcvYL

* fix(storage): make head serializable, declared, and stubbed

Three ways the new body-free read did not survive contact with a caller.

`head()` returned `download()`'s `withSha256` Proxy. That Proxy exists to
keep R2's native body accessors alive, and its own docblock says why it must
not be used for a body-free read: a Proxy over a non-extensible host object
cannot advertise the synthetic checksum fields as own keys, so
`JSON.stringify` drops them. A head result is exactly what a query returns,
so `sha256`/`sha256Base64` vanished on the wire. It now uses the same
`toListObject` projection `list()` does. The test could not catch it — it
asserted by property access, which the get trap serves, against an
extensible object literal — so it now round-trips through JSON against a
`preventExtensions`'d double.

`ctx.storage.head` was documented in the capability table and the file-storage
guide but declared on neither `ReadOnlyStorage` nor `Storage`, so calling it
was a type error. It is declared now, returning `StorageObjectHead` — the
richer public mirror an HTTP layer needs, keeping the validator, the base64
digest and `uploaded` as a `Date`.

Codegen's `storageStub` did not list `head`, so an app with no storage
configured met `TypeError: context.storage.head is not a function` on any
ranged request instead of the "no storage configured" message every other
operation gives.

Separately: a `Range` that cannot produce a 206 anyway — absent, multi-range,
malformed — no longer pays for a metadata read it then discards, which also
closes the window where the object could vanish between the two reads and
turn a 200 into a 404. The full-object answer is decidable from the header
alone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017M3tmDNVKV9Dq3GSVTcvYL

* refactor(shared): bound memoizePromise by size, not by callback

`onInsert` was an extension point with one consumer, on a helper whose whole
justification is that three call sites were the same shape. The thing that
one consumer did with it — `evictOldestEntry(map, capacity)` — is what
`evict-oldest`'s contract already assumes: "every caller inserts exactly one
entry immediately after calling". A `maxEntries` bound makes that structural
instead of a promise each caller keeps, with no closure per call.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017M3tmDNVKV9Dq3GSVTcvYL

### Features

* **runtime:** store the declared REST cache policy at the edge ([#476](https://github.com/anolilab/lunora/issues/476)) ([9ababee](https://github.com/anolilab/lunora/commit/9ababeebc68cd74adfef5d923cfa9e1d70f0f690))


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.87
* **@lunora/agent:** upgraded to 1.0.0-alpha.62
* **@lunora/platform:** upgraded to 1.0.0-alpha.17
* **@lunora/queue:** upgraded to 1.0.0-alpha.33
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.37
* **@lunora/do:** upgraded to 1.0.0-alpha.97
* **@lunora/server:** upgraded to 1.0.0-alpha.81
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.36

## @lunora/codegen [1.0.0-alpha.121](https://github.com/anolilab/lunora/compare/@lunora/codegen@1.0.0-alpha.120...@lunora/codegen@1.0.0-alpha.121) (2026-08-24)

### ⚠ BREAKING CHANGES

* **flags:** createFlags(options) is now
createFlags(definition, env, options); callers must pass the
defineFlags(...) result and the Worker env as identity keys.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(flags): bind each definition to its own openfeature domain

Keying the client memo by (definition, env) was not enough on its own:
every binding still went into the single global "lunora" OpenFeature
domain, so a second definition's setProviderAndWait replaced the first's
provider in the registry and the first's cached client silently began
evaluating the second's values. The memo hid the collision rather than
preventing it, and a module-scalar warning apologised for it.

Each (definition, env) pair now owns its OpenFeature domain: the first —
the only case a real app hits, one flags.ts and one env per isolate —
keeps the stable "lunora" name so an external OpenFeature.getClient
("lunora") still reads the app's provider; additional pairs get
"lunora-2", "lunora-3", … The domain is allocated once per pair and
survives a failed bind, so a provider whose initialize throws retries on
the same domain instead of stranding readers on a dead one. The
lastBoundDefinition scalar and its console.warn are gone.

createFlags also stopped taking config it was already handed: hooks,
logger, and the provider factory are read from the definition, and the
options bag shrank to the genuinely per-request extras — the
config.flags override (undefined falls back to the definition) and the
targeting-key thunk. Both codegen emission sites emit the smaller call.
* **flags:** CreateFlagsOptions no longer accepts `hooks` or
`logger` (read from the definition), and `provider` is now an optional
override returning `Provider | undefined` instead of a required factory.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(flags): give a binding-less env a stable memo identity

Generated workers build their env as `this.env ?? {}`, so when `this.env`
is nullish every context build yields a FRESH object. Keyed on that, each
request missed the client cache, allocated another `lunora-N` domain and
ran `setProviderAndWait` again — and OpenFeature's registry holds a
strong reference to every provider by domain name, so the WeakMap being
weak would not release them: unbounded growth on the nullish path.

An env carrying no bindings is indistinguishable to any provider factory,
so they now share one `EMPTY_ENV` key and bind exactly once.

Also record on `DEFAULT_DOMAIN` that which pair wins the unsuffixed
"lunora" name is allocation-order dependent — "first definition wins"
would be equally order-dependent, so the constraint is documented rather
than papered over, with the note that code needing a specific client
should be handed it instead of looking it up by domain.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

### Bug Fixes

* **agent:** unstrand HITL approvals ([#438](https://github.com/anolilab/lunora/issues/438)) ([45c3b42](https://github.com/anolilab/lunora/commit/45c3b42297a1564a62a86ba8563d4e6c2d439106))
* **bindings:** gate ctx.images, bound sql fetches ([#448](https://github.com/anolilab/lunora/issues/448)) ([a6bf09e](https://github.com/anolilab/lunora/commit/a6bf09e0d1348af5deda061d63164cc47a9059e9))
* **flags:** key the flags memo per definition ([#463](https://github.com/anolilab/lunora/issues/463)) ([ad76ea9](https://github.com/anolilab/lunora/commit/ad76ea984a77d52801370e0194d7339c6a241cf5))


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.86
* **@lunora/agent:** upgraded to 1.0.0-alpha.61
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.36
* **@lunora/workflow:** upgraded to 1.0.0-alpha.31
* **@lunora/do:** upgraded to 1.0.0-alpha.95
* **@lunora/server:** upgraded to 1.0.0-alpha.80

## @lunora/codegen [1.0.0-alpha.120](https://github.com/anolilab/lunora/compare/@lunora/codegen@1.0.0-alpha.119...@lunora/codegen@1.0.0-alpha.120) (2026-08-24)


### Dependencies

* **@lunora/container:** upgraded to 1.0.0-alpha.33
* **@lunora/queue:** upgraded to 1.0.0-alpha.32
* **@lunora/do:** upgraded to 1.0.0-alpha.94

## @lunora/codegen [1.0.0-alpha.119](https://github.com/anolilab/lunora/compare/@lunora/codegen@1.0.0-alpha.118...@lunora/codegen@1.0.0-alpha.119) (2026-08-23)

### Features

* **server:** close all four Convex primitive gaps — _commitSeq, untracked runQuery, .memory() + onShardInit, onQueryChange reactors ([#469](https://github.com/anolilab/lunora/issues/469)) ([75b0187](https://github.com/anolilab/lunora/commit/75b01872c06ae32f0174d2cc8385e78e373d9693))


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.85
* **@lunora/agent:** upgraded to 1.0.0-alpha.60
* **@lunora/platform:** upgraded to 1.0.0-alpha.15
* **@lunora/queue:** upgraded to 1.0.0-alpha.31
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.35
* **@lunora/do:** upgraded to 1.0.0-alpha.93
* **@lunora/server:** upgraded to 1.0.0-alpha.79
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.34

## @lunora/codegen [1.0.0-alpha.118](https://github.com/anolilab/lunora/compare/@lunora/codegen@1.0.0-alpha.117...@lunora/codegen@1.0.0-alpha.118) (2026-08-23)

### Bug Fixes

* **codegen:** harden sdk names and compiled reads ([#437](https://github.com/anolilab/lunora/issues/437)) ([816ac0a](https://github.com/anolilab/lunora/commit/816ac0a2bf05a990ee72fd6694aca2ad0c8ec0c1))

## @lunora/codegen [1.0.0-alpha.117](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.116...%40lunora%2Fcodegen%401.0.0-alpha.117) (2026-08-19)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.91
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.32

## @lunora/codegen [1.0.0-alpha.116](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.115...%40lunora%2Fcodegen%401.0.0-alpha.116) (2026-08-18)

## @lunora/codegen [1.0.0-alpha.115](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.114...%40lunora%2Fcodegen%401.0.0-alpha.115) (2026-08-18)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.84
* **@lunora/agent:** upgraded to 1.0.0-alpha.59
* **@lunora/platform:** upgraded to 1.0.0-alpha.14
* **@lunora/queue:** upgraded to 1.0.0-alpha.30
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.34
* **@lunora/do:** upgraded to 1.0.0-alpha.90
* **@lunora/server:** upgraded to 1.0.0-alpha.78
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.31

## @lunora/codegen [1.0.0-alpha.114](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.113...%40lunora%2Fcodegen%401.0.0-alpha.114) (2026-08-18)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.83
* **@lunora/agent:** upgraded to 1.0.0-alpha.58
* **@lunora/container:** upgraded to 1.0.0-alpha.32
* **@lunora/platform:** upgraded to 1.0.0-alpha.13
* **@lunora/queue:** upgraded to 1.0.0-alpha.29
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.33
* **@lunora/do:** upgraded to 1.0.0-alpha.89
* **@lunora/server:** upgraded to 1.0.0-alpha.77
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.30

## @lunora/codegen [1.0.0-alpha.113](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.112...%40lunora%2Fcodegen%401.0.0-alpha.113) (2026-08-18)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.82
* **@lunora/agent:** upgraded to 1.0.0-alpha.57
* **@lunora/workflow:** upgraded to 1.0.0-alpha.30
* **@lunora/server:** upgraded to 1.0.0-alpha.76

## @lunora/codegen [1.0.0-alpha.112](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.111...%40lunora%2Fcodegen%401.0.0-alpha.112) (2026-08-15)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.81
* **@lunora/agent:** upgraded to 1.0.0-alpha.56
* **@lunora/platform:** upgraded to 1.0.0-alpha.12
* **@lunora/queue:** upgraded to 1.0.0-alpha.28
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.32
* **@lunora/do:** upgraded to 1.0.0-alpha.88
* **@lunora/server:** upgraded to 1.0.0-alpha.75
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.29

## @lunora/codegen [1.0.0-alpha.111](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.110...%40lunora%2Fcodegen%401.0.0-alpha.111) (2026-08-14)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.87

## @lunora/codegen [1.0.0-alpha.110](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.109...%40lunora%2Fcodegen%401.0.0-alpha.110) (2026-08-14)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.80
* **@lunora/agent:** upgraded to 1.0.0-alpha.55
* **@lunora/container:** upgraded to 1.0.0-alpha.31
* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/platform:** upgraded to 1.0.0-alpha.11
* **@lunora/queue:** upgraded to 1.0.0-alpha.27
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.31
* **@lunora/values:** upgraded to 1.0.0-alpha.27
* **@lunora/workflow:** upgraded to 1.0.0-alpha.29
* **@lunora/do:** upgraded to 1.0.0-alpha.86
* **@lunora/server:** upgraded to 1.0.0-alpha.74
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.28

## @lunora/codegen [1.0.0-alpha.109](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.108...%40lunora%2Fcodegen%401.0.0-alpha.109) (2026-08-12)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.79
* **@lunora/agent:** upgraded to 1.0.0-alpha.54
* **@lunora/do:** upgraded to 1.0.0-alpha.85
* **@lunora/server:** upgraded to 1.0.0-alpha.73

## @lunora/codegen [1.0.0-alpha.108](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.107...%40lunora%2Fcodegen%401.0.0-alpha.108) (2026-08-11)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.78
* **@lunora/agent:** upgraded to 1.0.0-alpha.53
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.30
* **@lunora/workflow:** upgraded to 1.0.0-alpha.28
* **@lunora/do:** upgraded to 1.0.0-alpha.84
* **@lunora/server:** upgraded to 1.0.0-alpha.72
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.27

## @lunora/codegen [1.0.0-alpha.107](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.106...%40lunora%2Fcodegen%401.0.0-alpha.107) (2026-08-11)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.77
* **@lunora/do:** upgraded to 1.0.0-alpha.83
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.26

## @lunora/codegen [1.0.0-alpha.106](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.105...%40lunora%2Fcodegen%401.0.0-alpha.106) (2026-08-11)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.76
* **@lunora/agent:** upgraded to 1.0.0-alpha.52
* **@lunora/container:** upgraded to 1.0.0-alpha.30
* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/platform:** upgraded to 1.0.0-alpha.10
* **@lunora/queue:** upgraded to 1.0.0-alpha.26
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.29
* **@lunora/values:** upgraded to 1.0.0-alpha.26
* **@lunora/workflow:** upgraded to 1.0.0-alpha.27
* **@lunora/do:** upgraded to 1.0.0-alpha.82
* **@lunora/server:** upgraded to 1.0.0-alpha.71
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.25

## @lunora/codegen [1.0.0-alpha.105](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.104...%40lunora%2Fcodegen%401.0.0-alpha.105) (2026-08-11)

## @lunora/codegen [1.0.0-alpha.104](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.103...%40lunora%2Fcodegen%401.0.0-alpha.104) (2026-08-11)

## @lunora/codegen [1.0.0-alpha.103](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.102...%40lunora%2Fcodegen%401.0.0-alpha.103) (2026-08-10)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.75
* **@lunora/agent:** upgraded to 1.0.0-alpha.51
* **@lunora/do:** upgraded to 1.0.0-alpha.81
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.24

## @lunora/codegen [1.0.0-alpha.102](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.101...%40lunora%2Fcodegen%401.0.0-alpha.102) (2026-08-10)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.74
* **@lunora/agent:** upgraded to 1.0.0-alpha.50
* **@lunora/do:** upgraded to 1.0.0-alpha.80
* **@lunora/server:** upgraded to 1.0.0-alpha.70
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.23

## @lunora/codegen [1.0.0-alpha.101](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.100...%40lunora%2Fcodegen%401.0.0-alpha.101) (2026-08-09)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.73
* **@lunora/agent:** upgraded to 1.0.0-alpha.49
* **@lunora/container:** upgraded to 1.0.0-alpha.27
* **@lunora/errors:** upgraded to 1.0.0-alpha.18
* **@lunora/queue:** upgraded to 1.0.0-alpha.23
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.26
* **@lunora/values:** upgraded to 1.0.0-alpha.23
* **@lunora/workflow:** upgraded to 1.0.0-alpha.25
* **@lunora/do:** upgraded to 1.0.0-alpha.79
* **@lunora/server:** upgraded to 1.0.0-alpha.68
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.20

## @lunora/codegen [1.0.0-alpha.100](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.99...%40lunora%2Fcodegen%401.0.0-alpha.100) (2026-08-09)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.78

## @lunora/codegen [1.0.0-alpha.99](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.98...%40lunora%2Fcodegen%401.0.0-alpha.99) (2026-08-09)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.72
* **@lunora/agent:** upgraded to 1.0.0-alpha.48
* **@lunora/container:** upgraded to 1.0.0-alpha.26
* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/platform:** upgraded to 1.0.0-alpha.8
* **@lunora/queue:** upgraded to 1.0.0-alpha.22
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.25
* **@lunora/values:** upgraded to 1.0.0-alpha.22
* **@lunora/workflow:** upgraded to 1.0.0-alpha.24
* **@lunora/do:** upgraded to 1.0.0-alpha.76
* **@lunora/server:** upgraded to 1.0.0-alpha.67
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.18

## @lunora/codegen [1.0.0-alpha.98](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.97...%40lunora%2Fcodegen%401.0.0-alpha.98) (2026-08-08)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.75
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.17

## @lunora/codegen [1.0.0-alpha.97](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.96...%40lunora%2Fcodegen%401.0.0-alpha.97) (2026-08-08)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.47

## @lunora/codegen [1.0.0-alpha.96](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.95...%40lunora%2Fcodegen%401.0.0-alpha.96) (2026-08-07)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.71
* **@lunora/agent:** upgraded to 1.0.0-alpha.46
* **@lunora/platform:** upgraded to 1.0.0-alpha.7
* **@lunora/queue:** upgraded to 1.0.0-alpha.21
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.24
* **@lunora/do:** upgraded to 1.0.0-alpha.73
* **@lunora/server:** upgraded to 1.0.0-alpha.66
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.16

## @lunora/codegen [1.0.0-alpha.95](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.94...%40lunora%2Fcodegen%401.0.0-alpha.95) (2026-08-07)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.70
* **@lunora/agent:** upgraded to 1.0.0-alpha.45
* **@lunora/do:** upgraded to 1.0.0-alpha.72
* **@lunora/server:** upgraded to 1.0.0-alpha.65
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.15

## @lunora/codegen [1.0.0-alpha.94](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.93...%40lunora%2Fcodegen%401.0.0-alpha.94) (2026-08-07)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.69
* **@lunora/agent:** upgraded to 1.0.0-alpha.44
* **@lunora/container:** upgraded to 1.0.0-alpha.25
* **@lunora/errors:** upgraded to 1.0.0-alpha.16
* **@lunora/queue:** upgraded to 1.0.0-alpha.20
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.23
* **@lunora/values:** upgraded to 1.0.0-alpha.21
* **@lunora/workflow:** upgraded to 1.0.0-alpha.23
* **@lunora/do:** upgraded to 1.0.0-alpha.71
* **@lunora/server:** upgraded to 1.0.0-alpha.64
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.14

## @lunora/codegen [1.0.0-alpha.93](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.92...%40lunora%2Fcodegen%401.0.0-alpha.93) (2026-08-07)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.68
* **@lunora/agent:** upgraded to 1.0.0-alpha.43
* **@lunora/container:** upgraded to 1.0.0-alpha.24
* **@lunora/errors:** upgraded to 1.0.0-alpha.15
* **@lunora/queue:** upgraded to 1.0.0-alpha.19
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.22
* **@lunora/values:** upgraded to 1.0.0-alpha.20
* **@lunora/workflow:** upgraded to 1.0.0-alpha.22
* **@lunora/do:** upgraded to 1.0.0-alpha.70
* **@lunora/server:** upgraded to 1.0.0-alpha.63
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.13

## @lunora/codegen [1.0.0-alpha.92](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.91...%40lunora%2Fcodegen%401.0.0-alpha.92) (2026-08-04)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.42

## @lunora/codegen [1.0.0-alpha.91](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.90...%40lunora%2Fcodegen%401.0.0-alpha.91) (2026-08-04)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.69
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.12

## @lunora/codegen [1.0.0-alpha.90](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.89...%40lunora%2Fcodegen%401.0.0-alpha.90) (2026-08-04)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.67
* **@lunora/agent:** upgraded to 1.0.0-alpha.41
* **@lunora/container:** upgraded to 1.0.0-alpha.23
* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/platform:** upgraded to 1.0.0-alpha.6
* **@lunora/queue:** upgraded to 1.0.0-alpha.18
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.21
* **@lunora/values:** upgraded to 1.0.0-alpha.19
* **@lunora/workflow:** upgraded to 1.0.0-alpha.21
* **@lunora/do:** upgraded to 1.0.0-alpha.68
* **@lunora/server:** upgraded to 1.0.0-alpha.62
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.11

## @lunora/codegen [1.0.0-alpha.89](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.88...%40lunora%2Fcodegen%401.0.0-alpha.89) (2026-08-04)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.66
* **@lunora/agent:** upgraded to 1.0.0-alpha.40
* **@lunora/values:** upgraded to 1.0.0-alpha.18
* **@lunora/workflow:** upgraded to 1.0.0-alpha.20
* **@lunora/server:** upgraded to 1.0.0-alpha.61

## @lunora/codegen [1.0.0-alpha.88](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.87...%40lunora%2Fcodegen%401.0.0-alpha.88) (2026-08-04)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.65
* **@lunora/container:** upgraded to 1.0.0-alpha.22

## @lunora/codegen [1.0.0-alpha.87](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.86...%40lunora%2Fcodegen%401.0.0-alpha.87) (2026-08-04)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.64
* **@lunora/agent:** upgraded to 1.0.0-alpha.39
* **@lunora/container:** upgraded to 1.0.0-alpha.21
* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/platform:** upgraded to 1.0.0-alpha.5
* **@lunora/queue:** upgraded to 1.0.0-alpha.17
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.20
* **@lunora/values:** upgraded to 1.0.0-alpha.17
* **@lunora/workflow:** upgraded to 1.0.0-alpha.19
* **@lunora/do:** upgraded to 1.0.0-alpha.67
* **@lunora/server:** upgraded to 1.0.0-alpha.60
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.10

## @lunora/codegen [1.0.0-alpha.86](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.85...%40lunora%2Fcodegen%401.0.0-alpha.86) (2026-08-03)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.63
* **@lunora/agent:** upgraded to 1.0.0-alpha.38
* **@lunora/values:** upgraded to 1.0.0-alpha.16
* **@lunora/workflow:** upgraded to 1.0.0-alpha.18
* **@lunora/server:** upgraded to 1.0.0-alpha.59

## @lunora/codegen [1.0.0-alpha.85](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.84...%40lunora%2Fcodegen%401.0.0-alpha.85) (2026-08-02)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.62
* **@lunora/agent:** upgraded to 1.0.0-alpha.37
* **@lunora/platform:** upgraded to 1.0.0-alpha.4
* **@lunora/queue:** upgraded to 1.0.0-alpha.16
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.19
* **@lunora/do:** upgraded to 1.0.0-alpha.64
* **@lunora/server:** upgraded to 1.0.0-alpha.58
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.7

## @lunora/codegen [1.0.0-alpha.84](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.83...%40lunora%2Fcodegen%401.0.0-alpha.84) (2026-08-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.63

## @lunora/codegen [1.0.0-alpha.83](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.82...%40lunora%2Fcodegen%401.0.0-alpha.83) (2026-08-02)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.61
* **@lunora/agent:** upgraded to 1.0.0-alpha.36
* **@lunora/do:** upgraded to 1.0.0-alpha.62
* **@lunora/server:** upgraded to 1.0.0-alpha.57

## @lunora/codegen [1.0.0-alpha.82](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.81...%40lunora%2Fcodegen%401.0.0-alpha.82) (2026-07-31)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.60
* **@lunora/agent:** upgraded to 1.0.0-alpha.35
* **@lunora/do:** upgraded to 1.0.0-alpha.61
* **@lunora/server:** upgraded to 1.0.0-alpha.56
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.4

## @lunora/codegen [1.0.0-alpha.81](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.80...%40lunora%2Fcodegen%401.0.0-alpha.81) (2026-07-31)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.59
* **@lunora/agent:** upgraded to 1.0.0-alpha.34
* **@lunora/container:** upgraded to 1.0.0-alpha.18
* **@lunora/errors:** upgraded to 1.0.0-alpha.10
* **@lunora/queue:** upgraded to 1.0.0-alpha.13
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.16
* **@lunora/values:** upgraded to 1.0.0-alpha.13
* **@lunora/workflow:** upgraded to 1.0.0-alpha.15
* **@lunora/do:** upgraded to 1.0.0-alpha.60
* **@lunora/server:** upgraded to 1.0.0-alpha.55
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.3

## @lunora/codegen [1.0.0-alpha.80](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.79...%40lunora%2Fcodegen%401.0.0-alpha.80) (2026-07-31)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.58
* **@lunora/agent:** upgraded to 1.0.0-alpha.33
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.15
* **@lunora/do:** upgraded to 1.0.0-alpha.59
* **@lunora/server:** upgraded to 1.0.0-alpha.54
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.2

## @lunora/codegen [1.0.0-alpha.79](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.78...%40lunora%2Fcodegen%401.0.0-alpha.79) (2026-07-30)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.57
* **@lunora/agent:** upgraded to 1.0.0-alpha.32
* **@lunora/platform:** upgraded to 1.0.0-alpha.1
* **@lunora/queue:** upgraded to 1.0.0-alpha.12
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.14
* **@lunora/do:** upgraded to 1.0.0-alpha.58
* **@lunora/server:** upgraded to 1.0.0-alpha.53
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.1

## @lunora/codegen [1.0.0-alpha.78](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.77...%40lunora%2Fcodegen%401.0.0-alpha.78) (2026-07-30)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.56

## @lunora/codegen [1.0.0-alpha.77](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.76...%40lunora%2Fcodegen%401.0.0-alpha.77) (2026-07-30)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.55
* **@lunora/agent:** upgraded to 1.0.0-alpha.31
* **@lunora/do:** upgraded to 1.0.0-alpha.56
* **@lunora/server:** upgraded to 1.0.0-alpha.52

## @lunora/codegen [1.0.0-alpha.76](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.75...%40lunora%2Fcodegen%401.0.0-alpha.76) (2026-07-29)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.55

## @lunora/codegen [1.0.0-alpha.75](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.74...%40lunora%2Fcodegen%401.0.0-alpha.75) (2026-07-28)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.54
* **@lunora/agent:** upgraded to 1.0.0-alpha.30
* **@lunora/container:** upgraded to 1.0.0-alpha.17
* **@lunora/errors:** upgraded to 1.0.0-alpha.9
* **@lunora/queue:** upgraded to 1.0.0-alpha.11
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.13
* **@lunora/values:** upgraded to 1.0.0-alpha.12
* **@lunora/workflow:** upgraded to 1.0.0-alpha.14
* **@lunora/do:** upgraded to 1.0.0-alpha.53
* **@lunora/server:** upgraded to 1.0.0-alpha.51

## @lunora/codegen [1.0.0-alpha.74](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.73...%40lunora%2Fcodegen%401.0.0-alpha.74) (2026-07-28)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.53
* **@lunora/agent:** upgraded to 1.0.0-alpha.29
* **@lunora/server:** upgraded to 1.0.0-alpha.50

## @lunora/codegen [1.0.0-alpha.73](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.72...%40lunora%2Fcodegen%401.0.0-alpha.73) (2026-07-27)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.52
* **@lunora/agent:** upgraded to 1.0.0-alpha.28
* **@lunora/server:** upgraded to 1.0.0-alpha.49

## @lunora/codegen [1.0.0-alpha.72](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.71...%40lunora%2Fcodegen%401.0.0-alpha.72) (2026-07-27)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.51
* **@lunora/agent:** upgraded to 1.0.0-alpha.27
* **@lunora/server:** upgraded to 1.0.0-alpha.48

## @lunora/codegen [1.0.0-alpha.71](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.70...%40lunora%2Fcodegen%401.0.0-alpha.71) (2026-07-27)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.50
* **@lunora/agent:** upgraded to 1.0.0-alpha.26
* **@lunora/do:** upgraded to 1.0.0-alpha.52
* **@lunora/server:** upgraded to 1.0.0-alpha.47

## @lunora/codegen [1.0.0-alpha.70](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.69...%40lunora%2Fcodegen%401.0.0-alpha.70) (2026-07-27)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.49
* **@lunora/agent:** upgraded to 1.0.0-alpha.25
* **@lunora/server:** upgraded to 1.0.0-alpha.46

## @lunora/codegen [1.0.0-alpha.69](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.68...%40lunora%2Fcodegen%401.0.0-alpha.69) (2026-07-27)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.48
* **@lunora/agent:** upgraded to 1.0.0-alpha.24
* **@lunora/do:** upgraded to 1.0.0-alpha.51
* **@lunora/server:** upgraded to 1.0.0-alpha.45

## @lunora/codegen [1.0.0-alpha.68](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.67...%40lunora%2Fcodegen%401.0.0-alpha.68) (2026-07-27)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.47
* **@lunora/agent:** upgraded to 1.0.0-alpha.23
* **@lunora/do:** upgraded to 1.0.0-alpha.50
* **@lunora/server:** upgraded to 1.0.0-alpha.44

## @lunora/codegen [1.0.0-alpha.67](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.66...%40lunora%2Fcodegen%401.0.0-alpha.67) (2026-07-27)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.46
* **@lunora/agent:** upgraded to 1.0.0-alpha.22
* **@lunora/server:** upgraded to 1.0.0-alpha.43

## @lunora/codegen [1.0.0-alpha.66](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.65...%40lunora%2Fcodegen%401.0.0-alpha.66) (2026-07-27)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.45
* **@lunora/agent:** upgraded to 1.0.0-alpha.21
* **@lunora/server:** upgraded to 1.0.0-alpha.42

## @lunora/codegen [1.0.0-alpha.65](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.64...%40lunora%2Fcodegen%401.0.0-alpha.65) (2026-07-27)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.44
* **@lunora/agent:** upgraded to 1.0.0-alpha.20
* **@lunora/server:** upgraded to 1.0.0-alpha.41

## @lunora/codegen [1.0.0-alpha.64](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.63...%40lunora%2Fcodegen%401.0.0-alpha.64) (2026-07-26)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.43
* **@lunora/agent:** upgraded to 1.0.0-alpha.19
* **@lunora/server:** upgraded to 1.0.0-alpha.40

## @lunora/codegen [1.0.0-alpha.63](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.62...%40lunora%2Fcodegen%401.0.0-alpha.63) (2026-07-26)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.42
* **@lunora/agent:** upgraded to 1.0.0-alpha.18
* **@lunora/server:** upgraded to 1.0.0-alpha.39

## @lunora/codegen [1.0.0-alpha.62](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.61...%40lunora%2Fcodegen%401.0.0-alpha.62) (2026-07-26)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.41
* **@lunora/agent:** upgraded to 1.0.0-alpha.17
* **@lunora/server:** upgraded to 1.0.0-alpha.38

## @lunora/codegen [1.0.0-alpha.61](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.60...%40lunora%2Fcodegen%401.0.0-alpha.61) (2026-07-26)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.40
* **@lunora/agent:** upgraded to 1.0.0-alpha.16
* **@lunora/do:** upgraded to 1.0.0-alpha.49
* **@lunora/server:** upgraded to 1.0.0-alpha.37

## @lunora/codegen [1.0.0-alpha.60](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.59...%40lunora%2Fcodegen%401.0.0-alpha.60) (2026-07-26)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.39
* **@lunora/agent:** upgraded to 1.0.0-alpha.15
* **@lunora/do:** upgraded to 1.0.0-alpha.48
* **@lunora/server:** upgraded to 1.0.0-alpha.36

## @lunora/codegen [1.0.0-alpha.59](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.58...%40lunora%2Fcodegen%401.0.0-alpha.59) (2026-07-26)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.38
* **@lunora/agent:** upgraded to 1.0.0-alpha.14
* **@lunora/server:** upgraded to 1.0.0-alpha.35

## @lunora/codegen [1.0.0-alpha.58](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.57...%40lunora%2Fcodegen%401.0.0-alpha.58) (2026-07-25)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.37
* **@lunora/agent:** upgraded to 1.0.0-alpha.13
* **@lunora/server:** upgraded to 1.0.0-alpha.34

## @lunora/codegen [1.0.0-alpha.57](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.56...%40lunora%2Fcodegen%401.0.0-alpha.57) (2026-07-25)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.36
* **@lunora/agent:** upgraded to 1.0.0-alpha.12
* **@lunora/do:** upgraded to 1.0.0-alpha.46
* **@lunora/server:** upgraded to 1.0.0-alpha.33

## @lunora/codegen [1.0.0-alpha.56](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.55...%40lunora%2Fcodegen%401.0.0-alpha.56) (2026-07-25)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.35
* **@lunora/agent:** upgraded to 1.0.0-alpha.11
* **@lunora/do:** upgraded to 1.0.0-alpha.45
* **@lunora/server:** upgraded to 1.0.0-alpha.32

## @lunora/codegen [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.54...%40lunora%2Fcodegen%401.0.0-alpha.55) (2026-07-25)

## @lunora/codegen [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.53...%40lunora%2Fcodegen%401.0.0-alpha.54) (2026-07-25)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.34
* **@lunora/agent:** upgraded to 1.0.0-alpha.10
* **@lunora/container:** upgraded to 1.0.0-alpha.16
* **@lunora/errors:** upgraded to 1.0.0-alpha.8
* **@lunora/queue:** upgraded to 1.0.0-alpha.10
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.12
* **@lunora/values:** upgraded to 1.0.0-alpha.11
* **@lunora/workflow:** upgraded to 1.0.0-alpha.13
* **@lunora/do:** upgraded to 1.0.0-alpha.44
* **@lunora/server:** upgraded to 1.0.0-alpha.31

## @lunora/codegen [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.52...%40lunora%2Fcodegen%401.0.0-alpha.53) (2026-07-24)


### Dependencies

* **@lunora/container:** upgraded to 1.0.0-alpha.15
* **@lunora/do:** upgraded to 1.0.0-alpha.43

## @lunora/codegen [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.51...%40lunora%2Fcodegen%401.0.0-alpha.52) (2026-07-23)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.33
* **@lunora/agent:** upgraded to 1.0.0-alpha.9
* **@lunora/values:** upgraded to 1.0.0-alpha.10
* **@lunora/workflow:** upgraded to 1.0.0-alpha.12
* **@lunora/server:** upgraded to 1.0.0-alpha.30

## @lunora/codegen [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.50...%40lunora%2Fcodegen%401.0.0-alpha.51) (2026-07-22)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.8

## @lunora/codegen [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.49...%40lunora%2Fcodegen%401.0.0-alpha.50) (2026-07-22)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.7

## @lunora/codegen [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.48...%40lunora%2Fcodegen%401.0.0-alpha.49) (2026-07-21)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.37

## @lunora/codegen [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.47...%40lunora%2Fcodegen%401.0.0-alpha.48) (2026-07-21)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.32
* **@lunora/agent:** upgraded to 1.0.0-alpha.6
* **@lunora/do:** upgraded to 1.0.0-alpha.35
* **@lunora/server:** upgraded to 1.0.0-alpha.29

## @lunora/codegen [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.46...%40lunora%2Fcodegen%401.0.0-alpha.47) (2026-07-20)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.31
* **@lunora/agent:** upgraded to 1.0.0-alpha.5
* **@lunora/container:** upgraded to 1.0.0-alpha.13
* **@lunora/errors:** upgraded to 1.0.0-alpha.6
* **@lunora/queue:** upgraded to 1.0.0-alpha.9
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.11
* **@lunora/values:** upgraded to 1.0.0-alpha.9
* **@lunora/workflow:** upgraded to 1.0.0-alpha.11
* **@lunora/do:** upgraded to 1.0.0-alpha.34
* **@lunora/server:** upgraded to 1.0.0-alpha.28

## @lunora/codegen [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.45...%40lunora%2Fcodegen%401.0.0-alpha.46) (2026-07-19)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.30
* **@lunora/agent:** upgraded to 1.0.0-alpha.4
* **@lunora/do:** upgraded to 1.0.0-alpha.33
* **@lunora/server:** upgraded to 1.0.0-alpha.27

## @lunora/codegen [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.44...%40lunora%2Fcodegen%401.0.0-alpha.45) (2026-07-18)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.29
* **@lunora/agent:** upgraded to 1.0.0-alpha.3
* **@lunora/do:** upgraded to 1.0.0-alpha.32
* **@lunora/server:** upgraded to 1.0.0-alpha.26

## @lunora/codegen [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.43...%40lunora%2Fcodegen%401.0.0-alpha.44) (2026-07-17)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.28
* **@lunora/agent:** upgraded to 1.0.0-alpha.2
* **@lunora/container:** upgraded to 1.0.0-alpha.12
* **@lunora/errors:** upgraded to 1.0.0-alpha.5
* **@lunora/queue:** upgraded to 1.0.0-alpha.8
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.10
* **@lunora/values:** upgraded to 1.0.0-alpha.8
* **@lunora/workflow:** upgraded to 1.0.0-alpha.10
* **@lunora/do:** upgraded to 1.0.0-alpha.31
* **@lunora/server:** upgraded to 1.0.0-alpha.25

## @lunora/codegen [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.42...%40lunora%2Fcodegen%401.0.0-alpha.43) (2026-07-13)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.27
* **@lunora/agent:** upgraded to 1.0.0-alpha.1
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.9
* **@lunora/do:** upgraded to 1.0.0-alpha.29
* **@lunora/server:** upgraded to 1.0.0-alpha.24

## @lunora/codegen [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.41...%40lunora%2Fcodegen%401.0.0-alpha.42) (2026-07-12)


### Dependencies

* **@lunora/container:** upgraded to 1.0.0-alpha.11
* **@lunora/do:** upgraded to 1.0.0-alpha.28

## @lunora/codegen [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.40...%40lunora%2Fcodegen%401.0.0-alpha.41) (2026-07-11)


### Dependencies

* **@lunora/container:** upgraded to 1.0.0-alpha.10

## @lunora/codegen [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.39...%40lunora%2Fcodegen%401.0.0-alpha.40) (2026-07-11)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.26
* **@lunora/container:** upgraded to 1.0.0-alpha.9
* **@lunora/errors:** upgraded to 1.0.0-alpha.4
* **@lunora/queue:** upgraded to 1.0.0-alpha.7
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.8
* **@lunora/values:** upgraded to 1.0.0-alpha.7
* **@lunora/workflow:** upgraded to 1.0.0-alpha.9
* **@lunora/do:** upgraded to 1.0.0-alpha.27
* **@lunora/server:** upgraded to 1.0.0-alpha.23

## @lunora/codegen [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.38...%40lunora%2Fcodegen%401.0.0-alpha.39) (2026-07-10)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.25
* **@lunora/server:** upgraded to 1.0.0-alpha.22

## @lunora/codegen [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.37...%40lunora%2Fcodegen%401.0.0-alpha.38) (2026-07-08)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.24
* **@lunora/container:** upgraded to 1.0.0-alpha.8
* **@lunora/errors:** upgraded to 1.0.0-alpha.3
* **@lunora/queue:** upgraded to 1.0.0-alpha.6
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.7
* **@lunora/values:** upgraded to 1.0.0-alpha.6
* **@lunora/workflow:** upgraded to 1.0.0-alpha.8
* **@lunora/do:** upgraded to 1.0.0-alpha.26
* **@lunora/server:** upgraded to 1.0.0-alpha.21

## @lunora/codegen [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.36...%40lunora%2Fcodegen%401.0.0-alpha.37) (2026-07-08)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.23
* **@lunora/server:** upgraded to 1.0.0-alpha.20

## @lunora/codegen [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.35...%40lunora%2Fcodegen%401.0.0-alpha.36) (2026-07-07)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.22
* **@lunora/server:** upgraded to 1.0.0-alpha.18

## @lunora/codegen [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.34...%40lunora%2Fcodegen%401.0.0-alpha.35) (2026-07-06)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.21

## @lunora/codegen [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.33...%40lunora%2Fcodegen%401.0.0-alpha.34) (2026-07-04)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.20
* **@lunora/container:** upgraded to 1.0.0-alpha.7
* **@lunora/errors:** upgraded to 1.0.0-alpha.2
* **@lunora/queue:** upgraded to 1.0.0-alpha.5
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.6
* **@lunora/values:** upgraded to 1.0.0-alpha.5
* **@lunora/workflow:** upgraded to 1.0.0-alpha.7
* **@lunora/do:** upgraded to 1.0.0-alpha.24
* **@lunora/server:** upgraded to 1.0.0-alpha.17

## @lunora/codegen [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.32...%40lunora%2Fcodegen%401.0.0-alpha.33) (2026-07-04)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.19

## @lunora/codegen [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.31...%40lunora%2Fcodegen%401.0.0-alpha.32) (2026-07-04)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.18
* **@lunora/server:** upgraded to 1.0.0-alpha.16

## @lunora/codegen [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.30...%40lunora%2Fcodegen%401.0.0-alpha.31) (2026-07-04)


### Dependencies

* **@lunora/queue:** upgraded to 1.0.0-alpha.4
* **@lunora/do:** upgraded to 1.0.0-alpha.23

## @lunora/codegen [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.29...%40lunora%2Fcodegen%401.0.0-alpha.30) (2026-07-03)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.17
* **@lunora/server:** upgraded to 1.0.0-alpha.15

## @lunora/codegen [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.28...%40lunora%2Fcodegen%401.0.0-alpha.29) (2026-07-03)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.16
* **@lunora/container:** upgraded to 1.0.0-alpha.6
* **@lunora/errors:** upgraded to 1.0.0-alpha.1
* **@lunora/queue:** upgraded to 1.0.0-alpha.3
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.5
* **@lunora/values:** upgraded to 1.0.0-alpha.4
* **@lunora/workflow:** upgraded to 1.0.0-alpha.6
* **@lunora/do:** upgraded to 1.0.0-alpha.22
* **@lunora/server:** upgraded to 1.0.0-alpha.14

## @lunora/codegen [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.27...%40lunora%2Fcodegen%401.0.0-alpha.28) (2026-07-03)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.21

## @lunora/codegen [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.26...%40lunora%2Fcodegen%401.0.0-alpha.27) (2026-07-03)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.15
* **@lunora/do:** upgraded to 1.0.0-alpha.20
* **@lunora/server:** upgraded to 1.0.0-alpha.13

## @lunora/codegen [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.25...%40lunora%2Fcodegen%401.0.0-alpha.26) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.19

## @lunora/codegen [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.24...%40lunora%2Fcodegen%401.0.0-alpha.25) (2026-07-02)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.14
* **@lunora/queue:** upgraded to 1.0.0-alpha.2
* **@lunora/do:** upgraded to 1.0.0-alpha.18
* **@lunora/server:** upgraded to 1.0.0-alpha.12

## @lunora/codegen [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.23...%40lunora%2Fcodegen%401.0.0-alpha.24) (2026-07-02)


### Dependencies

* **@lunora/workflow:** upgraded to 1.0.0-alpha.5
* **@lunora/do:** upgraded to 1.0.0-alpha.17

## @lunora/codegen [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.22...%40lunora%2Fcodegen%401.0.0-alpha.23) (2026-07-02)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.13
* **@lunora/server:** upgraded to 1.0.0-alpha.11

## @lunora/codegen [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.21...%40lunora%2Fcodegen%401.0.0-alpha.22) (2026-07-02)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.12
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.4
* **@lunora/do:** upgraded to 1.0.0-alpha.16
* **@lunora/server:** upgraded to 1.0.0-alpha.10

## @lunora/codegen [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.20...%40lunora%2Fcodegen%401.0.0-alpha.21) (2026-07-02)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.11
* **@lunora/do:** upgraded to 1.0.0-alpha.15
* **@lunora/server:** upgraded to 1.0.0-alpha.9

## @lunora/codegen [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.19...%40lunora%2Fcodegen%401.0.0-alpha.20) (2026-07-01)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.10
* **@lunora/do:** upgraded to 1.0.0-alpha.14
* **@lunora/server:** upgraded to 1.0.0-alpha.8

## @lunora/codegen [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.18...%40lunora%2Fcodegen%401.0.0-alpha.19) (2026-06-30)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.9
* **@lunora/workflow:** upgraded to 1.0.0-alpha.4
* **@lunora/do:** upgraded to 1.0.0-alpha.12

## @lunora/codegen [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.17...%40lunora%2Fcodegen%401.0.0-alpha.18) (2026-06-30)

## @lunora/codegen [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.16...%40lunora%2Fcodegen%401.0.0-alpha.17) (2026-06-30)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.8
* **@lunora/do:** upgraded to 1.0.0-alpha.9
* **@lunora/server:** upgraded to 1.0.0-alpha.7

## @lunora/codegen [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.15...%40lunora%2Fcodegen%401.0.0-alpha.16) (2026-06-29)


### Dependencies

* **@lunora/container:** upgraded to 1.0.0-alpha.5

## @lunora/codegen [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.14...%40lunora%2Fcodegen%401.0.0-alpha.15) (2026-06-29)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.8

## @lunora/codegen [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fcodegen%401.0.0-alpha.13...%40lunora%2Fcodegen%401.0.0-alpha.14) (2026-06-29)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.7
* **@lunora/server:** upgraded to 1.0.0-alpha.6

## @lunora/codegen [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/@lunora/codegen@1.0.0-alpha.12...@lunora/codegen@1.0.0-alpha.13) (2026-06-28)

### Features

* **vite:** error-overlay solution finders ([#42](https://github.com/anolilab/lunora/issues/42)) ([33097e2](https://github.com/anolilab/lunora/commit/33097e2d5638b3e924c506eb5e161e9a20ea6f6f))

## @lunora/codegen [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/@lunora/codegen@1.0.0-alpha.11...@lunora/codegen@1.0.0-alpha.12) (2026-06-28)

### Features

* **container:** close Cloudflare Container feature gaps ([#36](https://github.com/anolilab/lunora/issues/36)) ([0246176](https://github.com/anolilab/lunora/commit/02461764873b47d51fb55dbd12bc784bcf9dad42)), closes [28/#178](https://github.com/28/lunora/issues/178) [cloudflare/containers#30](https://github.com/cloudflare/containers/issues/30) [cloudflare/containers#147](https://github.com/cloudflare/containers/issues/147) [cloudflare/containers#147](https://github.com/cloudflare/containers/issues/147) [cloudflare/containers#135](https://github.com/cloudflare/containers/issues/135)

### Documentation

* fix package doc bugs and dead cross-links ([205d74c](https://github.com/anolilab/lunora/commit/205d74c3b730e201e822141191b45015f303336b))


### Dependencies

* **@lunora/container:** upgraded to 1.0.0-alpha.4

## @lunora/codegen [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/@lunora/codegen@1.0.0-alpha.10...@lunora/codegen@1.0.0-alpha.11) (2026-06-27)

### Features

* **queue:** add queues, pipelines, secrets bindings + studio queues page ([#30](https://github.com/anolilab/lunora/issues/30)) ([131460c](https://github.com/anolilab/lunora/commit/131460c5826f2ef600fa0ef81248ede91835dd0c)), closes [#29](https://github.com/anolilab/lunora/issues/29) [#31](https://github.com/anolilab/lunora/issues/31) [visulima#714](https://github.com/visulima/visulima/issues/714)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.6
* **@lunora/container:** upgraded to 1.0.0-alpha.3
* **@lunora/queue:** upgraded to 1.0.0-alpha.1
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.3
* **@lunora/values:** upgraded to 1.0.0-alpha.3
* **@lunora/workflow:** upgraded to 1.0.0-alpha.3
* **@lunora/do:** upgraded to 1.0.0-alpha.6
* **@lunora/server:** upgraded to 1.0.0-alpha.5

## @lunora/codegen [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/@lunora/codegen@1.0.0-alpha.9...@lunora/codegen@1.0.0-alpha.10) (2026-06-27)

### Features

* **server:** pin durable objects to a data-residency jurisdiction ([#29](https://github.com/anolilab/lunora/issues/29)) ([0fcdc94](https://github.com/anolilab/lunora/commit/0fcdc94a836ea1b54a0eba78b6926de52aa3a767))


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.5
* **@lunora/container:** upgraded to 1.0.0-alpha.2
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.2
* **@lunora/server:** upgraded to 1.0.0-alpha.4

## @lunora/codegen [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/@lunora/codegen@1.0.0-alpha.8...@lunora/codegen@1.0.0-alpha.9) (2026-06-27)

### Features

* extending db  ([#32](https://github.com/anolilab/lunora/issues/32)) ([6b77a16](https://github.com/anolilab/lunora/commit/6b77a16996e6aa59c19c801c3ea18004deccd6dc))

### Performance Improvements

* **runtime:** skip route lookup when no custom routes ([#33](https://github.com/anolilab/lunora/issues/33)) ([e829b9b](https://github.com/anolilab/lunora/commit/e829b9b7d2a5c8a9f533f91706cdae8dd75b564d))

### Miscellaneous Chores

* update our og pacakge image ([63e6811](https://github.com/anolilab/lunora/commit/63e6811e2dfb94bc2cc38c05292b527e884660b5))


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.4
* **@lunora/values:** upgraded to 1.0.0-alpha.2
* **@lunora/workflow:** upgraded to 1.0.0-alpha.2
* **@lunora/do:** upgraded to 1.0.0-alpha.5
* **@lunora/server:** upgraded to 1.0.0-alpha.3

## @lunora/codegen [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/@lunora/codegen@1.0.0-alpha.7...@lunora/codegen@1.0.0-alpha.8) (2026-06-26)

### Bug Fixes

* **codegen:** pinpoint cron and migration errors to file:line ([7afadd3](https://github.com/anolilab/lunora/commit/7afadd3afce300df091aaf0d0a155a1d2ce4b8ac))

### Performance Improvements

* **codegen:** add opt-in codegen timing instrumentation ([9443e7f](https://github.com/anolilab/lunora/commit/9443e7f642f2081c086626e64a4f754ed8f65e19))

## @lunora/codegen [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/@lunora/codegen@1.0.0-alpha.6...@lunora/codegen@1.0.0-alpha.7) (2026-06-25)

### Bug Fixes

* **codegen:** resolve const table names in insert discovery ([37c97e7](https://github.com/anolilab/lunora/commit/37c97e71e1787a398a709a0ed5790ced05e00e62))

## @lunora/codegen [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/@lunora/codegen@1.0.0-alpha.5...@lunora/codegen@1.0.0-alpha.6) (2026-06-25)

### Features

* **codegen:** resolve node_modules schema extensions ([3b8d7e9](https://github.com/anolilab/lunora/commit/3b8d7e9b42b9778b64291e795c2f8e943d57fbab))

## @lunora/codegen [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/@lunora/codegen@1.0.0-alpha.4...@lunora/codegen@1.0.0-alpha.5) (2026-06-25)

### Features

* **codegen:** resolve definePlugin schema extensions ([63414fc](https://github.com/anolilab/lunora/commit/63414fcc288eedada05cf72d74e2fe12c157b9db))

## @lunora/codegen [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/@lunora/codegen@1.0.0-alpha.3...@lunora/codegen@1.0.0-alpha.4) (2026-06-25)

### Features

* **codegen:** emit deterministic ctx.now ([9e190cf](https://github.com/anolilab/lunora/commit/9e190cf0dc10bfa0785421bcc45fe32653f0388b))

### Bug Fixes

* **codegen:** detect aliased rate-limit .use() ([7c9e0de](https://github.com/anolilab/lunora/commit/7c9e0ded8686fbbfc46fa245cef1732b37404779))


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.3
* **@lunora/server:** upgraded to 1.0.0-alpha.2

## @lunora/codegen [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/@lunora/codegen@1.0.0-alpha.2...@lunora/codegen@1.0.0-alpha.3) (2026-06-24)

### Features

* **r2sql:** typed R2 SQL client with window functions, DISTINCT and set ops ([#26](https://github.com/anolilab/lunora/issues/26)) ([fe9546b](https://github.com/anolilab/lunora/commit/fe9546bb3473875d47939bf93e6fbb81084a07aa))

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.2
* **@lunora/do:** upgraded to 1.0.0-alpha.4

## @lunora/codegen [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/codegen@1.0.0-alpha.1...@lunora/codegen@1.0.0-alpha.2) (2026-06-22)

### Bug Fixes

* **bench:** seed CodSpeed benches in beforeAll, not top-level await ([3964f8a](https://github.com/anolilab/lunora/commit/3964f8aa241e4fac0a24236d693647144f0ea825))


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.2

## @lunora/codegen 1.0.0-alpha.1 (2026-06-21)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Miscellaneous Chores

* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.1
* **@lunora/container:** upgraded to 1.0.0-alpha.1
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.1
* **@lunora/values:** upgraded to 1.0.0-alpha.1
* **@lunora/workflow:** upgraded to 1.0.0-alpha.1
* **@lunora/do:** upgraded to 1.0.0-alpha.1
* **@lunora/server:** upgraded to 1.0.0-alpha.1
