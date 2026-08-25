## @lunora/server [1.0.0-alpha.81](https://github.com/anolilab/lunora/compare/@lunora/server@1.0.0-alpha.80...@lunora/server@1.0.0-alpha.81) (2026-08-25)

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
* **server:** previously-accepted `contains` on non-string filter
columns is no longer honoured. Consistent with the module's allow-list
mechanism (v.object strips undeclared keys), the key is stripped/dropped
rather than rejected with a validation error — the predicate never
reaches the SQL compiler. Alpha branch, no back-compat shim.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(server): redact camelCase and lowercase secret keys

redactSecrets' keyed-value pass matched any identifier key but tested it
against an uppercase-only suffix regex, so exactly the spellings that
appear in request bodies and thrown errors (password, apiToken,
authSecret) fell through unredacted unless the value happened to hit a
prefix or entropy heuristic.

The suffix regex now matches key/password/secret/token as a real word in
SCREAMING_SNAKE, lower snake/bare, or camelCase form, with a boundary so
MONKEY/monkey/donkey (suffix mid-word) no longer match — the old regex
redacted MONKEY=..., a false positive the boundary removes rather than
extends. Camel-hump keys like sortKey are deliberate over-redaction.

The duplicated regex in @lunora/config's .dev.vars scaffolder (and its
test mirror) is kept byte-identical per the existing cross-reference
comment.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* docs(server): pin storageRules getUrl sync contract

getUrl is the only synchronous member of the storageRules guarded
surface; the wrapping loop's untyped (unknown) return would let a future
async/await refactor silently turn ctx.storage.getUrl into a Promise for
guarded procedures only. Document the invariant at the declaration and
pin it with a test asserting the wrapped call returns a plain string,
not a thenable. No behaviour change.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* perf(server): bound presence reads and self-reap

listPresent collected every row a room had ever accumulated (the TTL is
a read-time filter that hides stale rows but never deletes them) and the
sweep is an internal mutation nothing schedules by default, so an app
that skipped wiring a cron degraded as O(live-set x historical-rows) per
TTL window — on the hottest query in the module, re-run for every
subscriber on every heartbeat.

Two local fixes:
- a (roomId, lastSeen) index and a maxMembers option (default 512):
  listPresent now reads newest-first with a hard cap, so cost scales
  with the cap, not with rows ever written; the in-memory sort is gone
  since index order already delivers newest-first.
- the heartbeat opportunistically reaps up to 8 of its room's oldest
  rows per beat, using a cutoff a full max(grace, ttl) window behind the
  visibility cutoff so a row the read filter could still show — or a
  grace-window reconnect could revive — is never deleted. Active rooms
  self-clean; sweep remains as optional bulk hardening.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(server): unify the secret-key rule in shared/

Four copies of the "does this key name imply a secret" regex existed —
the runtime redactor, the .dev.vars scaffolder, `lunora deploy`'s
required-secret resolver and `lunora doctor` — kept in step only by a
comment. Two had just been updated for camelCase keys and two had not,
so `apiToken` in a .dev.vars was a secret to the runtime and ordinary
config to the CLI.

They are now one definition in shared/secret-key.ts (zero-dep,
bundler-inlined, so no dependency edge between the app runtime and the
CLI/config layer).

The rule also fixes a regression the boundary-based regex introduced:
requiring `^`/`_`/`-` immediately before the suffix silently stopped
matching no-separator compounds the original caught — OPENAI_APIKEY,
APITOKEN, MYPASSWORD, AUTHSECRET — leaving a short or low-entropy secret
under one of those names unredacted in logs and unminted by the
scaffolder. Matching is now a plain case-insensitive suffix, which also
picks up the Title-case and kebab spellings (Api_Key, Auth-Token) the
previous doc claimed to cover.

MONKEY/monkey/donkey stay excluded by an explicit word list rather than
a boundary rule: MONKEY and APIKEY are structurally identical, so no
positional rule can separate them, and the word list is the only honest
way to keep both properties.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(server): treat enum columns as string filter columns

Gating `contains` on `validator.kind` alone judged an enum column —
`v.union(v.literal("open"), v.literal("closed"))`, kind "union" — and a
bare `v.literal("x")` as non-string, so the operator was omitted from
the generated validator. Because `v.object` strips an undeclared key and
an emptied predicate is dropped, `?where[status][contains]=ope` against
an enum column silently returned the UNFILTERED set rather than failing
— a silent widening wherever a list filter is doing the scoping.

A union now counts as string-typed when every member is (v.null()
members are transparent, so a nullable string union qualifies); a mixed
union still refuses, since `contains` would otherwise reach non-string
values.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(server): name the presence cap for sessions, not members

