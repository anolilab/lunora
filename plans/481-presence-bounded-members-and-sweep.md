# Plan 481 — Presence: cap members after dedup, and bound the sweep read

**Status:** TODO
**Priority:** P2
**Effort:** S (one file, two functions, tests)
**Risk:** low-medium. `listPresent` output changes in multi-tab rooms; the existing test that pins the old behaviour must be rewritten on purpose.
**Depends on:** none
**Category:** perf / bug
**Planned at:** `dcffa4d73` (2026-10-11)

## 0. Headline finding

Both halves are present on alpha, in `packages/server/src/presence.ts`:

- **(a) The member cap runs before dedup.** `listPresent` takes `maxSessions` session rows (line 334), then collapses one user's tabs (lines 349-358). Duplicate tabs use up the budget, so a room's real members can fall off the list. The existing test at `packages/server/__tests__/presence.test.ts:235-261` asserts this behaviour as intended. This plan reverses that assertion on purpose.
- **(b) `sweep` reads without a bound.** It calls `.filter(...).collect()` over the whole `byRoom` index (lines 385-389), then deletes every hit in one `Promise.all` (line 393).

The index title said "cap members after dedup". The code caps session rows, and the doc comment says so (lines 131-143, 336-337). The plan treats the title as the goal and the code as the thing to change.

## 1. Current state (measured at dcffa4d73)

**(a) Cap before dedup.** `packages/server/src/presence.ts`:

```ts
// line 330-334
const rows = await context.db
    .query(PRESENCE_TABLE)
    .withIndex("byRoomLastSeen", (q) => q.eq("roomId", args.roomId))
    .order("desc")
    .take(maxSessions);

// line 338
const live = rows.filter((row) => (row["lastSeen"] as number) > cutoff);
// lines 349-358: dedup by userId, after the read
```

Concrete failure, from the existing test (`maxSessions: 2`, ttl 10s): user `solo` heartbeats once at t=1000, user `multi` heartbeats two tabs at t=2000 and t=3000. `take(2)` returns the two `multi` rows. Dedup leaves `["multi"]`. `solo` is live and heartbeating, and is dropped. Expired rows have the same effect: `live` is filtered after `take`, so stale rows also use up slots (line 338).

**(b) Unbounded sweep.** `packages/server/src/presence.ts:382-396`:

```ts
const stale = await context.db
    .query(PRESENCE_TABLE)
    .withIndex("byRoom", (q) => q.eq("roomId", args.roomId))
    .filter((row) => (row["lastSeen"] as number) <= cutoff)
    .collect();
// ...
await Promise.all(stale.map((row) => context.db.delete(row["_id"] as never)));
```

Concrete failure: a room that went quiet with many expired rows (for example 50k after a reconnect storm) makes one `sweep` call read every row in the room, including live ones (the filter runs after the index scan), and issue every delete in one mutation. That can exceed the per-invocation read and write limits of the Durable Object SQLite / D1 backend. The `workerd` gate exists for that reason. Note that the `byRoomLastSeen` index (line 226) already supports a range on `lastSeen`, so the bound can use the index rather than a filter.

The heartbeat reap (lines 310-317) is already bounded by `REAP_BATCH` (line 77). It is not part of this plan.

## 2. Existing seams (do not reinvent)

- `byRoomLastSeen` index `["roomId", "lastSeen"]` (presence.ts:226). Both the read and the sweep can range over it.
- `REAP_BATCH` (presence.ts:77) is the pattern for a per-call batch constant. Add a sibling `SWEEP_BATCH`.
- `DEFAULT_MAX_SESSIONS` and `maxSessions` (presence.ts:69, 144) are a public option (`DefinePresenceOptions`), exported through `packages/server/src/index.ts:68`. Its name and meaning are part of the API.
- `makeMutationContext` / `makeQueryContext` / `createMemoryDb` in `presence.test.ts` drive the handlers directly. Use them; do not build a new harness.

## 3. The behavioural contract to preserve

- A single user's tabs collapse to one member, and the newest row wins (presence.ts:340-345).
- Anonymous rows are never collapsed (presence.ts:344-345).
- `listPresent` output contains no `sessionId` (presence.ts:360-362).
- `heartbeat` ownership gate (presence.ts:287-289), `MAX_DATA_BYTES`, and the reap cutoff (presence.ts:309) are unchanged.
- `sweep` stays an internal mutation (presence.ts:401) and returns `{ deleted: number }`.
- `api-snapshots/` for `@lunora/server` changes only if the exported option type changes (see step 2).
- Changed by design: the cap counts members after dedup, and expired rows no longer use the budget. The existing test at `presence.test.ts:235-261` is rewritten to the new contract, with its comment changed to match.

## 4. Design decisions

- **D1: how the cap counts.** Chosen: cap members after dedup, and keep a hard read ceiling. Read in pages of live rows (range `lastSeen > cutoff` on the index) until the member count reaches `maxMembers` or the ceiling is hit. Alternative rejected: raise the default `maxSessions` to 4096. That only moves the failure to a larger room, and the read still scales with duplicates.
- **D2: keep the option name.** Chosen: keep `maxSessions` as the read ceiling and add `maxMembers` (default = `maxSessions`). Alternative rejected: rename `maxSessions`. That is an API change with no gain on alpha, and it touches more call sites.
- **D3: sweep shape.** Chosen: range `lastSeen <= cutoff` on `byRoomLastSeen`, ordered ascending, `take(SWEEP_BATCH)`, and return the number deleted. A room with more expired rows needs another call, which is what the cron already does. Alternative rejected: add a `hasMore` field to the return type. That widens a public return shape for a case the cron already covers.

