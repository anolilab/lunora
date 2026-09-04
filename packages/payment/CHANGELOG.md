## @lunora/payment [1.0.0-alpha.104](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.103...@lunora/payment@1.0.0-alpha.104) (2026-09-04)

### ⚠ BREAKING CHANGES

* `MaterializerReducer` returns `S | typeof UNHANDLED` and `Materializer.apply`
returns a boolean. A reducer that signalled "not my event type" by returning the input state must
return `UNHANDLED`; returning the state now means "handled, nothing to do". `EventLogDO`'s
`GET /state` (and `EventLogDOClient.getState`) answers 413 past 1000 entries.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(codegen): withhold the vector wiring from the shard on a host with no vector store

The platform gate's `vectorStore` verdict reached `emitServer` and `emitApp` and not `emitShard`,
which recomputed the flag from `schema.vectorIndexes` instead. Running codegen for a target rating
`vectorStore: "unsupported"` produced a `generated.shard` byte-identical to the Cloudflare one — the
`@lunora/bindings/vectors` imports, the `createVectorSyncHook` write hook and `vectors` on the
runtime ctx all emitted — while the type surface was correctly withheld. `emitShard` now takes
`hasVectors` like its siblings, and the shard-key namespace fragment (with the `ROOT_SHARD_NAME`
import only it reads) is gated with it. `assertRequiredPackages` was a fourth consumer of the raw
count and hard-failed the build unless the app installed `@lunora/bindings` for an import the
emitted code no longer contains; it now takes the same verdict.

The regression test asserted one of the three emitters, which is how this shipped; it now asserts
all three, plus the required-package check and the sharded fragment.

Also closed, all the same class of a check that skips the caller it exists for:

- A `defineSchemaExtension` key was never validated on either path, and the package-runtime path
  validated no table names at all — so `defineSchemaExtension("rate-limit", …)` died in emit with an
  unlocated `INTERNAL` naming `rate-limit_buckets`, a table the user never typed. Both are checked
  now at the single point both paths namespace through, with a `file:line:column` diagnostic.
- `assertNoNamespaceCollisions` was fed functions and mutators only, so two `.stream()` route files
  sanitizing to one namespace emitted a duplicate key into both the `HttpStreamsRef` interface
  (TS2300) and its object literal (TS1117) — the exact failure the assert exists to name. It now
  runs once per emitted namespace space.
- Two `NODE_CAPABILITIES` notes asserted the opposite of the code they describe, in the matrix
  codegen trusts to decide whether an app can target a host: `objectStorage` claimed the bucket
  folds `A`/`a` into one object where the code percent-escapes `A-Z` to prevent exactly that, and
  `workflows` listed "terminate is not a barrier" as a gap where the host has a barrier, a guarded
  store, and a test named for it.
- `createNodePlatform` bound nothing for `globalTables`, the fourth `emulated`, gate-bearing
  capability beside queues / workflows / object storage — so an app with one `.global()` table
  passed codegen green and failed at the first global read with nothing upstream having warned. It
  composes `createNodeGlobalStore` from a `globalTablesPath` now, on the same declare-or-omit rule
  the bucket follows.
- The reference host supplied the one `SchedulerHost.cron` shape the contract forbids (declared and
  silently inert), and the TCK leg that would catch it skipped itself because it also keyed on
  `cronTicks`, which such a host never has.
* the host conformance suite now fails a host that declares `SchedulerHost.cron`
without a `cronTicks` observer instead of skipping the leg; a host with no dynamic cron must omit
the method, as the contract already required. `createReferenceHost` no longer implements `cron`.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(shard-engine): stop silent data loss on CDC replay, relay pokes and durable streams

Three defects on the data plane, each one a place where a write, a delivery or a
transcript went missing with no error anywhere.

CDC replay's `replace` fallback carried no table scope, so it fell back to
`locateRowById(id, undefined)` — a probe over every non-global table that rests
on ids being unique across tables. That premise is false for `.source()` tables:
`liftSourceId` sets `_id` to the upstream natural primary key, so two sourced
tables with `id serial` both own a row whose id is `"1"`, and an orders update
was written into the users row. This is the normal update path, not a corner —
the incremental tick emits `op: "insert"` for a changed existing row, the PK
collision maps to a ConflictError, and the catch takes the unscoped replace. The
delete and insert siblings in the same function already carried the table.

A relay's per-socket cohort memos lived only in an instance WeakMap while
`ShardDO` builds a fresh `RelayMember` on every wake and the hibernatable sockets
survive. One eviction — the steady state, since the keepalive answers pings from
the hibernation auto-response without waking the DO — emptied them, every socket
was skipped, and the relay still answered 204, so the owner advanced the cohort
frontier and no later poke could reopen the range. They are now durable in
`__lunora_relay_memos`, hydrated on a cold miss and dropped through the same
`releaseRelayShapes` hook that retires the owner's proxy registrations, the way
`__shape_poke_cursor` and `__lunora_relay_shapes` already are. Deliveries also
gate on `trySendFrame`'s boolean instead of discarding it: a memo advanced past
frames that never left froze that shape the same way, and over-counted the
fan-out metric.

A durable-stream run whose row a TTL sweep took mid-production orphaned every
chunk it appended afterwards — the sweep's chunk delete is scoped by a subselect
over the run table, so no future sweep could reach them — and because
`appendStreamChunk` is `INSERT OR IGNORE`, the next run under that key silently
inherited them at the colliding seqs. The terminal now reclaims the chunks when
its run row is gone, and a fresh claim clears the key before inserting. Sweeping
on every attach makes the mid-run window easier to hit, not harder.
* a relay DO's `RelayHost.sql()` is now load-bearing rather than
owner-only; the engine conformance suite drives it on the host under test, so a
host whose SQL cannot carry the memos fails the suite instead of silently
freezing its subscribers after the first wake.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(shard-engine)!: report an undelivered relay poke instead of pinning the memo

The relay's delivery gate held a socket's cohort memo back when `trySendFrame`
returned false, and answered 204 regardless. That inverts the repair it was
written for. `buildShapePoke` opens each range where the last one closed, so
consecutive pokes are `(A, B]` then `(B, C]` — a memo held at `A` is BEHIND the
next poke's base, `pokeAppliesToMemo` refuses it, and refuses every poke after
it. That is exactly the permanent silent freeze that rule's own docblock
describes, and the relay cannot self-heal out of it: the owner rewinds only on a
non-ok response, and the control channel returned `noContent()` for every poke.

The memo now advances for every socket the poke was applied to, the fan-out
metric counts only the sockets that took every frame, and a poke where those two
differ answers 503 with the counts — which is the signal `rewindShapeCursor`
already acts on, the same way it does for a POST that never landed. The frame
loop is `.map` before `.every`, matching the owner's local path: a short-circuit
emits a `pokeStart` with no `pokeEnd` and strands the client's buffer.

The durable memos move to `ctx-db-relay-memos.ts`, alongside their two siblings,
and hydrate ONCE PER WAKE into a `connectionId`-keyed map rather than lazily per
socket. The per-socket form issued one `WHERE connection_id = ?` per socket in a
single poke handler, on a tier that exists only past the promotion threshold and
whose evicted wake is the steady state. A targeted poke now filters by
`targetConnectionId` before hydrating anything at all.

`__lunora_relay_memos` rows were reclaimed only through `releaseRelayShapes`,
which runs from `webSocketClose` — never dispatched for a server-initiated close,
so an expired-credential drop leaked every row it held. A relay clears the table
when it loses its last socket, the one moment every remaining row is provably
dead.

Also: `ctx-db-relay-shapes`'s cost docblock claimed the relayed path was strictly
cheaper per subscriber, which stopped being true the moment a per-subscriber memo
row landed beside the cohort row; it now describes what the code does and records
the per-cohort question as open. `durable-stream`'s three copies of the chunk
delete are one `deleteStreamChunks`.
* `RelayLink.onShapePoke` returns `RelayPokeDelivery`
(`{ delivered, matched }`) rather than a bare delivered count, and a relay's
`relay_shape_poke` response is 503 rather than 204 when a matched socket did not
take the poke.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(sql-store)!: decode untyped bigint keys and key mirror rows by content

`sqliteEncode` keys off the runtime JS type, so a bigint written to a `v.any()` /
`v.union()` / `v.from()` column is stored as the same order-preserving key a declared
`v.bigint()` column gets — but `sqliteDecode` returned it verbatim, so the column read back
as 40 characters of padding. The min/max companion inherited that: `mayHoldBigintKey`
matched those kinds and folded them in JS, but the fold coerced the padded string to
`undefined`, so deleting a group's stored extreme left the companion on a stale value. Decode
through `decodeBigintSqlKey` instead, which fixes the round-trip and the fold in one place.

That test is by SHAPE — exactly 40 characters, `"0"` or `"1"` then 39 digits — so a stored
*string* of that shape reads back as a bigint. Preferred to the alternative, which is not "no
ambiguity" but guaranteed corruption of every bigint in every untyped column, on every read.
The unambiguous wire marker cannot carry it instead: `sqliteEncode` returns at its `bigint`
branch first, takes no column kind, and doubles as `serializeColumnValue`, so a second storage
form would never match a WHERE binding built from the first. The collision is pinned by a test.

The JS fold reads every surviving row of a group, and `mayHoldBigintKey` matches columns holding
no bigint at all (`v.union(v.number(), v.null())`), so one extreme-removing write against a
200k-row group put 200k rows in the isolate. It now pages by keyset on `id`, the shape
`ensureRankBackfilled` already uses.
* `deriveInsertId` keys an id-less insert by the row's CONTENT rather than by
the diff that carried it. `subscribeToMirror` re-emits an un-keyed row (an aggregate, or a
projection dropping the pk) on every frame and stamps each frame with `Date.now()`, so the old
digest minted a fresh key per frame: a shard writing once a second grew the mirror by ~86,400
rows a day, nothing ever removed them, and every read returned the whole history. Two id-less
inserts carrying identical data now collapse onto one row — nothing downstream can tell them
apart, so that is the only key that stays stable across replays. Derived ids change value.

Also: `applyDiffInto` accepts a `bigint` primary key, matching the SQLite path that already
did — the two disagreed on where an int64-keyed row lands. And the `unknownEventHandling`
docblock now says it reacts only to a reducer explicitly returning `UNHANDLED`, since one that
returns `state` for an unrecognised type makes `"fail"`/`"warn"` inert.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(codegen): gate the studio's vector page on the platform verdict

`buildStudioFeatures` was fed the raw `.vectorize()` count and the raw
`@lunora/bindings` dependency, so a `target: "node"` build emitted
`studioFeatures.vectors: true` into the generated shard and the studio rendered
its Vector browser nav entry — advertising a binding the same build had just
withheld `ctx.vectors` and the whole Vectorize wiring for. The verdict now AND's
the entire expression, so both arms fall together; it is the one feature a signal
can force off, because failing open against a host with no vector binding points
the nav at what was withheld.

`hasVectors` also meant two different things across the three emitters that take
it: `emitServer` and `emitShard` took the platform verdict and AND'd the schema
count internally, while `emitApp` took the CONJUNCTION under the same prop name,
with optional-vs-required as the only tell. All three now take the raw verdict
and AND internally — `emitApp` gets the declaration as `vectorIndexCount` — so
the "declared but gated" decision is made in one place per emitter instead of
per call site. `platformGate.signals.vectorStore !== false` is named once per
call-site file rather than re-derived four times.

Also in this change:

- The shard emitter's docblock still said the `@lunora/bindings/vectors` import
  hangs on the schema alone; it is conditioned on the platform verdict too.
- `NodePlatform.globalTables` claimed to close the hole where a store nobody
  bound fails at the first global read. It does not: `.global()` reaches its
  backend only through `createShardCtxDb({ globalDb })`, `globalDb` comes only
  from the generated shard's `d1`/`hyperdriveGlobal` thunks, and this
  composition root builds no shard DO. Softened to what it is — a building block
  — with the hop a caller has to make written down. Wiring it end to end was the
  alternative and is out of reach here: nothing in this package constructs a
  generated shard to route a global read through.
