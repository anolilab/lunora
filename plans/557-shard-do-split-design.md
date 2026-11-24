# Plan 557 — Design the split of `shard-do.ts`

**Baseline:** `94de493ad` (`origin/alpha`, 2026-11-24). First written against `4a7c48bfd` (2026-11-11).
**Status:** workstream 0 DONE (design below), workstream 1 step 1 (shard registration) on
`refactor/shard-do-split-design`; steps 2-10 TODO, one per PR.
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
| `function-metrics.ts`                                           | `FunctionMetrics`                      | function metrics                                                 |
| `cdc-meta.ts`                                                   | `CdcMeta`                              | CDC presence/epoch memos and fork seal (the private half of CDC) |
| `alarm-rearm-breaker.ts`, `schedule-rate-breaker.ts` (existing) | grow a per-instance class each         | alarm admission                                                  |
| `schedule-outbox.ts`                                            | `ScheduleOutboxRunner`                 | schedule outbox                                                  |
| `query-streams.ts`                                              | `QueryStreams`                         | query streams                                                    |
| `change-accumulator.ts`                                         | `ChangeAccumulator`                    | pending changed tables/keys/bookmarks (prerequisite for 8-10)    |
| `live-topics.ts`                                                | `LiveTopics`                           | live streams                                                     |
| `rooms.ts`                                                      | `Rooms`                                | rooms, whisper, socket routes                                    |
| `global-poll.ts`                                                | `GlobalPoll`                           | global poll and refresh                                          |
| `shape-pokes.ts`                                                | `ShapePokes`                           | shapes and pokes                                                 |
| `subscription-refresh.ts`                                       | `SubscriptionRefresh`                  | subscriptions and refresh                                        |

These stay in `shard-do.ts` for good: the entry points (Cloudflare calls them on the class), the
subclass hooks, the request scope, the transaction, mutation-bookkeeping and dispatch core,
`ctx.db`, telemetry, and the admin dispatch table. Sockets and delivery authorization have no step
yet; look at them again after step 10. Module-level helpers move with the cluster that uses them
(the schedule-outbox helpers at the top of the file go with step 5). After step 10 the file is
roughly 10-12k lines, about half of today, and the clusters that change for their own reasons are
no longer in it.

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
- **R6 — STOP rule, measured.** Count the class members (methods + fields) a step removes and the
  members it adds (collaborator fields + forwarding methods). A protected member whose body moves
  stays as a one-line forward to keep `api:check` at zero; each such forward counts as added. STOP
  the step if added ≥ removed, or if the host needs more entries than the cluster had fields.
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

**Every step** is one PR against `alpha`, a pure move, and reviewable with
`git diff --color-moved=zebra`: the moved bodies differ only in `this.` → `this.host.` and in their
field names. Gates per PR:

1. `pnpm run api:check`: zero diff.
2. `pnpm --filter "@lunora/do" run test`: green, with test edits limited to R7.
3. `LUNORA_WORKERD_TESTS=1` `do` project (`pnpm run test:workerd` for `@lunora/do`): green.
4. A deliberate break in the moved code turns a named test red. Record which test in the PR body.
5. For hot-path clusters (2, 7-10): the `packages/do/__bench__` dispatch, refresh and poke benches
   (`rpc-dispatch`, `refresh-fanout`, `shape-poke-fanout`, `broadcast-delta`) within noise of `alpha`.
6. Lint (`eslint` + `prettier`) on the touched files; `lint:package-json` is not affected.

Keep each branch short-lived: the file's churn means a refactor branch older than a few days
conflicts. Rebase onto `alpha` right before merge and redo the R6 count if the cluster changed.

## 6. Step 1 — shard registration (done in this PR)

- New `packages/do/src/shard-registration.ts`: `ShardRegistration` with the host `{ env,
jurisdiction, registry, shardKey, sql }`. It owns `registeredTables`, `registryRetryAt`
  and `registryTail`, which moved off `ShardDO`, plus `register(changed)`, `release(tables, dryRun)`,
  `serializeRegistry`, `registryStub`, `registryWriter`, `tableHasRows`, the `RegistryWriter`
  interface and `SHARD_REGISTRY_RETRY_MS`.
- `ShardDO` keeps `handleReleaseShardRegistration` as the admin wrapper (decode args → `release` →
  audit → `adminResponse`). `flushChangedTables` calls `this.shardRegistration.register(changed)`.
  `shardRegistry()` stays the codegen hook, read through the `registry` thunk.
- R6: removed 5 methods and 3 fields from the class, plus 1 module interface and 1 constant; added
  1 field; no forwards. `shard-do.ts`: 21,278 → 21,092.
- Proof: `shard-do.shard-registry.test.ts` and `shard-registry-do.test.ts` unchanged and green.
  Breaking `release`'s emptiness check fails "releases a table the shard holds no rows of and keeps
  one it does". Dropping the retry window fails "logs a failed registration without failing the
  write, and retries once the backoff passes".

## 7. Platform parity

Not applicable: no `ctx.*` surface, binding, host contract or wire change. Every collaborator reaches
the platform only through what `ShardDO` already holds (`ShardHost`, `SocketHost`, `env`).

## 8. Risks and STOP conditions

- **Callback bag** (the #522 failure): R6 stops a step if it adds as many members as it removes.
- **Hidden ordering:** a collaborator's thunk reads its value at call time, as the method did
  through `this`. A step that would need a value captured at construction is a STOP.
- **Public or protected API, a new host contract, or a wire change** needed to move a cluster: STOP
  and re-plan. None of steps 1-7 needs one.
- **Perf:** one extra property hop and thunk call per host access. Negligible off the hot path
  (registration runs past the response). For steps 2 and 7-10, the benches are a gate.

## 9. Open questions

1. `create-worker.ts` is handled separately by plan 622 (spike done, PR #1646), so it is out of scope here.
2. R7 relaxes the earlier "tests unchanged" gate to "assertions unchanged; cast-reach access paths
   may be retargeted". Steps 2, 6 and 8-10 depend on it. The maintainer should confirm it before
   step 2.