The bounded `listPresent` read caps SESSION ROWS — one per (roomId,
sessionId), so one per open tab — but the option was called maxMembers
and documented as a member cap, and the multi-tab dedup runs after the
read. A 300-person room at two tabs each is 600 rows, so the 512 default
silently truncated ~90 live, currently-heartbeating users out of "who's
here" where the previous unbounded read was complete.

Renamed to `maxSessions`, documented as a session cap to be sized
against expected tabs, and the default raised to 1024. A non-finite
value now falls back to the default instead of reaching the reader as
`LIMIT NaN` (Math.max(1, Math.floor(NaN)) is NaN).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(server): redact any key ending in a secret suffix

The word list excluding ordinary "-key" words (MONKEY, DONKEY, …) is
gone. It never delivered the property it claimed — turnkey, hokey,
lowkey and smokey all end in "key" and were absent, so the list bought
the appearance of precision and none of it, while being unbounded and
unjustifiable to the next reader.

MONKEY and APIKEY are structurally identical, so the only question is
which way to fail. For a redactor over log and error text, over-
redaction is the safe direction: masking a variable named MONKEY costs
one confusing log line, missing APITOKEN costs the credential. The
JSDoc now states that as the deliberate trade, and the tests assert
MONKEY/monkey/sortKey ARE redacted.

The one consumer that writes rather than logs is safe under over-
matching too: the .dev.vars scaffolder mints a value only where the
example held a placeholder, so an over-match fills a placeholder the
user had to fill anyway and never overwrites a real value.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* test(server): suppress the redaction fixture on the secret scanner

`MYPASSWORD=abc` is an input to a redaction assertion, not a credential, but
the scanner reads the assignment shape and fails the Secrets job. Marked with
`gitleaks:allow` the same way the other redaction and column-name fixtures in
this repo are.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016xX4FTtqmhWH97TomT8uww

### Features

