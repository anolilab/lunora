## @lunora/sql-store [1.0.0-alpha.98](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.97...@lunora/sql-store@1.0.0-alpha.98) (2026-08-28)

### Bug Fixes

* close nine copied-helper divergences across eight packages ([#522](https://github.com/anolilab/lunora/issues/522)) ([a2455bb](https://github.com/anolilab/lunora/commit/a2455bb0f58b9873633504c3f1e9bfeb44a5870e))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.25
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.46
* **@lunora/do:** upgraded to 1.0.0-alpha.108

## @lunora/sql-store [1.0.0-alpha.97](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.96...@lunora/sql-store@1.0.0-alpha.97) (2026-08-28)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.45
* **@lunora/do:** upgraded to 1.0.0-alpha.107

## @lunora/sql-store [1.0.0-alpha.96](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.95...@lunora/sql-store@1.0.0-alpha.96) (2026-08-27)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.44
* **@lunora/do:** upgraded to 1.0.0-alpha.106

## @lunora/sql-store [1.0.0-alpha.95](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.94...@lunora/sql-store@1.0.0-alpha.95) (2026-08-27)

### Bug Fixes

* **shard-engine:** reject cursors minted before the tiebreak changed direction ([#503](https://github.com/anolilab/lunora/issues/503)) ([fdc58bc](https://github.com/anolilab/lunora/commit/fdc58bc6acc6c4f794da42e038c6953d2554c0fe))


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.43
* **@lunora/do:** upgraded to 1.0.0-alpha.105

## @lunora/sql-store [1.0.0-alpha.94](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.93...@lunora/sql-store@1.0.0-alpha.94) (2026-08-27)

### Performance Improvements

* **shard-engine:** sort the id tiebreak the way the key it breaks sorts ([#495](https://github.com/anolilab/lunora/issues/495)) ([8302b06](https://github.com/anolilab/lunora/commit/8302b06c8cbb81c4392c1ca1a3b1e520bdf03a6d))


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.42
* **@lunora/do:** upgraded to 1.0.0-alpha.103

## @lunora/sql-store [1.0.0-alpha.93](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.92...@lunora/sql-store@1.0.0-alpha.93) (2026-08-26)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.41
* **@lunora/do:** upgraded to 1.0.0-alpha.102

## @lunora/sql-store [1.0.0-alpha.92](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.91...@lunora/sql-store@1.0.0-alpha.92) (2026-08-26)

### Performance Improvements

* five profiled hot-path optimizations ([#487](https://github.com/anolilab/lunora/issues/487)) ([12e867c](https://github.com/anolilab/lunora/commit/12e867ceeeae59d364c4d7dc234febab187d0150))


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.40
* **@lunora/do:** upgraded to 1.0.0-alpha.101

## @lunora/sql-store [1.0.0-alpha.91](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.90...@lunora/sql-store@1.0.0-alpha.91) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.24
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.39
* **@lunora/do:** upgraded to 1.0.0-alpha.100

## @lunora/sql-store [1.0.0-alpha.90](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.89...@lunora/sql-store@1.0.0-alpha.90) (2026-08-26)

### ⚠ BREAKING CHANGES

* **do:** `trimCdcChanges` and `compactCdcDocs` take a per-pass row
bound. `minCdcDocSeq` is replaced by `minCdcReplayableSeq`, `countCdcChanges`
is removed, and `shapeProbeKey`/`shapeRangeKey` are no longer exported.
`ShapeDiffCache` is a class with methods instead of a record with public
mutable fields. `cdcChangedTables`, `readSqlCdcChangedTables` and
`readGlobalChangedTables` take a `cursorOnly` argument.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(shard-engine): let a failed cdc index build degrade rather than brick

`CREATE INDEX IF NOT EXISTS` is idempotent, not cheap. On a deployment
upgrading into the new `("table", seq)` index, the first cold start builds it
over everything the changelog accumulated while it had no retention —
synchronously, on the request path. A failure there aborted the whole table
migration, so every subsequent request restarted the build from scratch and
the shard was unbootable rather than slow.

The index build now fails alone. Reads fall back to the `seq` scan they used
before it existed, the retention sweep bounds the log over the following
minutes, and the next cold start retries against a smaller table.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* feat(sql-store): bound the .global() changelog with a leased retention sweep

The `.global()` `__cdc_log` had no retention at all, and could not simply
copy the shard-local sweep: that log has an owner, this one does not. Every
shard in every region writes it, so nothing knows a `seq` that is safe for
all of them, and left alone each would trim it at once.

The cross-shard floor turns out not to need a cursor registry. Its two
consumer classes want opposite things and each is served exactly:

Shape pollers hold in-memory cursors the store cannot see, so the read path
reports the retained floor and a poller below it treats the tick as no
visibility and re-reads every shape — the same self-healing path a changelog
error already takes. A trimmed poller is slow for one tick, never wrong, and
no assumption is made about how far behind a shard can be. The floor is read
only when retention is configured, so a deployment that never trims pays
nothing on a two-second poll.

Streaming-export consumers hold opaque cursors issued outside the
deployment. Nothing here can see them, so nothing guesses: retention is
opt-in (`LUNORA_GLOBAL_CDC_RETENTION_MS`), and `readSqlCdcChanges` refuses a
page below the floor with `CDC_LOG_TRIMMED` rather than serving the
surviving tail behind an advanced cursor.

The window is time, not rows. A row count is a memory bound on one object;
this log is shared, so it is not a bound any single consumer can reason
about, while "older than N" is exactly what they compare their lag against.

A one-row lease settles who sweeps: whoever wins the compare-and-set does,
everyone else returns, and the lease doubles as the interval so the sweep
rate is a property of the log rather than of the shard count. A per-isolate
throttle keeps the lease attempt off every changelog append.

The log this protects was also never written. `createSqlCtxDb` gates its
changelog on `options.cdc`, and codegen passed that flag to the three
shard-local writers and to neither global one — so the global `__cdc_log`
did not exist in any generated app, and the poll's changed-tables fast path
was unreachable while looking, from the shard side, exactly like a backend
with CDC disabled. The shard's own `cdc` config now threads through to both
global writers, so one switch governs both changelogs.
* **do:** `trimSqlCdcChanges` / `trimD1CdcChanges` are replaced by
`sweepSqlCdcRetention` / `sweepD1CdcRetention`, which take a time window
instead of a `seq` checkpoint no caller could compute. `cdcChangedTables`
and `readSqlCdcChangedTables` may now report a `floor`, and the `d1` /
`hyperdriveGlobal` config thunks accept `cdc` and `cdcRetentionMs`.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(codegen): wire the .global() export, cdc-sync and apply worker options

Three worker options the runtime consumes were never set by codegen, and
each fails silently rather than loudly when absent.

`exportGlobals` is the worst of them: `export-stream.ts` guards on
`wantGlobals && exportGlobalsFunction`, so with no function the loop is
skipped, no row is written, and the response is a 200. `lunora export`,
`lunora backup create` and the scheduled R2 backup therefore emitted
shard-local rows only — while `importGlobals` WAS wired, so an
export/import round trip restored cleanly having lost every `.global()`
row. The docs describe the opposite.

`syncGlobals` and `applyGlobals` are the same shape on the admin CDC
endpoints: the sync endpoint returned shard-local changes at 200 and the
apply endpoint reported `globalApplied: 0`. `create-worker.ts` even
documents "wire it to @lunora/d1's readD1CdcChanges" — an instruction
nothing followed, which is why that reader had no production caller.

The emitted sync helper probes `sqlite_master` for `__cdc_log` and returns
an empty page when it is absent, matching `runShardCdcSync`, so an app that
has not enabled CDC reports "no changes" instead of throwing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(do): refuse resume for dependencies the changelog cannot speak for

`evaluateResume` reasoned entirely from `__cdc_log`, but the log records
shard-local table writes only. Anything else a query reads is invisible to
it, and the verdict was optimistic about all of them.

The concrete case is `.global()` tables: `onRead` stamps them into the
read-set, but `insertGlobal` and its twins write to D1 and broadcast — they
never reach `recordCdc`, so no CDC row exists for a global table from any
DO. `cdcTouchesTables` therefore answered `false` for a table that had just
changed, and the client kept a stale value until some shard-local table in
its read-set happened to move. The old `CDC_RESUME_SCAN_LIMIT` masked this
by re-snapshotting long-offline clients outright; removing that cap removed
the accidental safety net with it.

The fix is one rule rather than a case per source. `cdcCanVouchFor` defines
the vouchable set positively — a dependency is vouchable iff a table of that
name exists in this DO's SQLite, which is exactly the namespace `recordCdc`
appends for. `.global()` tables are never created locally, the flags/admin
wildcard `"*"` is not a table, and anything unrecognised falls to the same
default: cannot vouch, re-snapshot. The empty read-set becomes an instance
of the rule instead of its own branch, and the next capability added is safe
by construction rather than by remembering. The gate runs before the
at-the-high-watermark fast path, because a `.global()` write bumps no cursor
here — "already at the watermark" is precisely the state a client that
missed one arrives in.

A PITR restore reverts all of SQLite including the epoch row meant to detect
it, so the proactive bump is rolled back with the data. The one record the
restore cannot reach is the cursor each client cached, so the existing
per-client `sinceSeq > cursor` refusal now also re-mints the epoch
shard-wide: the first client to prove the rollback seals it for everyone who
reconnects later, after post-restore writes have climbed the cursor back
past their own and the per-client guard no longer fires.

That proof is client-supplied, and the epoch it must match rides on every
frame the client already holds — so any subscriber can forge it. The seal is
latched to once per wake: unbounded, each forged frame would cost a write
and invalidate every other subscriber's cached resume, turning one cheap
request into N full snapshots. One seal is all a real fork needs, so the cap
costs the genuine case nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(shard-engine): keep relayed shape subscribers recoverable

Two ways a relayed subscriber went permanently stale, both silent.

The cohort cursor advanced synchronously before a best-effort multicast
that swallows failures, so one failed POST to a relay left the frontier at
the new checkpoint while every socket on that relay still memoed the old
one. The relay gates delivery on `memo.cursor === poke.fromCursor`, so no
future poke ever matched again and those sockets sat on stale rows until
they happened to reconnect.

The owner now rewinds the frontier — in memory and durably, min-only — when
a leg fails, and the relay admits a poke whose range it has partly applied
(`memo.cursor >= fromCursor && memo.cursor < checkpoint`) instead of
demanding equality. Rewinding is safe because a shape diff is not a log
replay: `buildShapeDiff` ships each changed key's CURRENT membership and
value, so a wider range is the same answer plus redundant keys. The
synchronous advance stays, so an interleaving seed still cannot double-apply.
Recovery is now bounded by the next write rather than by a reconnect.

Second, the cohort registry and per-socket proxies were plain in-memory
Maps on the owner — and an owner in relay mode holds no sockets of its own,
so it is freely evictable between writes. After eviction the multicast
returned immediately on an empty registry and NO relayed subscriber
received anything again, for any write, until each reconnected. It also
blinded the retention floor: `minShapeCursor()` returned undefined at
exactly the moment the registry was lost, so the sweep was free to trim the
range those cohorts still needed. Both now live in
`__lunora_relay_shapes`, hydrated once per wake — one row per cohort, which
is cheaper per subscriber than the `__shape_poke_cursor` row the local path
already writes per socket. Proxy rows carry the forwarded identity, without
which a rehydrated proxy would resolve anonymously.

Reclamation stays deliberate: rows drop on relay detach and when the relay
set empties, and nothing else. A per-subscription staleness heuristic would
trade a bounded leak for a silent delete of a live subscriber's range.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(client): stop a full re-seed merging into the stale view it replaces

Four defects on the live-sync path, all silent.

A full shape re-seed was byte-identical on the wire to a delta poke, and
the client cleared its view only on a forked epoch or a diverged base — so
a seed was spliced onto whatever rows it already held. A seed emits only
inserts, so nothing the client kept could ever leave. `.global()` shapes
full-re-seed on every reconnect, and an op-log shape past retention does
too with the epoch unchanged, so both guards were inert. A row deleted
while a tab was away survived for the life of that tab. Pokes now carry a
per-shape `reset` flag, set at every full-seed site (local, global and
relayed), and a reset part clears before applying.

The delta path had none of the poke path's atomicity: `subscriptionFrames`
stamped the same cursor on every frame of a run and the client advanced on
each. A socket dying mid-run left a partly-applied value behind a fully
advanced cursor, and the next reconnect resumed on it — permanently wrong,
never re-snapshotted. The cursor now rides only the last frame of a run.

`pokeBuffers` was keyed by `pokeId` alone and is client-global, but
`pokeId` comes from a per-DO counter that also resets on eviction. Two
shards emitting `poke-1` interleaved: one applied with the other's epoch
and wiped its view, the other found no buffer and dropped its rows while
its cursor stood still. Keyed by `(connection, pokeId)` now.

`baseCheckpoint` was stamped on only one of six poke paths — the one where
a gap is least likely — so the divergence check was armed exactly where it
could not fire and disarmed on every path where a poke actually goes
missing. The live local path now stamps the last checkpoint that carried
rows, and the relayed path stamps `fromCursor`, which the delivery gate
already proves the socket holds.

Also: a cross-tab follower no longer replays a resume cursor with no value
behind it (it would resume into an empty view and hang), and a recognised
row delta that cannot merge re-subscribes for a snapshot instead of
replacing the query value with the raw delta object.

Every field is additive and optional, so a stale client or SDK against a
new server keeps today's behaviour rather than breaking; `protocol/` and
its fixtures record the new keys for the eight non-JS SDKs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(do): give staged search indexes the backfill their docs promise

`.searchIndex(..., { staged: true })` is documented as "skip the
migration-time backfill on this large table, run it out-of-band later", and
`backfillSearchIndexes` carries a docblock naming the out-of-band caller as
"a one-shot admin RPC, a migration step". No such caller existed on
Cloudflare — the only production caller anywhere was the experimental Node
host. So a staged index indexed rows written after the deploy and nothing
before it, permanently, with no supported repair. Non-staged indexes
self-heal a page per migration pass, which is why this stayed hidden.

Wired to the machinery that already exists rather than building more:
`backfillSearchIndexes` takes a page budget and reports progress, a
`backfillSearch` admin RPC drives it, and `lunora run` already forwards any
`__lunora_admin__:` path with the admin bearer — so there is no new CLI
surface. A finished index costs no budget, so a schema whose complete
indexes outnumber the budget still reaches the one that needs work.

Separately: `ctx.scheduler` threw inside every `.global()` table trigger.
`createSqlCtxDb` defaults an absent scheduler to `throwingScheduler`, and
codegen passed one to the shard writer and to neither global writer — while
the same generated object literal resolved the scheduler a few entries
below. A `defineTrigger` on a global table calling `runAfter` failed at
runtime in an app that had a scheduler configured, and nothing rejected it
at build time.

Known gap, documented rather than papered over: a staged index on a
`.global()` table is still stranded. The backfill needs a raw exec and the
DO holds only a writer, so closing it needs a new seam.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* docs(search): name the command that backfills a staged index

The page told readers to "run backfillSearchIndexes from a one-shot admin
path", which described the exact gap the previous commit closed: no such
path existed. It now names the real command, says the backfill is not
optional, and explains the page budget and its resumability — and is honest
that a `.global()` staged index still has no equivalent entry point.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(sql-store): the .global() retention sweep threw on every MySQL deployment

MySQL rejects a `LIMIT` inside an `IN (subquery)` outright — "This version of
MySQL doesn't yet support 'LIMIT & IN/ALL/ANY/SOME subquery'" — so the
bounded DELETE the sweep issues worked on SQLite and Postgres and threw on
every Hyperdrive-MySQL deployment. Materialising the bounded select through
a derived table is the one form all three accept; MySQL's own
`DELETE … ORDER BY … LIMIT` would need a dialect split, since Postgres has
no such syntax, and Postgres requires the alias so it is not optional.

The dialect split in the sweep lease had no test at all: the SQLite suite
only ever exercised `supportsReturning: true`, leaving the MySQL
affected-rows compare-and-set and its `ON DUPLICATE KEY UPDATE` seed to ship
unexecuted. Both engines now carry the sweep case against a real server —
pglite for Postgres, mysql-memory-server for MySQL — and it was the MySQL
one that found this.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(sdks): honour pokePart.reset in all eight non-JS clients

A full shape (re)seed carries the shape's complete membership and is
inserts-only, so a client that splices it onto the view it already holds
keeps every row that left the shape while it was disconnected — for the life
of the client. `.global()` shapes full-reseed on every reconnect and an
op-log shape past changelog retention does too, so this is the common path,
not an edge case. The TypeScript client and the server were fixed with a
`pokePart.reset` flag; the eight ports still merged.

Each client now records the flag per shape while buffering a poke — sticky,
so a seed split across several parts still replaces — and clears that
shape's rows before applying at `pokeEnd`. Each carries a conformance case
driving `resetPokeSequence` to `resetExpectedRows` from the shared fixture,
and each was confirmed to fail without its fix.

The cursor-omission risk that came with the same server change (a delta
frame may now legitimately arrive with no `cursor`, since only the last
frame of a run carries one) turned out to be already handled in all eight:
every port narrows through a presence check into a nullable slot rather than
decoding into a primitive that would silently become 0 and drive the cursor
backwards. An existing manifest case already pins it.

The Dart suite was reporting PASS without running. Case 16 awaited
`StreamIterator.moveNext()` only after feeding the frame it consumes, but
`watch()` is a `Stream.multi` that registers on listen and a `StreamIterator`
listens on its first `moveNext` — so the frame reached no listener, the event
loop emptied, and the isolate exited 0 having run 16 of 70 cases and printed
nothing at all. The runner read that as a pass. Starting each `moveNext`
before its frame is what lets cases 17-70 run.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* test(sdks): require the reset case of every port, not just the eight that have it

`protocol/conformance-cases.json` is the list every SDK suite reads at run
time and fails against, so a name added there turns every language red until
it is covered — which is how the repo stops coverage drifting between ports.
The `reset` case was deliberately left off it while the eight fixes landed
one group at a time, since adding it early would have failed the ports that
had not been written yet.

All eight now assert it, so it becomes required. Verified the gate actually
bites by removing Go's `covers(...)` and watching the suite fail with the
missing name, rather than trusting that listing it was enough.

Rust and Swift dispatch by manifest name rather than declaring standalone
tests, so both drop the "plain test because the manifest would red the other
ports" comment along with the `#[test]` attribute — that reason has expired.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(client): an unseeded delta is not a merge failure

The unmergeable-delta guard treated "no cached base" and "a base the delta
will not splice into" as the same thing, and re-subscribed for both. The
first is the legacy `ShardDO.broadcastDelta` fan-out, which stamps no cursor
at all — its own comment says the path "has no diff baseline to protect" —
so handing the change to a subscriber that has not been seeded strands
nothing, and is what that path has always done. Collapsing the two turned
every broadcast to an unseeded subscriber into a re-subscribe, which the
workerd integration suite caught and no unit test did.

Only the second case is dangerous, and it stays guarded: wholesale
replacement there publishes the `{ key, op, table, row }` envelope over a
real query result, and a frame carrying a cursor advances it, so nothing
would ever reconcile it.

The regression got in because the fix was speculative — its author said
plainly they could not construct a path where the current server sends an
unmergeable delta. It shipped anyway and broke a demonstrable one. The new
unit test pins the distinction so the mocks suite catches it next time
rather than a real workerd.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* feat(codegen): let an app turn CDC on, and cover delta-sync in a fixture

`config.cdc` was permanently `undefined` for every `defineApp()` project —
and every template uses `defineApp()`. The builder never assigns it, no
capability row produces a `.cdc()` method, and `.extend()` merges
`WorkerOptions` rather than `ShardConfig`, so the emitted `createShardDO({…})`
call had no way to carry it.

That is wider than the `.global()` half already fixed. `runShardMigrations`
gates FIVE tables on the flag — `__cdc_log`, `__cdc_meta`,
`__client_watermark`, `__shape_poke_cursor`, `__lunora_relay_shapes` — and
`ShardDO.cdcEnabled()` probes `sqlite_master` for `__cdc_log`, which
`computeOpLogShapeSeed` requires to resume. So on the templated path even
SHARD-LOCAL shapes could never resume: every reconnect re-seeded full
membership, and custom mutators had no watermark table.

The builder gains `.cdc()`, defaulting OFF. Inferring it from
`hasShapes && hasGlobalTables` was the tempting alternative and is wrong:
one flag governs both changelogs, so a project declaring only a `.global()`
shape would silently start paying a changelog row on every shard write too.

The reason this survived a PR, two reviews and an audit is that nothing
exercised it: no example or fixture declared a shape, none set `cdc`, and
the codegen suite asserts substrings of emitted text without ever compiling
it. The new `delta-sync` fixture declares both a shard-local and a
`.global()` shape, commits its generated output, and is imported by its test
so `tsc` pulls the emitted `shard.ts` into the program and actually compiles
it. Verified by breaking the golden's types on purpose and watching tsc fail.

Verified the fixture earns its place: reverting the cdc threading fails
three tests naming exactly that change.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* perf(shard-engine): memoize the table catalog the resume vouch reads

`cdcCanVouchFor` scanned `sqlite_master` on every resume evaluation, and that
question is asked on the hot path the two-stage read exists to keep flat.
Measured against a stubbed baseline on the `cdc-resume-probe` bench: 25.9k hz
with the scan against 31.5k without, so it cost ~18% of `evaluateResume` —
which is what CodSpeed flagged.

The catalog moves only when a migration runs, so it is memoized per `sql`
handle. That restores the baseline exactly (31.4k) with the correctness
intact.

Only POSITIVE answers are cached. A dep the memo does not know re-reads the
catalog once and retries, so a table created by a later migration is picked
up rather than refused forever — a stale negative would silently deny every
resume for it, which nothing else would notice. The reverse case, a table
dropped after being cached, would leave a stale vouch, but a query whose
dependency no longer exists cannot read it, so no live subscription can hold
one. The re-read path has its own test, confirmed to fail against a naive
cache.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(do): refuse resume for a query that read outside the changelog

`cdcCanVouchFor` can only judge dependencies that reach the read-set, and
`ctx.kv`, `ctx.storage`, `ctx.vectors`, `ctx.db.system` and `ctx.flags`
stamped nothing at all. So a query reading a local table AND one of them
arrived with a fully-vouchable read-set and resumed clean while the external
value had moved — the same silent-stale class as the `.global()` case, just
through a door the rule could not see.

Those reads now stamp `UNVOUCHABLE_DEP`, so the existing rule does the work
rather than a second mechanism appearing.

Stamped on CALL, not property access: `createShardCtxDb` probes
`typeof scheduler.list === "function"` while building the ctx, so an eager
`get` trap would mark every query in a scheduler-enabled app unresumable
before a handler read anything.

Deliberately NOT stamped, each for a reason: `ctx.storage.getUrl` /
`getSignedUrl` are pure URL construction with no I/O — and they are what real
handlers call, so stamping them would have made the common storage query
never-resumable for nothing; `ctx.secrets` cannot legitimately move a
subscriber's result; `ctx.analytics` / `ctx.notify` are write-only;
`ctx.env` is static; the action-only surfaces are never subscription-cached.

The sentinel is deliberately NOT `ADMIN_WILDCARD`. That value carries a
second meaning — `writeTouchesMemo` short-circuits on it, re-running the
query on every write-flush — so reusing it would have added a permanent
per-write tax. A distinct name can never appear in a written-table set, so
the live refresh path is bit-for-bit unchanged and a query that read KV
still re-runs exactly when one of its real tables moves.

It also must not escape: the delta frame picked its `table` from the
insertion-ordered read-set, so a query touching KV first would have put the
sentinel on the wire for every client and all eight SDK ports. The frame now
picks the first real dependency.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* test(do): pin the relay registry against real workerd eviction

The relay fixes were verified with a `RelayHost` double over `node:sqlite`,
with eviction simulated by constructing a second `OwnerRelay` over the same
storage. That is faithful to the mechanism but not to the transition, and
the registry-loss defect IS the transition: an owner in relay mode holds no
sockets of its own, so it is freely evictable between writes, and the
in-memory Maps went with it.

Two tests now drive `evictDurableObject` against a real owner+relay pair: a
relayed cohort still receives its poke after the owner is evicted, and
`minShapeCursor()` still reports a real floor rather than `undefined` — the
input `ShardDO.retentionFloor` folds in, so losing it lets the changelog
sweep trim the range those cohorts still need. Confirmed failing without the
hydration: `expected undefined to be 1` is the floor literally gone.

The floor is read through a test-only accessor rather than by driving the
sweep, which sits behind two env knobs and a 60s interval — a sweep-driven
test would prove the sweep works, not that the floor exists.

Deliberately NOT covered, and stated rather than faked: the failed-multicast
leg. `requestRelayMessage` yields one on exactly three conditions, and each
is closed under workerd — an unresolvable binding fails every leg and is
already caught by `canAddressSiblings()`, a same-namespace DO fetch throws
only on an uncaught callee exception with no fault injection available, and
every well-formed relay poke answers 204. Probed empirically rather than
read: a poke to a never-announced relay index, and one to an owner-role DO,
both return 204. So the rewind path stays covered by the double alone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(sdks): bound the pending poke buffers, and say why pokeId needs no scoping

Went looking for the `(connection, pokeId)` requirement `protocol/README.md`
§5.3 imposes and found the eight ports already satisfy it by construction:
every one holds exactly one socket (`attach_socket` REPLACES the sender, no
`handleFrame` carries connection identity), and the frames carry no shard
identity to key on anyway. Two connections means two client instances with
their own buffers, so the collision is unreachable everywhere.

Adding a synthetic key would have fixed a tenth of an already-broken
configuration — routing two sockets into one client also orphans the first at
the second attach, and `resendSubscriptions` then sends every shard's
subscriptions down whichever attached last — while implying multi-socket
support that does not exist. Recorded in the SDK capability matrix instead,
and §5.3 now says the requirement binds a multiplexing client rather than
reading as blanket.

The reachable half of the same paragraph WAS failing. "A socket that drops
mid-poke discards the buffer" — but a buffer is released only at `pokeEnd`,
and an abandoned poke never sends one, so seven of eight accumulated buffers
for the client's lifetime: one per reconnect, unbounded against a peer that
opens pokes it never closes. Rust alone had a cap; the TS client caps at 256.
Classic manifest drift — one port hardened, seven not, every gate green.

It is worse than a leak. `pokeId` resets on DO eviction, so a stale buffer
can be reached by a later poke's `pokeEnd` and APPLY ITS ROWS. Confirmed by
deleting the eviction in the Python port: the ghost row reaches the view.

Rust's oldest-first eviction ported to the other seven. Go and Swift needed
an explicit order list, their maps being unordered, and prune it at `pokeEnd`.
Enforced fleet-wide by `pending_poke_buffers_are_bounded` in the manifest,
asserted black-box in all eight since an evicted buffer is indistinguishable
from one never opened. Gate confirmed to bite on both mechanisms — the
`covers()` call and the dispatcher arm.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(do): keep the relay binding through an empty header and a cold alarm wake

Two ways `shardBinding` went missing, both taking the whole relay tier
silently dark — `siblingStub` resolves nothing, `canAddressSiblings()` is
false, and `onFlush` returns before the multicast.

An EMPTY header overwrote a known binding. A sibling POST stamps
`shardBinding() ?? ""`, so a peer that does not yet know its own binding
sends the empty string — and `headers.get` returns `""` rather than `null`,
so the `??` on the receiving side treated it as a value. `siblingStub` then
resolved `env[""]` to nothing, and the tier stayed dark until some later
request happened to carry a real value. Now an empty header is "not
supplied". The test asserts a relay detach still reaches its owner after one
arrives; without the fix it goes nowhere.

The binding also did not survive an alarm-only wake. An owner in relay mode
holds no sockets of its own, so it is evicted freely, and the TTL sweep and
external-source poll both end in `flushChangedTables` → `onFlush`. An alarm
carries no request, so the per-request binding is gone. No rows are lost —
the cohort cursor never advances, so the next flush that can address
siblings covers the widened range and `buildShapeDiff` ships current values
— but a shard whose subscribers all sit on relays and whose data changes
only on a timer generates no relay→owner traffic to re-supply it, so "until
the next request" can mean indefinitely. The owner now records the binding
when it learns one and reads it back at most once per wake.

The read deliberately does not create its table first: it sits behind the
`canAddressSiblings` guard that exists to keep a single-DO shard's flush off
SQLite entirely, so a missing table just means "nothing recorded".

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* feat(advisor): warn when a query branches on a flag it cannot be invalidated by

Completes the flags decision. `ctx.flags` reads no longer force a
re-snapshot on reconnect — that converged only the reconnect moment while
leaving the query stale for as long as the client stayed connected, paying a
permanent cost for half the property.

Flags are an input the invalidation system does not model: flipping one
appends nothing to `__cdc_log`, so it re-runs no live subscription either.
The reactive path already exists and is correct — a `useFlag` subscription is
tagged `ADMIN_WILDCARD` and re-evaluated on every write-flush. Branching on a
flag inside a cached query is a point-in-time evaluation, and the right
answer is to say so, which is exactly how this repo already handles
`Date.now()` in a query.

WARN rather than the precedent's INFO half: that half exists because a
mutation genuinely has no hazard, running once. Here the hazard is real and
its failure mode is silence — a stale flag branch is indistinguishable from
a correct one client-side, and INFO is filtered out of most surfaces. It also
cannot flood a codebase the way the mutation half did: queries only, and only
on an explicit `ctx.flags` touch.

Known limit, pinned by its own test rather than left implicit: a destructured
receiver (`const { flags } = ctx`) is not detected. That matches
`receiverNameOf`, which misses `const { random } = Math` identically —
following the binding needs the type checker and would make this one lint
behave unlike its siblings.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* test(codegen): recapture the delta-sync goldens after the rebase

The committed `lunora/_generated` goldens predate alpha's emitter work, so
the snapshot test failed once this branch was rebased onto it — the emitted
output now carries alpha's `lifecycle` hook manifest and prototype guard as
well as this branch's search-backfill override.

Regenerated with the repo's own `__tests__/capture-expected.ts` rather than
hand-merged, since the goldens are emitter output by definition. Codegen is
green again at 1343 tests.

* fix(shard-engine): close the delta-sync review findings

**The relay registry stored identity outside the wire codec.** `args` round-trip
through `encodeWire`/`decodeWire` because a value can be a `bigint`, `Date` or
`Uint8Array`; `identity` went through bare JSON on both legs. A `bigint` claim
therefore threw on the seed path, and — the quieter half — a `Date` claim came
back a string, so a rehydrated shape resolved RLS under a claim of a different
type than the live registry used. Not an error, a different answer. Both legs now
use the codec; two regression tests cover the throw and the silent retype, and
both fail against the previous code. The table is new in this branch, so there is
nothing stored to migrate.

**The membership cache did not collapse concurrent reads.** `rows()` awaited
`load()` before publishing its entry, so every caller arriving in that window
started its own backend read — the exact fan-out the cache exists to prevent, and
it inflated `readCount` while doing it. It now caches the in-flight promise and
drops the entry if the read rejects, so a failure is retried next tick rather
than served for the object's life.

**The schema-less backfill hook threw an internal code.** `INTERNAL` is
catalogued `internal`, so `errorToResponse` replaced "this shard was built
without a generated schema" with "internal error" and the caller got a bare 501.
`NOT_IMPLEMENTED` carries the same status and keeps the reason.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016xX4FTtqmhWH97TomT8uww

* test(shard-engine): use the real SubscriptionIdentity shape

The round-trip test put claims at the top level, but `SubscriptionIdentity` is
`{ identity?: Record<string, unknown>; userId?: string }` — the claims live in
the nested `identity`, which is what the review's `Record<string, unknown>` note
was pointing at. `lint:types` failed with TS2353 on the invented keys.

Nesting them exercises the same defect: `JSON.stringify` still throws on a
nested bigint, and a nested `Date` still round-trips to a string. Re-verified
against `HEAD~1` — both cases fail there and pass with the codec fix.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016xX4FTtqmhWH97TomT8uww

* chore(shard-engine): refresh the api snapshot after the rebase

The rebase onto alpha left the committed snapshot behind this branch's own
surface, so `Lint (api surface)` failed. Regenerated off a fresh build.

Everything in the diff is this branch's work: the new delta-sync exports
(`GlobalPollTick`, `ShapeDiffCache`, `CdcChangeKey`, `ShapeProbeCounters`,
`ReadShapeCdcKeys`, `CDC_LOG_TABLE_SEQ_INDEX`, `SearchBackfillProgress`) plus
three signature changes its commits already describe — `backfillSearchIndexes`
takes `maxPages` and reports progress, `trimCdcChanges` takes the retention
bound, and `selectShapeMemberIds` became `selectShapeMembers` returning each
surviving row's document from the same SELECT that tests membership. No export
was dropped.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016xX4FTtqmhWH97TomT8uww

* fix(shard-engine): correct the review fixes the audit found overclaimed

A thermo pass over yesterday's three fixes found the code correct but two of
them justified by comments that are wrong about the call graph. Both reviewers
converged on the same three items independently.

**The single-flight cache guarded a race the design forbids.** `rows()` grew a
promise-publish-before-await, a try/catch and a rethrow to collapse concurrent
callers. There are none, and there deliberately cannot be: `tick.rows` has one
call site, reached through two serial loops that both carry `no-await-in-loop`
disables saying concurrency there is unwanted, and the tick is discarded at the
end of each poll. The catch's claim that a cached rejection would persist "for
the rest of the object's life" was wrong for the same reason. Simplified to the
five-line form, and the docblock now says what is true — the map holds the
in-flight promise so an entry exists from the moment a read starts, which keeps
serialization a property of the caller rather than a requirement here. Failure
recovery stays with `requestResync()`, which already owns it.

**The identity codec claim was overstated.** Routing `identity` through the wire
codec is right for consistency, but the authorization divergence the previous
message described cannot occur: claims reach a shard only through the
`x-lunora-identity` header, which is itself `JSON.stringify`d, so a bigint claim
already throws at the worker and a `Date` is already a string. The transport
half is also still asymmetric — `seedRelayShape` encodes `args` across the
relay→owner hop and forwards `identity` raw. The docblock now records both
facts. Closing the hop is a wire-format change on the relay path and is
deliberately not done here.

Both columns now go through a named `encodeColumn`/`decodeColumn` pair, mirroring
`encodeDocJson`/`decodeDocJson` in `do-sql.ts`, so the halves cannot drift apart
the way they already did once.

**The tests pinned the wrong row shape.** Both seeded cohort rows, which
`OwnerRelay.relayShapes` hydrates while discarding identity entirely. Only a
proxy row carries it, so both cases now set `relayIndex`/`connectionId`, and one
asserts that addressing survives the round trip.

Also from the audit: the `flagsClient` alias the rebase left behind is gone (it
existed only while it was wrapped, and that wrapping was reversed), its 18-line
rationale moved out of the emitted template into the emitter's docblock so it
stops shipping into every generated app, the `no-secrets` suppression now wraps
the whole function instead of sitting between two object properties,
`read-footprint.ts` no longer lists `ctx.flags` among the stamped reads, the
redundant `{ status: 501 }` on a catalog code that already carries it is dropped,
and the protocol table's `delta` row documents the `lastMutationId` that rides
every frame.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016xX4FTtqmhWH97TomT8uww

* fix(shard-engine): close the relay-shape seed and probe review findings

Three defects and four hardenings from the outstanding review notes on the
delta-sync read path.

A relayed shape seed reported its checkpoint at the op-log cursor it was
computed at while memoing the socket at the cohort frontier. Any joiner to a
cohort whose frontier already lagged — which an unrelated write is enough to
cause — was therefore told a base the next multicast poke would not stamp, so
its very first poke failed the client's divergence check and re-seeded it. The
seed now reports the frontier it memos; the poke stamps the socket's own memo
rather than the range's opening cursor, which the admission rule (a range, not
an equality) allows to differ.

A non-uniform relay shape whose subscribe carried no connection id registered
no proxy and wrote no row, but still returned seed frames. The subscriber
rendered one snapshot and was never poked again for the life of the socket,
with nothing logged. It is now refused with RELAY_SHAPE_UNROUTABLE.

`cdcTouchesTables` bound one parameter per table in the read-set, and the
read-set is however many tables one query happened to read. Past workerd's
100-parameter statement cap the resume probe threw instead of answering. It is
chunked now.

Also: the search backfill decided its page budget after walking the page, so a
call arriving with nothing left wrote 500 more rows than the caller asked for;
the shared per-flush scan and membership map are typed read-only, since every
subscriber of a shape in one flush is handed the same objects; the changed-key
read no longer aliases `MAX(seq)` to the column it aggregates; and the backfill
docs name the `.global()` twin, which the shard-local entry point silently
skips.

* test(codegen): recapture the delta-sync golden after the rebase

The base branch added a `head` method to the no-storage `ctx.storage` stub;
the fixture this branch introduced predates it.

* fix(do): close the delta-sync audit findings

Two silent data-divergence paths, one inert feature, and the maintainability
findings from the same audit round.

**A shape over a quiet table pinned the whole retention floor.** A shape whose
table saw no write in a flush was skipped without advancing its cursor, and
`retentionFloor` is a MIN over every recorded cursor — so one subscriber to a
quiet table held the log's floor at its seed cursor indefinitely, and an
operator who set `LUNORA_CDC_LOG_RETENTION` watched the log keep growing with no
error, no metric, and nothing to grep. Such a shape now advances anyway: its
diff over that range is empty without reading the log. The relay tier cannot do
the same — advancing a cohort cursor with no delivered poke puts every relay
socket below the next poke's base and freezes them — so that ceiling is written
down at the floor computation instead.

**The `.global()` PITR applier and bulk importer wrote with CDC off.** Restored
rows reached the tables and nothing else: a warehouse connector's cursor walked
past a range with no entries and its mirror diverged from the database with
nothing on either side able to notice. Both writers now carry the app's own
`cdc` setting.

**A shard-local shape with CDC off seeded once and then never updated.** The
seed reads the table, not the log, so it succeeded; every later diff threw `no
such table` into a per-shape catch and the client rendered one snapshot and went
silent for the life of the socket, reported only on a counter. The subscribe is
now refused with `SHAPE_REQUIRES_CDC`, naming the switch. The playground shipped
in exactly this state and is fixed.

Also: the unvouchable-read sentinel no longer reaches the Studio's reactor
watched-table list; `backfillSearch` rejects a malformed `maxPages` instead of
reading it as "no cap"; the retained-floor predicate and its refusal are stated
once rather than six times across three packages; the two `CDC_SWEEP_MAX_ROWS`
constants no longer share a name at different values; `.global()` poll counters
get their own type, since they are not membership probes and were rendered
through the same component; the instrumented `sql` getter returns one handle per
dispatch, which is what the resume path's table-catalog memo was keyed on; and
the `sealForkedTimeline` threat model no longer understates what a forged frame
buys.

### Performance Improvements

* **do:** rebuild the delta-sync read path — metadata scan, hydrate last ([#432](https://github.com/anolilab/lunora/issues/432)) ([f98847d](https://github.com/anolilab/lunora/commit/f98847df4605b3e20b51c13904411138f434a9bc))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.23
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.38
* **@lunora/do:** upgraded to 1.0.0-alpha.99

## @lunora/sql-store [1.0.0-alpha.89](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.88...@lunora/sql-store@1.0.0-alpha.89) (2026-08-25)

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

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.37
* **@lunora/do:** upgraded to 1.0.0-alpha.98

## @lunora/sql-store [1.0.0-alpha.88](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.87...@lunora/sql-store@1.0.0-alpha.88) (2026-08-25)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.36
* **@lunora/do:** upgraded to 1.0.0-alpha.97

## @lunora/sql-store [1.0.0-alpha.87](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.86...@lunora/sql-store@1.0.0-alpha.87) (2026-08-25)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.35
* **@lunora/do:** upgraded to 1.0.0-alpha.96

## @lunora/sql-store [1.0.0-alpha.86](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.85...@lunora/sql-store@1.0.0-alpha.86) (2026-08-23)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.34
* **@lunora/do:** upgraded to 1.0.0-alpha.93

## @lunora/sql-store [1.0.0-alpha.85](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.84...@lunora/sql-store@1.0.0-alpha.85) (2026-08-21)

### ⚠ BREAKING CHANGES

* **search-core:** an exact-boundary page request
(offset + numItems === 1024) now throws BAD_REQUEST instead of
returning a final page. A ≤1024-match corpus paged right up to the cap
previously got a correct last page; it now gets the same refusal every
other cap-reaching request already got, because without the probe row
the page cannot answer hasMore truthfully. The test that asserted the
boundary page succeeded encoded the bug and now expects the throw;
consumer test regexes tracking the error message were updated to match.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* chore(search-core): align manifest with sibling conventions

Pin @lunora/errors to 1.0.0-alpha.22 like every sibling in the
platform/runtime cluster (runtime, do, shard-engine, d1, sql-store),
so the pin moves with the release tooling instead of floating on
workspace:*. Add the fallow:audit / fallow:dead-code / fallow:health
scripts and the fallow devDependency so the package joins the repo's
dead-code and health gates, and add @vitest/coverage-v8 so the
already-declared test:coverage script can actually run.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(search-core): reject non-finite page sizes

Math.floor(NaN) is NaN and NaN >= MAX_SEARCH_SCAN is false, so a NaN
numItems slid past both the normalization and the cap guard and came
back as a bogus empty terminal page instead of an error. planSearchPage
now refuses any non-finite numItems with the same BAD_REQUEST family
before normalizing; the cap boundary behavior is unchanged for finite
input. Adds a NaN regression test beside the boundary cases.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(search-core): keep the errors dep on workspace:*

The exact-version pins on intra-repo dependencies work because
multi-semantic-release rewrites them on every release — as
pnpm-workspace.yaml documents. @lunora/search-core is private with no
.releaserc.json, so nothing rewrites its manifest: an exact pin
resolves locally only while packages/errors happens to sit at that
version, and the next @lunora/errors release would put the local
package outside the range, make preferWorkspacePackages inert, and
resolve the registry tarball instead — which then gets inlined into
@lunora/server, @lunora/do and @lunora/sql-store, all of which bundle
this package. The lockfile records `specifier: workspace:*` either way,
so CI would not catch the flip. Private packages stay on workspace:*,
as @lunora/auth-ui already does.

Also make the scan-cap refusal actionable: the error now names the
largest numItems that would still leave room for the probe row, since a
power-of-two page walk lands its final page exactly on the cap and the
caller otherwise has to guess. Two comments describing the old
report-isDone-at-the-cap behaviour are corrected to match.
* **search-core:** a search page ending exactly on the 1024-document scan
cap now throws BAD_REQUEST instead of returning a final page. This hits
the last page of any walk whose sizes divide the cap — numItems 512 at
offset 512, 256 at 768, 128 at 896, 64 at 960, 32 at 992, and so on.
Such a page cannot fetch the probe row that distinguishes "exactly this
many matches" from "far more", so its isDone was a guess reported as
fact; the error now names the page size to retry with.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

### Bug Fixes

* **search-core:** refuse the capped boundary page ([#464](https://github.com/anolilab/lunora/issues/464)) ([86bfa63](https://github.com/anolilab/lunora/commit/86bfa631be8d7eabe4399b138b44dc85bf1026d6))


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.33
* **@lunora/do:** upgraded to 1.0.0-alpha.92

## @lunora/sql-store [1.0.0-alpha.84](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.83...%40lunora%2Fsql-store%401.0.0-alpha.84) (2026-08-19)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.32
* **@lunora/do:** upgraded to 1.0.0-alpha.91

## @lunora/sql-store [1.0.0-alpha.83](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.82...%40lunora%2Fsql-store%401.0.0-alpha.83) (2026-08-18)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.31
* **@lunora/do:** upgraded to 1.0.0-alpha.90

## @lunora/sql-store [1.0.0-alpha.82](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.81...%40lunora%2Fsql-store%401.0.0-alpha.82) (2026-08-18)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.30
* **@lunora/do:** upgraded to 1.0.0-alpha.89

## @lunora/sql-store [1.0.0-alpha.81](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.80...%40lunora%2Fsql-store%401.0.0-alpha.81) (2026-08-15)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.29
* **@lunora/do:** upgraded to 1.0.0-alpha.88

## @lunora/sql-store [1.0.0-alpha.80](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.79...%40lunora%2Fsql-store%401.0.0-alpha.80) (2026-08-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.28
* **@lunora/do:** upgraded to 1.0.0-alpha.86

## @lunora/sql-store [1.0.0-alpha.79](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.78...%40lunora%2Fsql-store%401.0.0-alpha.79) (2026-08-11)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.27
* **@lunora/do:** upgraded to 1.0.0-alpha.84

## @lunora/sql-store [1.0.0-alpha.78](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.77...%40lunora%2Fsql-store%401.0.0-alpha.78) (2026-08-11)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.26
* **@lunora/do:** upgraded to 1.0.0-alpha.83

## @lunora/sql-store [1.0.0-alpha.77](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.76...%40lunora%2Fsql-store%401.0.0-alpha.77) (2026-08-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.25
* **@lunora/do:** upgraded to 1.0.0-alpha.82

## @lunora/sql-store [1.0.0-alpha.76](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.75...%40lunora%2Fsql-store%401.0.0-alpha.76) (2026-08-10)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.24
* **@lunora/do:** upgraded to 1.0.0-alpha.81

## @lunora/sql-store [1.0.0-alpha.75](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.74...%40lunora%2Fsql-store%401.0.0-alpha.75) (2026-08-10)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.23
* **@lunora/do:** upgraded to 1.0.0-alpha.80

## @lunora/sql-store [1.0.0-alpha.74](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.73...%40lunora%2Fsql-store%401.0.0-alpha.74) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.18
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.20
* **@lunora/do:** upgraded to 1.0.0-alpha.79

## @lunora/sql-store [1.0.0-alpha.73](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.72...%40lunora%2Fsql-store%401.0.0-alpha.73) (2026-08-09)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.19
* **@lunora/do:** upgraded to 1.0.0-alpha.77

## @lunora/sql-store [1.0.0-alpha.72](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.71...%40lunora%2Fsql-store%401.0.0-alpha.72) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.18
* **@lunora/do:** upgraded to 1.0.0-alpha.76

## @lunora/sql-store [1.0.0-alpha.71](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.70...%40lunora%2Fsql-store%401.0.0-alpha.71) (2026-08-08)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.17
* **@lunora/do:** upgraded to 1.0.0-alpha.75

## @lunora/sql-store [1.0.0-alpha.70](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.69...%40lunora%2Fsql-store%401.0.0-alpha.70) (2026-08-07)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.16
* **@lunora/do:** upgraded to 1.0.0-alpha.73

## @lunora/sql-store [1.0.0-alpha.69](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.68...%40lunora%2Fsql-store%401.0.0-alpha.69) (2026-08-07)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.15
* **@lunora/do:** upgraded to 1.0.0-alpha.72

## @lunora/sql-store [1.0.0-alpha.68](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.67...%40lunora%2Fsql-store%401.0.0-alpha.68) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.16
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.14
* **@lunora/do:** upgraded to 1.0.0-alpha.71

## @lunora/sql-store [1.0.0-alpha.67](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.66...%40lunora%2Fsql-store%401.0.0-alpha.67) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.15
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.13
* **@lunora/do:** upgraded to 1.0.0-alpha.70

## @lunora/sql-store [1.0.0-alpha.66](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.65...%40lunora%2Fsql-store%401.0.0-alpha.66) (2026-08-04)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.12
* **@lunora/do:** upgraded to 1.0.0-alpha.69

## @lunora/sql-store [1.0.0-alpha.65](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.64...%40lunora%2Fsql-store%401.0.0-alpha.65) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.11
* **@lunora/do:** upgraded to 1.0.0-alpha.68

## @lunora/sql-store [1.0.0-alpha.64](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.63...%40lunora%2Fsql-store%401.0.0-alpha.64) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.10
* **@lunora/do:** upgraded to 1.0.0-alpha.67

## @lunora/sql-store [1.0.0-alpha.63](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.62...%40lunora%2Fsql-store%401.0.0-alpha.63) (2026-08-04)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.9
* **@lunora/do:** upgraded to 1.0.0-alpha.66

## @lunora/sql-store [1.0.0-alpha.62](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.61...%40lunora%2Fsql-store%401.0.0-alpha.62) (2026-08-03)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.8
* **@lunora/do:** upgraded to 1.0.0-alpha.65

## @lunora/sql-store [1.0.0-alpha.61](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.60...%40lunora%2Fsql-store%401.0.0-alpha.61) (2026-08-03)

## @lunora/sql-store [1.0.0-alpha.60](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.59...%40lunora%2Fsql-store%401.0.0-alpha.60) (2026-08-02)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.7
* **@lunora/do:** upgraded to 1.0.0-alpha.64

## @lunora/sql-store [1.0.0-alpha.59](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.58...%40lunora%2Fsql-store%401.0.0-alpha.59) (2026-08-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.62

## @lunora/sql-store [1.0.0-alpha.58](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.57...%40lunora%2Fsql-store%401.0.0-alpha.58) (2026-07-31)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.4
* **@lunora/do:** upgraded to 1.0.0-alpha.61

## @lunora/sql-store [1.0.0-alpha.57](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.56...%40lunora%2Fsql-store%401.0.0-alpha.57) (2026-07-31)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.10
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.3
* **@lunora/do:** upgraded to 1.0.0-alpha.60

## @lunora/sql-store [1.0.0-alpha.56](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.55...%40lunora%2Fsql-store%401.0.0-alpha.56) (2026-07-31)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.2
* **@lunora/do:** upgraded to 1.0.0-alpha.59

## @lunora/sql-store [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.54...%40lunora%2Fsql-store%401.0.0-alpha.55) (2026-07-30)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.1
* **@lunora/do:** upgraded to 1.0.0-alpha.58

## @lunora/sql-store [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.53...%40lunora%2Fsql-store%401.0.0-alpha.54) (2026-07-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.57

## @lunora/sql-store [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.52...%40lunora%2Fsql-store%401.0.0-alpha.53) (2026-07-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.56

## @lunora/sql-store [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.51...%40lunora%2Fsql-store%401.0.0-alpha.52) (2026-07-29)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.55

## @lunora/sql-store [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.50...%40lunora%2Fsql-store%401.0.0-alpha.51) (2026-07-28)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.54

## @lunora/sql-store [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.49...%40lunora%2Fsql-store%401.0.0-alpha.50) (2026-07-28)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.53
* **@lunora/errors:** upgraded to 1.0.0-alpha.9

## @lunora/sql-store [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.48...%40lunora%2Fsql-store%401.0.0-alpha.49) (2026-07-27)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.52

## @lunora/sql-store [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.47...%40lunora%2Fsql-store%401.0.0-alpha.48) (2026-07-27)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.51

## @lunora/sql-store [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.46...%40lunora%2Fsql-store%401.0.0-alpha.47) (2026-07-27)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.50

## @lunora/sql-store [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.45...%40lunora%2Fsql-store%401.0.0-alpha.46) (2026-07-26)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.49

## @lunora/sql-store [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.44...%40lunora%2Fsql-store%401.0.0-alpha.45) (2026-07-26)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.48

## @lunora/sql-store [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.43...%40lunora%2Fsql-store%401.0.0-alpha.44) (2026-07-25)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.47

## @lunora/sql-store [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.42...%40lunora%2Fsql-store%401.0.0-alpha.43) (2026-07-25)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.46

## @lunora/sql-store [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.41...%40lunora%2Fsql-store%401.0.0-alpha.42) (2026-07-25)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.45

## @lunora/sql-store [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.40...%40lunora%2Fsql-store%401.0.0-alpha.41) (2026-07-25)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.44
* **@lunora/errors:** upgraded to 1.0.0-alpha.8

## @lunora/sql-store [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.39...%40lunora%2Fsql-store%401.0.0-alpha.40) (2026-07-24)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.43

## @lunora/sql-store [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.38...%40lunora%2Fsql-store%401.0.0-alpha.39) (2026-07-24)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.42

## @lunora/sql-store [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.37...%40lunora%2Fsql-store%401.0.0-alpha.38) (2026-07-23)

## @lunora/sql-store [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.36...%40lunora%2Fsql-store%401.0.0-alpha.37) (2026-07-21)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.37

## @lunora/sql-store [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.35...%40lunora%2Fsql-store%401.0.0-alpha.36) (2026-07-21)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.36

## @lunora/sql-store [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.34...%40lunora%2Fsql-store%401.0.0-alpha.35) (2026-07-21)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.35

## @lunora/sql-store [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.33...%40lunora%2Fsql-store%401.0.0-alpha.34) (2026-07-20)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.34
* **@lunora/errors:** upgraded to 1.0.0-alpha.6

## @lunora/sql-store [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.32...%40lunora%2Fsql-store%401.0.0-alpha.33) (2026-07-19)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.33

## @lunora/sql-store [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.31...%40lunora%2Fsql-store%401.0.0-alpha.32) (2026-07-18)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.32

## @lunora/sql-store [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.30...%40lunora%2Fsql-store%401.0.0-alpha.31) (2026-07-17)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.31
* **@lunora/errors:** upgraded to 1.0.0-alpha.5

## @lunora/sql-store [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.29...%40lunora%2Fsql-store%401.0.0-alpha.30) (2026-07-13)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.30

## @lunora/sql-store [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.28...%40lunora%2Fsql-store%401.0.0-alpha.29) (2026-07-13)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.29

## @lunora/sql-store [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.27...%40lunora%2Fsql-store%401.0.0-alpha.28) (2026-07-12)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.28

## @lunora/sql-store [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.26...%40lunora%2Fsql-store%401.0.0-alpha.27) (2026-07-11)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.27
* **@lunora/errors:** upgraded to 1.0.0-alpha.4

## @lunora/sql-store [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.25...%40lunora%2Fsql-store%401.0.0-alpha.26) (2026-07-08)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.26
* **@lunora/errors:** upgraded to 1.0.0-alpha.3

## @lunora/sql-store [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.24...%40lunora%2Fsql-store%401.0.0-alpha.25) (2026-07-07)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.25

## @lunora/sql-store [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.23...%40lunora%2Fsql-store%401.0.0-alpha.24) (2026-07-04)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.24
* **@lunora/errors:** upgraded to 1.0.0-alpha.2

## @lunora/sql-store [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.22...%40lunora%2Fsql-store%401.0.0-alpha.23) (2026-07-04)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.23

## @lunora/sql-store [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.21...%40lunora%2Fsql-store%401.0.0-alpha.22) (2026-07-03)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.22
* **@lunora/errors:** upgraded to 1.0.0-alpha.1

## @lunora/sql-store [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.20...%40lunora%2Fsql-store%401.0.0-alpha.21) (2026-07-03)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.21

## @lunora/sql-store [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.19...%40lunora%2Fsql-store%401.0.0-alpha.20) (2026-07-03)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.20

## @lunora/sql-store [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.18...%40lunora%2Fsql-store%401.0.0-alpha.19) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.19

## @lunora/sql-store [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.17...%40lunora%2Fsql-store%401.0.0-alpha.18) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.18

## @lunora/sql-store [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.16...%40lunora%2Fsql-store%401.0.0-alpha.17) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.17

## @lunora/sql-store [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.15...%40lunora%2Fsql-store%401.0.0-alpha.16) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.16

## @lunora/sql-store [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.14...%40lunora%2Fsql-store%401.0.0-alpha.15) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.15

## @lunora/sql-store [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.13...%40lunora%2Fsql-store%401.0.0-alpha.14) (2026-07-01)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.14

## @lunora/sql-store [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.12...%40lunora%2Fsql-store%401.0.0-alpha.13) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.13

## @lunora/sql-store [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.11...%40lunora%2Fsql-store%401.0.0-alpha.12) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.12

## @lunora/sql-store [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.10...%40lunora%2Fsql-store%401.0.0-alpha.11) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.11

## @lunora/sql-store [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.9...%40lunora%2Fsql-store%401.0.0-alpha.10) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.10

## @lunora/sql-store [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.8...%40lunora%2Fsql-store%401.0.0-alpha.9) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.9

## @lunora/sql-store [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.7...%40lunora%2Fsql-store%401.0.0-alpha.8) (2026-06-29)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.8

## @lunora/sql-store [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.6...@lunora/sql-store@1.0.0-alpha.7) (2026-06-28)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.7

## @lunora/sql-store [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.5...@lunora/sql-store@1.0.0-alpha.6) (2026-06-27)

### Features

* **queue:** add queues, pipelines, secrets bindings + studio queues page ([#30](https://github.com/anolilab/lunora/issues/30)) ([131460c](https://github.com/anolilab/lunora/commit/131460c5826f2ef600fa0ef81248ede91835dd0c)), closes [#29](https://github.com/anolilab/lunora/issues/29) [#31](https://github.com/anolilab/lunora/issues/31) [visulima#714](https://github.com/visulima/visulima/issues/714)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.6

## @lunora/sql-store [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.4...@lunora/sql-store@1.0.0-alpha.5) (2026-06-27)

### Features

* extending db  ([#32](https://github.com/anolilab/lunora/issues/32)) ([6b77a16](https://github.com/anolilab/lunora/commit/6b77a16996e6aa59c19c801c3ea18004deccd6dc))

### Miscellaneous Chores

* update our og pacakge image ([63e6811](https://github.com/anolilab/lunora/commit/63e6811e2dfb94bc2cc38c05292b527e884660b5))


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.5

## @lunora/sql-store [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.3...@lunora/sql-store@1.0.0-alpha.4) (2026-06-24)

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.4

## @lunora/sql-store [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.2...@lunora/sql-store@1.0.0-alpha.3) (2026-06-22)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.3

## @lunora/sql-store [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.1...@lunora/sql-store@1.0.0-alpha.2) (2026-06-22)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.2

## @lunora/sql-store 1.0.0-alpha.1 (2026-06-21)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Miscellaneous Chores

* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.1