- The `objectStorage` capability note claimed a lowercase key maps to a
  byte-identical filename unconditionally; `%`, `:` and a trailing `.`/space are
  escaped too. Corrected in the matrix and its verbatim docs copy.
- `EXTENSION_KEY_IDENTIFIER_RE` was a second copy of `TABLE_NAME_IDENTIFIER_RE`
  in a module that already imports from its home; the constant is exported and
  reused.
- `assertTableNameAllowed` ran twice on the AST path, which throws at the precise
  name node first, so the coarse second gate only ever fired for the
  package-runtime path. Moved to that path, where the check was actually missing.
- `RequiredPackageOptions` was a one-field options object with one caller and no
  importer; it is a positional parameter now.
- Four copies of the same `emulated` ⇒ codegen-emits-the-surface argument in
  `node-platform.ts` are one copy, on the composition comment.
* `EmitAppOptions.hasVectors` is optional and now means the
platform's `vectorStore` verdict, not "emit `.vectors()`" — pass the schema's
index count as the new `vectorIndexCount` alongside it. `assertRequiredPackages`
and `requiredPackagesFor` take the verdict as a positional `hasVectors` argument
and the `RequiredPackageOptions` type is gone.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(payment): stop losing refunds, retried captures and chargeback amounts

Four money-path defects on the webhook ledger, each of which left the store holding a number
that did not match the money the provider had actually moved.

**Creem refunds never reached the ledger.** `refund.created` keyed the session on
`transaction.id`, but every Creem payment row is written under the CHECKOUT id
(`checkout.completed` stores `CheckoutEntity.id`, and `getPaymentStatus` retrieves the same id
via `checkouts.retrieve`). `RefundEntity.transaction` is required while `checkout` is optional,
so the transaction read always won and the checkout fallback was dead code. Every dashboard
refund therefore hit a nonexistent row: orphaned, 500, one retry, then silently unhandled, with
the row left `captured` and `refundedAmount = 0` forever. Creem's `refundPayment` throws, so
this webhook is the only path a Creem refund has. The existing regression test pinned the bug
(it asserted `sessionId === "tx_1"` from a fixture with no `checkout`); it now asserts the
checkout id from a fixture carrying both fields, plus a second test that pins the refund key
against the key `checkout.completed` writes.

**A payment that failed and then succeeded was dropped.** `failed` was modelled as terminal,
but a declined Stripe PaymentIntent returns to `requires_payment_method` and the same `pi_` can
be confirmed again and reach `succeeded` (or `requires_capture` on a manual-capture intent).
The confirming `payment_intent.succeeded` was rejected as `illegal_transition` with a 200, so
Stripe stopped retrying while the money was captured and the row read `failed` with
`capturedAmount = 0`. `failed` now permits exactly the transitions the provider performs —
`capture`, `authorize`, and a `fail` self-loop for a second decline on the same intent — while
refunds stay illegal, since nothing was captured to reverse. `failed` accordingly leaves
`PAYMENT_TERMINAL_STATES`, so a reconcile sweep over non-terminal rows now covers it.

**A lost Dodo chargeback reversed zero.** `GetDispute.amount` is a string, so `readNumber`
yielded `undefined` and a lost dispute recorded `0` while moving the row to
`partially_refunded`. The fixture used a number the real API never sends, so the gate asserted
nothing. A whole-number string is now read as minor units, matching every money field Dodo does
document; a non-integer string is refused rather than scaled, because the dispute amount's unit
is undocumented and choosing between "25.00" meaning 25 and meaning 2500 is a 100x error on a
reversal — the action then carries no amount, which records a full reversal with the money
untouched instead of a guessed figure. No other numeric read in that adapter reads a field the
SDK types as a string.

**Every provider guide taught the webhook wiring the overview forbids.** All five pages wired
the route with `Response.json(await ctx.runAction(...))`, which collapses the deliberate 500 on
an orphaned event to a 200 and makes the whole orphan/one-retry mechanism inert for anyone who
copies a provider page. They now use `webhookResponse`, and a new test asserts no docs page
regresses to the hand-built response.

Also corrects the `paymentsFromContext` comment that claimed `??` normalises an empty-string
identity to `undefined`; it does not, and the invariant rests on the authorizer's `trim()`
clause, which the comment now says so nobody removes it.
* `PAYMENT_TERMINAL_STATES` no longer contains `failed`, and the payment FSM
accepts `capture`, `authorize` and `fail` out of `failed`. A caller sweeping non-terminal rows
will now include failed payments, which is the point: they may have succeeded on a retry.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* test(codegen): stop pinning the heaviest suite below the shared timeout

Every full `vis run test:coverage` sweep reported one or two
`Error: Test timed out in 10000ms` from `codegen:test:coverage` with zero
assertion failures, varying which specs lost the race. Run alone the project
passed 1674/1674. That was written off as sweep contention five sweeps running,
which made a real codegen failure indistinguishable from the noise.

It was not generic contention. `getVitestConfig` stopped keying its timeouts on
`process.env.CI` and settled on a flat 30s, because `vis` fans the suite across
a developer's machine while CI gets a dedicated runner — local is the MORE
contended environment and the ternary gave it the shorter fuse. Two packages
kept hand-rolled copies of the old idiom and were missed. codegen's read
`CI ? 60_000 : 10_000`, so the intent was double headroom but the effect was
that the single heaviest suite in the repo ran at a THIRD of the shared ceiling
— the one project pinned below the default.

Measured, the 10s ceiling was not margin at all. Nearly every codegen spec
builds a fresh ts-morph `Project`; constructing one costs ~1ms, but the first
type-checker query against it builds a TypeScript program and parses
`lib.d.ts` at 390-710ms, paid again per Project because nothing is shared.

    codegen alone, coverage      20 specs >5s, slowest 10,625ms -> FAILED
    sweep-shaped (slots=5+load)  13 specs >5s, slowest  9,459ms -> 5% margin

Both configs now use a flat timeout. The specs cannot be made cheaper by
sharing a Project: they overwrite the same fixture paths and assert on which
declarations are visible, so reuse would leak one case's types into the next.
Concurrency is already handled — codegen inherits the `VIS_TASK_SLOTS` worker
cap from the shared config; only the timeout half of that fix was missing. No
assertion changed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(advisor): stop the KV IDOR lint failing builds on internal procedures

`kv_unscoped_user_key_idor` is the third arg-derived sink at ERROR, and the only one without the
`internal` downgrade its two siblings carry. ERROR is the build-failing tier (`advisory-gate`
defaults `strictAdvisories` on in CI), so an `internalMutation` doing `ctx.kv.put(args.key, …)`
aborted `lunora codegen` / `lunora deploy` over "any caller can read/overwrite/delete another user's
entry" — false by construction for a procedure no caller can reach. The evidence was missing too:
`run-codegen` handed the resolved function table to the owner-field and storage-key discovers and
not to the KV one, so `AdvisorKvKeyAccess` had no visibility to branch on.
* `AdvisorKvKeyAccess` and `KvKeyAccessIR` gain an optional `visibility`, and
`discoverKvKeyAccesses` takes the function table as a third argument (defaulted, matching its two
siblings). Findings for `internal` procedures now emit at INFO/INTERNAL, and every finding's
metadata carries `visibility`.

Also in the advisor:

- `workflow_unused` guarded on the DECLARATION array and defaulted the usage array, so `workflows`
  without `workflowCalls` reported every declared workflow as never started — a verdict about call
  sites nobody supplied. It now requires both, which is what `geo_index_unused`'s comment already
  claimed it did.
- `parseAdvisorMap` validated every field `compareToBaseline` dereferences except `checks`, which
  `checksWorsened` calls `.map` on. A row of `checks: {}` survives `?? []` and threw a TypeError
  inside the CI gate — the merge-conflicted-artifact case the docblock says it defends against.
- Column masking was documented two opposite ways in one package: the relation-load evidence
  modules said masking does not descend into `with` hops, while the lint implements (and the runtime
  does) the opposite — the loader applies the READING procedure's policy at every depth. Corrected
  in all three places.
- The docs advertised a `Lint.weight` override that no interface declares and nothing reads;
  dropped, along with the `weightOf` seam in `attributeFindings` that existed only for it. The docs
  also claimed `parseAdvisorMap` rejects an older-version baseline, which `baseline.ts` deliberately
  does not.

Four gates asserted nothing for the shape production emits, all now covered:

- `fan_out_breadth` was only ever exercised with a `group` set, yet the runtime's `ShardTrafficEntry`
  has no such field — the ungrouped deployment-wide prose and cacheKey every real run produces were
  asserted nowhere. Same for `hot_shard`'s root-shard label (`shardKey: ""`).
- `relation_references_unknown_field`'s `many`-side column swap — its only non-trivial logic — had
  three fixtures, all `r.one`. Dropping the swap raises a false ERROR on every to-many relation.
- `allow_unauthenticated_shard_access_enabled` had no fixture for the `lunora()` callee, which per
  its own docblock is the only way a default-Vite app can set the flag.
- `circular_fk`'s Johnson unblock cascade had no fixture; without it a real cycle is silently
  dropped while all ten existing tests stay green. The MAX_CYCLES cap was untested too, and the
  rotation the docblock calls load-bearing genuinely is — the search order is locale-collated while
  the rotation compares by codepoint, and they disagree on mixed-case names.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* security(do)!: close the socket-plane gaps in the stream cap, expiry drop and admin gate

Three defects on the WebSocket path, each one a control the code claims to enforce and does not.

`MAX_STREAMS_PER_SOCKET` was defeated by re-sending one stream id. The cap reads `cancellers.size`
and `id` comes straight off the client frame, so N `stream` frames sharing an id all passed the cap
and each started its own pump under a single map entry. The overwritten `AbortController` became
unreachable (neither `unsubscribe` nor `webSocketClose` could abort it) and whichever pump finished
first deleted the entry its siblings were still cancelled through. A duplicate id is now refused
with the new `STREAM_ID_IN_USE` code. The cap itself was asserted by no test at all; it is now
pinned, together with the duplicate-id case.

The credential-expiry drop ran on four of five outbound socket paths. Whisper fan-out skipped it,
and on the canonical whisper workload — presence, cursors, typing indicators — none of the other
four ever fires: no SQLite write means no refresh flush, no shape poke and no global poll, and a
passive receiver sends nothing inbound. A lapsed socket kept receiving every whisper on its joined
topics, including the sender's userId, for its whole life. The same gap existed on three further
outbound paths found by sweeping every send site: the legacy `broadcastDelta` fan-out, and both
stream pumps, where the inbound check ran once on the frame that started a run that can outlive the
credential by hours. All four now drop the socket.

An admin socket was never re-authorized. `refreshSubscriptions` recomputed `isAdmin` from the
function path alone, two lines below an `isPaidFunction` re-check that exists precisely because the
registration-time gate can no longer see a later change. Rotating or clearing `LUNORA_ADMIN_TOKEN`
closed the HTTP admin plane instantly and closed nothing here: the 60-second sub-token bounded only
how long an attacker had to OPEN a socket that then served `runSql`, `readTablePage` and `getLogs`
output indefinitely, and `isSocketExpired` cannot help because an admin socket carries no identity
expiry. The upgrade now stamps an HMAC fingerprint of the authorizing token on the attachment, and
both the subscribe gate and the refresh path re-derive it from `env` and compare exactly, so a
rotation revokes the live socket. Fails closed on an unset token, an unstamped attachment, or a
mismatch.
* `SocketAttachment` gains `adminBinding`, and an admin socket without one is
refused. Attachments minted before this change lose their admin subscriptions at the next flush;
clients reconnect and re-upgrade. `ERROR_CATALOG` gains `STREAM_ID_IN_USE` (409).

Also corrects two comments that asserted properties the adjacent code does not provide:
`withRequestIdentity` claimed a single caller and used that to argue it is race-free, but
`dispatchLifecycle` is a second caller reached from `webSocketClose`; and
`x-lunora-shard-binding` was documented as riding every forwarded request when the owner `/rpc`
path never sends it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(studio): stop reporting verdicts for checks that never ran

Six defects where a panel answered confidently about work the server never did, plus the two
gates that were sitting on the worst of them.

