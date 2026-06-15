# Design: First-class Offline / Local-first Lunora

Status: **Draft** · Owner: TBD · Target branch: `alpha`

## Goal

Make Lunora apps keep working seamlessly with no network and reconcile
automatically on reconnect. Today the framework is **write-side offline-capable**
(durable mutation outbox, optimistic updates) but **read-side online-only**
(query results live only in memory; a reload while offline shows nothing). This
doc specifies the work to close that gap and reach true local-first.

## Where we are today (baseline)

| Capability                                                                                         | Status                 | Source of truth                                                 |
| -------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------- |
| Durable mutation outbox (IndexedDB, FIFO, bounded, hydrate-on-reload)                              | ✅                     | `packages/client/src/offline-queue.ts`, `persistence.ts`        |
| Identity-stamped replay (FNV-1a of auth token; reject on identity change)                          | ✅                     | `lunora-client.ts` `identityFingerprint()`                      |
| Optimistic updates (`optimistic` + multi-query `optimisticUpdate`) + version-guarded LIFO rollback | ✅                     | `local-store.ts`, `lunora-client.ts`                            |
| `@lunora/db` TanStack outbox (client-UUID rows, retriable/terminal split)                          | ✅                     | `packages/db/src/define-collections.ts`, `internals.ts`         |
| Reconnect (exp backoff + decorrelated jitter, resubscribe, list delta-merge)                       | ✅                     | `reconnect.ts`, `lunora-client.ts`                              |
| Server CDC log (`__cdc_log`, per-shard monotonic `seq`, post-image)                                | ✅ but unused for live | `packages/do/src/ctx-db.ts`                                     |
| OCC write-conflict detection (`ConflictError` kind `occ` → 409)                                    | ✅                     | `packages/do/src/transaction.ts`, `ctx-db.ts` `runGuardedWrite` |
| **Persistent read cache (queries survive reload offline)**                                         | ❌                     | —                                                               |
| **Subscription resume cursor (delta since seq N, not full re-run)**                                | ❌                     | `SubscriptionQuery` has no cursor (`packages/do/src/types.ts`)  |
| **Server mutation idempotency / exactly-once**                                                     | ❌                     | `RpcRequest` has no mutation id (`packages/do/src/types.ts`)    |
| Connection-status hook parity (React only; Vue/Solid/Svelte missing)                               | ⚠️                     | `packages/react/src/use-connection-status.ts`                   |
| AsyncStorage adapter (promised in docs)                                                            | ❌ doc drift           | `apps/docs/content/docs/api/client.mdx`                         |
| e2e offline tests (offline→mutate→reload→reconnect→reconcile)                                      | ❌                     | absent in `packages/db/__tests__`, `packages/client/__tests__`  |

Grade today: **~6/10.** One-line summary: _mutations survive offline; reads don't._

## Prior art — how the field does this (mid-2026)

Surveyed Rocicorp Zero, Convex (hosted + the WIP Object Sync Engine),
robelest/convex-embedded, ElectricSQL, PowerSync, Replicache, TanStack DB,
WatermelonDB, RxDB, Triplit/Jazz/Evolu/LiveStore, and Cloudflare's own stack.
Three findings shape this design.

**1. The dominant pattern for transactional apps is server-authoritative
rebase, not CRDT.** Replicache→Zero, TanStack DB, WatermelonDB, PowerSync, and
Convex's own roadmap all do: client applies an optimistic mutation → server is
the source of truth → optimistic state is rebased/discarded against the
authoritative result. CRDT auto-merge (Yjs/Automerge/Jazz/Evolu) is reserved
for collaborative text/docs and explicitly _loses cross-table transactional
consistency_ (Convex and convex-embedded both warn about this). **Lunora already
has the hard half of server-authoritative rebase** — OCC serializable commit
(`ConflictError`) + read-set-driven subscription re-execution. That is exactly
Convex's model and the natural fit for a DO backend. We keep CRDT out of v1.

**2. A resumable delta cursor is the universal scalability backbone.** Every
serious system ships only the diff since a durable per-client cursor and does
_partial_ (query/shape/bucket) replication, never full:

