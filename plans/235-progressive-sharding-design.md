# Plan 235 — Progressive-sharding WAL + watermark + dual-read protocol (design spike)

**Baseline:** `ad873e805` (2026-07-31)
**Status:** DONE (spike) — design + test-only prototype; no `src/` routing changes.

## 0. Headline finding

The applied-watermark + dual-read protocol below is achievable with the
primitives that already exist — the per-shard `__cdc_log` WAL
(`packages/shard-engine/src/ctx-db-cdc.ts`) and a monotonic-cursor watermark
in the same shape as `__client_watermark`
(`packages/shard-engine/src/ctx-db-client-watermark.ts`). No new log format
and no new storage primitive is needed; the work is a **consumer** of the
existing WAL, not a new one. This was proven, not assumed: a 2-shard
prototype (`packages/shard-engine/__tests__/progressive-shard-move.test.ts`,
`__tests__/_helpers/progressive-shard-move.ts`) implements the full
snapshot → catch-up → quiesce → cutover → forward lifecycle against two real
in-memory SQLite shards and asserts exactly-once resolution, dual-read dedup,
and mid-move write correctness. All 24 tests (7 new + 17 pre-existing
`shard-ring.test.ts`) pass. `git diff --stat` against `ad873e805` touches only
`__tests__/*` and this doc.

The one correctness insight worth carrying into implementation: **placement
authority for writes is enforced by the shard receiving the write, not by
whichever directory version the caller happened to resolve from.** A source
shard that has ceded a vnode forwards (or rejects) any write it still
receives for it, regardless of how stale the caller's cached directory is.
This is what makes the protocol correct despite the directory itself
propagating to many coordinator instances at different speeds — the
propagation lag becomes a **dual-read** problem (bounded, self-healing,
dedup-able) rather than a **dual-write** problem (which would need
distributed consensus to get right).

## 1. The per-shard WAL record

Reuse `CdcChange` as-is — no new format:

```ts
interface CdcChange {
    doc?: Record<string, unknown>; // post-image; absent for delete
    id: string;
    op: "delete" | "insert" | "update";
    seq: number; // monotonic per-shard cursor, AUTOINCREMENT-backed
    table: string;
    ts: number;
}
```

`readCdcCursor` already gives the shard's current high-watermark (survives
trimming via `sqlite_sequence`, so it never regresses); `readCdcChanges(sql,
{ sinceSeq, tables })` already pages the log forward. A migration mover reads
this exact API — the only new consumer behavior is filtering pages to the
vnode(s) being moved (`vnodeForId(change.id, ringSize)` against the moving
set), which happens client-side since the WAL is not vnode-partitioned.

## 2. The applied-watermark protocol

State per in-flight move (test-local `VnodeMoveState` in the prototype; a real
implementation would persist this per-migration, likely in the coordinator's
own system table):

```ts
interface VnodeMoveState {
    appliedWatermark: number; // target's cursor into source's WAL
    quiesceSeq?: number; // source cursor at the cutover-gate instant
    snapshotSeq: number; // source cursor when the base copy ran
}
```

Protocol, in order:

1. **`snapshotSeq = readCdcCursor(source)`.** Recorded before the base copy
   starts.
2. **Base copy.** Target bulk-copies every row in the moving vnode(s) as they
   stand in `source` right now. Must not race a write to those vnodes — a
   real shard gets this for free from the same single-threaded-isolate
   guarantee it already uses for OCC (one active transaction at a time).
3. **`appliedWatermark` starts at `snapshotSeq`, not `0`.** The base copy
   already captured everything up to that cursor; treating the watermark as
   zero was the first bug the prototype's tests caught (`beginVnodeMove` —
   see §7) — it would make `catchUpVnodes` wait forever for a WAL tail that
   the snapshot, not the WAL, already accounts for.
4. **Catch-up.** Target repeatedly calls `readCdcChanges(source, {
   sinceSeq: appliedWatermark, tables })`, applies each entry belonging to a
   moving vnode (upsert on insert/update, delete on delete), and advances
   `appliedWatermark` to the highest replayed `seq`. Runs however many times
   is needed while source keeps taking writes.
5. **Cutover gate (quiesce).** Coordinator briefly stops admitting new writes
   to the moving vnode's keys on `source` (queue-and-retry in a real
   deployment; the prototype's `routeWrite` returns a `"quiesced"` sentinel).
   Records `quiesceSeq = readCdcCursor(source)`.
6. **Final catch-up**, bounded to `quiesceSeq`. Cutover is legal **exactly
   when** `appliedWatermark === quiesceSeq` — at that instant target is
   byte-identical to source for the moving vnode(s), as of a cursor both
   sides agree on. This is the "target has caught up to source's watermark"
   signal the plan asked for: a single integer comparison, not a timeout or
   a heuristic.
7. **Atomic directory flip.** The coordinator commits one new
   `VnodeDirectory` value with the moving vnode(s) reassigned. A logically
   single write (e.g. one KV put or one D1 row update) — there is no window
   in the *source of truth* where a vnode has zero or two owners.