Permissions playground: the probe dispatched `runAs` with whatever was in "Run as (userId)",
including nothing. The server rejects a blank `userId` with a BAD_REQUEST before dispatching,
and the probe's catch-all painted every throw as a red **Denied** — a security-diagnostic tool
answering DENY for a call that was never made, invited by the field's own "Leave empty to run
as admin" placeholder. The guard now lives in the shared probe (the function runner and the CLI
already had it at their own dispatch sites) and refuses with a neutral "Not run" outcome; the
placeholder says the field is required. The happy-path test clicked Run with the field empty
and passed only because the mock answered `runAs` unconditionally — the mock now models the
server's own argument validation.

Storage integrity check: past 10,000 bucket keys the check deliberately skips the RPC, and the
failure path bails the same way; both set `references = []`, which the panel renders as "No
dangling references. Every record's file reference points at an object that exists in the
bucket." The truncation warning written for exactly that case was nested inside the
`length > 0` branch, so it could never appear there. A check with no verdict now reports none
(`undefined`), the notice renders independently, and the all-clear needs a completed scan. A
bucket of exactly the cap that enumerated to its end is no longer called truncated.

KV browser: clicking Filter cleared the key list but only re-keyed the load effect when the
prefix changed, so a no-op Filter — including the very first click — blanked the list for the
rest of the session. The action bumps the reload nonce.

Studio shell: the login gate opens on the raw token while the client was built from the
debounced one, so every panel's first admin read after a login ran on a credential-less client
for 300 ms. The mirror now snaps on the empty/non-empty transition; editing an existing token
stays debounced.

`useAdminSpec`: the "fetcher must be stable" contract was violated at both call sites, and
because `classify` mints a fresh object every settled fetch re-rendered and refetched. Under
vitest the loop is unbounded (a test asserting one fetch times out); in the build only React
Compiler's silent bail held it. The effect reads both callbacks through effect events, so it is
keyed on `inlineSpec` alone and a caller cannot get it wrong.

Bulk drain: `written` was assigned only from the resolved result, so a failed delete/patch
always reported "at least 0 rows were already deleted" no matter how many batches had committed.
The count is accumulated at the transport, where a batch is on disk the moment its call
resolves.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(client): hold, never destroy, an offline write of unknown identity

The built-in offline queue purged the queuing user's own durable writes on every
reload. `passesReplayIdentityGate` had no branch for "nobody signed in yet": the
constructor hydrates the queue and opens a socket itself, the socket's `open`
flushes with no auth gating, and the app's session resolve lands a tick later —
so a write stamped `subj:u1` met a `null` current identity, was rejected
`OFFLINE_IDENTITY_CHANGED` and unpersisted. Irreversible.

The client already owned the rule: `replayIdentityVerdict` returns `"unknown"`
for exactly that state and its docblock says dropping there destroys the write.
The outbox path honoured it; the queue path — the default for the standalone
client — never did. Both now route through the one verdict, which grew a third
outcome: hold (stay queued and persisted, stamp intact) instead of a boolean.
`rejectQueuedForIdentityChange` gets the same per-item treatment, so signing in
from signed-out no longer drains the signing-in user's own restored writes, and
no longer wipes the whole durable read cache on every cold boot.

The sticky-`subject` machinery that keeps a token refresh from reading as a user
switch was unreachable in production: every shipped adapter calls
`setAuthToken(token)` with no subject, and `useAuth`'s `setToken` gave apps no
way to pass one. `getCurrentUser` now establishes it from the resolved user —
the one call every adapter's identity store already makes — so a refresh keeps
the identity, the queue and the read cache. A subject carried across a token
change is unconfirmed until the next session resolve attributes the NEW
credential, and every replay verdict holds for that window: the client cannot
yet tell a refresh from an account switch, and must not replay one user's writes
under the other's token.

Also: re-stamp `ShardConnection.identity` alongside the queue and watermarks, or
every read cached after a late subject resolve is filed under a fingerprint the
next session's identity gate rejects; bound `clientWatermarks` by identity;
open sockets for queued-write shards when a `crossTabSync` tab self-promotes,
which a write-only shard's restored writes otherwise never got.
* clearing the auth token now clears an established subject. A
credential-less subject would let the next sign-in inherit the previous user's
identity, queue and read cache.

Two tests asserted the destroyed-write behaviour with a signed-out fixture
titled "a different identity"; both are rewritten to hold, with separate cases
for a genuinely different identity that still drops.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* security(server): close the policy gates that failed open on the request edge

`mask()`'s `bypass` was the one policy hook evaluated by TRUTHINESS, and it failed
open: a `bypass` returning a claim rather than a decision (`({ auth }) =>
auth.identity?.role`, the `.can(...)` forgotten) skipped the whole mask for every
caller whose claim was merely present, serving `ssn` / `email` / `hashedPassword`
raw with no error and nothing in the logs. Narrowed to `=== true`, matching every
sibling gate. No test covered it; one now returns a truthy non-boolean and asserts
the column stays masked.

`storageRules()` rebuilt `ctx.storage` as an allowlist literal and dropped
`deleteAfterCommit`, which the generated ctx installs on every dispatch that can
host a mutation handler — so a guarded mutation threw a bare `TypeError` on a
method its own type promises. It is now a guarded method, gated as a `delete` at
ENQUEUE time (the queue replays `delete(key)` after the transaction commits, past
every wrapper, so the enqueue is the only point a rule can see the key).

`ctx.db.system` reached the same R2 adapter `storageRules` fences, ungated: a query
under a `read` prefix rule could still enumerate key/size/sha256 for every object
in the bucket, and fetch any one by key. Bytes were gated; keys and hashes were
not. The middleware now rewrites `ctx.db.system` too — the `_storage` enumeration
is filtered to the objects that clear both `list` and `read`, and the by-key `get`
is refused like `getMetadata`/`head`. `list` rules consequently govern something
real, which their docblock previously admitted they did not.
* `httpRoute(...).output(v)` now binds `.stream()`, so a stream
handler must yield the declared output type and each chunk is parsed through the
validator before its SSE frame is written. `.output()` used to be accepted and
silently discarded on a stream route — SSE was the one result path that skipped
`applyOutput`, whose contract is that every transport routes through it. A chunk
that violates the schema ends the stream with a redacted `event: error` frame.
* `defineListArgs(...).toQueryArgs()` now rejects an over-long
`in`/`notIn` array instead of truncating it, matching what the validated `.input()`
path does with the same value. Truncating `in` merely narrows; truncating `notIn`
DROPPED exclusions and returned rows the caller asked to exclude.

Also in `@lunora/server`:

- `document-history`'s `redact()` now walks `Map` and `Set`. Both round-trip
  through the wire codec and a `Map` holds NAMED keys, so a column holding
  `new Map([["refreshToken", tok]])` was retained verbatim against the module's
  "secret-shaped fields are dropped recursively" claim.
- `listForDocument`'s `limit` is clamped. It was the one preset read with no
  ceiling on `take()`, and it returns full un-RLS'd row snapshots.
- `defineActionCache`'s "What it does not do" now states that the cache is global:
  the key is `(name, args)` with no identity component, so a `compute` closure that
  reads `ctx.auth.userId` serves one caller's result to every other caller.

In `@lunora/runtime`:

- `serverQuery` and an `httpRoute`'s `ctx.run*` skipped `assertDispatchableEnvelope`,
  leaving the RLS-blind `__lunora_relation__:*` read reachable single-shard — and
  the shard applies no gate of its own, citing the worker's refusal as the reason.
  The refusal is now one shared guard applied on every dispatch surface, the
  scheduler/cron root included. `ctx.run*` also stamps `x-lunora-system: "1"`, so
  an unguarded dispatch there read raw rows as a trusted caller.
- The two admin RPCs the worker serves itself at `/_lunora/rpc` never evaluated
  `adminGate` (it is scoped to `/_lunora/admin/*` to stay off the data hot path), so
  an Access-only deployment got 403 on the Studio's auth-audit and
  notification-device reads. The grant is now recorded once the envelope has named
  one of them, leaving ordinary RPC traffic untouched.
- `resolveX402Charge` served every paid procedure FREE when `options.functions` was
  absent, under a docblock promising the paywall is fail-closed by construction. It
  warns once now, like the identical missing-registry condition for `replicaReads`.
- `health-routes` sorted by `localeCompare` under a comment claiming snapshot
  stability; `localeCompare` resolves against the runtime's locale and ICU version,
  which the repo says twice in writing. Now UTF-16 code unit.
- The two scheduler admin routes reading a bare `request.json()` read under the
  shared byte budget like every sibling.

New gate: `admin-route-table.test.ts` walks every `/_lunora/admin/*` path declared
in the source through a credential-less worker and asserts none of them answers.
Nothing previously enumerated the route table, so a newly added admin route that
forgets its gate was caught by no test. Verified by ungating one route and watching
it go red.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* chore(shard-engine): record adminBinding on the socket attachment snapshot

`SocketAttachment` gained `adminBinding` when the socket plane started
re-authorizing admin subscriptions, but the type lives in `shard-engine` while
the change landed in `@lunora/do`, so the per-package `api:check` that ran there
never saw this snapshot.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(advisor,platform-node): validate baseline check entries and unwind a failed compose

`parseAdvisorMap` guarded the `checks` container but not its entries, which left the same
defect one level in: `checksWorsened` keys a Map on `check.name` and compares
`check.occurrences` with `>`, so a `null` entry throws inside the CI gate the same way a
`checks: {}` did, and a non-numeric `occurrences` makes every comparison `false` — a corrupt
baseline then reads as "no regression". Both the procedure rows and the project bucket now
require each entry to carry a string `name` and a finite `occurrences`, the only two fields a
baseline's checks are ever read for; `level` and `weight` stay unchecked because nothing reads
them off a baseline.

`createNodePlatform` built the shard connection, the registry and the scheduler before queues,
object storage and global tables. Several of the later steps throw on bad input — a queue whose
dead-letter target nothing declares, a `globalTablesPath` that cannot be opened — and the throw
escaped before any platform object existed, so the sqlite handle (with its WAL/SHM sidecars),
the registry's live shards and the scheduler's armed timers leaked for the life of the process.
Construction now records each resource's own teardown thunk — they are three different shapes,
a bare `dispose()`, a `close()` method and a `dispose()` method — and unwinds them in reverse
on the way out, swallowing a teardown error so the construction error still reaches the caller.
* `close()` unwinds the same list, so it now runs in reverse construction order
(global store, scheduler, registry, shard) rather than the previous scheduler-shard-registry-
global-store order. Scheduler timers still come before the connection they would fire against.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* security(runtime)!: refuse to build an x402 paywall that cannot see its paid functions

`.x402({ price })` tags are read off the `functions` registry, so a worker configured with an
`x402Charge` gate and no registry paywalled nothing: `resolveX402Charge` returned `undefined` for
every path, and EVERY paid procedure dispatched free — no 402, no settlement, no receipt — under
a docblock promising the paywall is fail-closed by construction. The condition warned once per
worker and served the request, trading an authorization hole for a log line nobody reads.

Move the refusal to worker construction: `createWorker` now throws `MISCONFIGURED` when
`x402Charge` is supplied without `functions`, naming both ways to fix it. A misconfigured paywall
should fail at boot with an actionable message, not serve paid functions free at runtime. Per-RPC
refusal was the wrong lever — it would have taken a free app down over a paid-function config,
which is the objection the warn-instead choice was answering; construction-time refusal answers it
without leaving the gate inert.
* `createWorker({ x402Charge })` without `functions` now throws instead of building
a worker that serves paid procedures free. `defineApp()` always supplies the registry, so only a
hand-rolled `createWorker` can hit this; no example or template passes `x402Charge` today.

The identical missing-registry condition on `replicaReads` is left as a warning. It is a placement
optimization, not a gate: inert means every read is served by the shard owner, which is correct and
merely slower, so refusing to boot over it would trade availability for nothing.