| System                           | Client store                     | Sync scope                  | Resume cursor                     | Conflict                                    |
| -------------------------------- | -------------------------------- | --------------------------- | --------------------------------- | ------------------------------------------- |
| Zero 1.0                         | IndexedDB (→SQLite)              | synced queries (ZQL)        | CVR (server-side per-client)      | server-auth rebase; **no offline writes**   |
| Convex (Object Sync Engine, WIP) | IndexedDB→SQLite                 | query set                   | subscription resumption (roadmap) | server reconciliation, "CRDT-ish" mutations |
| convex-embedded                  | indexed SQLite + IndexedDB       | local/remote routed         | (undocumented)                    | Yjs field CRDTs                             |
| ElectricSQL                      | PGlite / in-mem                  | Shapes (table+where)        | offset + handle (Shape Log)       | server-auth, read-only                      |
| PowerSync                        | SQLite (OPFS)                    | buckets / sync rules        | checkpoint + per-bucket op_id     | server-auth, causal+                        |
| Replicache                       | IndexedDB                        | client-view                 | **cookie** (opaque cursor)        | server-auth rebase, mutators                |
| WatermelonDB                     | SQLite / Loki                    | tables                      | `last_pulled_at`                  | server-auth                                 |
| TanStack DB                      | SQLite (v0.6) / IndexedDB outbox | per-collection              | adapter txid / refetch            | server-auth optimistic                      |
| **Lunora (this design)**         | **IndexedDB (v1)**               | **live queries (read-set)** | **`__cdc_log.seq`**               | **OCC + server-auth rebase**                |

Our `__cdc_log` per-shard `seq` _is_ the cookie/offset/checkpoint equivalent —
it already exists; Pillar 1b just wires it to live subscriptions. This validates
Pillar 1b as the highest-leverage server change.

**3. Cloudflare gives us the authoritative tier but not the client tier.** DO
SQLite (source of truth + 30-day PITR bookmarks), D1 Sessions bookmarks
(sequential consistency / read-your-writes — Lunora already uses these in
`bookmark.ts`), and hibernated WS (cheap live channels) are exactly the server
primitives. Cloudflare's _client_ sync story is unproductized (Agents SDK =
full-state broadcast, `partysync` = experimental full-record, neither has deltas
or client persistence). So the gap Lunora must fill — durable client store +
durable outbox + resumable delta cursor + optimistic-rebase contract +
query-scoped partial sync — is precisely the gap CF leaves third parties to fill.
Two of those five (durable outbox, optimistic rebase) we already have.

**Notable contrasts worth calling out:**

- **We already beat Zero on offline writes.** Zero 1.0 deliberately rejects
  offline writes; our durable outbox accepts and replays them. Keep that lead.
- **Storage endgame is SQLite-wasm + OPFS**, which the field has converged on
  (PowerSync, Evolu, LiveStore, TanStack DB v0.6, WatermelonDB). We ship **v1 on
  IndexedDB** (reuses the existing `persistence.ts` plumbing, zero new deps) and
  treat an OPFS/SQLite-wasm `QueryCacheAdapter` as a later swap behind the same
  interface — see Future directions.
