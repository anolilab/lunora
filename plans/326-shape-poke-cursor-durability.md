# Plan 326 — Stop the first write after every hibernation wake rescanning the whole change log

**Baseline:** `70b7451b5` (2026-08-11)
**Status:** TODO

> **Executor instructions**: follow this file top to bottom, run every verification
> command, stop on any §8 STOP condition, and update this plan's row in
> `plans/README.md` when done. §4 has one measurement to take **before** writing
> code — take it.
>
> **Drift check (run first):**
> `git diff --stat 70b7451b5..HEAD -- packages/do/src/shard-do.ts packages/shard-engine/src`
>
> **Build before you measure:** `pnpm run build:packages` once. Note that
> `packages/shard-engine` had the repo's highest churn in the last 20 commits and has
> uncommitted work in flight (`durable-stream.ts`) — re-read the drift check output
> carefully.

## 0. Headline finding

The per-socket poke baseline for shape subscriptions, `shapeMemos`, is a `WeakMap` on
the Durable Object **instance** with no durable backing. A hibernation eviction clears
it. On the next write, `pokeShapeSubscribers` reads

```ts
const memoCursor = this.shapeMemos.get(ws)?.get(subId)?.cursor ?? 0;
```

— a literal `0`, not the socket's attachment `sinceSeq` and not a stored cursor. So the
first write after **every** wake drains the entire retained `__cdc_log` for that table
(paged 1000 rows at a time), runs a membership probe over every row id in that range,
and emits a poke carrying the full projected membership to every subscriber.

The keepalive at `shard-do.ts:9354` exists precisely so idle shape sockets hibernate,
which makes this the steady state for a live-shape shard, not a rare cold start. Cost
grows with change-log retention.

Its sibling `globalShapeSnapshots` already solved exactly this, and its docblock names
the failure mode. The asymmetry between the two is the tell.

Correctness is not at risk today — `applyRowOpsToView` is idempotent and live pokes
pass `baseCheckpoint: undefined`, so the `baseDiverged` check is skipped. This is a
cost cliff, not a data bug.

## 1. Current state (audit)

`packages/do/src/shard-do.ts:8558`:

```ts
const memoCursor = this.shapeMemos.get(ws)?.get(subId)?.cursor ?? 0;
const rowsPatch = this.buildShapeDiff(sql, resolved, memoCursor, checkpoint, opRangeCache);
```

`packages/do/src/shard-do.ts:1244-1252` — the declaration, whose docblock overstates
what happens on a cold memo:

```
 * `pokeShapeSubscribers` reads each op page since this cursor and advances
 * it to the flush watermark. In-memory only (like {@link ShardDO.subMemos});
 * a cold memo on a reconnected/hibernated socket re-seeds from the client's
 * `sinceCheckpoint`.
```

That re-seed happens on a fresh `shape_subscribe` — not on a hibernation wake, where
the socket and its attachment survive but the `WeakMap` entry does not.

Only writers: `recordShapeMemo` (`:9097-9099`), called from `:8394`, `:8479`, `:8494`.
Nothing rehydrates on wake. Deletes at `:1679` (socket close) and `:3127`
(unsubscribe).

The contrast, `packages/do/src/shard-do.ts:1259-1268`:

```
 * This is a hot in-memory **cache** over the durable `__global_shape_snapshot`
 * table (keyed by the socket's `connectionId` + subId): a hibernation eviction
 * clears the WeakMap, so on the next alarm wake {@link ShardDO.readGlobalSnapshot}
 * misses and re-loads the baseline from SQLite ...
```

The cost path: `readShapeOpRange` (`:8604-8621`) pages from `sinceSeq` to `upTo`, then
`buildShapeDiff` (`:8645+`) runs one `selectShapeMemberIds` over every distinct id in
that range and emits a `ShapeRowOp` per surviving member, each carrying its full
projected doc.

## 2. Existing seams (do not reinvent)

This plan is almost entirely "do what the sibling already does":

- `packages/shard-engine/src/ctx-db-global-shape-snapshot.ts` — the whole durable
  pattern: table constant, `create…Table`, keyed by `(connection_id, sub_id)`, read and
  write helpers, degradation when the table is missing. Copy its structure for a
  `__shape_poke_cursor` table.
- `shard-do.ts:8799-8830` — `readGlobalSnapshot` / `recordGlobalSnapshot` /
  `loadGlobalSnapshot`: the cache-then-durable-fallback triple, including the
  `connectionId === ""` escape for unit harnesses and the try/catch that degrades to
  in-memory rather than failing a tick. Mirror all three properties.
- `recordShapeMemo` (`:9097`) — the single write point to extend.
- The attachment's `shape.sinceSeq` — the cheap intermediate fallback (see §4).

## 3. The behavioural contract to preserve