8. **Un-quiesce with forwarding.** `source` resumes accepting requests for
   the ceded vnode's keys but never re-originates a write for them — it
   forwards to `target` and returns target's result. `source` does **not**
   delete its now-stale rows at this point (see §3) — that is a later,
   separate drain-close step.

## 3. The dual-read window and its dedup rule

The directory flip in step 7 is atomic at the source of truth, but a real
deployment has many coordinator/isolate instances, each with its own cached
copy that propagates on its own schedule (a Worker isolate's in-memory copy,
a KV read with its own TTL, etc.). Between the flip committing and every
cache having observed it, two placements are simultaneously "live": some
callers still resolve the moving vnode to `source`, others already resolve it
to `target`. This is the **dual-read window**, and it is a read-side hazard
only — writes stay single-owner throughout because of the forwarding rule in
step 8, which does not depend on the caller's directory being fresh.

Because `source` never purges the moved rows until a later drain-close step,
a coordinator that wants to be safe rather than trust its own cache can fan
out to **both** shards during this window and merge:

```ts
const dualRead = (source, target, ids) => {
    const merged = new Map<string, Row>(); // one entry per id, structurally
    for (const id of ids) {
        const fromTarget = readRow(target, id);
        if (fromTarget) {
            merged.set(id, fromTarget);
            continue;
        }
        const fromSource = readRow(source, id);
        if (fromSource) merged.set(id, fromSource);
    }
    return merged;
};
```

**Dedup rule: target wins whenever it has the row.** After a caught-up
cutover, target is a superset-or-equal of source's state for the moved
vnode(s), and any write since cutover only ever landed on target (via
forwarding) — so target's copy, when present, is always the freshest. Keying
the merge by `(table, id)` in a `Map` makes "each row exactly once" a
structural property of the merge, not a manually-counted invariant.

The prototype's own dual-read test caught a real bug in an earlier draft: an
assertion that only checked `merged.size === batch.length` (no duplicates,
nothing dropped) passed even when the merge preferred **source's stale
value**, because the mutated version still produced one entry per id — it
just had the wrong content. Fixed by asserting the merged row's *content*
equals target's post-forward value for a deliberately-diverged id (source
still holding the pre-move body, target holding a forwarded update). A
mutation check (swap the merge's preference order, confirm the test fails,
restore) verified this is now a real assertion and not a tautology — see §7.

## 4. What a client observes mid-move

Nothing anomalous, by construction of the above:

- **No missing row.** Before cutover, `source` is undisturbed and fully
  authoritative. After cutover, `target` holds everything `source` had
  (base copy + full WAL replay through `quiesceSeq`) plus anything forwarded
  since. A row is never in neither place.
- **No duplicated row observed.** A single-shard read only ever consults its
  own directory resolution, which names exactly one shard. A dual-read
  fan-out (used defensively during the propagation window) collapses to one
  entry per id via the target-wins `Map` merge.
- **No lost write.** Pre-quiesce, writes land on `source` normally and are
  captured by the WAL like any other write. During quiesce, `source` refuses
  and the caller retries (a bounded, single-vnode pause — not a full-shard
  outage). Post-cutover, `source` forwards rather than silently dropping or
  re-applying a write for a vnode it no longer owns.

## 5. Prototype summary

`packages/shard-engine/__tests__/_helpers/progressive-shard-move.ts` (helper,
not exported from any package) implements: `createShardHarness` (wraps the
existing `_helpers/node-sqlite.ts` in-memory SQLite harness + the existing
`migrateCdcLog`), `writeMessage`/`deleteMessage`/`readMessage` (append to the
real `__cdc_log` via `appendCdcChange`), `beginVnodeMove`, `snapshotVnodes`,
`catchUpVnodes`, `MoveCoordinator` + `quiesceVnodes`/`cedeVnodes` (the
directory-flip + forwarding stand-in), `routeWrite`,
`resolveAuthoritativeShard`, and `dualRead`.