- **API-compatibility-first** (convex-embedded's core idea): the local engine
  must be transparent to `useQuery`/`useMutation`. Our Pillar 2 honors this —
  hydration feeds existing `SubscriptionState`, no new app-facing read API.

## Non-goals

- CRDT / multi-writer text merge. We stay last-writer-wins + OCC reject; rebase
  is out of scope for v1.
- Peer-to-peer sync. Server (DO) remains the source of truth.
- Full PWA app-shell tooling. We document a service-worker recipe; we don't ship
  a Lunora-owned SW.

## Design — four pillars (dependency order)

### Pillar 1 — Server: incremental sync + idempotency (`@lunora/do`, `@lunora/runtime`)

The foundation everything else builds on. Two independent pieces.

#### 1a. Mutation idempotency (exactly-once replay)

Problem: client replay is at-least-once. A transport failure that hides a
committed write causes a duplicate on replay.

- Add `mutationId?: string` to `RpcRequest` (`packages/do/src/types.ts`) and to
  the client mutation envelope. Client generates it once per logical mutation
  (reuse the existing offline-queue `id`).
- New reserved table `__idempotency` in the DO: `(identity TEXT, mutation_id TEXT,
result_json TEXT, seq INTEGER, ts REAL, PRIMARY KEY (identity, mutation_id))`.
  Write it inside the same transaction as the mutation (same durability coupling
  as `__cdc_log.appendCdcChange`).
- On dispatch (`shard-do.ts` RPC handler, ~L1721): if `(identity, mutationId)`
  exists, short-circuit and return the cached `result_json` — do **not** re-run
  the handler. Otherwise run, persist result, return.
- GC: prune `__idempotency` rows older than a TTL (e.g. 24h) on a scheduler tick
  or opportunistically by `seq` low-watermark.

**Implementation seams (verified against current code):**

- Migration: add `migrateIdempotency(sql)` beside `migrateCdcLog`, called from
  `runShardMigrations` (`ctx-db.ts:3295/3317`).
- Helpers in `ctx-db.ts`, mirroring the CDC helpers: `readIdempotent(sql,
identity, mutationId)`, `writeIdempotent(sql, identity, mutationId,
resultJson, ts)`, `trimIdempotent(sql, olderThanTs)` — all over the
  unit-testable `SqlExec` seam (plain-Node, no workerd).
- Wire: `mutationId?: string` on `RpcRequest` (`types.ts`); header
  `x-lunora-mutation-id` read at the dispatch site (`shard-do.ts:1742`-style),
  forwarded by `@lunora/runtime`, sent by `@lunora/client` (reuse the existing
  offline-queue mutation `id`).
- **Atomicity decision: write the dedup record inside `runInTransaction`
  (`shard-do.ts:2306`), not at the dispatch site.** Mutations commit their
  writes inside that BEGIN/COMMIT span (serialized by `blockConcurrencyWhile`);
  writing the idempotency row as the last statement before COMMIT makes it
  durable iff the writes are. Writing it after `handleRpc` returns would leave a
  crash window where the write committed but the dedup record didn't → a replay
  re-executes. Gate the write on `currentRequestMutationId` being set.
- Dedup _read_ short-circuits at the dispatch site **before** `handleRpc`
  (returns the cached `{ result }` + stored bookmark, skipping handler + CDC +
  subscription flush). The read needs no transaction.
- Identity key: `currentRequestUserId ?? ""` + `mutationId`. Anonymous calls
  dedup within the empty-identity namespace.
- GC: `trimIdempotent` on a SchedulerDO tick, 24h retention (resolved decision).

#### 1b. Subscription resume cursor

Problem: on reconnect the DO re-runs the full query and ships a full snapshot;
`__cdc_log.seq` already exists but is not wired to live subscriptions.

- Extend `SubscriptionQuery` (`packages/do/src/types.ts`) with `sinceSeq?: number`.
- Server returns the shard's current `seq` as a `cursor` field on every `data`
  and `delta` frame (the high-watermark covered by that frame).
- On `subscribe` with `sinceSeq`, the DO reads `readCdcChanges(sinceSeq)`
  (`ctx-db.ts` ~L1436) and, when the changed tables intersect the subscription's
  read-set, ships the deltas and advances the cursor — instead of a full re-run.
  Fallback to full snapshot when `sinceSeq` is below the CDC retention floor
  (log compacted) or the read-set can't be determined.
- Persist the read-set (tables a query touched) alongside each sub so the DO can
  decide intersection without re-executing. The re-execution path already tracks
  changed tables (`flushChangedTables` ~L4543); reuse that table-set.

Decision to settle in review: **cursor granularity.** Per-shard `seq` is simplest
and already exists. Cross-shard causal ordering is a non-goal for v1 — clients
hold one cursor per shard (mirrors how the connector-sync cursor already shapes
`{ s: { shardKey: seq } }` in `connector-cdc.ts`).

**Implemented (server, `@lunora/do`).** Shipped as the _safe_ subset of the
above:

- `SubscriptionQuery.sinceSeq?: number` (`types.ts`); `cursor` high-watermark
  stamped on every `data`/`delta` frame (`pushSubscriptionData`), omitted on
  non-CDC shards so the wire stays byte-identical for apps that never enabled
  CDC. `readCdcCursor` reads the watermark from `sqlite_sequence` so it survives
  a `trimCdcChanges` that deletes the row carrying it; `minCdcSeq` reports the
  retention floor (`ctx-db.ts`).
- On `subscribe` with `sinceSeq` (`seedSubscription` → `evaluateResume`), the DO
  decides resumability from the CDC log: **resumable** when `sinceSeq` is within
  the retention window _and_ no table the query reads changed in
  `(sinceSeq, cursor]` — it then sends a lightweight `{type:"resume", cursor}`
  frame and the client keeps its cached value. Otherwise (read-set changed,
  retention gap, or CDC off) it falls back to the full-snapshot seed, now
  cursor-stamped. The read-set is the query's own `SubscriptionOutcome.tables`
  (no separate persistence needed — the seed runs the query once anyway, which
  also memoises the per-socket diff baseline for later flushes).
- **Deliberately deferred: shipping raw `__cdc_log` rows as deltas on resume.**
  CDC row post-images only reconstruct a subscription's result for a plain
  diffable table scan; for any query with a filter/join/aggregate, applying raw
  row deltas to the client's cached value diverges from the authoritative
  result. The existing safe delta path (`subscriptionListDeltas`) derives deltas
  by _diffing two full query results_, which the server can't do on a fresh
  reconnect socket (it has no prior value to diff against). So v1 ships the
  correctness-preserving resume short-circuit — full bandwidth win on the common
  "reconnect, nothing in my read-set changed" case — and leaves
  reconstruct-from-CDC deltas to a future pass that proves per-query safety
  (mirrors how the cross-socket execution dedup in `refreshSubscriptions` was
  investigated and intentionally not done).
- **Client side** (send `sinceSeq`, persist `cursor`, handle the `resume`
  frame) lands with **Pillar 2**, which owns the on-disk cursor. Today's client
  never sends `sinceSeq`, so it never receives a `resume` frame — fully
  backward compatible.

### Pillar 2 — Client: persistent read cache (`@lunora/client`)

The biggest user-visible win. Reads hydrate from disk on boot and render
immediately while the socket reconnects.

- Generalize the existing `PersistenceAdapter` (`packages/client/src/types.ts`)
  or add a sibling `QueryCacheAdapter` with the same IndexedDB plumbing as
  `persistence.ts` (new object store `query-cache`, keyed by
  `shardKey + functionPath + argsKey`).
- Persist `{ value, serverCursor, identityFingerprint, ts }` whenever a
  subscription's `lastValue` advances (`SubscriptionState`, `subscription.ts`).
  Debounce writes; cap rows; evict LRU.
- On client construction, **hydrate synchronously-ish**: load cached values into
  `SubscriptionState.lastValue` so the first `query()`/subscription read returns
  cached data before any socket opens. Gate on `identityFingerprint` match (same
  rule the outbox uses) so a logged-out cache never leaks to a new identity.
- On reconnect, send the cached `serverCursor` as `sinceSeq` (Pillar 1b) so the
  server replays deltas instead of a full snapshot.
- New constructor option: `queryCache?: QueryCacheAdapter | false` (default off
  to preserve current behavior; opt-in like `persistence`).
- Read-your-writes across reload: also persist the D1 bookmark (`bookmark.ts`,
  currently in-memory only) through the same adapter so a reload keeps causal
  read position.

### Pillar 3 — Adapter parity + DX (`react`/`vue`/`solid`/`svelte`, docs)

- Port `useConnectionStatus()` (React, `use-connection-status.ts`) to Vue
  (`useConnectionStatus` composable), Solid (`createConnectionStatus`), and
  Svelte (`connectionStatus` store), each wrapping
  `client.onConnectionStatus()` / `client.connectionStatus()` which already
  exist (`lunora-client.ts` L606/615).
- Optional `useOutbox()` / pending-writes count surface so apps can show "N
  changes pending sync" UI from the outbox size.
- Docs: a new `apps/docs/content/docs/guides/offline-first.mdx` recipe —
  enabling `persistence` + `queryCache`, the service-worker app-shell snippet,
  and the reconciliation model. Cross-link from `addons/db.mdx`.

### Pillar 4 — Correctness: fix drift + tests

- **AsyncStorage drift.** Either ship `createAsyncStoragePersistence()` (React
  Native / Expo) implementing `PersistenceAdapter`, or correct
  `apps/docs/content/docs/api/client.mdx` (L33-44) which currently promises it.
  Recommendation: ship it — it's ~the in-memory adapter over an async KV and
  unlocks the RN story the docs already advertise.
- **e2e offline tests** (the named gap). Add to `packages/client/__tests__` and
  `packages/db/__tests__`, driving the real adapters with a fake IndexedDB
  (`fake-indexeddb`) and a mock socket:
    1. offline → enqueue mutation → reload (re-hydrate) → reconnect → flush →
       server sees it exactly once (validates Pillar 1a + outbox durability).
    2. offline → query returns cached value from disk (Pillar 2).
    3. reconnect with `sinceSeq` → server ships deltas only, not a full snapshot
       (Pillar 1b).
    4. server rejects with coded conflict → optimistic row rolls back (already
       partly covered in `internals.test.ts`; extend to the collection layer).
    5. identity change between sessions → cached reads + queued writes are dropped,
       not replayed under the new identity.

> Note on the sandbox: workerd can't run here (see project memory
> `project-workerd-sandbox-limit`), so Pillar 1 server logic is validated with
> plain-Node tests against the `ctx-db`/transaction modules, not a live DO.