1. **A baseline that is too high silently drops rows.** Too low is merely wasteful
   (the client's apply is idempotent). Every fallback in the chain must therefore
   degrade _downward_: stored cursor → attachment `sinceSeq` → `0`. Never invent a
   higher one.
2. The cursor advances **only on a delivered poke**, matching today's `recordShapeMemo`
   call sites. Do not advance on a computed-but-unsent diff.
3. A missing table, a stub `sql` handle, or an empty `connectionId` must degrade to
   today's in-memory behaviour, not throw. The global-snapshot loader shows the shape.
4. Cleanup parity: the durable row must be removed when the socket closes (`:1679`) and
   when a subscription is dropped (`:3127`), or the table grows forever across
   reconnects.
5. Wire protocol unchanged. No new frame, no new field on an existing frame.

## 4. Design decisions

**Measure first (before any code).** Two numbers, recorded in §9:

- (a) how many `__cdc_log` rows a representative shard retains, and
- (b) the wall-clock of one `pokeShapeSubscribers` with `memoCursor = 0` versus a warm
  memo, using the existing test seam at `readShapeCdcPage` (`:8630-8634`), whose
  docblock says it exists to give "tests a point to count the reads the op-range cache
  collapses". Count reads, not just time.

If (b) shows a negligible delta at realistic retention, **stop and report** — the
cheap fallback below may be the whole fix, and a durable table would be new machinery
for nothing.

**Chosen (assuming the measurement justifies it): a durable `__shape_poke_cursor`
table keyed by `(connection_id, sub_id)`, with the attachment's `sinceSeq` as the
intermediate fallback.** Rejected: attachment-`sinceSeq`-only. It is one line and much
of the win, but `sinceSeq` is the _subscribe-time_ value; a socket that has been poked
forward and then hibernates would rescan back to subscribe time, so the cliff shrinks
rather than disappears. Take it as the fallback, not the answer.

Rejected: persisting into the socket attachment (`serializeAttachment`). Attachments
are size-limited and rewritten on every change; a per-shape cursor written on every
poke is the wrong thing to put there, and the sibling already established SQLite as
the place for this.

## 5. Workstreams

### WS0 — Measure (S) — **gates everything else**

Take (a) and (b) from §4. Record in §9. If the delta is negligible, STOP.

### WS1 — The durable table (S)

New module `packages/shard-engine/src/ctx-db-shape-poke-cursor.ts`, modelled line for
line on `ctx-db-global-shape-snapshot.ts`: table constant, creation, `readShapePokeCursor`,
`writeShapePokeCursor`, `deleteShapePokeCursorsForConnection`. Wire the table creation
into the same place the global-shape snapshot table's creation is wired (find it by
grepping for its creation function's call site).

**Verify:** `pnpm --filter "@lunora/shard-engine" run test` green.

### WS2 — Read through the cache (S)

In `packages/do/src/shard-do.ts`, replace the `?? 0` at `:8558` with a
`readShapePokeCursor(ws, subId, connectionId)` private method mirroring
`readGlobalSnapshot`: in-memory hit → stored value → attachment `sinceSeq` → `0`.
Extend `recordShapeMemo` (`:9097`) to write through to the table alongside the
in-memory set.

Fix the docblock at `:1244-1251` — the "re-seeds from the client's `sinceCheckpoint`"
sentence is what made this invisible.

### WS3 — Cleanup parity (S)

Delete the durable rows at the two sites that already clear the in-memory map:
`:1679` (socket gone) and `:3127` (subscription dropped). Check how the global-shape
snapshot handles connection cleanup and match it — including whatever it does about
rows left behind by a socket that never closed cleanly.

### WS4 — Tests (M)

See §Test plan.

## 6. Platform parity

The change is internal to the shard engine and the Cloudflare DO host; it adds no
`ctx.*` surface and no binding, so no `PlatformCapabilities` row changes. It does add a
reserved table (`__shape_poke_cursor`), which any host implementing `ShardHost` will
carry automatically since it goes through the same `sql` seam as
`__global_shape_snapshot`. State that in the PR description.

| Feature                   | `cloudflare` | `node` | Notes                                                                  |
| ------------------------- | ------------ | ------ | ---------------------------------------------------------------------- |
| durable shape poke cursor | native       | native | Plain SQLite through the existing `SqlExec` seam; no provider API used |

## 7. Phasing & ordering

| Phase | Work | Gate                                                                                                                                     |
| ----- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | WS0  | numbers recorded in §9; a decision to proceed or stop                                                                                    |
| 1     | WS1  | shard-engine suite green; the new table is created on a fresh shard                                                                      |
| 2     | WS2  | new test: a simulated wake pokes from the stored cursor, not 0 — asserted by **counting CDC page reads** via the `readShapeCdcPage` seam |
| 3     | WS3  | new test: closing the socket removes the rows                                                                                            |
| 4     | WS4  | `pnpm --filter "@lunora/do" run test` green (1,134 tests today)                                                                          |

## Commands you will need

| Purpose      | Command                                              | Expected                                                                          |
| ------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| Build        | `pnpm run build:packages`                            | exit 0                                                                            |
| Engine tests | `pnpm --filter "@lunora/shard-engine" run test`      | all pass                                                                          |
| DO tests     | `pnpm --filter "@lunora/do" run test`                | all pass                                                                          |
| Typecheck    | `pnpm --filter "@lunora/do" run lint:types`          | exit 0                                                                            |
| API snapshot | `pnpm run api:check`                                 | exit 0 (internal change; a diff means you exported something you did not mean to) |
| Format, lint | `pnpm run lint:prettier:fix && pnpm run lint:eslint` | exit 0                                                                            |

## Scope

**In scope:**

- `packages/shard-engine/src/ctx-db-shape-poke-cursor.ts` (create)
- `packages/shard-engine/src/index.ts` (export the new helpers)
- `packages/do/src/shard-do.ts` — `:1244-1252` (docblock), `:8558` (read), `:9097`
  (write), `:1679` and `:3127` (cleanup)
- Tests under `packages/do/__tests__/` and `packages/shard-engine/__tests__/`

**Out of scope:**

- `globalShapeSnapshots` and the `__global_shape_snapshot` table — the exemplar, not a
  target.
- `subMemos` — the per-subscription result memo. It has the same in-memory-only
  property but a different cost profile (one redundant push, as its own docblock says),
  so it does not follow from this measurement. Record it in §9 if the numbers suggest
  otherwise.
- CDC retention policy and compaction. Shortening retention would also shrink the
  cliff, and it is a different, riskier decision.
- `packages/shard-engine/src/durable-stream.ts` and any uncommitted work in
  `packages/server/src` — another change is in flight there.

## Git workflow

- Branch: `advisor/326-shape-poke-cursor-durability`
- Suggested commits: `feat(shard-engine): add the durable shape poke cursor table`
  then `perf(do): poke shapes from the stored cursor after a wake`

## Test plan

**`packages/do/__tests__/`** — extend the existing shape-poke suite (find it:
`ls packages/do/__tests__ | grep -i shape`):

1. **The regression test, by read count.** Subscribe a shape, write, deliver a poke
   (cursor advances), then simulate a hibernation wake by clearing the in-memory
   `shapeMemos` for that socket. Write again, and assert `readShapeCdcPage` was called
   with a `sinceSeq` equal to the stored cursor — **not** `0`. Counting reads through
   the existing seam is more robust than timing.
2. **Downward degradation:** no stored row → falls back to the attachment `sinceSeq`;
   no attachment either → `0`. Both must still produce a _correct_ (superset) diff.
3. **Never too high:** a stored cursor ahead of the current checkpoint must not skip
   rows — pin the §3.1 invariant explicitly.
4. **Cleanup:** closing the socket, and dropping the subscription, each remove the
   durable rows.
5. **Degradation:** a stub `sql` handle and a missing table both behave exactly as
   today (in-memory only, no throw).

**`packages/shard-engine/__tests__/`** — a direct spec for the new module, modelled on
the global-shape-snapshot spec.

## Done criteria

- [ ] §9 records measurements (a) and (b) with the decision they support
- [ ] `pnpm --filter "@lunora/shard-engine" run test` and `pnpm --filter "@lunora/do" run test` exit 0
- [ ] `grep -n "?? 0;" packages/do/src/shard-do.ts | grep -i shapememo` → no match (the bare-zero fallback is gone)
- [ ] Test 1 fails when WS2 is reverted (prove it)
- [ ] `pnpm run api:check` exits 0
- [ ] `git status` shows no files outside the in-scope list
- [ ] `plans/README.md` row updated

## 8. Risks & STOP conditions

- **STOP** if WS0 shows a negligible delta at realistic retention. Land the
  attachment-`sinceSeq` fallback alone (one line, no new table) and record the numbers
  that justified stopping.
- **STOP** if the stored cursor can ever exceed the shard's current checkpoint (e.g.
  after a DO id recycle, which `shard-do.ts:2570` already contemplates for `sinceSeq`).
  A cursor from a previous epoch indexes an unrelated changelog and would silently skip
  rows. If the epoch guard does not already cover this path, the design needs an epoch
  column before it is safe.
- **Risk:** write amplification. A cursor write per delivered poke adds one SQLite
  upsert per poke. Measure it in WS0's (b) as well — trading a full scan for a small
  write is the intended deal, but confirm the write is small.
- **Risk:** table growth from sockets that never close cleanly. WS3 must handle the
  connection-level sweep, not just the tidy paths.

## 9. Measurements and open questions (fill in during execution)

1. (a) retained `__cdc_log` rows on a representative shard: __________
2. (b) `pokeShapeSubscribers` CDC page reads and wall-clock, cold memo vs warm:
   __________ / __________
3. Cost of the extra upsert per delivered poke: __________
4. Does `subMemos` deserve the same treatment? Answer from the same measurement run,
   yes or no with the number behind it.