`packages/shard-engine/__tests__/progressive-shard-move.test.ts` seeds 200
documents on a source shard, moves half the ring (8 of 16 vnodes, a "key
range") to a second shard, and asserts across three `describe` blocks:

- **`exactly-once resolution`** (3 tests): every key resolves to `source`
  before the move; still resolves to `source` through snapshot and catch-up
  (`appliedWatermark === quiesceSeq` checked directly — the watermark
  protocol's core signal); flips moved keys to `target` and leaves staying
  keys on `source` after cutover, with content verified against ground truth
  for all 200 ids.
- **`dual-read window dedup`** (2 tests): a diverged sample (source stale,
  target forward-updated) merges to target's fresh value, not source's stale
  one, and the merge is exactly one row per id; a 200-id mixed batch merges
  with zero drops and zero duplicates, content-checked against ground truth
  for every id.
- **`mid-move write correctness`** (2 tests): a write issued during
  catch-up lands on `source`, is absent from `target` until replay runs, and
  is visible on `target` after cutover, at the correct id; a write to a
  quiesced vnode is rejected (not silently lost) and succeeds via forwarding
  once cutover has committed.

Result: **7/7 new tests pass**, plus the pre-existing 17-test
`shard-ring.test.ts` suite unaffected. `git diff --stat` against `ad873e805`
touches only files under `packages/shard-engine/__tests__/` and this
document — `resolveVnodePlacement`, `shard-ring.ts`, and `shard-do.ts` are
untouched.

## 6. Open questions

- **Split policy** — when does a deployment promote tier-0 (`shardCount: 0`,
  everything on `LOCAL_SHARD`) to sharded? Candidates: a storage-size
  threshold the coordinator already tracks for other purposes, a
  write-rate/row-count threshold, or an explicit operator trigger only (no
  autoscale in phase 1 — see §7). Needs its own measurement of what "too
  big" costs in practice before picking a number.
- **Hysteresis** — a move that fires, then immediately reverses because the
  triggering metric oscillates around the threshold, is worse than not
  moving. Needs a cooldown window per vnode (no re-evaluation for N minutes
  after a move) and probably a "sustained past threshold for N consecutive
  samples" gate rather than a single-sample trigger. Not designed here —
  deliberately deferred to autoscale-policy work, which this spike's SCOPE
  explicitly excludes.
- **Cross-shard relations/rank/search during a move.** This spike moved a
  flat key-value table. `@lunora/shard-engine` also has relation joins, rank
  pages, and full-text search that read across rows — some of those already
  work cross-shard (`cross-shard-relations.ts`, cross-shard rank/rankPage per
  prior work per `MEMORY.md`'s plan2-gap-status). Whether those paths
  tolerate a vnode being mid-move (some rows on `source`, some on `target`,
  some rows in the dual-read window) is untested here and is the first thing
  a phase-2 implementation must verify — a rank page or search index that
  silently double-counts or drops a row during a move would be a much worse
  failure mode than the flat-table case this spike covers.
- **Migration story for `.shardBy(...)` apps.** Progressive sharding and
  explicit `.shardBy(key)` sharding are two different placement strategies
  today (jump-consistent-hash-on-id vs. hash-on-field). An app that already
  chose `.shardBy` has no obvious path onto progressive sharding without a
  real data migration (re-keying by id-hash instead of field-hash) — that is
  a different, likely harder migration than what this spike prototypes
  (which moves whole vnodes, not re-partitions by a different key). Whether
  the two stay permanently separate tiers, or one subsumes the other, is
  unresolved and out of scope here.
- **Directory propagation mechanism.** §3 assumes coordinator caches
  propagate "eventually" but does not specify how — a KV put with a TTL, an
  explicit invalidation broadcast, or a lease/ack protocol where the
  coordinator waits for confirmation from every known reader before closing
  the drain window. This determines how long the dual-read window realistically
  stays open and therefore how long `source` must keep the stale rows around
  before drain-close can purge them.

## 7. Phased build order

1. **Land `shard-ring.ts` as routing-only.** Already done (this plan's
   groundwork) — pure placement given a directory, tier-0 identity, not
   exported from the barrel.
2. **Generalize this spike's mover into `src/`** — single-vnode move,
   operator-triggered only (no autoscale), single-coordinator (no directory
   propagation problem yet because there is exactly one coordinator
   instance to update). This turns the test-only `MoveCoordinator` stand-in
   into a real, persisted per-migration state machine and wires
   `snapshotVnodes`/`catchUpVnodes`/cutover into `ShardDO`. **STOP gate:**
   does not ship until it has run against a real multi-DO dev deployment,
   not just the in-memory harness — the harness cannot exercise real network
   partitions, partial failures mid-catch-up, or Durable Object eviction
   during a move.
3. **Directory propagation for multiple coordinator instances** — pick and
   implement the propagation mechanism from the open question above; define
   and test the drain-close purge trigger. **STOP gate:** dual-read dedup
   must be re-verified against the real propagation mechanism's actual
   staleness bound, not the instantaneous test-local `MoveCoordinator`.
4. **Split policy + hysteresis (autoscale).** Only after 2–3 have run in a
   real deployment long enough to know what "too big" and "flapping" look
   like in practice, not from a spike's guesses.
5. **Cross-shard feature parity during moves** — relations, rank, search
   verified (or explicitly documented as unsupported mid-move) against a
   moving vnode. **STOP gate:** a feature that silently double-counts or
   drops a row during a move is worse than not building progressive sharding
   at all; each feature needs its own test before it is declared safe
   mid-move.
6. **`.shardBy(...)` interop / migration tooling** — only once the open
   question above is resolved; may turn out to be "the two stay separate,
   document the boundary" rather than a build item.

Confirmed: **zero changes to `src/` routing code.** `git diff --stat
ad873e805..HEAD -- packages/shard-engine/src/shard-ring.ts
packages/do/src/shard-do.ts` is empty; the only files this spike touched are
`packages/shard-engine/__tests__/progressive-shard-move.test.ts`,
`packages/shard-engine/__tests__/_helpers/progressive-shard-move.ts`, and this
document.
