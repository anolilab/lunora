## @lunora/platform-node [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/@lunora/platform-node@1.0.0-alpha.38...@lunora/platform-node@1.0.0-alpha.39) (2026-08-31)

### Bug Fixes

* close the silent-success class across all 55 packages ([#536](https://github.com/anolilab/lunora/issues/536)) ([dad6b74](https://github.com/anolilab/lunora/commit/dad6b74b79dd336b13f0b922a6ab32d3345c9657))


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.99
* **@lunora/platform:** upgraded to 1.0.0-alpha.22
* **@lunora/queue:** upgraded to 1.0.0-alpha.39
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.101
* **@lunora/do:** upgraded to 1.0.0-alpha.110
* **@lunora/platform-cloudflare:** upgraded to 1.0.0-alpha.27
* **@lunora/runtime:** upgraded to 1.0.0-alpha.84
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.48
* **@lunora/storage:** upgraded to 1.0.0-alpha.44

## @lunora/platform-node [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/@lunora/platform-node@1.0.0-alpha.37...@lunora/platform-node@1.0.0-alpha.38) (2026-08-30)


### Dependencies

* **@lunora/workflow:** upgraded to 1.0.0-alpha.38
* **@lunora/runtime:** upgraded to 1.0.0-alpha.82

## @lunora/platform-node [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/@lunora/platform-node@1.0.0-alpha.36...@lunora/platform-node@1.0.0-alpha.37) (2026-08-29)

### ⚠ BREAKING CHANGES

* eleven packages now declare peerDependencies. Consumers that
relied on those packages resolving through hoisting must install them; the
alternative was shipping types that fail to resolve off this repo's node_modules.

`@lunora/workflow` is an optional peer of `@lunora/runtime`, so packem inlines
its types rather than importing them — the published `@lunora/runtime` carries no
`@lunora/workflow` dependency, as its source comments already promised.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AWDgSnuBJaeQHfEitB2zeL

* fix: satisfy eslint and the template matrix after the packem gate

Two CI failures from making packem warnings fatal, each a gate that the local
packem sweep does not cover.

`@lunora/advisor` back to a real dependency on `@lunora/errors`. `ae-metrics.ts`
imports `LunoraError` as a VALUE, and import/no-extraneous-dependencies requires
that for anything under `src/` regardless of whether the module reaches the
bundle. packem cannot see it because that module's value exports are
quarantined — `src/index.ts` re-exports only its types — so the throwing code is
tree-shaken out. The two rules disagree by construction; the packem side is now a
commented `unused` exclusion that says which condition would end it.

`@lunora/workflow` becomes a REQUIRED peer of `@lunora/runtime`. As an optional
peer it was auto-installed anyway, and every one of the twelve templates then
resolved `@lunora/workflow` from the npm REGISTRY instead of this checkout — the
scaffold matrix builds its local-tarball map from required peers only, on the
assumption that optional ones are never pulled in. Forcing the type to inline
instead (`resolveExternals.exclude`) does not work: that option governs the JS
bundle, and the declaration build has its own resolver, so the import survived.
A required peer matches the other seven packages here and keeps the type
resolvable for consumers.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AWDgSnuBJaeQHfEitB2zeL

### Build System

* ship .mjs everywhere and make packem warnings fatal ([#526](https://github.com/anolilab/lunora/issues/526)) ([b3eaacc](https://github.com/anolilab/lunora/commit/b3eaacc5a31fe4634a5f4a6c59fda6fbbc8315e1))


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.98
* **@lunora/errors:** upgraded to 1.0.0-alpha.26
* **@lunora/platform:** upgraded to 1.0.0-alpha.21
* **@lunora/queue:** upgraded to 1.0.0-alpha.38
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.100
* **@lunora/workflow:** upgraded to 1.0.0-alpha.37
* **@lunora/do:** upgraded to 1.0.0-alpha.109
* **@lunora/platform-cloudflare:** upgraded to 1.0.0-alpha.26
* **@lunora/runtime:** upgraded to 1.0.0-alpha.80
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.47
* **@lunora/storage:** upgraded to 1.0.0-alpha.43

## @lunora/platform-node [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/@lunora/platform-node@1.0.0-alpha.35...@lunora/platform-node@1.0.0-alpha.36) (2026-08-28)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.97
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.99

## @lunora/platform-node [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/@lunora/platform-node@1.0.0-alpha.34...@lunora/platform-node@1.0.0-alpha.35) (2026-08-28)

### Bug Fixes

* close nine copied-helper divergences across eight packages ([#522](https://github.com/anolilab/lunora/issues/522)) ([a2455bb](https://github.com/anolilab/lunora/commit/a2455bb0f58b9873633504c3f1e9bfeb44a5870e))


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.96
* **@lunora/errors:** upgraded to 1.0.0-alpha.25
* **@lunora/platform:** upgraded to 1.0.0-alpha.20
* **@lunora/queue:** upgraded to 1.0.0-alpha.37
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.98
* **@lunora/workflow:** upgraded to 1.0.0-alpha.36
* **@lunora/do:** upgraded to 1.0.0-alpha.108
* **@lunora/platform-cloudflare:** upgraded to 1.0.0-alpha.25
* **@lunora/runtime:** upgraded to 1.0.0-alpha.79
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.46
* **@lunora/storage:** upgraded to 1.0.0-alpha.42

## @lunora/platform-node [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/@lunora/platform-node@1.0.0-alpha.33...@lunora/platform-node@1.0.0-alpha.34) (2026-08-28)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.95
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.97
* **@lunora/do:** upgraded to 1.0.0-alpha.107
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.45

## @lunora/platform-node [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/@lunora/platform-node@1.0.0-alpha.32...@lunora/platform-node@1.0.0-alpha.33) (2026-08-27)

### Features

* **do:** archive trimmed changelog rows to R2 ([#507](https://github.com/anolilab/lunora/issues/507)) ([9daef2e](https://github.com/anolilab/lunora/commit/9daef2eb4b4fa2ec7163390e3155c32d5e814294))


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.94
* **@lunora/platform:** upgraded to 1.0.0-alpha.19
* **@lunora/queue:** upgraded to 1.0.0-alpha.36
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.96
* **@lunora/do:** upgraded to 1.0.0-alpha.106
* **@lunora/platform-cloudflare:** upgraded to 1.0.0-alpha.24
* **@lunora/runtime:** upgraded to 1.0.0-alpha.78
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.44
* **@lunora/storage:** upgraded to 1.0.0-alpha.41

## @lunora/platform-node [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/@lunora/platform-node@1.0.0-alpha.31...@lunora/platform-node@1.0.0-alpha.32) (2026-08-27)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.93
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.95
* **@lunora/do:** upgraded to 1.0.0-alpha.105
* **@lunora/runtime:** upgraded to 1.0.0-alpha.77
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.43
* **@lunora/storage:** upgraded to 1.0.0-alpha.40

## @lunora/platform-node [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/@lunora/platform-node@1.0.0-alpha.30...@lunora/platform-node@1.0.0-alpha.31) (2026-08-27)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.92
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.94
* **@lunora/do:** upgraded to 1.0.0-alpha.103
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.42

## @lunora/platform-node [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/@lunora/platform-node@1.0.0-alpha.29...@lunora/platform-node@1.0.0-alpha.30) (2026-08-26)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.91
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.93
* **@lunora/do:** upgraded to 1.0.0-alpha.102
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.41

## @lunora/platform-node [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/@lunora/platform-node@1.0.0-alpha.28...@lunora/platform-node@1.0.0-alpha.29) (2026-08-26)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.90
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.92
* **@lunora/workflow:** upgraded to 1.0.0-alpha.35
* **@lunora/do:** upgraded to 1.0.0-alpha.101
* **@lunora/runtime:** upgraded to 1.0.0-alpha.76
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.40

## @lunora/platform-node [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/@lunora/platform-node@1.0.0-alpha.27...@lunora/platform-node@1.0.0-alpha.28) (2026-08-26)


### Dependencies

* **@lunora/workflow:** upgraded to 1.0.0-alpha.34

## @lunora/platform-node [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/@lunora/platform-node@1.0.0-alpha.26...@lunora/platform-node@1.0.0-alpha.27) (2026-08-26)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.89
* **@lunora/errors:** upgraded to 1.0.0-alpha.24
* **@lunora/platform:** upgraded to 1.0.0-alpha.18
* **@lunora/queue:** upgraded to 1.0.0-alpha.35
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.91
* **@lunora/workflow:** upgraded to 1.0.0-alpha.33
* **@lunora/do:** upgraded to 1.0.0-alpha.100
* **@lunora/platform-cloudflare:** upgraded to 1.0.0-alpha.23
* **@lunora/runtime:** upgraded to 1.0.0-alpha.75
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.39
* **@lunora/storage:** upgraded to 1.0.0-alpha.38

## @lunora/platform-node [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/@lunora/platform-node@1.0.0-alpha.25...@lunora/platform-node@1.0.0-alpha.26) (2026-08-26)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.88
* **@lunora/errors:** upgraded to 1.0.0-alpha.23
* **@lunora/queue:** upgraded to 1.0.0-alpha.34
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.90
* **@lunora/workflow:** upgraded to 1.0.0-alpha.32
* **@lunora/do:** upgraded to 1.0.0-alpha.99
* **@lunora/platform-cloudflare:** upgraded to 1.0.0-alpha.22
* **@lunora/runtime:** upgraded to 1.0.0-alpha.74
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.38
* **@lunora/storage:** upgraded to 1.0.0-alpha.37

## @lunora/platform-node [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/@lunora/platform-node@1.0.0-alpha.24...@lunora/platform-node@1.0.0-alpha.25) (2026-08-25)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.87
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.89
* **@lunora/do:** upgraded to 1.0.0-alpha.98
* **@lunora/runtime:** upgraded to 1.0.0-alpha.73
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.37

## @lunora/platform-node [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/@lunora/platform-node@1.0.0-alpha.23...@lunora/platform-node@1.0.0-alpha.24) (2026-08-25)

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

* **@lunora/d1:** upgraded to 1.0.0-alpha.86
* **@lunora/platform:** upgraded to 1.0.0-alpha.17
* **@lunora/queue:** upgraded to 1.0.0-alpha.33
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.88
* **@lunora/do:** upgraded to 1.0.0-alpha.97
* **@lunora/platform-cloudflare:** upgraded to 1.0.0-alpha.21
* **@lunora/runtime:** upgraded to 1.0.0-alpha.72
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.36
* **@lunora/storage:** upgraded to 1.0.0-alpha.36

## @lunora/platform-node [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/@lunora/platform-node@1.0.0-alpha.22...@lunora/platform-node@1.0.0-alpha.23) (2026-08-25)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.85
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.87
* **@lunora/do:** upgraded to 1.0.0-alpha.96
* **@lunora/runtime:** upgraded to 1.0.0-alpha.71
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.35

## @lunora/platform-node [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/@lunora/platform-node@1.0.0-alpha.21...@lunora/platform-node@1.0.0-alpha.22) (2026-08-24)

### Bug Fixes

* **bindings:** gate ctx.images, bound sql fetches ([#448](https://github.com/anolilab/lunora/issues/448)) ([a6bf09e](https://github.com/anolilab/lunora/commit/a6bf09e0d1348af5deda061d63164cc47a9059e9))


### Dependencies

* **@lunora/workflow:** upgraded to 1.0.0-alpha.31
* **@lunora/do:** upgraded to 1.0.0-alpha.95
* **@lunora/runtime:** upgraded to 1.0.0-alpha.70
* **@lunora/storage:** upgraded to 1.0.0-alpha.35

## @lunora/platform-node [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/@lunora/platform-node@1.0.0-alpha.20...@lunora/platform-node@1.0.0-alpha.21) (2026-08-24)


### Dependencies

* **@lunora/queue:** upgraded to 1.0.0-alpha.32
* **@lunora/do:** upgraded to 1.0.0-alpha.94

## @lunora/platform-node [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/@lunora/platform-node@1.0.0-alpha.19...@lunora/platform-node@1.0.0-alpha.20) (2026-08-23)

### Features

* **server:** close all four Convex primitive gaps — _commitSeq, untracked runQuery, .memory() + onShardInit, onQueryChange reactors ([#469](https://github.com/anolilab/lunora/issues/469)) ([75b0187](https://github.com/anolilab/lunora/commit/75b01872c06ae32f0174d2cc8385e78e373d9693))


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.84
* **@lunora/platform:** upgraded to 1.0.0-alpha.15
* **@lunora/queue:** upgraded to 1.0.0-alpha.31
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.86
* **@lunora/do:** upgraded to 1.0.0-alpha.93
* **@lunora/platform-cloudflare:** upgraded to 1.0.0-alpha.20
* **@lunora/runtime:** upgraded to 1.0.0-alpha.69
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.34
* **@lunora/storage:** upgraded to 1.0.0-alpha.34

## @lunora/platform-node [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/@lunora/platform-node@1.0.0-alpha.18...@lunora/platform-node@1.0.0-alpha.19) (2026-08-21)

### Bug Fixes

* **platform-node:** index sockets by raw handle ([#465](https://github.com/anolilab/lunora/issues/465)) ([eb2968e](https://github.com/anolilab/lunora/commit/eb2968eae2b4826419fba497a8e742453c071aac))


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.83
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.85
* **@lunora/do:** upgraded to 1.0.0-alpha.92
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.33

## @lunora/platform-node [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-node%401.0.0-alpha.17...%40lunora%2Fplatform-node%401.0.0-alpha.18) (2026-08-19)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.82
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.84
* **@lunora/do:** upgraded to 1.0.0-alpha.91
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.32

## @lunora/platform-node [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-node%401.0.0-alpha.16...%40lunora%2Fplatform-node%401.0.0-alpha.17) (2026-08-18)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.81
* **@lunora/platform:** upgraded to 1.0.0-alpha.14
* **@lunora/queue:** upgraded to 1.0.0-alpha.30
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.83
* **@lunora/do:** upgraded to 1.0.0-alpha.90
* **@lunora/platform-cloudflare:** upgraded to 1.0.0-alpha.19
* **@lunora/runtime:** upgraded to 1.0.0-alpha.67
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.31
* **@lunora/storage:** upgraded to 1.0.0-alpha.33

## @lunora/platform-node [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-node%401.0.0-alpha.15...%40lunora%2Fplatform-node%401.0.0-alpha.16) (2026-08-18)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.80
* **@lunora/platform:** upgraded to 1.0.0-alpha.13
* **@lunora/queue:** upgraded to 1.0.0-alpha.29
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.82
* **@lunora/do:** upgraded to 1.0.0-alpha.89
* **@lunora/platform-cloudflare:** upgraded to 1.0.0-alpha.18
* **@lunora/runtime:** upgraded to 1.0.0-alpha.66
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.30
* **@lunora/storage:** upgraded to 1.0.0-alpha.32

## @lunora/platform-node [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-node%401.0.0-alpha.14...%40lunora%2Fplatform-node%401.0.0-alpha.15) (2026-08-18)


### Dependencies

* **@lunora/workflow:** upgraded to 1.0.0-alpha.30

## @lunora/platform-node [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-node%401.0.0-alpha.13...%40lunora%2Fplatform-node%401.0.0-alpha.14) (2026-08-15)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.79
* **@lunora/platform:** upgraded to 1.0.0-alpha.12
* **@lunora/queue:** upgraded to 1.0.0-alpha.28
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.81
* **@lunora/do:** upgraded to 1.0.0-alpha.88
* **@lunora/platform-cloudflare:** upgraded to 1.0.0-alpha.17
* **@lunora/runtime:** upgraded to 1.0.0-alpha.65
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.29
* **@lunora/storage:** upgraded to 1.0.0-alpha.31

## @lunora/platform-node [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-node%401.0.0-alpha.12...%40lunora%2Fplatform-node%401.0.0-alpha.13) (2026-08-14)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.78
* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/platform:** upgraded to 1.0.0-alpha.11
* **@lunora/queue:** upgraded to 1.0.0-alpha.27
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.80
* **@lunora/workflow:** upgraded to 1.0.0-alpha.29
* **@lunora/do:** upgraded to 1.0.0-alpha.86
* **@lunora/platform-cloudflare:** upgraded to 1.0.0-alpha.16
* **@lunora/runtime:** upgraded to 1.0.0-alpha.63
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.28
* **@lunora/storage:** upgraded to 1.0.0-alpha.30

## @lunora/platform-node [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-node%401.0.0-alpha.11...%40lunora%2Fplatform-node%401.0.0-alpha.12) (2026-08-12)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.85
* **@lunora/storage:** upgraded to 1.0.0-alpha.29

## @lunora/platform-node [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-node%401.0.0-alpha.10...%40lunora%2Fplatform-node%401.0.0-alpha.11) (2026-08-11)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.77
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.79
* **@lunora/workflow:** upgraded to 1.0.0-alpha.28
* **@lunora/do:** upgraded to 1.0.0-alpha.84
* **@lunora/runtime:** upgraded to 1.0.0-alpha.62
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.27

## @lunora/platform-node [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-node%401.0.0-alpha.9...%40lunora%2Fplatform-node%401.0.0-alpha.10) (2026-08-11)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.76
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.78
* **@lunora/do:** upgraded to 1.0.0-alpha.83
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.26

## @lunora/platform-node [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-node%401.0.0-alpha.8...%40lunora%2Fplatform-node%401.0.0-alpha.9) (2026-08-11)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.75
* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/platform:** upgraded to 1.0.0-alpha.10
* **@lunora/queue:** upgraded to 1.0.0-alpha.26
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.77
* **@lunora/workflow:** upgraded to 1.0.0-alpha.27
* **@lunora/do:** upgraded to 1.0.0-alpha.82
* **@lunora/platform-cloudflare:** upgraded to 1.0.0-alpha.15
* **@lunora/runtime:** upgraded to 1.0.0-alpha.61
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.25
* **@lunora/storage:** upgraded to 1.0.0-alpha.28

## @lunora/platform-node [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-node%401.0.0-alpha.7...%40lunora%2Fplatform-node%401.0.0-alpha.8) (2026-08-11)

## @lunora/platform-node [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-node%401.0.0-alpha.6...%40lunora%2Fplatform-node%401.0.0-alpha.7) (2026-08-10)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.74
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.76
* **@lunora/do:** upgraded to 1.0.0-alpha.81
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.24

## @lunora/platform-node [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-node%401.0.0-alpha.5...%40lunora%2Fplatform-node%401.0.0-alpha.6) (2026-08-10)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.73
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.75
* **@lunora/do:** upgraded to 1.0.0-alpha.80
* **@lunora/runtime:** upgraded to 1.0.0-alpha.60
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.23

## @lunora/platform-node [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-node%401.0.0-alpha.4...%40lunora%2Fplatform-node%401.0.0-alpha.5) (2026-08-09)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.72
* **@lunora/errors:** upgraded to 1.0.0-alpha.18
* **@lunora/queue:** upgraded to 1.0.0-alpha.23
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.74
* **@lunora/workflow:** upgraded to 1.0.0-alpha.25
* **@lunora/do:** upgraded to 1.0.0-alpha.79
* **@lunora/platform-cloudflare:** upgraded to 1.0.0-alpha.12
* **@lunora/runtime:** upgraded to 1.0.0-alpha.59
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.20
* **@lunora/storage:** upgraded to 1.0.0-alpha.25

## @lunora/platform-node [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-node%401.0.0-alpha.3...%40lunora%2Fplatform-node%401.0.0-alpha.4) (2026-08-09)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.71
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.73
* **@lunora/do:** upgraded to 1.0.0-alpha.77
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.19

## @lunora/platform-node [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-node%401.0.0-alpha.2...%40lunora%2Fplatform-node%401.0.0-alpha.3) (2026-08-09)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.70
* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/platform:** upgraded to 1.0.0-alpha.8
* **@lunora/queue:** upgraded to 1.0.0-alpha.22
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.72
* **@lunora/workflow:** upgraded to 1.0.0-alpha.24
* **@lunora/do:** upgraded to 1.0.0-alpha.76
* **@lunora/platform-cloudflare:** upgraded to 1.0.0-alpha.11
* **@lunora/runtime:** upgraded to 1.0.0-alpha.58
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.18
* **@lunora/storage:** upgraded to 1.0.0-alpha.24

## @lunora/platform-node [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-node%401.0.0-alpha.1...%40lunora%2Fplatform-node%401.0.0-alpha.2) (2026-08-08)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.69
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.71
* **@lunora/do:** upgraded to 1.0.0-alpha.75
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.17

## @lunora/platform-node 1.0.0-alpha.1 (2026-08-07)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.68
* **@lunora/platform:** upgraded to 1.0.0-alpha.7
* **@lunora/queue:** upgraded to 1.0.0-alpha.21
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.70
* **@lunora/do:** upgraded to 1.0.0-alpha.73
* **@lunora/platform-cloudflare:** upgraded to 1.0.0-alpha.10
* **@lunora/runtime:** upgraded to 1.0.0-alpha.57
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.16
* **@lunora/storage:** upgraded to 1.0.0-alpha.23
