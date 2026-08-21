# Plan 390: Bound `listPresent`'s per-room read and make presence self-reaping

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/server/src/presence.ts`
> On a mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (changes `listPresent` semantics for very large rooms; index addition)
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`listPresent` is a live query: every heartbeat patch to a room re-runs it for every subscriber of that room. The query `.collect()`s **every** row the room has ever accumulated (the TTL is a read-time filter that hides stale rows but never deletes them), then filters and sorts in JS. The reaper (`sweep`) is an internal mutation that nothing schedules by default — the module doc says "you SHOULD schedule the sweep" and leaves it to the app. An app that skips that step degrades as O(live-set × historical-rows) per TTL window: cost scales with rows ever written, not with who's present. Two fixes, both local to `presence.ts`: bound the read (newest-first, capped), and make the heartbeat opportunistically reap a bounded number of expired rows so the table self-cleans without requiring a cron.

## Current state

- `packages/server/src/presence.ts:262-268` — the unbounded read:
  ```ts
  const listPresent = query.input({ roomId: v.string() }).query(async ({ args, ctx: context }): Promise<PresenceMember[]> => {
      const cutoff = Date.now() - ttlMs;

      const rows = await context.db
          .query(PRESENCE_TABLE)
          .withIndex("byRoom", (q) => q.eq("roomId", args.roomId))
          .collect();
  ```
  followed by a JS filter on `lastSeen > cutoff` and a newest-first `toSorted`.
- `packages/server/src/presence.ts:186-188` — indexes: `byRoomSession: ["roomId", "sessionId"]` and `byRoom: ["roomId"]`. No index covers `(roomId, lastSeen)`.
- `packages/server/src/presence.ts:19-26` — module doc conceding the read filter "only HIDES stale rows; it never deletes them".
- `packages/server/src/presence.ts:255-258` — heartbeat patches/inserts a row per beat (a mutation — it may delete too).
- `packages/server/src/presence.ts:332-335` — `sweep` re-tagged `visibility: "internal"`; nothing in the package schedules it.
- `DefinePresenceOptions` (line 101) currently has `disconnectGraceMs`, `ttlMs`, (read the whole interface before editing).
- The table-reader API supports `.order("asc" | "desc")` (`packages/server/src/types.ts:941`) and bounded `.take(n)` (used elsewhere with `.take(1024)`, types.ts:919).

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/server..." run build` | exit 0 |
| Tests     | `pnpm --filter "@lunora/server" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/server" run lint:types` | exit 0 |
| Lint      | `pnpm --filter "@lunora/server" run lint:eslint` | exit 0 |
| API snapshot (if `DefinePresenceOptions` grows) | `pnpm run build:packages && pnpm run api:update` | snapshot updated |

## Scope

**In scope**:
- `packages/server/src/presence.ts`
- `packages/server/__tests__/presence.test.ts` (find the actual presence test file: `ls packages/server/__tests__ | grep -i presence`)
- `api-snapshots/server.api.md` via `pnpm run api:update` (new option = surface change)

**Out of scope**:
- `@lunora/react`'s `usePresence` — truncation awareness for capped rooms is an explicitly deferred follow-up; the cap default below is high enough that current consumers see no change.
- `@lunora/do` subscription machinery — the live re-run behaviour is by design.
- `@lunora/scheduler` — do NOT add a scheduler dependency to wire `sweep` to a cron; the opportunistic reap below is the dependency-free fix.

## Git workflow

- Branch: `improve/wave22-server`
- Commit: `perf(server): bound presence reads and self-reap`

## Steps

### Step 1: Add the `(roomId, lastSeen)` index and a `maxMembers` option

- Add `.index("byRoomLastSeen", ["roomId", "lastSeen"])` to the presence table definition (line ~186), keeping the two existing indexes (the upsert and sweep still use them).
- Add to `DefinePresenceOptions`: `maxMembers?: number` — "Upper bound on rows `listPresent` reads per call (newest-first, so the visible set is the freshest). Defaults to 512." Normalize it like the module's other options (see how `ttlMs`/`disconnectGraceMs` defaults are resolved in `definePresence`).

**Verify**: `pnpm --filter "@lunora/server" run lint:types` → exit 0.

### Step 2: Bound the read

Rewrite the `listPresent` read to use the new index newest-first with a cap:

```ts
const rows = await context.db
    .query(PRESENCE_TABLE)
    .withIndex("byRoomLastSeen", (q) => q.eq("roomId", args.roomId))
    .order("desc")
    .take(maxMembers);
```

Rows arrive newest-first already, so drop the `toSorted` and keep the `cutoff` filter + per-user dedup unchanged. Confirm against `packages/server/src/types.ts` that `.withIndex(...).order("desc").take(n)` composes on the reader type; if `take` is not available on the query-context reader (only `.collect()`/`.first()`/`.paginate()`), STOP and report the actual reader surface.

**Verify**: presence tests pass: `pnpm --filter "@lunora/server" run test -- presence`.

### Step 3: Opportunistic reap in the heartbeat

In the heartbeat mutation (around line 255), after the upsert, delete a small bounded batch of expired rows for the same room using the new index oldest-first:

```ts
// Self-reaping: each heartbeat reclaims a few of its room's aged-out rows so
// the table stays bounded without requiring the app to schedule `sweep`.
const stale = await context.db
    .query(PRESENCE_TABLE)
    .withIndex("byRoomLastSeen", (q) => q.eq("roomId", args.roomId))
    .order("asc")
    .take(REAP_BATCH); // const REAP_BATCH = 8
const expired = stale.filter((row) => (row["lastSeen"] as number) <= reapCutoff);
await Promise.all(expired.map((row) => context.db.delete(row["_id"] as never)));
```

Use a reap cutoff strictly older than the visibility cutoff (e.g. `Date.now() - ttlMs - Math.max(disconnectGraceMs, ttlMs)`) so a row is never deleted while the read-time filter could still show it (grace-window reconnects must keep working — see the `disconnectGraceMs` docblock at line 102).

Keep `sweep` as-is for bulk cleanup; update the module doc (lines 19-26): the sweep is now optional hardening, not required.

**Verify**: `pnpm --filter "@lunora/server" run test -- presence` → pass.

### Step 4: Tests + API snapshot

Add tests (model on the existing presence tests):
1. Rooms with more than `maxMembers` rows: `listPresent` returns the newest ones and never more than the cap.
2. Heartbeating a room deletes rows older than the reap cutoff, and does NOT delete a row inside the `disconnectGraceMs` window.

Then `pnpm run build:packages && pnpm run api:update` (the new option changes `server.api.md`).

**Verify**: `pnpm --filter "@lunora/server" run test` → all pass; `pnpm run api:check` → exit 0.

## Test plan

- 2 new tests as in Step 4, in the existing presence test file, modeled on its existing heartbeat/listPresent cases.
- All existing presence tests green (dedup, TTL hiding, disconnect grace).

## Done criteria

- [ ] `grep -n "collect()" packages/server/src/presence.ts` → no match inside `listPresent`
- [ ] `grep -n "byRoomLastSeen" packages/server/src/presence.ts` → index + both usages
- [ ] `pnpm --filter "@lunora/server" run test` exits 0 with the 2 new tests
- [ ] `pnpm run api:check` exits 0 (snapshot updated for `maxMembers`)
- [ ] `pnpm --filter "@lunora/server" run lint:types` + `lint:eslint` exit 0

## STOP conditions

- The reader surface in a query context lacks `.order()`/`.take()` composition on `withIndex` (report the actual surface instead of falling back to `collect`).
- Adding the index changes migration behaviour for existing deployments in a way the schema-extension machinery flags (report the diagnostic).
- The reap in Step 3 breaks the `disconnectGraceMs` reconnect tests — the cutoff math is then wrong; report rather than loosening the tests.

## Maintenance notes

- Deferred follow-up (do NOT do here): `usePresence` (React) and the other adapters could surface "list may be truncated at maxMembers"; today the 512 default exceeds any realistic room.
- Reviewer: scrutinize the reap cutoff arithmetic against the grace-window semantics — deleting a graced row breaks reconnect-without-flicker.
- The old `byRoom` index still serves `sweep`; if a later change drops `sweep`, re-check whether `byRoom` has other consumers before removing it.