Also enforce the studio orphan check's live-key cap during iteration, not only between pages.
`StorageListFunction` is a caller-supplied seam and the admin route returns its result unchanged,
so nothing enforces `objects.length <= limit`; the walk pushed every object of every page and
only then re-tested the cap. An over-sized cursorless page therefore produced a key list past the
bound while reporting `truncated: false` — a complete verdict over work it did not bound. Take
only what fits and mark the walk truncated when a page's keys were dropped.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(replica): key rows on the wire form and bound the /state body

Three defects around the content-derived row id and the event-log DO's unpaged read.

Derived row ids hashed a JSON encoding of the row AFTER the wire decoder had run, so every
value with no own enumerable key rendered as `{}`. A `Date`, a `URL`, a `Map`, a `Set`, an
`ArrayBuffer` and a literal `{}` therefore shared one digest and one mirror row — the upsert
that content-keying exists to enable was overwriting unrelated rows. `NaN`/`+-Infinity`
collapsed onto `null`, a typed array aliased the plain object with the same indices, and a
`bigint` did not hash at all: `JSON.stringify` threw, and in `applyDiffToDb` that throw is
inside the transaction, discarding every well-keyed row in the batch. Encode with
`stableWireKey` (`encodeWire` + `stableStringify`) instead, which is already what
`subscribeToMirror` keys its `known` map with, so the keyed and un-keyed paths now agree on
what "the same row content" means.
* derived ids change for any row holding a `bigint`/`Date`/`Map`/`Set`/`URL`/
bytes/non-finite number, and an `undefined` array element is now distinct from `null`. Pure-
JSON rows are unchanged. `canonicalizeForHash` is gone (it was exported for the bench and
tests only, never from `src/index.ts`).

`MaterializerRuntime.applyEntries` reported an entry as unknown whenever no reducer that RAN
handled it — but a materializer already past the entry's seq does not run. Replaying an entry
to catch up a lagging materializer, over events a snapshot-recovered sibling had applied, was
therefore classified unknown and `"fail"` aborted on an event that was in fact processed.
Unknown now means no materializer handled it, not that the subset still behind it declined.

`GET /state` checked only the entry COUNT, and parsed every payload before that check, so
exactly 1000 valid-but-large entries built the whole body inside a 128 MB isolate. Both bounds
are now decided on the raw rows before a single payload is parsed, `/since` shortens a page
that would exceed the same budget (reporting it through `truncated`/`cursor`), and `/append`
carries a matching per-event cap in the same units — so an event the log accepts is always
readable, and no read can pull more than the cap times the page size.
* `/append` now rejects an event whose serialized payload exceeds 32768
characters, and one with no `payload` at all (which previously reached the NOT NULL column and
surfaced as a 500).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

### Bug Fixes