## 5. Workstreams

1. **Failing test first (S).** Add a test that fails on alpha: `maxSessions: 2` with `solo` and two `multi` tabs must return `["multi", "solo"]`. Add a sweep test with more expired rows than `SWEEP_BATCH` that asserts one call deletes at most `SWEEP_BATCH`. **Done when** both fail for the reason stated above.
2. **Cap members after dedup (S).** Rewrite `listPresent` (presence.ts:322-380) as a bounded page loop over the `byRoomLastSeen` range `q.eq("roomId", r).gt("lastSeen", cutoff)`, newest first. Stop when `members.length === maxMembers` or the rows read reach `maxSessions`. Add the `maxMembers` option (presence.ts:119-151). Rewrite the test at `presence.test.ts:235-261` to assert the new contract, and say so in the commit body.
3. **Bound the sweep (S).** Replace presence.ts:382-396 with the index range `q.eq("roomId", r).lte("lastSeen", cutoff)`, ascending, `take(SWEEP_BATCH)`. Update the sweep doc comment (presence.ts:189-196) to say it is batched and that callers repeat it on a cron.
4. **Public surface and docs (S).** If `DefinePresenceOptions` changed, run `pnpm run build:packages` then `pnpm run api:update` only against a fresh build, and check the diff.

## 6. Platform parity

Not applicable: no new `ctx.*` surface, binding, or deploy capability. The change is internal query bounds in a function that runs the same way on every host. The reader and index are the existing `ctx.db` surface.

## 7. Commands

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
pnpm run build:packages
pnpm --filter "@lunora/server" run test -- presence
pnpm run test:workerd
pnpm run lint:eslint -- packages/server/src/presence.ts packages/server/__tests__/presence.test.ts
pnpm run lint:prettier -- packages/server/src/presence.ts packages/server/__tests__/presence.test.ts
pnpm run api:check
```

Run prettier before eslint (see the repo gotcha on the fix order).

## 8. Scope

**In:** `packages/server/src/presence.ts`, `packages/server/__tests__/presence.test.ts`, and `api-snapshots/server.api.md` only if the option type changed.

**Out:** the heartbeat reap, the `disconnect` hook, `packages/react` `usePresence`, `packages/server/src/lifecycle.ts`, codegen, and any other package. Do not rename `maxSessions`.

## 9. Git workflow

- Branch: `advisor/481-presence-bounds`, off `origin/alpha`.
- One commit, conventional form, for example `fix(server): count presence members after dedup and bound the sweep`. Put the behaviour change and the rewritten test in the body, wrapped at 100 characters.
- Do not push. Do not use `--no-verify`. Stage explicit paths only.

## 10. Steps with verify commands

1. Read `presence.ts` (322-396) and `presence.test.ts` (214-330) in full before editing.
2. Write the two failing tests from workstream 1. Run `pnpm --filter "@lunora/server" run test -- presence`. **Verify:** both fail, for the stated reason.
3. Implement workstreams 2 and 3. **Verify:** the same command passes with zero assertions weakened outside the rewritten test.
4. Mutation check: revert the page loop to a single `take(maxSessions)` and confirm the cap test fails again. Revert the sweep to `.collect()` and confirm the batch test fails.
5. Run `pnpm run test:workerd`. **Verify:** the server workerd project is green.
6. Run the lint and `api:check` commands above.

## 11. Test plan

- Node (`presence.test.ts`): the rewritten cap test, the new sweep batch test, the existing `sweep hard-deletes only expired rows` test (line 318), and the existing non-finite fallback test (line 263).
- Workerd: `pnpm run test:workerd`. `presence.test.ts` runs under Node only. Node tests cannot verify the DO-backed read path, the index range on the real SQLite backend, or the per-invocation limits the sweep bound exists for. The workerd gate must be green before the PR.
- Regression at scale: the cap test uses 3 rows, which is too small to show the bound. Add one case with about 2,000 rows (`maxSessions` = 1024) to check that the page loop stops at the ceiling.

## 12. Done criteria

- Both failing tests were red on alpha and are green after the change.
- `listPresent` returns `maxMembers` distinct members when they exist, and never reads more than `maxSessions` rows.
- `sweep` deletes at most `SWEEP_BATCH` rows per call and reads through the `lastSeen` index.
- No assertion outside the rewritten test changed.
- `pnpm run test:workerd` and `pnpm run api:check` are green.
- One commit on `advisor/481-presence-bounds`, not pushed.

## 13. Risks and STOP conditions

- **STOP** if the db reader has no range predicate on a non-leading index column (`gt` / `lte` on `lastSeen`). Re-scope: the bound would need a different index or a schema change, which is a separate plan.
- **STOP** if `api:check` shows a change outside `DefinePresenceOptions`. The change leaked somewhere public.
- **Risk:** a page loop that reads more rows per call makes subscriber re-runs more expensive. Mitigate: the ceiling stays at `maxSessions`, so the worst case is no worse than today.
- **Perf watch:** `listPresent` cost per call at 1k and 2k rows, with `packages/server` bench suites if present. Name the suite in the PR before claiming a win.

## 14. Open questions

1. Does `ctx.db` expose a `gt` / `lte` predicate on the second index column, and does the memory db used by tests implement it? Check `packages/server/src` for the query builder before step 2.
2. Should `SWEEP_BATCH` be a fixed constant (proposed: 256) or an option? Proposed: a constant, matching `REAP_BATCH`.
3. Is `maxMembers` worth a separate option, or should the member count default to `maxSessions` with no knob? Proposed: keep the knob, since the read ceiling and the member cap answer different sizing questions.
