# Plan 557 — Design the split of `shard-do.ts`

**Baseline:** `94de493ad` (`origin/alpha`, 2026-11-24). First written against `4a7c48bfd` (2026-11-11).
**Status:** workstream 0 DONE (design below). Workstream 1 on `refactor/shard-do-split-design`
(PR #1691), one commit per step: steps 1, 2, 3 and 5 DONE; steps 4 and 6-10 STOPPED by R6 (§6).
The per-frame-type split of `handleWebSocketMessage` is DONE. The conflict replay (§7) showed that no
further split of this file buys meaningfully fewer merge conflicts, so the work ends here.
`shard-do.ts`: 21,278 → 19,573 lines.
**Priority / effort / risk:** P3 / L / MED. **Category:** tech-debt.

## 0. Headline finding

`packages/do/src/shard-do.ts` is 21,278 lines at the baseline, up 952 in 13 days. The abstract
`ShardDO` class starts at line 2333 and has 625 members (161 instance fields, 464 methods and
accessors carrying 17,093 lines). 121 non-release commits touched it in the last 90 days, out of 130
that touched `packages/do/src` at all, so nearly every `do` change edits this one file. That conflict
rate is the cost, not the line count.

The split works when a cluster moves **with the state it owns** into a collaborator object that
`ShardDO` holds as a field. Moving methods alone, without their state, needs a bag of callbacks into
`this`, which an earlier attempt measured and rejected. The order below starts with the clusters that
own their state outright and have no protected surface.

## 1. Why the split was deferred, and what is different now

- `plans/135-stable-1.0-roadmap.md:395` lists the split (TECH-01) as "maintainability, not
  correctness; stays deferred". It was left out of the 1.0 gate, and no technical blocker was
  recorded.
- The one attempt so far, `a2455bb0f` (#522), moved 13 `this`-free admin readers into
  `admin-readers.ts` (11,273 → 11,012 lines) and stopped. Its reason: the remaining readers call
  hooks that take a table argument (`tableRefs`, `tableColumns`, `tableIndexes`), so moving them
  "means passing a callback bag rather than a value … and it buys only line count". It also noted
  that the shape/subscription cluster and the codegen-emitted `protected override` hooks cannot move.
- What this design changes:
    1. The goal is fewer conflicts, not fewer lines. A cluster that changes for its own reasons
       (outbox, metrics, rooms) moves to its own file, so its commits stop touching the god-file.
    2. Clusters move with their fields. The host interface then stands in for fields that are
       deleted from the class; it is not added on top of them. §4 rule R6 turns "buys only line
       count" into a STOP condition that can be measured.
    3. The hooks and the per-dispatch request scope stay on the class (§4 R3, R4). Those are the parts
       #522 found it could not move, and nothing here moves them.
    4. The pattern is already in use on this class: `CdcRetentionRunner` (`cdc-retention.ts`),
       `InFlightClaims`, `SocketTableIndex` and `DurableStreamRunner` are collaborators built from a
       host interface of thunks and held as `private readonly` fields.

## 2. Cluster map (D1)

Measured at the baseline with a ts-morph pass over the class. For each member it records the line
span, the instance fields it reads, the fields it assigns or mutates (`=`, `++`,
`.set/.add/.delete/.push/...`), and the members it calls. Members are grouped by concern. A field is
**owned** by a cluster when only that cluster writes it. A **shared write** is a field that more than
one cluster writes.

Column key: **prot** = protected members (in `api-snapshots/do.api.md`; codegen or subclasses may
call them). **out** = other clusters called / call sites. **in** = clusters calling in / members
called from outside. **test reach** = private members that a test reads by name through
`as unknown as { … }`. Moving one of those needs a test edit (§4 R7).

| Cluster                                                                                                                              | members | lines | prot | owned fields | shared writes | out     | in      | test reach                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------: | ----: | ---: | -----------: | ------------: | ------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| admin RPC handlers (`handleAdminRpc`, `handle*`, `readAdmin*`, AI/mail/queue/token ops)                                              |      55 |  1820 |    0 |            2 |             1 | 16 / 96 | 3 / 3   | `readAdminWildcardOp`                                                                                                                                                  |
| entry points (`constructor`, `fetch`, `webSocket*`, `alarm`, `handleFetchCloudflare`, `handleWebSocketMessage`, …)                   |      11 |  1792 |    3 |           14 |            14 | 22 /118 | 6 / 4   | `shardHost`, `socketHost`, `shapeMemos`, `globalShapeSnapshots`, `closingSockets`, `relay`, `replica`, `replicaOwnerHost`                                              |
| subscriptions and refresh (`subscribe`, `refreshSubscriptions`, `seed*`, `flushChangedTables`, `pushSubscriptionData`, …)            |      45 |  1724 |    4 |           11 |             5 | 14 / 55 | 11 / 13 | `flushChangedTables`, `pushSubscriptionData`                                                                                                                           |
| rooms, whisper, socket routes                                                                                                        |      31 |  1141 |    0 |            9 |             2 | 9 / 46  | 3 / 17  | `authorizeWhisper`, `rejectRetainedRooms`, `allowWhisper`, `socketMayReceiveRouteTopic`, `dispatchSocketEvent`, `runRoomHandler`, `forwardRoomEvent`, `relayRoomEvent` |
| telemetry (spans, logger, tracer, wide event, `recordUserLog`)                                                                       |      23 |   982 |   13 |            3 |             4 | 1 / 7   | 5 / 7   | `spans`, `metricSeries`, `lifecycleInfo`                                                                                                                               |
| shapes and pokes (`shapeSubscribe`, `pokeShapeSubscribers`, `sendPoke`, shape memos/cursors)                                         |      23 |   932 |    3 |            2 |             3 | 7 / 35  | 7 / 9   | `seedShapeSubscription`                                                                                                                                                |
| subclass hooks (`tableRefs`, `prepareFunction`, `runShard*`, `*Metadata`, `liveStreams`, `shardRegistry`, …)                         |      54 |   898 |   54 |            0 |             0 | 2 / 2   | 16 / 53 | —                                                                                                                                                                      |
| sockets: upgrade, auth, attachments (`handleWebSocketUpgrade`, `reauthenticateSocket`, `readAttachment`, …)                          |      25 |   828 |    2 |            3 |             1 | 7 / 13  | 9 / 14  | `readAttachment`                                                                                                                                                       |
| global poll and refresh (`pollGlobalShapes`, `refreshGlobalShape`, snapshots, `recordGlobalWrite`)                                   |      22 |   750 |    3 |            8 |             4 | 7 / 33  | 6 / 7   | `scheduleGlobalPoll`                                                                                                                                                   |
| schedule outbox (`scheduleOutbox`, `pollScheduleOutbox`, hand-off/drop/retry)                                                        |      22 |   701 |    2 |            5 |             2 | 5 / 17  | 3 / 4   | `handleDropOutboxEntry`, `handleRetryOutboxEntry` (these stay on the class, R5)                                                                                        |
| request scope (`getCurrent*`, `captureRequestScope`, `beginDispatch`/`endDispatch`, `withRequestIdentity`, …)                        |      23 |   616 |   16 |           15 |            10 | 2 / 2   | 14 / 16 | —                                                                                                                                                                      |
| live streams (`handleLiveConnect`, `broadcastLiveTopic`, `publishLiveEvent`, grant index)                                            |      16 |   614 |    4 |            3 |             2 | 3 / 11  | 2 / 6   | `handleLiveSocketControl`, `deliverLiveLocal`                                                                                                                          |
| `ctx.db` and SQL (`sql`/`db` getters, `runCachedQuery`, read/index hooks, `recordChangedTable`)                                      |      10 |   553 |   10 |            3 |             8 | 2 / 5   | 13 / 4  | —                                                                                                                                                                      |
| mutation bookkeeping and idempotency (`evaluateResume`, `*Idempotent*`, `classifyClientMutation`, …)                                 |      13 |   548 |   13 |            1 |             1 | 4 / 14  | 2 / 9   | —                                                                                                                                                                      |
| function metrics (`recordFunctionCall`, `fold*`, `flushPendingMetrics`, `collectFunctionStats`, `collectMetrics`, root-size warning) |      12 |   519 |    0 |            7 |             0 | 0 / 0   | 3 / 7   | `functionStats`, `pendingFunctionMetrics`                                                                                                                              |
| alarm admission and TTL (`admitAlarmRearm`, `admitScheduleRate`, `pollTtlSweeps`, `armRecoveryWake`, …)                              |      12 |   389 |    3 |            2 |             1 | 5 / 15  | 4 / 5   | —                                                                                                                                                                      |
| transaction (`runInTransaction`, `deferAfterCommit`, `deferPastResponse`, …)                                                         |       6 |   347 |    5 |            5 |             0 | 3 / 4   | 3 / 2   | —                                                                                                                                                                      |
| reactors and shard init                                                                                                              |      10 |   345 |    8 |            1 |             1 | 9 / 21  | 3 / 3   | —                                                                                                                                                                      |
| query streams (`handleStream`, `pumpStream`, `attachDurableStream`, …)                                                               |       9 |   343 |    2 |            0 |             1 | 4 / 9   | 1 / 1   | `handleStream`                                                                                                                                                         |
| CDC sync and epoch (`runShardCdcSync`, `cdcEnabled`, `cachedCdcEpoch`, `sealForkedTimeline`, …)                                      |       9 |   306 |    5 |            3 |             0 | 1 / 5   | 7 / 9   | —                                                                                                                                                                      |
| dispatch core (`handleBatchRpc`, `preDispatchAnswer`, headroom/limits)                                                               |      10 |   305 |    4 |            0 |             1 | 7 / 9   | 8 / 7   | —                                                                                                                                                                      |
| request log and audit (`recordRequestLog`, `recordAudit`, …)                                                                         |       5 |   201 |    0 |            0 |             0 | 2 / 3   | 4 / 4   | `recordAudit`                                                                                                                                                          |
| delivery authorization (`authorizeSubscription`, `installDeliveryFence`, `fetchAuthorizedRpc`, …)                                    |       7 |   189 |    0 |            2 |             1 | 4 / 12  | 2 / 5   | —                                                                                                                                                                      |
| **shard registration** (`registerWrittenShard`, `serializeRegistry`, `registryWriter`, release, `tableHasRows`)                      |       6 |   181 |    0 |            3 |             0 | 4 / 6   | 2 / 2   | —                                                                                                                                                                      |
| sensitive-args scope                                                                                                                 |       5 |    69 |    5 |            0 |             0 | 1 / 2   | 4 / 2   | —                                                                                                                                                                      |

### Shared state that blocks a move

A cluster cannot move while it writes a field that another cluster also writes. These are the
fields with more than one writer, and how each one gets a single owner:

| Field(s)                                                                                         | Writers                                                 | Resolution                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logs` (`LogBuffer`)                                                                             | 9 clusters                                              | Not shared state: an append-only sink. Hand it to collaborators as `log: LogBuffer` (or a `recordShapeError`-style thunk). Never moves.                           |
| `deliveryAuthorization`                                                                          | entry, delivery auth, subscriptions, shapes, rooms      | Owned by delivery authorization; the others clear it through one method on that collaborator. Blocks subscriptions/shapes/rooms until then.                       |
| `currentRequest*`, `currentMutatorClass`, `traceSampling`, `mutationBookkeeping`, `currentStmt*` | request scope + entry/telemetry/ctxDb/mutation/dispatch | Stays on the class (R4). Collaborators read it through host getters and never write it.                                                                           |
| `pendingChangedTables/Keys/Bookmarks`, `pendingGlobalWriteTables`                                | ctxDb, global poll, subscriptions                       | One `ChangeAccumulator` collaborator owning all four: `recordChangedTable`/`recordGlobalWrite` write it, `flushChangedTables` drains it. Prerequisite for step 8. |
| `globalPollArmedAt`                                                                              | entry (alarm), outbox, global poll                      | Owned by alarm scheduling; outbox and global poll arm through a host `armAlarmAt(ms)`.                                                                            |
| `liveSocketsByConnection`, `liveGrantSockets`                                                    | entry (`webSocketClose`), live, sockets                 | Owned by live; `webSocketClose` calls `live.forgetSocket(ws)`.                                                                                                    |
| `streamCancellers`, `shapeMemos`, `globalShapeSnapshots`, `closingSockets`                       | entry (`webSocketClose`) + owning cluster               | Same shape: the close path calls a `forget(ws)` on the owner.                                                                                                     |
| `reactiveCache`, `ctxDbCacheWired`, `dispatchSpans`, `lastTelemetrySink`, `pokeSequence`         | constructor + one cluster                               | Not a conflict: the constructor initializes, one cluster writes afterwards. The owner takes the initial value through its host.                                   |

### Protected and generated surface

- `api-snapshots/do.api.md` pins 195 protected/public `ShardDO` members. `scripts/api-snapshot.js`
  drops `private` members from the snapshot (`/^\s*private\b[^(]*;$/`). A private collaborator field
  and the private members it replaces are therefore invisible to `api:check`. Changing a protected
  member's name, signature or presence is not.
- The codegen-emitted subclass (`packages/codegen/src/emit/shard.ts`) overrides 24 hooks:
  `advisories ensureMigrated ensureShardInit isCacheableQuery isPaidFunction isPerDispatchFunction
lifecycleHookPaths liveStreams loadLiveStream maskMetadata prepareFunction rlsMetadata roomHandlerPath
runReactor runShardInit runShardSearchBackfill sensitiveArgNames socketRoute storageColumns
storageRulesMetadata studioFeatures tableColumns tableIndexes tableRefs ttlSweeps`. It also calls
  base members: `ensureMigrated prepareFunction recordChangedTable recordGlobalWrite
recordLateGlobalWrite dispatchShardInit recordShardInitError transactionHeadroom subscriptionHeadroom
scheduleTtlSweep restoreRequestScope captureRequestScope recordStalePatchDropped publishLiveFromAction
isSystemDispatch isInTransaction ipKeyedFunctionPaths invalidateCompanionMemo holdShardWhileLoading
globalCdcOptions getInboundBookmark getCurrentBaselineSeq getCtxDb{Read,ReadRange,IndexUse}Hook
deferAfterCommit ctxDbTuning sql`.
- 99 test subclasses in `packages/do/__tests__`, 6 benches, and tests in `platform-node`, `runtime`,
  `client` and `platform-celld` also extend `ShardDO`.

## 3. Target module layout

Flat files in `packages/do/src/`, matching the existing collaborators (`cdc-retention.ts`,
`in-flight-claims.ts`, `socket-table-index.ts`). No subdirectory: `do` has no second shard class that
would need one. Each file exports one collaborator class, plus free functions where a part of the
cluster is `this`-free. None is re-exported from `src/index.ts`.

| File                                                            | Collaborator                           | Cluster                                                          |
| --------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| `shard-registration.ts`                                         | `ShardRegistration` (**done**, step 1) | shard registration                                               |
| `function-metrics.ts`                                           | `FunctionMetrics` (**done**, step 2)   | function metrics                                                 |
| `cdc-meta.ts`                                                   | `CdcMeta` (**done**, step 3)           | CDC presence/epoch memos and fork seal (the private half of CDC) |
| `alarm-rearm-breaker.ts`, `schedule-rate-breaker.ts` (existing) | stopped (step 4)                       | alarm admission                                                  |
| `schedule-outbox.ts`                                            | `ScheduleOutboxRunner` (**done**, 5)   | schedule outbox                                                  |
| `query-streams.ts`                                              | stopped (step 6)                       | query streams                                                    |
| `change-accumulator.ts`                                         | stopped (step 7)                       | pending changed tables/keys/bookmarks (prerequisite for 8-10)    |
| `live-topics.ts`                                                | stopped (step 8)                       | live streams                                                     |
| `rooms.ts`                                                      | stopped (step 8)                       | rooms, whisper, socket routes                                    |
| `global-poll.ts`                                                | stopped (step 9)                       | global poll and refresh                                          |
| `shape-pokes.ts`                                                | stopped (step 10)                      | shapes and pokes                                                 |
| `subscription-refresh.ts`                                       | stopped (step 10)                      | subscriptions and refresh                                        |

These stay in `shard-do.ts` for good: the entry points (Cloudflare calls them on the class), the
subclass hooks, the request scope, the transaction, mutation-bookkeeping and dispatch core,
`ctx.db`, telemetry, and the admin dispatch table. Module-level helpers move with the cluster that
uses them (the schedule-outbox helpers at the top of the file went with step 5). The original
estimate, 10-12k lines after step 10, assumed the reactive engine could move one cluster at a time.
It cannot (§6), and moving it whole is not worth it (§7), so the file stays around 19.5k lines.

## 4. How a moved cluster gets its state (D2)

- **R1 — collaborator, not free functions, when the cluster owns state.** The shape of
  `CdcRetentionRunner`: `class X { constructor(host: XHost) }`, with the cluster's fields moved
  onto `X` as `private`. `ShardDO` holds it as `private readonly x = new X({ … })`. A `this`-free
  part of a cluster (no fields read or written) moves as free functions taking `(sql, args)`
  instead, like `admin-readers.ts` and `schema-history-reads.ts`.
- **R2 — the host is thunks.** Every entry is a function, never a captured value: the field
  initializer runs before the constructor assigns `state`, `env` and the hosts, and subclass hooks
  must be asked on every call. The host interface is module-private (not exported, not in the
  index), so it widens neither the public nor the protected API.
- **R3 — hooks never move.** The 54 hook members stay on `ShardDO` with their signatures. A
  collaborator that needs one gets a thunk (`registry: () => this.shardRegistry()`), so a codegen
  override keeps working.
- **R4 — the request scope never moves.** `beginDispatch`/`endDispatch` and the
  `currentRequest*` fields are the per-dispatch state every cluster reads. Collaborators read the
  scope through host getters (`shardKey: () => this.currentShardKey()`) and never write it.
- **R5 — admin handlers stay as thin wrappers.** The admin dispatch table and each
  `handle<Op>(args)` stay on the class as decode → call the collaborator → audit → `adminResponse`
  (the AGENTS.md "thin transport" rule). The behaviour moves to the owning cluster's module. The
  admin cluster is not extracted as a unit, because it calls into 16 other clusters. It shrinks as
  each owner leaves.
- **R6 — STOP rule, measured.** Count the class members (methods + fields) a step removes, the
  members it adds (collaborator fields, forwarding methods, wrappers that stay), and the host
  entries. A protected member whose body moves stays as a one-line forward to keep `api:check` at
  zero; each such forward counts as added. STOP the step if added + host entries ≥ removed. (The
  first version compared host entries with the cluster's fields. That stopped the outbox, which
  removes 27 members for 5 added and a 6-entry host, so it measured the wrong thing.)
- **R7 — tests.** No assertion, fixture or expected value changes. A test that reads a moved
  private member by name through `as unknown as { … }` gets its access path retargeted in the same
  PR (for example `shard.functionMetrics.pending` instead of `shard.pendingFunctionMetrics`), and
  the PR body lists every such line. Any other test edit is a STOP.
- **R8 — no shared writes across a boundary.** A step may not move a cluster that writes a field
  some other cluster also writes. Resolve the owner first (table in §2), in its own PR.

## 5. Extraction order (D3) and per-step gates

The plan's earlier guess was to start with admin/export. The map rules that out: admin has the
widest outbound surface of any cluster (16 clusters, 96 call sites). The order instead ranks by
shared writes (0 first), protected members to forward, outbound calls, and test reach.

| Step | Cluster                       | Why here                                                                                                                                                                                                                                                 | R6 count (removed → added)  | Test retargets                                               |
| ---: | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------ |
|    1 | shard registration (**done**) | 3 owned fields, no shared writes, no protected members, no test reach; own test file                                                                                                                                                                     | 9 → 1                       | none                                                         |
|    2 | function metrics              | 7 owned fields, calls no other cluster, no protected; host = `sql`, `env`. `collectMetrics` (reads `reactiveCache`, `runner`, `metrics`) stays as the `getMetrics` assembler, and the public static `resetRootSizeWarning` stays. Hot path: bench needed | ~17 → 1                     | `function-metrics.test.ts`, `shard-do.bounded-state.test.ts` |
|    3 | CDC presence/epoch memos      | 3 owned fields, calls only `sql`; the 5 protected CDC members stay. Move only the private memos and `sealForkedTimeline`'s body                                                                                                                          | ~7 → 2 (protected forwards) | none                                                         |
|    4 | alarm admission               | 2 owned fields; the breaker modules already exist and gain their per-instance state; writes only the `logs` sink                                                                                                                                         | ~6 → 1                      | none                                                         |
|    5 | schedule outbox               | 5 owned fields, reads no other cluster's fields; `scheduleOutbox`/`pollScheduleOutbox` stay protected forwards; `globalPollArmedAt` goes through `armAlarmAt` first                                                                                      | ~27 → 3                     | none (admin handlers stay, R5)                               |
|    6 | query streams                 | no owned fields; `streamCancellers` gets a `forget(ws)` for `webSocketClose`                                                                                                                                                                             | ~10 → 3                     | `handleStream` stays (entry point)                           |
|    7 | `ChangeAccumulator`           | gives the four pending-change fields one owner; unblocks 8-10                                                                                                                                                                                            | 4 fields + drain → 1        | `flushChangedTables` stays                                   |
|    8 | live streams, then rooms      | socket-indexed; need the `forget(ws)` close hooks; large test reach, so one PR each                                                                                                                                                                      | per PR                      | listed in §2                                                 |
|    9 | global poll                   | after 7; shares `globalPollArmedAt` (step 5) and snapshots                                                                                                                                                                                               | per PR                      | `scheduleGlobalPoll`                                         |
|   10 | shapes, then subscriptions    | the reactive core; last, after `deliveryAuthorization` has one owner                                                                                                                                                                                     | per PR                      | listed in §2                                                 |

Telemetry (13 protected `make*`/`record*` members called by codegen and subclasses) and the request
log are left out of the order. Moving them would be mostly protected forwards, and R6 would stop
them.

**Every step** is one commit (the maintainer chose a single branch for all of them), a pure move,
and reviewable with `git diff --color-moved=zebra`: the moved bodies differ only in `this.` →
`this.host.` and in their field names. Gates per step:

1. `pnpm run api:check`: zero diff.
2. `pnpm --filter "@lunora/do" run test`: green, with test edits limited to R7.
3. `LUNORA_WORKERD_TESTS=1` `do` project (`pnpm run test:workerd` for `@lunora/do`): green.
4. A deliberate break in the moved code turns a named test red. Record which test in the PR body.
5. For hot-path clusters (2, 7-10): the `packages/do/__bench__` dispatch, refresh and poke benches
   (`rpc-dispatch`, `refresh-fanout`, `shape-poke-fanout`, `broadcast-delta`) within noise of `alpha`.
6. Lint (`eslint` + `prettier`) on the touched files; `lint:package-json` is not affected.

Keep each branch short-lived: the file's churn means a refactor branch older than a few days
conflicts. Rebase onto `alpha` right before merge and redo the R6 count if the cluster changed.

## 6. Results

Measured with R6 as revised in §4. "Host" counts host entries, and protected statics count as
entries. Every done step: `api:check` unchanged, the `do` suite green (1,623 tests), a deliberate
break caught by named tests, and lint and types clean.

| Step | Cluster              | Result      | Removed → added + host | Deliberate break caught by                                                        |
| ---: | -------------------- | ----------- | ---------------------- | --------------------------------------------------------------------------------- |
|    1 | shard registration   | done        | 8 → 1 + 5              | `shard-do.shard-registry.test.ts`: the release emptiness check, the retry window  |
|    2 | function metrics     | done        | 16 → 1 + 2             | `function-metrics.test.ts`: four tests, the error force-flush                     |
|    3 | CDC memos, fork seal | done        | 7 → 2 + 1              | `shard-do.cdc-meta-cache.test.ts`: "seals at most once per wake…"                 |
|    4 | alarm admission      | **stopped** | 6 → 1 + 5              | —                                                                                 |
|    5 | schedule outbox      | done        | 27 → 5 + 6             | codegen `emit-shard-schedule-outbox.dispatch.test.ts`: six tests, the drop marker |
|    6 | query streams        | **stopped** | 9 → 2 + 11             | —                                                                                 |
|    7 | change accumulator   | **stopped** | 7 → 5 + 9              | —                                                                                 |
|    8 | live streams         | **stopped** | 21 → 9 + 20            | —                                                                                 |
|    8 | rooms                | **stopped** | 42 → 19 + 29           | —                                                                                 |
|    9 | global poll          | **stopped** | 31 → 11 + 37           | —                                                                                 |
|   10 | shapes               | **stopped** | 26 → 13 + 31           | —                                                                                 |
|   10 | subscriptions        | **stopped** | 56 → 16 + 52           | —                                                                                 |
|    — | sockets (checked)    | **stopped** | 28 → 15 + 21           | —                                                                                 |

Notes on the done steps:

- **1:** the `releaseShardRegistration` admin wrapper (decode → release → audit → respond) stays on
  the class. `shardRegistry()` stays the codegen hook, read through a thunk.
- **2:** `collectMetrics` and the public static `resetRootSizeWarning` stay on the class. Under R7,
  three cast-reach lines were retargeted (`function-metrics.test.ts` ×2,
  `shard-do.bounded-state.test.ts` ×1); no assertion changed.
- **3:** `sealForkedTimeline` is protected, so it stays as a forward. `currentCdcCursor` and
  `currentCdcEpoch` keep their bodies.
- **5:** `scheduleOutbox` and `pollScheduleOutbox` stay as protected forwards (codegen calls
  them). `handleDropOutboxEntry` stays as a decode-and-forward wrapper. `handleRetryOutboxEntry`
  keeps the poll re-arm and the audit, so `globalPollArmedAt` never crosses into the module.
- **Benches** (`rpc-dispatch`, `refresh-fanout`, branch vs baseline `94de493ad`, alternated, under
  a load average of 6-12): within noise. Minimums match, and the order the runs went in moved the
  means more than the branch did. In the last three alternations the branch was faster on direct
  insert every time.

**Why steps 6-10 stop.** They are the reactive engine. Its clusters share the socket attachment
layer (`readAttachment` has 43 call sites, `writeAttachment` 13, `dropIfLapsed` 15, `sendFrame` 11),
`deliveryAuthorization`, the socket index and the request scope, and each one calls the others. A
collaborator would need a host as large as the code it removes. That is the callback bag #522
measured, now measured cluster by cluster. Moving the attachment cache alone would pass R6 (6 → 1 +
0), but it rewrites 64 call sites across the file for about 100 lines and shrinks the other hosts by
only 2 entries. That is more conflict surface, the opposite of the goal.

**Moved together, the reactive engine passes R6, but it is not worth moving.** Subscriptions,
shapes, global poll, the change accumulator and delivery authorization as one module, with every
protected member left on the class so subclass overrides keep running (`broadcastDelta`,
`matchesSubscription` and `readShapeCdcKeys` are overridden in tests): 119 members removed, 40
added, a 63-entry host. Live and rooms together: 59 removed, 27 added, 27 host entries. §7 shows
why that is still the wrong trade. A per-socket object (attachment, delivery permit, frame sending)
would cut each host by only about 5 entries, so it does not change the verdict. Step 4 (alarm
admission) is not worth revisiting either: the breaker logic already lives in its modules, and what
is left on the class is mostly the telemetry calls.

## 7. Where the conflicts actually come from

Measured two ways. The second is the sounder one; the first is kept because it is what first showed
the pattern.

**A. Adjacent-commit replay (a weak proxy).** Each of the 121 non-release commits to `shard-do.ts`
in the 90 days before the baseline is applied with `patch --fuzz=0` to the parent of each of the 1-3
commits before it. 97 of 357 pairs fail. It overstates conflicts in two ways:

- **It is stricter than git.** A real 3-way merge (`git merge-file`) of the same pairs conflicts in
  85, not 97.
- **It counts follow-ups as concurrent.** History is linear squash merges, so adjacent commits are
  often sequential: in at least 19 of the 85, the later commit edits lines the earlier one
  introduced.

**B. PR-overlap replay (independent review).** Each commit's PR `createdAt` comes from `gh`. Its
change is 3-way merged onto the file as it stood before the first `shard-do.ts` commit that landed
while that PR was open.

| PRs touching `shard-do.ts` | Count |
| -------------------------- | ----: |
| No concurrent commit       |    69 |
| Concurrent, merged cleanly |    34 |
| Concurrent, conflicted     |    18 |

18 of 121 is 15%. Of those 18:

- **13 are true overlapping edits** to the same lines.
- **1 edits code** a concurrent commit introduced.
- **4 are insert-only:** both sides added at the same anchor.
- **Only 1 conflicts only in the shared regions** (imports, module-level helpers, fields); 11 have
  at least one hunk there.

The conflict hunks fall in `handleWebSocketMessage` (7, from three PRs: a stacked follow-up and two
socket features open at once), `handleStream`, `deliverWhisperLocal`,
`resolveReactiveOutcomeDeduped` (3 each), and a long tail of subscription and socket methods.
`handleFetchCloudflare` has none. Its hits in replay A all came from sequential commits.

Limits: `createdAt` understates branch age, so 15% is a lower bound. The merge uses squashed diffs,
not the real PR heads. Region attribution is by nearest preceding member.

**What that means for layout.** Git conflicts on textual proximity. A new module or a new method
boundary keeps the moved lines next to the same neighbours, so it separates none of the 13 true
overlaps. The extractions on this branch relocated conflicts rather than removing them; for example,
the outbox drop conflicts (#1402) would now happen in `schedule-outbox.ts`. Regrouping the field or
import blocks has a ceiling of the 4 insert-only PRs (about 3% of PRs), which resolve trivially, and
the regroup itself would conflict with every open PR.

By cluster (replay A's attribution): the code that stays on the class is touched by 109 of the 121
commits. The reactive engine is touched by 48, but only 5 touched it alone, so moving it whole would
take about 6% of commits off the file.

**Options rejected, with the reason:**

- **An inheritance chain of abstract bases across files:** the `extends` clause and the members that
  leave the class body diff `api:check`. Privates shared across layers would have to become
  `protected`, which is new public surface. It also moves the same lines, so no conflict goes away.
- **Declaration merging with prototype assignment, or mixins:** interfaces cannot declare
  `protected` or `private`. It breaks `override`/`super` for the codegen subclass and the ~110 test
  subclasses, and has the same zero conflict effect.
- **Moving the reactive engine whole, or splitting `handleFetchCloudflare`:** see §6 and above.
- **More small collaborators:** they fail R6.

**Conclusion.** Stop restructuring. Steps 1, 2, 3 and 5 were cheap, behaviour-identical moves of
self-contained subsystems and are worth keeping for reading and ownership. They are not a conflict
fix, and nothing further in the file's layout would be. 13 of the 18 conflicts are concurrent work on
the same dispatch, socket and subscription logic, and at least five come from stacked or sibling PRs.
The levers are process:

- Sequence PRs that touch those paths.
- Land stacked follow-ups onto their parent.
- Rebase long-lived branches early (two PRs were open for 1,734h and 3,407h).

The four collaborators are still covered only through `ShardDO`; no test drives them directly yet.

**The per-frame-type split** of `handleWebSocketMessage` is kept for what it does buy: one method
per frame type to read and review, and complexity disables scoped to the two handlers that need
them. `handleFetchCloudflare` is not split. Its `try`, `catch` and `finally` share `let` state across
the whole dispatch lifecycle (`dispatchError`, `dispatchServerFault`, `heldClaim`, `dispatchScope`,
`sensitive`), it is the most security-sensitive path in the class, and it has no concurrent-PR
conflicts to relieve.

## 8. Platform parity

Not applicable: no `ctx.*` surface, binding, host contract or wire change. Every collaborator reaches
the platform only through what `ShardDO` already holds (`ShardHost`, `SocketHost`, `env`).

## 9. Risks and STOP conditions

- **Callback bag** (the #522 failure): R6 stops a step if it adds as many members as it removes.
- **Hidden ordering:** a collaborator's thunk reads its value at call time, as the method did
  through `this`. A step that would need a value captured at construction is a STOP.
- **Public or protected API, a new host contract, or a wire change** needed to move a cluster: STOP
  and re-plan. None of the done steps needed one.
- **Perf:** one extra property hop and thunk call per host access. Negligible off the hot path
  (registration runs past the response). For steps 2 and 7-10, the benches are a gate.

## 10. Open questions

1. `create-worker.ts` is handled separately by plan 622 (spike done, PR #1646), so it is out of scope here.
2. R7 relaxes the earlier "tests unchanged" gate to "assertions unchanged; cast-reach access paths
   may be retargeted". The maintainer asked for every step on one branch; step 2 applied R7 to three
   lines, listed in its commit. Confirm it in review.
3. None left for this plan. If the conflict rate on the dispatch and subscription paths keeps hurting,
   the lever is PR sequencing on those paths (§7), not another split.