* close 4 audit rounds across the data path, request edge, socket plane and money path ([#590](https://github.com/anolilab/lunora/issues/590)) ([c2a8377](https://github.com/anolilab/lunora/commit/c2a8377e01c6b34926a3fe9810b3a404702ab479))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.31
* **@lunora/server:** upgraded to 1.0.0-alpha.102
* **@lunora/values:** upgraded to 1.0.0-alpha.39

## @lunora/payment [1.0.0-alpha.103](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.102...@lunora/payment@1.0.0-alpha.103) (2026-09-03)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.101

## @lunora/payment [1.0.0-alpha.102](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.101...@lunora/payment@1.0.0-alpha.102) (2026-09-03)

### ⚠ BREAKING CHANGES

* 34 public API changes across mail, storage, payment, replica,
studio, workflow, agent, codegen, cli and the shard runtime. The full list is in

### Bug Fixes

* audit rounds 7-11 ([#579](https://github.com/anolilab/lunora/issues/579)) ([224a42a](https://github.com/anolilab/lunora/commit/224a42a741f524e0110da55917c79fd08c90a885))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.30
* **@lunora/server:** upgraded to 1.0.0-alpha.100
* **@lunora/values:** upgraded to 1.0.0-alpha.38

## @lunora/payment [1.0.0-alpha.101](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.100...@lunora/payment@1.0.0-alpha.101) (2026-09-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.29
* **@lunora/server:** upgraded to 1.0.0-alpha.99
* **@lunora/values:** upgraded to 1.0.0-alpha.37

## @lunora/payment [1.0.0-alpha.100](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.99...@lunora/payment@1.0.0-alpha.100) (2026-09-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.28
* **@lunora/server:** upgraded to 1.0.0-alpha.98
* **@lunora/values:** upgraded to 1.0.0-alpha.36

## @lunora/payment [1.0.0-alpha.99](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.98...@lunora/payment@1.0.0-alpha.99) (2026-09-01)

### ⚠ BREAKING CHANGES

* **shard-engine:** close round-3 audit findings across the data path, guards, mirrors and tests (#541)

### Bug Fixes

* **shard-engine:** close round-3 audit findings across the data path, guards, mirrors and tests ([#541](https://github.com/anolilab/lunora/issues/541)) ([dfc2d4d](https://github.com/anolilab/lunora/commit/dfc2d4d07bf8f67214122dc7f14d83a9b1533d07))


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.97

## @lunora/payment [1.0.0-alpha.98](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.97...@lunora/payment@1.0.0-alpha.98) (2026-09-01)

### ⚠ BREAKING CHANGES

* `ctx.scheduler.runAfter` and `runAt` resolve the bare job id
instead of `{ id, scheduledFor }`. Four gates — the type, the docs, the
platform contract and the generated surface — already said `Promise<string>`;
only `@lunora/scheduler` resolved an object, and the install is a cast, so
nothing caught the disagreement. `scheduler-host.ts` assembles the platform
contract's `ScheduledJob` from the instant it already computed, so no
information is lost. The one in-repo call site is updated.

`@lunora/ai`'s default model and embedding model were settable only through
options codegen does not thread, so an app could not change either. Both now
read `LUNORA_AI_DEFAULT_MODEL` / `LUNORA_AI_DEFAULT_EMBEDDING_MODEL` from
`env`, the seam codegen does thread, mirroring the existing
`LUNORA_AI_GATEWAY_*` convention; explicit options still win.

`SocketHost.idFor` is kept but its doc no longer claims the engine uses it to
reassociate a rehydrated socket — per-socket state is keyed on the handle
object and durable identity is the engine's own `connectionId`. It is the
conformance suite's identity oracle in 8 legs, which is a real consumer.

* fix(codegen): scan the worker entry so the security lints can fire

Five ERROR-level advisor lints could never fire. `listLunoraSourceFiles`
recurses only `lunora/`, but `createBrowser`, `createPayment` and
`createInboundEmailHandler` are called from the worker entry under `src/`,
so `discoverConfigCalls` found nothing and every lint keyed on it returned
clean regardless of the code. `mail_inbound_dispatch_without_verify`,
`payment_create_without_authorize`, `browser_allow_private_targets`,
`export_sink_misconfigured` and `browser_user_url_without_allowlist`'s
suppression arm are now live.

The fix is a second, explicitly-scoped walk rather than widening the
existing one: `listLunoraSourceFiles` also feeds `refreshCodegenProject`'s
add/remove reconciliation, which drops Project files under `lunoraDirectory`
that vanished from disk, so widening it globally would have changed that set
too. Only `config-calls.ts` and `export-sinks.ts` are switched over.

`apps/playground`'s inbound email handler declares no `verify`, so it now
produces a real ERROR advisory — which is the point, but it will surprise a
gate until it is fixed.

Also inert: the umbrella's `lunorash/flags/flagship` specifier was not in the
flagship provider set, so an app importing through the umbrella got no
binding inference; and `fsTool` never registered the sandbox dispatcher, so
declaring it produced an app whose tool had nothing to dispatch to.

`constraint_validator` is kept — `runAdvisor`, the lint and
`AdvisorTableSample` are all public API and the README's example is a caller
passing its own samples. What was false was the claim that the studio feeds
it: `LintContext.tableSamples` said the studio "reads up to the configured
row cap from each table via readTablePage", which nothing does. Building a
feeder needs a bounded-sample admin read that does not exist, so the docs now
state there is no shipped feeder rather than implying one.

The generated Drizzle schemas were documented nowhere despite
`@lunora/server/drizzle` existing as a published subpath whose own docs point
at them; they now have a section explaining the global/shard split.

* fix(templates): stop scaffolding insecure cookies and a shared rate-limit bucket

`templates/expo` set `AUTH_URL: "http://localhost:8787"` in wrangler's
`vars`, which is baked into the deployed Worker. better-auth derives
`useSecureCookies` from that URL, so every project scaffolded from this
template shipped session cookies without `Secure` in production. The value
moved to `.dev.vars.example`; unset, better-auth resolves per request and the
weak-secret guard throws. The README was actively instructing users to put it
in `vars`.

All 12 non-expo templates keyed their rate limiter
`(ctx) => ctx.auth.userId ?? "anon"`, so every unauthenticated caller shared
one bucket — one client could exhaust it for all of them. Now
`ctx.auth.userId ?? ctx.ip ?? "anon"`, verbatim from the advisor lint that
prescribes it. The hand-rolled inline limiter is replaced by the copy-in
`lunora/ratelimit/schema.ts`, whose `limits` map was previously dead config:
its only key was never read, so tuning it did nothing.

`templates/expo` had no `imports` map, so `lunora registry add` produced
files importing `#lunora/_generated/server.js` that could not resolve.

In examples: `auth-playground`'s document list claimed membership isolation
in a comment while reading every row for an organization the caller merely
named; the index now pins the equality prefix to the session's own ownerId.
A procedure context deliberately carries no raw Headers, so `getActiveMember`
is unreachable from a query — the doc says so and points at the httpAction
recipe rather than implying a check that cannot happen.

`blog`'s cron was documented but never wired: no `crons.ts`, no trigger, and
`scheduled()` was never exported, so it would have fired into nothing even
once declared. Its `drafts.save` patched any id the client sent, which is an
IDOR; it now re-reads and checks the author, returning an indistinguishable
NOT_FOUND. Its bare `Error` throws were becoming redacted 500s rather than
the 401s they read as. The unused `users` table carrying a `passwordHash`
column is gone — shipping a second, empty credential store teaches worse
than losing the `.global()` demo, and the README now points at `team-chat`
for that.

* fix(playground): take the message author from the verified identity

`lunora/mutators.ts` accepted `userId` as an argument and wrote it verbatim
as the author, so any caller could post as any user. It is publicly
dispatchable — codegen registers `mutators:sendMessage` and exposes it on the
`api` proxy — so this was not a local-only path. Fixed with the framework's
existing control, `owner: "userId"` on `defineMutator`, which requires a
verified identity, rejects a mismatched argument, and overwrites the column
before the authoritative impl runs.

The same path also bypassed `messages.send`'s rate limit and its 4096-char
cap by pushing an identical row through a second entry point; both now match.

`apps/studio` read `VITE_LUNORA_ADMIN_TOKEN` unconditionally, so a production
build inlined an admin bearer token into a shipped bundle. The neighbouring
`baseUrl` was already gated on `import.meta.env.PROD`; the token now sits
behind `import.meta.env.DEV`, which is statically false in a production
build, so the variable is never read and cannot be inlined.

The signed-upload content-type check ran only when the URL had pinned one,
so an unpinned URL accepted any content type — the guard is unconditional
now, and the e2e helper forwards `contentType` so it can still mint a usable
pinned PUT.

`seedKv` stays a public action deliberately. Making it internal was
considered and would have stranded it with no caller at all: the internal
gate reads `x-lunora-system`, set only by scheduler/cron/queue dispatch,
while the Studio runner and `lunora run --as` both re-enter through the
ordinary RPC path. It takes no caller input — fixed values at six fixed keys
— so the exposure is resetting demo data. The docstring records why, and
warns that a seeder writing caller-supplied keys must not copy the shape.

Deletes a 443-line throwaway spike the file itself labelled as such.

* docs: make the non-callable examples callable and correct the wrong claims

Nineteen snippets across the concept docs used the object form
`query({ args, handler })`, which is not callable — the same page set's
migration guide says so explicitly. Every one is now the chainable builder
form the code actually exposes.

The Hyperdrive recipes assigned `ctx.sql = …`, which does not work: the
facade is wired by codegen from the app's config, not assigned in a handler.
The caching page hand-rolled 110 lines of cache bookkeeping that
`defineActionCache` does in three.

Corrections where the prose was simply false: the payment integration
claimed 12 tables where it creates 5; the read-replica page described
fallback behaviour the implementation does not have; and the offline-first
page contradicted the `.meta()` documentation this round introduced.

`packages/hyperdrive`'s README documented "Tagged-template queries" and
"Unsafe / raw queries" sections for APIs that do not exist —
`fromPostgresJs()` returns a `SqlClient` whose only member is `query(text,
params)`; `.unsafe()` belongs to the raw postgres.js client it wraps.

`sdks/python`'s `stable_stringify` docstring was the last copy of the
"code-point order" claim; the sort is UTF-16 code-unit order, which its own
`_utf16_sort_key` already implemented correctly.

* fix(examples): sort the expo manifest after adding the imports map

The `imports` map that lets `lunora registry add` resolve
`#lunora/_generated/server.js` was inserted in the wrong position.
Key order is enforced by one CI job that nothing else covers.

* style(client): satisfy the lint rules the new code tripped

Mostly mechanical, but two are real changes rather than suppressions.

The deferred-close WebSocket double added for the teardown regression test
duplicated the shared one except for a single method, which sonarjs
correctly flagged twice. The shared double now takes a `deferClose` flag and
the copy is gone. Verified the test still fails with the teardown fix
reverted, so the consolidation kept its diagnostic power.

The offline-flush barrier chained off `.then()` without returning a value.
It is a sequencing barrier with nothing to pass along, so it is an async
IIFE now — no rule to satisfy, and it reads as what it is.

The stream drain discarded its chunks into an unused binding; it collects
them and asserts the torn-down stream yielded none, which is the property
the test is actually about.

The remaining jsdoc/no-secrets disables follow the convention already used
in `@lunora/advisor` and `@lunora/codegen`: intentional bullet lists, and
back-ticked identifiers in prose that the entropy heuristic reads as
credentials.

* docs(scheduler): correct the three places still destructuring the old return

`runAfter`/`runAt` resolve the bare job id now, so `const { id } = await
ctx.scheduler.runAfter(...)` binds `undefined`. The package README and the
`lunora-setup-scheduler` CLI skill both taught exactly that, and the skill
also stated the old `{ id, scheduledFor }` shape in prose.

These are the siblings of the call site that was already fixed —
`docs/index.mdx` was updated with the signature change and its neighbours
were not.

* style(server): drop the now-redundant casts on the middleware context

`validateArgs` already returns `Record<string, unknown>`, so the two
`parsed as Record<string, unknown>` assertions at the `withCallContext`
call sites became unnecessary once it took `parsed` directly.

* fix(client): model the browser's asynchronous close in the shared socket double

The double dispatched `close` synchronously inside `close()`, which no browser
does. That hid a whole class of teardown-ordering bug from all 148 tests using
it: `teardownConnection` clears `conn.socket` AFTER calling `close()`, so a
same-tick event still found the identity guard satisfied and reached
`handleDisconnect`. The teardown regression test added earlier in this branch
had to opt into deferred close to see its own bug — which left the unfaithful
behaviour as the default for everything else.

Deferred close is now the only behaviour. Flipping it turned four tests red,
and all four were the double's fault rather than the code's: `readyState` must
flip synchronously (a browser sets it before returning from `close()`) while
only the EVENT is deferred. Fixed there; 783 pass.

Verified the teardown regression test still fails with its fix reverted, so
consolidating on one double did not cost it its teeth.

Also from review:

- `resolveRunnableTargetOrThrow` was written twice — once in the CLI, once in
  the Vite plugin — with two hand-written messages that would drift. The
  predicate is a property of the driver registry, not of either tool, so
  `isRunnableTarget`/`runnableTargetIds` now live in `@lunora/config` beside
  `resolveTargetOrThrow`, whose own docblock already argued the Vite plugin
  needs the same guard. Both callers keep their own wording; neither keeps its
  own logic.

- `check-project-json-targets.js` floored only its TOTAL count, so a declared
  workspace group that exists but holds no members passed vacuously while its
  two sibling checks failed. Floored per group, on member directories rather
  than on `project.json` files — not every member has one, by design.

- `WORKER_ENTRY_ROOTS` claimed to mirror `@lunora/config`'s
  `WORKER_ENTRY_FALLBACKS` and does not. Kept separate deliberately — one picks
  THE entry file, the other decides what a security lint may see, and equal
  lists would be wrong for one of the two jobs — but the comment now says that
  instead of inviting the reader to assume equality.

- Two `{@link}` targets are qualified, which removes the need for the
  `jsdoc/no-undefined-types` half of a suppression.

* fix(client): restore follower subscribe, and reset backoff on a frame-less socket

Two regressions this branch introduced, both found by review.

**`crossTabSync` was broken for every follower tab.** `subscribe()` was added
to the leader-only guard on the reasoning that a follower's subscribe "reached
the server only when the leader happened to hold the same
`(fn, args, shardKey)`". That is not an accident — it is the mechanism. The
follower's registration is what puts a `SubscriptionState` in
`this.subscriptions`, and `onSubscriptionData` drops any broadcast whose key it
cannot find there. Guarding it did not make a silent failure loud; it made the
leader's entire broadcast path dead code and threw `NOT_IMPLEMENTED`
synchronously out of every `useQuery`, `useInfiniteQuery`, `@lunora/db`
collection and svelte `query` in every non-leader tab.

`subscribeShape`, `whisper*`, `setConnectionContext` and
`acquireConnectionContext` genuinely have no relay path and keep their throws.

The existing follower tests could not catch this: each calls `subscribe()`
without any other tab announcing leadership, so the client is still inside its
startup claim window and the guard never fires. The new test establishes the
leader FIRST, then subscribes, then asserts the broadcast is delivered —
re-adding the guard turns it red.

**A socket that receives no JSON frame never reset its reconnect backoff.**
Moving the reset off `onOpen` was right (an upgrade is accepted before the
credential is read, so resetting there turns a lapsed token into a storm), but
"first non-error frame" is unreachable for some clients: the server sends no ack
for the `connect` envelope, and the keepalive pong is a plain string answered by
the runtime without waking the DO, so `JSON.parse` rejects it before the reset.
A whisper sender, a presence-only client, or any `ensureSocket` warm-up with no
active subscription therefore doubled its delay on every blip with nothing ever
resetting it, parking a healthy connection at the 30s cap.

Surviving a 5s window is now the second proof of acceptance — a rejected
credential closes 4001 well inside it, and that path clears the timer. The test
covers both directions: a socket held open past the window reconnects at the
initial delay again, and one closed at 100ms does not.

**`apps/playground` could not build.** The worker-entry scan added earlier in
this branch makes `mail_inbound_dispatch_without_verify` fire on an inbound
handler that really does dispatch spoofable mail into a function running with
the admin bearer and RLS off. `vite build` fails unconditionally on an
ERROR-level advisory, and `lint:types` fails under CI only — which is why the
pre-flight gate run reported green. Added the `verify` gate the lint asks for:
DMARC pass, or SPF and DKIM both passing. Fails closed, since a `null` verdict
means the receiving MX stamped no `Authentication-Results` header at all.

* fix(codegen): type the emitted scheduler config so the compiler guards the install

The scheduler return type had drifted from `Promise<string>` across four gates
with nothing failing, and the fix earlier in this branch corrected the type
while leaving the mechanism intact: the emitted config field was
`(env) => unknown`, which forced `as SchedulerLike` at all four use sites and
made the compiler blind to exactly this class of drift. The field now carries
`SchedulerLike`, the casts are gone, and the next disagreement is a build
error. Golden fixtures and all 13 example `_generated` trees regenerated.

Also from review:

- The registry's new auth and target guards threw bare `Error`, which the
  templates commit in this same branch identified as becoming a redacted 500.
  An unauthenticated caller was told the server had faulted. They are coded
  now: `UNAUTHORIZED` for the auth gate, `BAD_REQUEST` for a malformed or
  non-`https:` URL, `FORBIDDEN` for a host outside the allowlist. The
  missing-binding throws stay bare — a misconfigured deployment IS a 500.

- `@lunora/container` telemetry is batched now, so nothing leaves the process
  until a timer elapses or `flush()` drains it. Every emit used to be its own
  POST, so an existing job that exits promptly without flushing went from
  reporting everything to reporting nothing. `flush()` is documented as
  required rather than as an optimisation, including the oldest-first drop at
  the item cap.

- `examples/auth-playground` memoised the init PROMISE, so one failed
  cold-start migration was replayed to every later request for the isolate's
  life with no path back. Cleared on failure so the next request retries.

- The SDK port-discovery gates treated every directory under `sdks/` except
  `smoke` as a port, so a stray `node_modules` or `.venv` would have failed
  both permanently on a difference that is not a missing port. Anchored on the
  README every real port ships. Demonstrated both ways: a stray directory no
  longer trips it, a genuine new port still does.

- `discoverSandboxUsage` drove its scan from `TOOL_FLAGS` but kept a
  hand-written conjunction for the early break; that is the third flag waiting
  to be forgotten, so it reads the table too.

- `registry/tsconfig.json`'s exclusion rationale had grown to a ~1,100-character
  JSON string — unwrappable, unreadable in review, unlintable. Moved to
  `registry/TYPECHECK.md` with a pointer left behind.

- Noted in `withCallContext`'s JSDoc that every builder procedure now receives a
  cloned context, not only those declaring `.meta()`.

* revert(codegen): keep the scheduler config field untyped, and record why

Typing the emitted `scheduler?: (env) => …` field as `SchedulerLike` — so the
compiler would guard the seam the `Promise<string>` drift slipped through —
does not compile. `@lunora/scheduler`'s public `Scheduler.runAfter`/`runAt` are
generic with a REQUIRED `args`, while `SchedulerLike` takes it optional, so a
function needing three parameters is not assignable to one callable with two.
Every app that calls `createScheduler` directly fails, `apps/playground` and
`examples/blog` among them.

So the `as SchedulerLike` cast was not a loose annotation over two agreeing
shapes; it was hiding a real incompatibility between the scheduler package's
public type and what the DO accepts. Reconciling those two signatures is the
fix, and it is an API change to `@lunora/scheduler` rather than a cast removal.

Reverted to `unknown`, with the exact cause written at the field so the next
reader learns why the cast is there instead of rediscovering it. The
`Promise<string>` correction itself stands — that was the actual defect.

Adds `isRunnableTarget` / `runnableTargetIds` to the `@lunora/config` snapshot.

* fix(client): keep the framework-called follower surfaces inert instead of throwing

A second review pass over the fixes the first one prompted. Its highest finding
is the same shape the branch keeps producing: the earlier commit un-guarded
`subscribe` because a follower's registration is what the leader's broadcast is
matched against, and stopped there. `acquireConnectionContext` and
`subscribeShape` are not app-level calls — all five `usePresence` adapters
(react, vue, svelte, solid, angular) call the first from a component effect, and
`@lunora/db`'s shape-backed `createCollection` calls the second from its sync
path. Neither is something an app can opt out of, so the guard threw
`NOT_IMPLEMENTED` out of an effect and unwound the entire tab to an error
boundary. Before this branch presence merely failed to update.

Both are inert on a follower now. The loud throw is kept for `whisper`,
`whisperSubscribe` and `setConnectionContext`, which no first-party package
calls — those are app code, which can handle a failure.

`@lunora/agent`'s inbound handler had the same call-site-vs-layer problem with
a security edge: it built `createInboundEmailHandler` with no `verify` and
`AgentEmailTarget` gave apps no way to add one, while its own header instructs
mappers not to trust `email.from`. A claimed message starts a durable run whose
tools execute RLS-bypassed, so the gate now runs before any mapper — the same
fail-closed DKIM/SPF/DMARC check the playground got. The advisor lint could
never have caught this: it scans user projects, not this repo's sources.

Also from the pass:

- `runnableTargetIds` repeated the predicate `isRunnableTarget` defines, five
  lines below it, in the commit whose purpose was removing that duplication.
  Both moved to `driver-registry.ts`, beside the registry they query rather than
  in the module that reads `lunora.json`, and `isRunnableTarget` answers `false`
  for an unregistered id instead of throwing.
- Three registry JSON files had every em dash rewritten to `—` and their
  arrays exploded by a serializer that was not the repo's Prettier, mangling
  user-facing `description` copy. Restored.
- The emitted `scheduler?:` docblock carried a ~600-character maintainer
  post-mortem into every user's `_generated/shard.ts`. One sentence there now;
  the explanation lives in `emit.ts` where maintainers read it.
- The SDK README marker added last round NARROWED the gate it was meant to
  protect: a new port shipping without a README was invisible to discovery AND
  absent from the list, so no drift fired. Replaced with an explicit ignore
  list — a non-port directory costs one deliberate line, anything else fails.
- `examples/auth-playground` still memoised a rejected promise if `buildAuth`
  threw, one line above the fix for exactly that.
- The browser item echoed the rejected hostname back to the caller, letting an
  authenticated caller enumerate `ALLOWED_RENDER_HOSTS` by probing. Logged
  server-side, generic to the client.
- `clearConnectionTimers` replaces three copies of the same clear block across
  two teardown paths, so a fourth timer cannot be half-remembered.
- Comment trimming where the prior review's "rationale as changelog" note
  applied again, and a `jsdoc/check-indentation` suppression deleted by removing
  the list that needed it.

* perf(server): skip the per-call context clone when no middleware can read it

CodSpeed flagged 15 regressed benchmarks on this branch, all in
`packages/server`, with `N=0: no .use (dispatch floor)` down 21.5% — a
procedure with no middleware at all. That is the tell: `withCallContext`
was cloning the dispatch context on every call, where the previous
`withMeta` cloned only when `.meta()` was declared.

`ctx.args` and `ctx.meta` exist for `.use()` steps to read; a handler already
receives `args` as its own parameter. So a procedure with no middleware and no
meta is handed the dispatch context unchanged.

Measured locally rather than inferred from the instruction-count delta:

  N=0 dispatch floor   3.06M -> 4.37M ops/s   (1.43x)
  empty args           3.06M -> 4.43M ops/s   (1.44x)
  single id arg        2.71M -> 4.04M ops/s   (1.49x)

Procedures that DO declare middleware still pay the clone, and that cost is
real — it is what makes `ctx.args` reach a `.use()` step, which is what fixed
`emailGateMiddleware` and `verifyTurnstileMiddleware` throwing FORBIDDEN on
every call. Prototype delegation would avoid the property copy, but
`@lunora/auth`'s own docs teach `next({ ctx: { ...ctx, … } })`, and a spread
drops inherited properties — so the full clone is required for correctness.

* test(vite): cover the runnable-target guard

Codecov put `packages/vite/src/index.ts` at 66% patch coverage: the guard
that stops `vite build --target node` running the Cloudflare pipeline had no
test at all. Verified the two positive cases fail with the guard reverted.

* ci: keep CodeRabbit under its file cap so it reviews the code at all

CodeRabbit skipped this PR entirely — "116 files, 16 over the limit of 100" —
so a change touching every package got no automated review. The cap counts
files that survive `path_filters`, and 44 of those were markdown.

Excluded two kinds that cost review budget without earning it:

- `**/CHANGELOG.md` — semantic-release writes them; reviewing generated
  release notes is noise.
- `**/docs/**` — the long-form prose docs under `packages/*/docs/` and
  `apps/docs/src/content/`.

That brings the reviewable set to 92. READMEs stay in deliberately: they are
what a user reads first, and a wrong snippet there costs the most — this
branch fixed several.

The trade is explicit. Prose review is worth less than code review, and the
previous setting bought neither: over the cap, CodeRabbit reviews nothing.
* `useFlag`, `useFlags`, `createFlag`, `createFlags` and `flag`/
`flags` no longer take a targeting `context`, and `FlagContext` is no longer
exported. Any call passing one was passing a value the server discarded.

`react-native.api.md` drifts too: it re-exports `@lunora/react` wholesale, so it
carried a `FlagContext` row nothing would think to look for.

* refactor(runtime): stop exporting four symbols nothing outside them uses

Audited as "dead exports". Only one was dead code; the other three have live
in-file callers, so it was the EXPORT that was unused, not the function — and
deleting them would have broken working paths. `readShardKey` is the only thing
that reads `?shardKey=` / `x-lunora-shard-key` for REST dispatch;
`exportShardTable` is what `exportShardRows` delegates to per table;
`hydrateDocsById` is the `IN (...)` hydration that keeps `computeRankPage` off
an N+1. All three are now module-private.

`DEFAULT_LOG_LIMIT` was genuinely dead: a public alias of the module-private
`DEFAULT_LIMIT = 500` that nothing read except one `{@link}`. Deleted, and the
`PipelineLogQuery.limit` doc states the default literally instead of linking a
symbol that no longer exists.

Also removes an unreachable diagnostic in the advisor command. It printed
"advisor evidence unavailable — codegen ran with linting disabled" when
`advisorContext` was undefined, which requires `CodegenOptions.lint` to be set —
and that option is set at 47 call sites, every one of them inside codegen's own
tests. No production caller passes it, so the branch could not run. Deleted
rather than given a `--no-lint` flag to justify it: a user running `lunora
advisor` wants the advisor evidence by definition. The option stays for library
callers.

* fix(codegen): gate `.commitOrdered()` against the target's capability matrix

`commitOrderedTables` was rated in every platform capability matrix and read by
nothing. A host rating it `unsupported` emitted the full `.commitOrdered()`
surface with no diagnostic and silently dropped the ordering guarantee — which
is the only thing that feature is.

Promoted to a real `PlatformSignals` entry, read off the same IR that already
feeds `globalTables`, so an unsupported rating now emits
`platform_unsupported_feature` at codegen time. The test fails without the
signal key wired in.

`@lunora/platform`'s docblock called this "the outstanding case"; it now records
that it was promoted, and that `memoryTables`, `objectStorageBackups` and
`objectStorageCdcArchive` remain unpromoted instances of the same shape — rated
in every matrix, consulted by nothing.

* fix(examples): re-bless the five schema baselines that reported deploy drift

`feedback-board`, `team-chat`, `kanban-board`, `chess` and `tanstack-start` all
call `.extend(ratelimit.extension)` but their committed
`lunora/.lunora-schema.json` had no `ratelimit_buckets`, so `lunora deploy`
reported drift on each. Refreshed through the documented path.

Two of them carried more than the ratelimit drift, and re-blessing accepts it:
`kanban-board` had a required `tasks.status`, `chess` had `games.drawOfferedBy`
and `lobbies.guestId` widening `string -> union`. Both were pre-existing and
breaking; naming them here beats letting them ride in silently.

`--update-schema-baseline` was reported as crashing with "Cannot read properties
of undefined (reading 'filter')". It does not, under any condition that could be
constructed — a refactor wrapped every reconcile step in try/catch, so a
TypeError there now surfaces as a warning rather than killing the command, and
the likely original home (`DeployDriver.provision`) is dead code no CLI path
calls. No speculative fix. What the path did lack was any coverage at all, so it
now has an end-to-end test: capture a baseline, age it into breaking drift,
assert `prepare` blocks, assert the flag re-blesses it. Neutering the flag turns
it red.

The rate-limit copy-in paths taught two names for one thing: `registry/ratelimit`
called its only bucket `default` while all 13 templates and all 9 example
schemas use operation-shaped names. Reconciled on `send`. `lunora init`'s overlay
was a third copy — and was internally inconsistent, emitting `default` while the
`LUNORA_MESSAGES` it writes alongside declared `send`.

`.lunora-schema.json` is now Prettier-ignored. `serializeSchemaSnapshot` writes
2-space and Prettier rewrites it to 4, so every re-bless produced a file that
failed `lint:prettier` until someone ran `--write`. The serializer owns that
format and cannot change: its exact output is the input to `hashSchemaSnapshot`,
which is a schema version's identity in the DO's `__lunora_schema_history`
ledger. Ignoring is safe because that hash is taken from the re-serialized
object, never from the file's bytes.

Docs: `plans/README.md` described a deleted playground prototype as a live spike
deliverable, and `protocol/README.md` documented the wire grammar without the
two fixture-schema additions that now drive all eight SDK suites — `reencoded`
(for shapes that are legitimately not fixed points of `encode(decode(x)) == x`)
and `rejected[]`. Two claims those additions falsified are corrected with them.

### Bug Fixes

* close the round-2 package audit findings across registry, protocol, client and CI ([#539](https://github.com/anolilab/lunora/issues/539)) ([e3dd702](https://github.com/anolilab/lunora/commit/e3dd70282af1aff606fe03a4ebd29c33d0029ce5)), closes [#540](https://github.com/anolilab/lunora/issues/540)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.27
* **@lunora/server:** upgraded to 1.0.0-alpha.96
* **@lunora/values:** upgraded to 1.0.0-alpha.35

## @lunora/payment [1.0.0-alpha.97](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.96...@lunora/payment@1.0.0-alpha.97) (2026-08-31)

### Bug Fixes

* close the silent-success class across all 55 packages ([#536](https://github.com/anolilab/lunora/issues/536)) ([dad6b74](https://github.com/anolilab/lunora/commit/dad6b74b79dd336b13f0b922a6ab32d3345c9657))


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.95

## @lunora/payment [1.0.0-alpha.96](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.95...@lunora/payment@1.0.0-alpha.96) (2026-08-30)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.94
* **@lunora/values:** upgraded to 1.0.0-alpha.34

## @lunora/payment [1.0.0-alpha.95](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.94...@lunora/payment@1.0.0-alpha.95) (2026-08-29)

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
* **@lunora/server:** upgraded to 1.0.0-alpha.93
* **@lunora/values:** upgraded to 1.0.0-alpha.33

## @lunora/payment [1.0.0-alpha.94](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.93...@lunora/payment@1.0.0-alpha.94) (2026-08-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.25
* **@lunora/server:** upgraded to 1.0.0-alpha.92
* **@lunora/values:** upgraded to 1.0.0-alpha.32

## @lunora/payment [1.0.0-alpha.93](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.92...@lunora/payment@1.0.0-alpha.93) (2026-08-28)

### Bug Fixes

* **codegen:** close eight silent-drop gaps in procedure discovery ([#513](https://github.com/anolilab/lunora/issues/513)) ([e393e49](https://github.com/anolilab/lunora/commit/e393e494c0145ad78e0f2b1e27798ed96e7039a3))


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.91

## @lunora/payment [1.0.0-alpha.92](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.91...@lunora/payment@1.0.0-alpha.92) (2026-08-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.90

## @lunora/payment [1.0.0-alpha.91](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.90...@lunora/payment@1.0.0-alpha.91) (2026-08-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.89

## @lunora/payment [1.0.0-alpha.90](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.89...@lunora/payment@1.0.0-alpha.90) (2026-08-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.88

## @lunora/payment [1.0.0-alpha.89](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.88...@lunora/payment@1.0.0-alpha.89) (2026-08-26)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.87
* **@lunora/values:** upgraded to 1.0.0-alpha.31

## @lunora/payment [1.0.0-alpha.88](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.87...@lunora/payment@1.0.0-alpha.88) (2026-08-26)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.86
* **@lunora/values:** upgraded to 1.0.0-alpha.30

## @lunora/payment [1.0.0-alpha.87](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.86...@lunora/payment@1.0.0-alpha.87) (2026-08-26)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.85

## @lunora/payment [1.0.0-alpha.86](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.85...@lunora/payment@1.0.0-alpha.86) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.24
* **@lunora/server:** upgraded to 1.0.0-alpha.84
* **@lunora/values:** upgraded to 1.0.0-alpha.29

## @lunora/payment [1.0.0-alpha.85](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.84...@lunora/payment@1.0.0-alpha.85) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.23
* **@lunora/server:** upgraded to 1.0.0-alpha.83
* **@lunora/values:** upgraded to 1.0.0-alpha.28

## @lunora/payment [1.0.0-alpha.84](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.83...@lunora/payment@1.0.0-alpha.84) (2026-08-25)

### ⚠ BREAKING CHANGES

* authorizeShard takes a single ShardCaller object
({ identity, shardKey }) instead of two positional arguments. Both
previously-natural shapes now fail to compile, which is deliberate -- an
optional argument would have documented the trap while leaving every
un-updated gate silently breaking cron dispatch.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* fix(examples): update authorizeShard call sites

team-chat's gate no longer type-checks against the ShardCaller object.
The remaining changes are code samples and comments that would otherwise
teach the positional shape that no longer exists.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* fix(studio): mask the global data browser

The .global() browser had no mask preview at all: a table carrying a
.use(mask(...)) policy rendered in cleartext, with no toggle and no
header chips, while the sharded browser honoured the same policy on every
surface.

The policy metadata was reachable all along -- maskPolicies is
schema-wide rather than shard-scoped, and a .global() table's declared
field names join against it identically.

Covers the grid cells, header chips, the toggle, the facet sidebar, and
the drill-down filter chips. That last one is the non-obvious surface:
facet a covered column with the preview off, click a value, toggle back
on, and the chip still held the secret.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* build(api): pin re-exports to one printed signature

A subpath re-exporting another subpath's declaration printed the whole
signature again, so auth-ui's six framework ports each re-printed core's
271 declarations and the snapshot reached 39,299 lines -- a real surface
change was unreviewable inside it.

A declaration now prints in full once, under the subpath whose entry
directory contains it, and every other subpath records a pin naming where
the signature is tracked. Keyed by declaration identity rather than name,
so two subpaths exporting the same name from different files stay two
sections. The same rule the script already applied across packages, now
applied within one.

Coverage is unchanged: every export is still recorded per subpath, so
losing a re-export still fails for that port by name. auth-ui drops to
16,691 lines.

Also fixes the drift reporter, which keyed sections by bare export name:
in a multi-subpath snapshot the last section overwrote the others, so a
real signature change could summarise as no change. The gate always
compared whole files, so this affected the message, not the verdict.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* test(runtime): format and annotate the fixture bearer

The scheduler-dispatch test's authorization header trips the secret
scanner's kingfisher.http.2 rule; it is a fixture matching the stub admin
token asserted a few lines below, so it carries an inline allow naming
what it is rather than a baseline entry.

Both files also went in unformatted -- they predate the pre-commit hooks
being wired up, which is what would otherwise have caught this.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* fix(examples): regenerate every stale _generated tree

All 13 examples carried generated output predating a codegen change --
the lifecycle field on RegisteredLunoraFunction, runShardInit/runReactor
dispatch, the inTransaction predicate and the untracked ctx.runQuery
path. 26 files, and nothing had ever noticed.

Output is deterministic (two consecutive sweeps produced byte-identical
diffs) and every regenerated tree typechecks clean.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* build: gate lunora codegen output

check-generated-files.mjs proved three generators reproduce their
committed output and did not cover lunora codegen -- the repo's primary
generator -- so every _generated tree under examples/ drifted unwatched.
All 13 were stale.

The generator list now discovers an entry per example with a codegen
script, so a new example is covered as soon as it has one. Templates are
not gated because they commit no generated output at all: every one of
the 13 lists lunora/_generated in its .gitignore, so there is nothing to
hold to a generator.

The job gains the build the sweep needs, matching what the api-surface
job already pays.

The gate was also not triggering: the generated_files filter matched
manifests and generate-*.js, so a change to packages/codegen/src/emit.ts
-- the exact thing that caused this drift -- matched nothing and the job
never ran. The filter now covers packages/codegen, examples, and the
script itself.

Known limitation, unchanged and now documented: the script compares git
status codes rather than content, so drift inside a file that was already
dirty before the sweep is invisible. Harmless in CI, which starts clean;
it means a local run mid-change cannot detect drift in files you have
already modified.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* docs(studio): record why filter rows stay unmasked

The question of whether the sharded browser's filter bar should mask has
now been asked twice and answered from memory both times. The answer is
no, and the reason is an invariant rather than a preference: a filter
clause rendered in that bar is always simultaneously rendered verbatim in
the address bar, because useDataBrowser mirrors toFilterClauses through
onViewChange into ?filters=. Masking a row would blank a value legible
three inches above it while making the input uneditable.

That is what separates it from the .global() drill-down chips, which are
masked: those are read-only, fed only by a facet click, and held in local
state that never reaches the URL. The two data-derived paths into a
sharded filter are already closed at the source -- a facet click cannot
reach a covered column while the preview is on, and FK traversal seeds
search rather than filters.

Two tests now pin the halves the rationale rests on, so it fails loudly
rather than rotting into a stale comment.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* fix(sdk): chain the dart generated-check analysis

A `\` continuation followed by a comment terminates the command, so the
prose spliced mid-chain detached everything after it: the analysis ran
unchained from the `cp` that stages the smoke, in a script that runs
without `set -e`.

That is the hole the chain was added to close, still open on the one leg
this script exists to gate. The comment moves above the case label, with a
note saying why it cannot live inside the chain. No other shell file in
the repo has the pattern.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* refactor(shared): one fnv1a, not four

`shared/fnv1a.ts` argues in its own header that a shared definition is
what enforces non-drift. Four definitions existed, one of them
`shared/content-digest.ts` in the same directory, and
`notify`'s carried a comment requiring it to reproduce the algorithm
byte-for-byte or delete the wrong subscription row -- a hand-maintained
contract against a function it did not import.

Equivalence was proven before consolidating, across 4,016 inputs
including astral characters and lone surrogates, because a digest change
here picks which row gets deleted. The offset is now a parameter so
`contentDigest` can run its second pass through the same function.

`@lunora/client`'s `hashToken` is deliberately NOT folded in: it uses
`charCodeAt` and combines FNV with djb2, so it is a different digest.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* refactor(studio): share the toolbar button classes

Five copies across the data feature, several commenting themselves
"shared", two already differing in class order. A theme tweak had to land
in five files.

Two exports rather than one, because three of the five carried
`aria-pressed:` styling and two did not. The pressed classes are inert
without the attribute so a single constant would render identically --
but which buttons are toggles is the thing a reader needs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* refactor(codegen): let tsc classify the capabilities

The gate map was `Partial`, with the unmapped keys repeated in a second
list and a test asserting the two partitioned `CapabilityKey`. The map is
now total and credential-based is spelled `null`, so an unclassified
capability fails `tsc` where it is written instead of a test at CI time
-- verified by deleting an entry and reading TS2741.

The surviving test covers what the type cannot: `CAPABILITIES` is a
runtime array, so a row added there without widening `CapabilityKey`
would still leave a real capability out of the map. That is the fail-open
`notify` had.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* fix(runtime): throw the typed error on a denied voice shard

The voice upgrade returned a bare 403 `Response` where every other shard
path throws `FORBIDDEN_SHARD`, so a denied caller there got a status with
no error code to branch on.

Deliberately NOT collapsed into `assertShardAuthorized`, despite reading
like a copy of it: that helper default-denies only a NON-default shard,
and there is no default voice shard, so routing through it would admit a
caller who names the default shard as their threadKey. The difference now
says so in a comment.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* fix(studio): mask the foreign-key hover preview

Hovering an FK cell fetched the TARGET row and rendered its first eight
fields verbatim. The grid's mask view covers the browsed table and says
nothing about another table's columns, so a target's covered columns
showed in the clear in a tooltip beside a grid masking exactly those.

The policies are deployment-wide, so the target resolves without another
fetch. The test uses a column the NAME HEURISTIC cannot catch: the first
version used `apiKey`, which the heuristic masks whichever table is
looked up, so it passed against the unfixed code and proved nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* docs: fix an authorizeShard that 403s the default shard

`assertShardAuthorized` runs the callback for EVERY shard the caller
names once one is configured -- the non-default test is in the `else`,
reached only when there is no callback. So `identity?.userId === shardKey`
rejects the default shard, which is where an unsharded table lives, and an
app copying the snippet 403s every unsharded RPC it has.

The snippets are corrected across the concept docs, the scaling tutorial
and the template comments, and the package's own docs already recommended
the safe form -- the two contradicted each other on lines this branch had
just touched.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* ci: self-list lint.yml in the generated_files filter

The job's workflow now carries the `build:packages` step the codegen
sweep cannot run without. A PR editing only `lint.yml` to drop it matched
`frontend_lintable` -- so eslint ran -- but not `generated_files`, so the
generated-files job was skipped and its required check stayed green while
the guard it protects was removed. The file's own header states this
self-listing rule; four other filters already follow it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* test: pin the AI filter grounding and drop two tautologies

The studio's rationale for leaving filter rows unmasked cited
generateFilter sending column names only, in a comment about another
package with nothing checking it. Now asserted subtractively -- everything
the caller supplied is removed from the serialised payload and the residue
must contain no user data -- rather than as a not.toContain of a value the
test never supplied, which would pass whatever the code did.

Also: a bigint equality assertion that called one pure function twice with
the same argument, and an admin-function count pinned at 50 that would
fail the day someone legitimately adds one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* style(studio): format useMaskView

An eslint --fix arrow-body-style rewrite landed after the file was
formatted, and the version restored from a mutation-test backup captured
that state -- so the concise body became a block body Prettier had never
seen. CI's `prettier --check .` caught it.

This is the ordering CLAUDE.md warns about, in reverse: Prettier must run
BEFORE eslint --fix, and anything restored from a backup afterwards needs
the check re-run against it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

### Bug Fixes

* restore guards and gates that passed silently ([#478](https://github.com/anolilab/lunora/issues/478)) ([62af245](https://github.com/anolilab/lunora/commit/62af2456030c28cba83814e410a9dc2ea1d3e580))


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.82

## @lunora/payment [1.0.0-alpha.83](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.82...@lunora/payment@1.0.0-alpha.83) (2026-08-25)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.81

## @lunora/payment [1.0.0-alpha.82](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.81...@lunora/payment@1.0.0-alpha.82) (2026-08-24)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.80

## @lunora/payment [1.0.0-alpha.81](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.80...@lunora/payment@1.0.0-alpha.81) (2026-08-23)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.79

## @lunora/payment [1.0.0-alpha.80](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.79...@lunora/payment@1.0.0-alpha.80) (2026-08-23)

### Bug Fixes

* **payment:** harden webhook sync and money paths ([#435](https://github.com/anolilab/lunora/issues/435)) ([b8687b0](https://github.com/anolilab/lunora/commit/b8687b0772aa7a9f417cd61fd11f6b1c9f12d71e))

## @lunora/payment [1.0.0-alpha.79](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.78...%40lunora%2Fpayment%401.0.0-alpha.79) (2026-08-18)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.78

## @lunora/payment [1.0.0-alpha.78](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.77...%40lunora%2Fpayment%401.0.0-alpha.78) (2026-08-18)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.77

## @lunora/payment [1.0.0-alpha.77](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.76...%40lunora%2Fpayment%401.0.0-alpha.77) (2026-08-18)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.76

## @lunora/payment [1.0.0-alpha.76](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.75...%40lunora%2Fpayment%401.0.0-alpha.76) (2026-08-15)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.75

## @lunora/payment [1.0.0-alpha.75](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.74...%40lunora%2Fpayment%401.0.0-alpha.75) (2026-08-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/server:** upgraded to 1.0.0-alpha.74
* **@lunora/values:** upgraded to 1.0.0-alpha.27

## @lunora/payment [1.0.0-alpha.74](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.73...%40lunora%2Fpayment%401.0.0-alpha.74) (2026-08-12)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.73

## @lunora/payment [1.0.0-alpha.73](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.72...%40lunora%2Fpayment%401.0.0-alpha.73) (2026-08-11)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.72

## @lunora/payment [1.0.0-alpha.72](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.71...%40lunora%2Fpayment%401.0.0-alpha.72) (2026-08-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/server:** upgraded to 1.0.0-alpha.71
* **@lunora/values:** upgraded to 1.0.0-alpha.26

## @lunora/payment [1.0.0-alpha.71](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.70...%40lunora%2Fpayment%401.0.0-alpha.71) (2026-08-10)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.70

## @lunora/payment [1.0.0-alpha.70](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.69...%40lunora%2Fpayment%401.0.0-alpha.70) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.18
* **@lunora/server:** upgraded to 1.0.0-alpha.68
* **@lunora/values:** upgraded to 1.0.0-alpha.23

## @lunora/payment [1.0.0-alpha.69](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.68...%40lunora%2Fpayment%401.0.0-alpha.69) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/server:** upgraded to 1.0.0-alpha.67
* **@lunora/values:** upgraded to 1.0.0-alpha.22

## @lunora/payment [1.0.0-alpha.68](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.67...%40lunora%2Fpayment%401.0.0-alpha.68) (2026-08-08)

## @lunora/payment [1.0.0-alpha.67](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.66...%40lunora%2Fpayment%401.0.0-alpha.67) (2026-08-07)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.66

## @lunora/payment [1.0.0-alpha.66](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.65...%40lunora%2Fpayment%401.0.0-alpha.66) (2026-08-07)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.65

## @lunora/payment [1.0.0-alpha.65](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.64...%40lunora%2Fpayment%401.0.0-alpha.65) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.16
* **@lunora/server:** upgraded to 1.0.0-alpha.64
* **@lunora/values:** upgraded to 1.0.0-alpha.21

## @lunora/payment [1.0.0-alpha.64](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.63...%40lunora%2Fpayment%401.0.0-alpha.64) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.15
* **@lunora/server:** upgraded to 1.0.0-alpha.63
* **@lunora/values:** upgraded to 1.0.0-alpha.20

## @lunora/payment [1.0.0-alpha.63](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.62...%40lunora%2Fpayment%401.0.0-alpha.63) (2026-08-07)

## @lunora/payment [1.0.0-alpha.62](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.61...%40lunora%2Fpayment%401.0.0-alpha.62) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/server:** upgraded to 1.0.0-alpha.62
* **@lunora/values:** upgraded to 1.0.0-alpha.19

## @lunora/payment [1.0.0-alpha.61](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.60...%40lunora%2Fpayment%401.0.0-alpha.61) (2026-08-04)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.61
* **@lunora/values:** upgraded to 1.0.0-alpha.18

## @lunora/payment [1.0.0-alpha.60](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.59...%40lunora%2Fpayment%401.0.0-alpha.60) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/server:** upgraded to 1.0.0-alpha.60
* **@lunora/values:** upgraded to 1.0.0-alpha.17

## @lunora/payment [1.0.0-alpha.59](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.58...%40lunora%2Fpayment%401.0.0-alpha.59) (2026-08-03)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.59
* **@lunora/values:** upgraded to 1.0.0-alpha.16

## @lunora/payment [1.0.0-alpha.58](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.57...%40lunora%2Fpayment%401.0.0-alpha.58) (2026-08-02)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.58

## @lunora/payment [1.0.0-alpha.57](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.56...%40lunora%2Fpayment%401.0.0-alpha.57) (2026-08-02)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.57

## @lunora/payment [1.0.0-alpha.56](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.55...%40lunora%2Fpayment%401.0.0-alpha.56) (2026-07-31)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.56

## @lunora/payment [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.54...%40lunora%2Fpayment%401.0.0-alpha.55) (2026-07-31)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.10
* **@lunora/server:** upgraded to 1.0.0-alpha.55
* **@lunora/values:** upgraded to 1.0.0-alpha.13

## @lunora/payment [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.53...%40lunora%2Fpayment%401.0.0-alpha.54) (2026-07-31)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.54

## @lunora/payment [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.52...%40lunora%2Fpayment%401.0.0-alpha.53) (2026-07-30)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.53

## @lunora/payment [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.51...%40lunora%2Fpayment%401.0.0-alpha.52) (2026-07-30)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.52

## @lunora/payment [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.50...%40lunora%2Fpayment%401.0.0-alpha.51) (2026-07-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.9
* **@lunora/server:** upgraded to 1.0.0-alpha.51
* **@lunora/values:** upgraded to 1.0.0-alpha.12

## @lunora/payment [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.49...%40lunora%2Fpayment%401.0.0-alpha.50) (2026-07-28)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.50

## @lunora/payment [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.48...%40lunora%2Fpayment%401.0.0-alpha.49) (2026-07-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.49

## @lunora/payment [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.47...%40lunora%2Fpayment%401.0.0-alpha.48) (2026-07-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.48

## @lunora/payment [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.46...%40lunora%2Fpayment%401.0.0-alpha.47) (2026-07-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.47

## @lunora/payment [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.45...%40lunora%2Fpayment%401.0.0-alpha.46) (2026-07-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.46

## @lunora/payment [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.44...%40lunora%2Fpayment%401.0.0-alpha.45) (2026-07-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.45

## @lunora/payment [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.43...%40lunora%2Fpayment%401.0.0-alpha.44) (2026-07-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.44

## @lunora/payment [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.42...%40lunora%2Fpayment%401.0.0-alpha.43) (2026-07-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.43

## @lunora/payment [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.41...%40lunora%2Fpayment%401.0.0-alpha.42) (2026-07-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.42

## @lunora/payment [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.40...%40lunora%2Fpayment%401.0.0-alpha.41) (2026-07-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.41

## @lunora/payment [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.39...%40lunora%2Fpayment%401.0.0-alpha.40) (2026-07-26)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.40

## @lunora/payment [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.38...%40lunora%2Fpayment%401.0.0-alpha.39) (2026-07-26)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.39

## @lunora/payment [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.37...%40lunora%2Fpayment%401.0.0-alpha.38) (2026-07-26)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.38

## @lunora/payment [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.36...%40lunora%2Fpayment%401.0.0-alpha.37) (2026-07-26)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.37

## @lunora/payment [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.35...%40lunora%2Fpayment%401.0.0-alpha.36) (2026-07-26)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.36

## @lunora/payment [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.34...%40lunora%2Fpayment%401.0.0-alpha.35) (2026-07-26)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.35

## @lunora/payment [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.33...%40lunora%2Fpayment%401.0.0-alpha.34) (2026-07-25)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.34

## @lunora/payment [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.32...%40lunora%2Fpayment%401.0.0-alpha.33) (2026-07-25)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.33

## @lunora/payment [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.31...%40lunora%2Fpayment%401.0.0-alpha.32) (2026-07-25)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.32

## @lunora/payment [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.30...%40lunora%2Fpayment%401.0.0-alpha.31) (2026-07-25)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.8
* **@lunora/server:** upgraded to 1.0.0-alpha.31
* **@lunora/values:** upgraded to 1.0.0-alpha.11

## @lunora/payment [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.29...%40lunora%2Fpayment%401.0.0-alpha.30) (2026-07-23)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.30
* **@lunora/values:** upgraded to 1.0.0-alpha.10

## @lunora/payment [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.28...%40lunora%2Fpayment%401.0.0-alpha.29) (2026-07-21)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.29

## @lunora/payment [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.27...%40lunora%2Fpayment%401.0.0-alpha.28) (2026-07-20)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.6
* **@lunora/server:** upgraded to 1.0.0-alpha.28
* **@lunora/values:** upgraded to 1.0.0-alpha.9

## @lunora/payment [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.26...%40lunora%2Fpayment%401.0.0-alpha.27) (2026-07-19)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.27

## @lunora/payment [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.25...%40lunora%2Fpayment%401.0.0-alpha.26) (2026-07-18)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.26

## @lunora/payment [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.24...%40lunora%2Fpayment%401.0.0-alpha.25) (2026-07-17)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.5
* **@lunora/server:** upgraded to 1.0.0-alpha.25
* **@lunora/values:** upgraded to 1.0.0-alpha.8

## @lunora/payment [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.23...%40lunora%2Fpayment%401.0.0-alpha.24) (2026-07-13)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.24

## @lunora/payment [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.22...%40lunora%2Fpayment%401.0.0-alpha.23) (2026-07-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.4
* **@lunora/server:** upgraded to 1.0.0-alpha.23
* **@lunora/values:** upgraded to 1.0.0-alpha.7

## @lunora/payment [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.21...%40lunora%2Fpayment%401.0.0-alpha.22) (2026-07-10)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.22

## @lunora/payment [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.20...%40lunora%2Fpayment%401.0.0-alpha.21) (2026-07-08)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.3
* **@lunora/server:** upgraded to 1.0.0-alpha.21
* **@lunora/values:** upgraded to 1.0.0-alpha.6

## @lunora/payment [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.19...%40lunora%2Fpayment%401.0.0-alpha.20) (2026-07-08)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.20

## @lunora/payment [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.18...%40lunora%2Fpayment%401.0.0-alpha.19) (2026-07-07)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.18

## @lunora/payment [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.17...%40lunora%2Fpayment%401.0.0-alpha.18) (2026-07-06)

## @lunora/payment [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.16...%40lunora%2Fpayment%401.0.0-alpha.17) (2026-07-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.2
* **@lunora/server:** upgraded to 1.0.0-alpha.17
* **@lunora/values:** upgraded to 1.0.0-alpha.5

## @lunora/payment [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.15...%40lunora%2Fpayment%401.0.0-alpha.16) (2026-07-04)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.16

## @lunora/payment [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.14...%40lunora%2Fpayment%401.0.0-alpha.15) (2026-07-03)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.15

## @lunora/payment [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.13...%40lunora%2Fpayment%401.0.0-alpha.14) (2026-07-03)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.1
* **@lunora/server:** upgraded to 1.0.0-alpha.14
* **@lunora/values:** upgraded to 1.0.0-alpha.4

## @lunora/payment [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.12...%40lunora%2Fpayment%401.0.0-alpha.13) (2026-07-03)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.13

## @lunora/payment [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.11...%40lunora%2Fpayment%401.0.0-alpha.12) (2026-07-02)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.12

## @lunora/payment [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.10...%40lunora%2Fpayment%401.0.0-alpha.11) (2026-07-02)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.11

## @lunora/payment [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.9...%40lunora%2Fpayment%401.0.0-alpha.10) (2026-07-02)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.10

## @lunora/payment [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.8...%40lunora%2Fpayment%401.0.0-alpha.9) (2026-07-02)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.9

## @lunora/payment [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.7...%40lunora%2Fpayment%401.0.0-alpha.8) (2026-07-01)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.8

## @lunora/payment [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.6...%40lunora%2Fpayment%401.0.0-alpha.7) (2026-06-30)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.7

## @lunora/payment [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Fpayment%401.0.0-alpha.5...%40lunora%2Fpayment%401.0.0-alpha.6) (2026-06-29)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.6

## @lunora/payment [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.4...@lunora/payment@1.0.0-alpha.5) (2026-06-27)

### Features

* **queue:** add queues, pipelines, secrets bindings + studio queues page ([#30](https://github.com/anolilab/lunora/issues/30)) ([131460c](https://github.com/anolilab/lunora/commit/131460c5826f2ef600fa0ef81248ede91835dd0c)), closes [#29](https://github.com/anolilab/lunora/issues/29) [#31](https://github.com/anolilab/lunora/issues/31) [visulima#714](https://github.com/visulima/visulima/issues/714)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.5
* **@lunora/values:** upgraded to 1.0.0-alpha.3

## @lunora/payment [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.3...@lunora/payment@1.0.0-alpha.4) (2026-06-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.4

## @lunora/payment [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.2...@lunora/payment@1.0.0-alpha.3) (2026-06-27)

### Miscellaneous Chores

* update our og pacakge image ([63e6811](https://github.com/anolilab/lunora/commit/63e6811e2dfb94bc2cc38c05292b527e884660b5))


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.3
* **@lunora/values:** upgraded to 1.0.0-alpha.2

## @lunora/payment [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/payment@1.0.0-alpha.1...@lunora/payment@1.0.0-alpha.2) (2026-06-25)

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.2

## @lunora/payment 1.0.0-alpha.1 (2026-06-21)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Styles

* format source with prettier and ignore generated artifacts ([c63b52a](https://github.com/anolilab/lunora/commit/c63b52a05578b8476cf627babe246acd9730c0f9))

### Miscellaneous Chores

* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.1
* **@lunora/values:** upgraded to 1.0.0-alpha.1