## Wire-protocol changes (summary)

| Frame                            | Field added                   | Direction     | Purpose               |
| -------------------------------- | ----------------------------- | ------------- | --------------------- |
| `RpcRequest` / mutation envelope | `mutationId`                  | client→server | exactly-once dedup    |
| `SubscriptionQuery`              | `sinceSeq`                    | client→server | resume from cursor    |
| `data` / `delta`                 | `cursor` (seq high-watermark) | server→client | advance client cursor |

All additions are optional fields → backward compatible. An old client omits
`sinceSeq`/`mutationId` and gets today's full-snapshot, at-least-once behavior.

## Rollout / sequencing

1. **Pillar 1a** (idempotency) — self-contained, immediately valuable, lowest UI
   risk. Lands first.
2. **Pillar 1b** (resume cursor) — server side, gated behind the optional field.
3. **Pillar 2** (read cache) — depends on 1b's `cursor` to be efficient but works
   (full-snapshot fallback) without it; can start in parallel once the `cursor`
   field shape is frozen.
4. **Pillar 3 + 4** — parity, docs, AsyncStorage, tests; partly parallelizable.

Each pillar is its own PR (or small stack) into `alpha`. Suggested commit scopes:
`feat(do): mutation idempotency dedup table`,
`feat(do): subscription resume cursor over __cdc_log`,
`feat(client): persistent query cache`,
`feat(react|vue|solid|svelte): connection-status parity`,
`test(client): e2e offline lifecycle`,
`docs: offline-first guide`.