* **runtime:** store the declared REST cache policy at the edge ([#476](https://github.com/anolilab/lunora/issues/476)) ([9ababee](https://github.com/anolilab/lunora/commit/9ababeebc68cd74adfef5d923cfa9e1d70f0f690))

### Bug Fixes

* **server:** harden validation, presence, filters ([#441](https://github.com/anolilab/lunora/issues/441)) ([ca46d51](https://github.com/anolilab/lunora/commit/ca46d510a3f865df6ed547b4b9521ac625e055a3))


### Dependencies

* **@lunora/scheduler:** upgraded to 1.0.0-alpha.37

## @lunora/server [1.0.0-alpha.80](https://github.com/anolilab/lunora/compare/@lunora/server@1.0.0-alpha.79...@lunora/server@1.0.0-alpha.80) (2026-08-24)


### Dependencies

* **@lunora/scheduler:** upgraded to 1.0.0-alpha.36

## @lunora/server [1.0.0-alpha.79](https://github.com/anolilab/lunora/compare/@lunora/server@1.0.0-alpha.78...@lunora/server@1.0.0-alpha.79) (2026-08-23)

### Features

* **server:** close all four Convex primitive gaps — _commitSeq, untracked runQuery, .memory() + onShardInit, onQueryChange reactors ([#469](https://github.com/anolilab/lunora/issues/469)) ([75b0187](https://github.com/anolilab/lunora/commit/75b01872c06ae32f0174d2cc8385e78e373d9693))


### Dependencies

* **@lunora/scheduler:** upgraded to 1.0.0-alpha.35

## @lunora/server [1.0.0-alpha.78](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.77...%40lunora%2Fserver%401.0.0-alpha.78) (2026-08-18)


### Dependencies

* **@lunora/scheduler:** upgraded to 1.0.0-alpha.34

## @lunora/server [1.0.0-alpha.77](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.76...%40lunora%2Fserver%401.0.0-alpha.77) (2026-08-18)


### Dependencies

* **@lunora/scheduler:** upgraded to 1.0.0-alpha.33

## @lunora/server [1.0.0-alpha.76](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.75...%40lunora%2Fserver%401.0.0-alpha.76) (2026-08-18)

## @lunora/server [1.0.0-alpha.75](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.74...%40lunora%2Fserver%401.0.0-alpha.75) (2026-08-15)


### Dependencies

* **@lunora/scheduler:** upgraded to 1.0.0-alpha.32

## @lunora/server [1.0.0-alpha.74](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.73...%40lunora%2Fserver%401.0.0-alpha.74) (2026-08-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.31
* **@lunora/values:** upgraded to 1.0.0-alpha.27

## @lunora/server [1.0.0-alpha.73](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.72...%40lunora%2Fserver%401.0.0-alpha.73) (2026-08-12)

## @lunora/server [1.0.0-alpha.72](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.71...%40lunora%2Fserver%401.0.0-alpha.72) (2026-08-11)


### Dependencies

* **@lunora/scheduler:** upgraded to 1.0.0-alpha.30

## @lunora/server [1.0.0-alpha.71](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.70...%40lunora%2Fserver%401.0.0-alpha.71) (2026-08-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.29
* **@lunora/values:** upgraded to 1.0.0-alpha.26

## @lunora/server [1.0.0-alpha.70](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.69...%40lunora%2Fserver%401.0.0-alpha.70) (2026-08-10)

## @lunora/server [1.0.0-alpha.69](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.68...%40lunora%2Fserver%401.0.0-alpha.69) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.20
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.28
* **@lunora/values:** upgraded to 1.0.0-alpha.25

## @lunora/server [1.0.0-alpha.68](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.67...%40lunora%2Fserver%401.0.0-alpha.68) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.18
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.26
* **@lunora/values:** upgraded to 1.0.0-alpha.23

## @lunora/server [1.0.0-alpha.67](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.66...%40lunora%2Fserver%401.0.0-alpha.67) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.25
* **@lunora/values:** upgraded to 1.0.0-alpha.22

## @lunora/server [1.0.0-alpha.66](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.65...%40lunora%2Fserver%401.0.0-alpha.66) (2026-08-07)


### Dependencies

* **@lunora/scheduler:** upgraded to 1.0.0-alpha.24

## @lunora/server [1.0.0-alpha.65](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.64...%40lunora%2Fserver%401.0.0-alpha.65) (2026-08-07)

## @lunora/server [1.0.0-alpha.64](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.63...%40lunora%2Fserver%401.0.0-alpha.64) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.16
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.23
* **@lunora/values:** upgraded to 1.0.0-alpha.21

## @lunora/server [1.0.0-alpha.63](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.62...%40lunora%2Fserver%401.0.0-alpha.63) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.15
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.22
* **@lunora/values:** upgraded to 1.0.0-alpha.20

## @lunora/server [1.0.0-alpha.62](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.61...%40lunora%2Fserver%401.0.0-alpha.62) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.21
* **@lunora/values:** upgraded to 1.0.0-alpha.19

## @lunora/server [1.0.0-alpha.61](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.60...%40lunora%2Fserver%401.0.0-alpha.61) (2026-08-04)


### Dependencies

* **@lunora/values:** upgraded to 1.0.0-alpha.18

## @lunora/server [1.0.0-alpha.60](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.59...%40lunora%2Fserver%401.0.0-alpha.60) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.20
* **@lunora/values:** upgraded to 1.0.0-alpha.17

## @lunora/server [1.0.0-alpha.59](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.58...%40lunora%2Fserver%401.0.0-alpha.59) (2026-08-03)


### Dependencies

* **@lunora/values:** upgraded to 1.0.0-alpha.16

## @lunora/server [1.0.0-alpha.58](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.57...%40lunora%2Fserver%401.0.0-alpha.58) (2026-08-02)


### Dependencies

* **@lunora/scheduler:** upgraded to 1.0.0-alpha.19

## @lunora/server [1.0.0-alpha.57](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.56...%40lunora%2Fserver%401.0.0-alpha.57) (2026-08-02)

## @lunora/server [1.0.0-alpha.56](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.55...%40lunora%2Fserver%401.0.0-alpha.56) (2026-07-31)

## @lunora/server [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.54...%40lunora%2Fserver%401.0.0-alpha.55) (2026-07-31)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.10
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.16
* **@lunora/values:** upgraded to 1.0.0-alpha.13

## @lunora/server [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.53...%40lunora%2Fserver%401.0.0-alpha.54) (2026-07-31)


### Dependencies

* **@lunora/scheduler:** upgraded to 1.0.0-alpha.15

## @lunora/server [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.52...%40lunora%2Fserver%401.0.0-alpha.53) (2026-07-30)


### Dependencies

* **@lunora/scheduler:** upgraded to 1.0.0-alpha.14

## @lunora/server [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.51...%40lunora%2Fserver%401.0.0-alpha.52) (2026-07-30)

## @lunora/server [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.50...%40lunora%2Fserver%401.0.0-alpha.51) (2026-07-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.9
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.13
* **@lunora/values:** upgraded to 1.0.0-alpha.12

## @lunora/server [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.49...%40lunora%2Fserver%401.0.0-alpha.50) (2026-07-28)

## @lunora/server [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.48...%40lunora%2Fserver%401.0.0-alpha.49) (2026-07-27)

## @lunora/server [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.47...%40lunora%2Fserver%401.0.0-alpha.48) (2026-07-27)

## @lunora/server [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.46...%40lunora%2Fserver%401.0.0-alpha.47) (2026-07-27)

## @lunora/server [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.45...%40lunora%2Fserver%401.0.0-alpha.46) (2026-07-27)

## @lunora/server [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.44...%40lunora%2Fserver%401.0.0-alpha.45) (2026-07-27)

## @lunora/server [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.43...%40lunora%2Fserver%401.0.0-alpha.44) (2026-07-27)

## @lunora/server [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.42...%40lunora%2Fserver%401.0.0-alpha.43) (2026-07-27)

## @lunora/server [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.41...%40lunora%2Fserver%401.0.0-alpha.42) (2026-07-27)

## @lunora/server [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.40...%40lunora%2Fserver%401.0.0-alpha.41) (2026-07-27)

## @lunora/server [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.39...%40lunora%2Fserver%401.0.0-alpha.40) (2026-07-26)

## @lunora/server [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.38...%40lunora%2Fserver%401.0.0-alpha.39) (2026-07-26)

## @lunora/server [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.37...%40lunora%2Fserver%401.0.0-alpha.38) (2026-07-26)

## @lunora/server [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.36...%40lunora%2Fserver%401.0.0-alpha.37) (2026-07-26)

## @lunora/server [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.35...%40lunora%2Fserver%401.0.0-alpha.36) (2026-07-26)

## @lunora/server [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.34...%40lunora%2Fserver%401.0.0-alpha.35) (2026-07-26)

## @lunora/server [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.33...%40lunora%2Fserver%401.0.0-alpha.34) (2026-07-25)

## @lunora/server [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.32...%40lunora%2Fserver%401.0.0-alpha.33) (2026-07-25)

## @lunora/server [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.31...%40lunora%2Fserver%401.0.0-alpha.32) (2026-07-25)

## @lunora/server [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.30...%40lunora%2Fserver%401.0.0-alpha.31) (2026-07-25)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.8
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.12
* **@lunora/values:** upgraded to 1.0.0-alpha.11

## @lunora/server [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.29...%40lunora%2Fserver%401.0.0-alpha.30) (2026-07-23)


### Dependencies

* **@lunora/values:** upgraded to 1.0.0-alpha.10

## @lunora/server [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.28...%40lunora%2Fserver%401.0.0-alpha.29) (2026-07-21)

## @lunora/server [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.27...%40lunora%2Fserver%401.0.0-alpha.28) (2026-07-20)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.6
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.11
* **@lunora/values:** upgraded to 1.0.0-alpha.9

## @lunora/server [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.26...%40lunora%2Fserver%401.0.0-alpha.27) (2026-07-19)

## @lunora/server [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.25...%40lunora%2Fserver%401.0.0-alpha.26) (2026-07-18)

## @lunora/server [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.24...%40lunora%2Fserver%401.0.0-alpha.25) (2026-07-17)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.5
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.10
* **@lunora/values:** upgraded to 1.0.0-alpha.8

## @lunora/server [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.23...%40lunora%2Fserver%401.0.0-alpha.24) (2026-07-13)


### Dependencies

* **@lunora/scheduler:** upgraded to 1.0.0-alpha.9

## @lunora/server [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.22...%40lunora%2Fserver%401.0.0-alpha.23) (2026-07-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.4
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.8
* **@lunora/values:** upgraded to 1.0.0-alpha.7

## @lunora/server [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.21...%40lunora%2Fserver%401.0.0-alpha.22) (2026-07-10)

## @lunora/server [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.20...%40lunora%2Fserver%401.0.0-alpha.21) (2026-07-08)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.3
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.7
* **@lunora/values:** upgraded to 1.0.0-alpha.6

## @lunora/server [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.19...%40lunora%2Fserver%401.0.0-alpha.20) (2026-07-08)

## @lunora/server [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.18...%40lunora%2Fserver%401.0.0-alpha.19) (2026-07-07)

## @lunora/server [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.17...%40lunora%2Fserver%401.0.0-alpha.18) (2026-07-07)

## @lunora/server [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.16...%40lunora%2Fserver%401.0.0-alpha.17) (2026-07-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.2
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.6
* **@lunora/values:** upgraded to 1.0.0-alpha.5

## @lunora/server [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.15...%40lunora%2Fserver%401.0.0-alpha.16) (2026-07-04)

## @lunora/server [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.14...%40lunora%2Fserver%401.0.0-alpha.15) (2026-07-03)

## @lunora/server [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.13...%40lunora%2Fserver%401.0.0-alpha.14) (2026-07-03)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.1
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.5
* **@lunora/values:** upgraded to 1.0.0-alpha.4

## @lunora/server [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.12...%40lunora%2Fserver%401.0.0-alpha.13) (2026-07-03)

## @lunora/server [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.11...%40lunora%2Fserver%401.0.0-alpha.12) (2026-07-02)

## @lunora/server [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.10...%40lunora%2Fserver%401.0.0-alpha.11) (2026-07-02)

## @lunora/server [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.9...%40lunora%2Fserver%401.0.0-alpha.10) (2026-07-02)


### Dependencies

* **@lunora/scheduler:** upgraded to 1.0.0-alpha.4

## @lunora/server [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.8...%40lunora%2Fserver%401.0.0-alpha.9) (2026-07-02)

## @lunora/server [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.7...%40lunora%2Fserver%401.0.0-alpha.8) (2026-07-01)

## @lunora/server [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.6...%40lunora%2Fserver%401.0.0-alpha.7) (2026-06-30)

## @lunora/server [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Fserver%401.0.0-alpha.5...%40lunora%2Fserver%401.0.0-alpha.6) (2026-06-29)

## @lunora/server [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/@lunora/server@1.0.0-alpha.4...@lunora/server@1.0.0-alpha.5) (2026-06-27)

### Features

* **queue:** add queues, pipelines, secrets bindings + studio queues page ([#30](https://github.com/anolilab/lunora/issues/30)) ([131460c](https://github.com/anolilab/lunora/commit/131460c5826f2ef600fa0ef81248ede91835dd0c)), closes [#29](https://github.com/anolilab/lunora/issues/29) [#31](https://github.com/anolilab/lunora/issues/31) [visulima#714](https://github.com/visulima/visulima/issues/714)


### Dependencies

* **@lunora/scheduler:** upgraded to 1.0.0-alpha.3
* **@lunora/values:** upgraded to 1.0.0-alpha.3

## @lunora/server [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/@lunora/server@1.0.0-alpha.3...@lunora/server@1.0.0-alpha.4) (2026-06-27)

### Features

* **server:** pin durable objects to a data-residency jurisdiction ([#29](https://github.com/anolilab/lunora/issues/29)) ([0fcdc94](https://github.com/anolilab/lunora/commit/0fcdc94a836ea1b54a0eba78b6926de52aa3a767))


### Dependencies

* **@lunora/scheduler:** upgraded to 1.0.0-alpha.2

## @lunora/server [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/@lunora/server@1.0.0-alpha.2...@lunora/server@1.0.0-alpha.3) (2026-06-27)

### Features

* extending db  ([#32](https://github.com/anolilab/lunora/issues/32)) ([6b77a16](https://github.com/anolilab/lunora/commit/6b77a16996e6aa59c19c801c3ea18004deccd6dc))

### Performance Improvements

* **runtime:** skip route lookup when no custom routes ([#33](https://github.com/anolilab/lunora/issues/33)) ([e829b9b](https://github.com/anolilab/lunora/commit/e829b9b7d2a5c8a9f533f91706cdae8dd75b564d))

### Documentation

* document ctx.now across server, testing, and the docs site ([04db307](https://github.com/anolilab/lunora/commit/04db30703beee17a322ff5dd6251f8f954232dcb))

### Miscellaneous Chores

* update our og pacakge image ([63e6811](https://github.com/anolilab/lunora/commit/63e6811e2dfb94bc2cc38c05292b527e884660b5))


### Dependencies

* **@lunora/values:** upgraded to 1.0.0-alpha.2

## @lunora/server [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/server@1.0.0-alpha.1...@lunora/server@1.0.0-alpha.2) (2026-06-25)

### Features

* **server:** add deterministic ctx.now ([f17363e](https://github.com/anolilab/lunora/commit/f17363e4efc9164917bac46c41ffcdd26006dccb))

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))

### Code Refactoring

* remove dead code flagged by fallow ([be57eca](https://github.com/anolilab/lunora/commit/be57ecaf4d6f3bc95d7b1a5876305dfb2af80e45))

## @lunora/server 1.0.0-alpha.1 (2026-06-21)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Styles

* format source with prettier and ignore generated artifacts ([c63b52a](https://github.com/anolilab/lunora/commit/c63b52a05578b8476cf627babe246acd9730c0f9))

### Miscellaneous Chores

* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))


### Dependencies

* **@lunora/scheduler:** upgraded to 1.0.0-alpha.1
* **@lunora/values:** upgraded to 1.0.0-alpha.1
