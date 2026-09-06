## @lunora/x402 [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.54...@lunora/x402@1.0.0-alpha.55) (2026-09-06)

### Bug Fixes

* **agent,ai,ratelimit,x402:** point prettier at the repo ignore file ([#638](https://github.com/anolilab/lunora/issues/638)) ([bf2a8e7](https://github.com/anolilab/lunora/commit/bf2a8e7e50019149ddf3a50f38adbb91f6e0351b))

## @lunora/x402 [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.53...@lunora/x402@1.0.0-alpha.54) (2026-09-06)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.34

## @lunora/x402 [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.52...@lunora/x402@1.0.0-alpha.53) (2026-09-06)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.33

## @lunora/x402 [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.51...@lunora/x402@1.0.0-alpha.52) (2026-09-05)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.32

## @lunora/x402 [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.50...@lunora/x402@1.0.0-alpha.51) (2026-09-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.31

## @lunora/x402 [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.49...@lunora/x402@1.0.0-alpha.50) (2026-09-03)

### Bug Fixes

* audit rounds 14-16 ([#586](https://github.com/anolilab/lunora/issues/586)) ([6a09b74](https://github.com/anolilab/lunora/commit/6a09b746cfc9fb36f451c208b7a1c3eac16e56f4))

## @lunora/x402 [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.48...@lunora/x402@1.0.0-alpha.49) (2026-09-03)

### ⚠ BREAKING CHANGES

* 34 public API changes across mail, storage, payment, replica,
studio, workflow, agent, codegen, cli and the shard runtime. The full list is in

### Bug Fixes

* audit rounds 7-11 ([#579](https://github.com/anolilab/lunora/issues/579)) ([224a42a](https://github.com/anolilab/lunora/commit/224a42a741f524e0110da55917c79fd08c90a885))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.30

## @lunora/x402 [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.47...@lunora/x402@1.0.0-alpha.48) (2026-09-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.29

## @lunora/x402 [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.46...@lunora/x402@1.0.0-alpha.47) (2026-09-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.28

## @lunora/x402 [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.45...@lunora/x402@1.0.0-alpha.46) (2026-09-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.27

## @lunora/x402 [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.44...@lunora/x402@1.0.0-alpha.45) (2026-08-31)

### Bug Fixes

* close the silent-success class across all 55 packages ([#536](https://github.com/anolilab/lunora/issues/536)) ([dad6b74](https://github.com/anolilab/lunora/commit/dad6b74b79dd336b13f0b922a6ab32d3345c9657))

## @lunora/x402 [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.43...@lunora/x402@1.0.0-alpha.44) (2026-08-29)

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

* **@lunora/errors:** upgraded to 1.0.0-alpha.26

## @lunora/x402 [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.42...@lunora/x402@1.0.0-alpha.43) (2026-08-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.25

## @lunora/x402 [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.41...@lunora/x402@1.0.0-alpha.42) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.24

## @lunora/x402 [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.40...@lunora/x402@1.0.0-alpha.41) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.23

## @lunora/x402 [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.39...@lunora/x402@1.0.0-alpha.40) (2026-08-25)

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

## @lunora/x402 [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.38...@lunora/x402@1.0.0-alpha.39) (2026-08-23)

### ⚠ BREAKING CHANGES

* **x402:** consumers must now install the peer(s) for their
chain family — @x402/evm + viem for EVM networks, @x402/svm +
@solana/kit for Solana (pre-1.0 alpha install-shape change).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(x402): only blame the peer when it is missing

The optional-peer guards caught every dynamic-import failure and
reported "install the peer", so an installed-but-broken toolchain
(runtime incompatibility, bad transitive dep, a throw at evaluation
time) named the wrong cause and lost the original error. Extract one
importOptionalPeer helper that matches module-not-found by error code
or message — walking the cause chain, since loaders wrap it — rethrows
everything else untouched, and attaches the original as cause. All
seven guards, including the pre-existing CDP one, route through it.

resolveEvmAccount now returns the structural ClientEvmSigner instead
of viem's PrivateKeyAccount, keeping viem out of the published
declarations so consumers without the peer can still type-check.
README documents which peers each network family needs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

### Bug Fixes

* **x402:** parse release amounts, slim deps ([#436](https://github.com/anolilab/lunora/issues/436)) ([2daa83c](https://github.com/anolilab/lunora/commit/2daa83c225fcd0c5a60b0d1a636bd753113b6860))

### Build System

* migrate to @cloudflare/vitest-plugin v1 ([#470](https://github.com/anolilab/lunora/issues/470)) ([05c4937](https://github.com/anolilab/lunora/commit/05c49371c30d65907eec8719f27a117f9bcaaefc))

## @lunora/x402 [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.37...%40lunora%2Fx402%401.0.0-alpha.38) (2026-08-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.22

## @lunora/x402 [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.36...%40lunora%2Fx402%401.0.0-alpha.37) (2026-08-12)

## @lunora/x402 [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.35...%40lunora%2Fx402%401.0.0-alpha.36) (2026-08-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.21

## @lunora/x402 [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.34...%40lunora%2Fx402%401.0.0-alpha.35) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.20

## @lunora/x402 [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.33...%40lunora%2Fx402%401.0.0-alpha.34) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.18

## @lunora/x402 [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.32...%40lunora%2Fx402%401.0.0-alpha.33) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.17

## @lunora/x402 [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.31...%40lunora%2Fx402%401.0.0-alpha.32) (2026-08-07)

## @lunora/x402 [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.30...%40lunora%2Fx402%401.0.0-alpha.31) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.16

## @lunora/x402 [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.29...%40lunora%2Fx402%401.0.0-alpha.30) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.15

## @lunora/x402 [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.28...%40lunora%2Fx402%401.0.0-alpha.29) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.14

## @lunora/x402 [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.27...%40lunora%2Fx402%401.0.0-alpha.28) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.13

## @lunora/x402 [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.26...%40lunora%2Fx402%401.0.0-alpha.27) (2026-08-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.12

## @lunora/x402 [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.25...%40lunora%2Fx402%401.0.0-alpha.26) (2026-08-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.11

## @lunora/x402 [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.24...%40lunora%2Fx402%401.0.0-alpha.25) (2026-07-31)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.10

## @lunora/x402 [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.23...%40lunora%2Fx402%401.0.0-alpha.24) (2026-07-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.9

## @lunora/x402 [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.22...%40lunora%2Fx402%401.0.0-alpha.23) (2026-07-28)

## @lunora/x402 [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.21...%40lunora%2Fx402%401.0.0-alpha.22) (2026-07-27)

## @lunora/x402 [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.20...%40lunora%2Fx402%401.0.0-alpha.21) (2026-07-27)

## @lunora/x402 [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.19...%40lunora%2Fx402%401.0.0-alpha.20) (2026-07-27)

## @lunora/x402 [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.18...%40lunora%2Fx402%401.0.0-alpha.19) (2026-07-27)

## @lunora/x402 [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.17...%40lunora%2Fx402%401.0.0-alpha.18) (2026-07-27)

## @lunora/x402 [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.16...%40lunora%2Fx402%401.0.0-alpha.17) (2026-07-27)

## @lunora/x402 [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.15...%40lunora%2Fx402%401.0.0-alpha.16) (2026-07-27)

## @lunora/x402 [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.14...%40lunora%2Fx402%401.0.0-alpha.15) (2026-07-27)

## @lunora/x402 [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.13...%40lunora%2Fx402%401.0.0-alpha.14) (2026-07-27)

## @lunora/x402 [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.12...%40lunora%2Fx402%401.0.0-alpha.13) (2026-07-26)

## @lunora/x402 [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.11...%40lunora%2Fx402%401.0.0-alpha.12) (2026-07-26)

## @lunora/x402 [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.10...%40lunora%2Fx402%401.0.0-alpha.11) (2026-07-26)

## @lunora/x402 [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.9...%40lunora%2Fx402%401.0.0-alpha.10) (2026-07-26)

## @lunora/x402 [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.8...%40lunora%2Fx402%401.0.0-alpha.9) (2026-07-26)

## @lunora/x402 [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.7...%40lunora%2Fx402%401.0.0-alpha.8) (2026-07-26)

## @lunora/x402 [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.6...%40lunora%2Fx402%401.0.0-alpha.7) (2026-07-25)

## @lunora/x402 [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.5...%40lunora%2Fx402%401.0.0-alpha.6) (2026-07-25)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.8

## @lunora/x402 [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.4...%40lunora%2Fx402%401.0.0-alpha.5) (2026-07-20)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.6

## @lunora/x402 [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.3...%40lunora%2Fx402%401.0.0-alpha.4) (2026-07-19)

## @lunora/x402 [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.2...%40lunora%2Fx402%401.0.0-alpha.3) (2026-07-17)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.5

## @lunora/x402 [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.1...%40lunora%2Fx402%401.0.0-alpha.2) (2026-07-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.4

## @lunora/x402 1.0.0-alpha.1 (2026-07-10)