## Decisions (resolved)

1. **AsyncStorage → ship the adapter.** Build `createAsyncStoragePersistence()`
   (PersistenceAdapter over an async KV) to unlock React Native / Expo, which the
   docs already advertise. Additive; no doc retraction needed.
2. **`queryCache` default → opt-in.** `queryCache?: QueryCacheAdapter | false`,
   default off — mirrors how `persistence` is wired today. No behavior change for
   existing apps; explicit consent to persist query data to disk.
3. **Implementation start → Pillar 1a (mutation idempotency).** Self-contained,
   lowest UI risk, fixes duplicate-write-on-replay; foundation for the rest.
4. **Idempotency TTL → 24h, scheduler tick.** Prune `__idempotency` rows older
   than 24h on a periodic SchedulerDO tick. Covers any realistic offline gap;
   bounds per-shard table growth.

## Still open (decide before the relevant pillar)

- **Read-set persistence cost** (Pillar 1b) — storing per-sub touched-tables in
  the DO: size vs the cost of full re-run on every reconnect. Measure first.
- **Query-cache eviction policy** (Pillar 2) — default to LRU row cap with
  per-identity IndexedDB namespacing; revisit byte-budget if needed.

## Future directions (post-v1, explicitly deferred)

- **SQLite-wasm + OPFS query store.** The field's storage endgame. Implement a
  second `QueryCacheAdapter` over OPFS-backed SQLite-wasm and let large offline
  datasets query locally with real indexes (what convex-embedded and PowerSync
  do). Behind the same adapter interface as the IndexedDB v1 — a swap, not a
  rewrite.
- **Opt-in CRDT field primitives.** For collaborative fields only (text,
  counters, sets), following convex-embedded's Yjs `register`/`prose`/`counter`/
  `set` and Convex's Automerge recipe. Strictly opt-in per field; the rest of the
  row stays on the OCC/server-authoritative path so transactional consistency is
  preserved. This is the one place CRDT earns its complexity.
- **Cross-tab coordination.** Leader-elected single socket + shared cache/outbox
  across tabs (TanStack offline-transactions and convex-embedded both do this) so
  N tabs don't each hold a socket and race the outbox.
- **Rejected-mutation observability.** Zero's documented gap (no client hook for
  a rolled-back mutation). We should expose a rejection callback on the outbox so
  apps can surface "this change couldn't be saved."

## Risk register

- **DO hot-path regression** (Pillar 1) — idempotency + CDC reads add work to
  every mutation/subscribe. Mitigate: single-statement upserts, indexed PKs,
  benchmark against the OCC-contention metrics already in `shard-do.ts`.
- **Cache poisoning across identity** — strict `identityFingerprint` gate on
  hydrate (reuse outbox rule); clear cache on logout.
- **CDC retention vs resume** — if a client is offline past the CDC floor, it
  must fall back to full snapshot cleanly (never silently miss changes).
- **Doc over-promise** — don't tag anything "local-first" in docs until Pillar 2
  ships; the `@lunora/db` page already says "offline-first" (accurate for writes).
